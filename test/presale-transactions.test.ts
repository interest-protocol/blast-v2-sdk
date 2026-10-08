import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import type { Transaction } from "@mysten/sui/transactions";
import {
  fromBase64,
  normalizeStructTag,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";

import {
  buildRewardManifest,
  MIGRATOR_REWARD_LEAF_DOMAIN,
  PRESALE_REWARD_LEAF_DOMAIN,
} from "../src/holder-rewards/allocations.ts";
import { itemAt } from "../src/lib/arrays.ts";
import type { SharedObjectReference } from "../src/lib/sui.ts";
import { buildAllowlist } from "../src/presale/allowlist.ts";
import { openEligibility, uncappedForAnyone } from "../src/presale/math.ts";
import type {
  PresaleDeployment,
  PresaleTerms,
} from "../src/presale/transactions.ts";
import {
  cetusMemeSide,
  PresaleCalls,
  PresaleTransactions,
} from "../src/presale/transactions.ts";

function shared<const Mutable extends boolean>(
  objectId: string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion: "3", mutable };
}

const deployment: PresaleDeployment = {
  packageId: "0x5f",
  originalPackageId: "0x5e",
  venueConfig: shared("0x60", false),
  feePolicy: shared("0x61", false),
  creationPolicy: shared("0x62", false),
  adminRegistry: shared("0x63", false),
};
const tx = new PresaleTransactions(deployment);
const memeA = normalizeStructTag("0xa::meme::MEME");
const memeB = normalizeStructTag("0x1::meme::MEME");
const sui = normalizeStructTag("0x2::sui::SUI");
const usdc = normalizeStructTag(
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
);
const CLOCK = `shared:${SUI_CLOCK_OBJECT_ID}`;
const presale = shared("0xab", true);
const types = { memeType: memeA, quoteType: sui };
const terms: PresaleTerms = {
  ...types,
  treasuryCap: "0x7c",
  memeCurrency: shared("0xcc", true),
  tokenSupply: 20_001n,
  tokenAllocationBps: 5_000n,
  participantVesting: null,
  liquidityTokenAllocationBps: 1_000n,
  recipientAllocations: [
    { recipient: "0xa110c", bps: 2_500n },
    { recipient: "0xb110c", bps: 1_500n },
  ],
  burnable: false,
  raiseTarget: 1_000n,
  raiseAllocations: [{ recipient: "0x5a1e", bps: 2_000n }],
  durationMs: 100n,
  liquidityWindowMs: 50n,
  eligibility: openEligibility(500n, 4n, 250n),
  uncapped: uncappedForAnyone(50n, 4n, 250n),
  hardCap: { startsAfterMs: 50n, closesWhenFilled: true },
  feeRecipients: [{ recipient: "0xc0ffee", bps: 7_000n }],
  holderRewardsBps: 3_000n,
};
/** The `&AdminRegistry, &AdminCap` pair every administrator call takes. */
const ADMIN = ["shared:0x63", "object:0xadc"];
/** One `RecipientShare`: its rate, then the constructor. */
const recipientShare = ["bps::new", "blast_presale::recipient_share"];
const cetus = {
  cetusConfig: shared("0x70", false),
  cetusPools: shared("0x71", true),
};
const partner = shared("0x9a27", false);

test("orders Cetus coins by defining type name, both ways", () => {
  assert.equal(cetusMemeSide(memeA, sui), "a");
  assert.equal(cetusMemeSide(memeB, sui), "b");
  // The venue fork asserts (USDC, SUI) is in Cetus order.
  assert.equal(cetusMemeSide(usdc, sui), "a");
  assert.equal(cetusMemeSide(sui, usdc), "b");

  const migrate = (memeType: string) =>
    moveCall(
      tx.migrateCetus({
        memeType,
        quoteType: sui,
        presale,
        ...cetus,
        burnManager: shared("0x72", true),
      }),
      "cetus::migrate",
    );
  assert.deepEqual(migrate(memeA).typeArguments, [memeA, sui, memeA, sui]);
  assert.deepEqual(migrate(memeB).typeArguments, [memeB, sui, sui, memeB]);
  const collect = moveCall(
    tx.collectCetusFees({
      memeType: memeB,
      quoteType: sui,
      vault: shared("0xba", true),
      cetusConfig: cetus.cetusConfig,
      burnManager: shared("0x72", false),
      pool: shared("0x90", true),
    }),
    "cetus::collect_fees",
  );
  assert.deepEqual(collect.typeArguments, [memeB, sui, sui, memeB]);
});

test("starts, configures, finalizes, shares, and keeps the cap of a Cetus presale in one PTB", () => {
  const ptb = tx.createCetusPresale({
    ...terms,
    ...cetus,
    tickSpacing: 200,
    startMs: 1_000n,
    capRecipient: "0xc0",
  });
  assert.deepEqual(moveFunctions(ptb), [
    "cetus::new",
    "blast_presale::set_supply",
    "bps::new", // token_allocation_bps
    "bps::new", // liquidity_token_allocation_bps
    ...recipientShare,
    ...recipientShare, // recipient_allocations
    "blast_presale::set_token_allocations",
    ...recipientShare, // raise_allocations
    "blast_presale::set_raise",
    "blast_presale::set_windows",
    "blast_presale::open_eligibility",
    "blast_presale::set_eligibility",
    "blast_presale::uncapped_for_anyone",
    "blast_presale::set_uncapped_phase",
    "blast_presale::set_hard_cap",
    ...recipientShare, // fee_split shares
    "bps::new", // fee_split holder_rewards_bps
    "blast_presale::fee_split",
    "blast_presale::set_fee_split",
    "blast_presale::finalize",
    "blast_presale::share",
  ]);
  const created = moveCall(ptb, "cetus::new");
  assert.deepEqual(created.typeArguments, [memeA, sui]);
  assert.deepEqual(argumentKinds(ptb, created), [
    "object:0x7c",
    "shared:0x62",
    "shared:0x61",
    "shared-mut:0x60",
    "shared:0x70",
    "shared-mut:0x71",
    "pure",
  ]);
  assert.equal(created.arguments.length, abiArity("cetus", "new"));
  const initializer = `Result:${commandIndex(ptb, "cetus::new")}`;
  for (const setter of [
    "set_supply",
    "set_token_allocations",
    "set_raise",
    "set_windows",
    "set_eligibility",
    "set_uncapped_phase",
    "set_hard_cap",
    "set_fee_split",
  ]) {
    const call = moveCall(ptb, `blast_presale::${setter}`);
    assert.deepEqual(call.typeArguments, [memeA, sui]);
    assert.equal(argumentKinds(ptb, call)[0], initializer);
    assert.equal(call.arguments.length, abiArity("blast_presale", setter));
  }
  const allocations = moveCall(ptb, "blast_presale::set_token_allocations");
  assert.deepEqual(argumentKinds(ptb, allocations), [
    initializer,
    `Result:${commandIndex(ptb, "bps::new")}`,
    `Result:${commandIndex(ptb, "bps::new") + 1}`,
    `Result:${commandIndexOf(ptb, "MakeMoveVec", 0)}`,
  ]);
  const hardCap = moveCall(ptb, "blast_presale::set_hard_cap");
  assert.equal(pureU64(ptb, hardCap.arguments[1]), 50n);
  const feeSplit = moveCall(ptb, "blast_presale::fee_split");
  assert.deepEqual(argumentKinds(ptb, feeSplit), [
    `Result:${commandIndexOf(ptb, "MakeMoveVec", 2)}`,
    `Result:${commandIndex(ptb, "blast_presale::fee_split") - 1}`,
  ]);
  const finalize = moveCall(ptb, "blast_presale::finalize");
  assert.deepEqual(argumentKinds(ptb, finalize), [
    initializer,
    "shared-mut:0xcc",
  ]);
  assert.equal(
    finalize.arguments.length,
    abiArity("blast_presale", "finalize"),
  );
  const share = moveCall(ptb, "blast_presale::share");
  assert.deepEqual(argumentKinds(ptb, share), [
    `NestedResult:${commandIndex(ptb, "blast_presale::finalize")}:0`,
    "pure",
    CLOCK,
  ]);
  assert.equal(pureU64(ptb, share.arguments[1]), 1_000n);
  assert.equal(ptb.getData().commands.at(-1)?.$kind, "TransferObjects");
  const vectors = ptb
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MakeMoveVec" ? [command.MakeMoveVec.type] : [],
    );
  assert.deepEqual(
    vectors,
    Array(3).fill(normalizeStructTag("0x5e::blast_presale::RecipientShare")),
  );
});

test("names a partner on the initializer before finalize, and pays it in the migration PTB", () => {
  const ptb = tx.createCetusPresale({
    ...terms,
    ...cetus,
    tickSpacing: 200,
    startMs: 1_000n,
    capRecipient: "0xc0",
    partner,
  });
  assert.deepEqual(moveFunctions(ptb).slice(-4), [
    "blast_presale::set_fee_split",
    "blast_presale::set_partner",
    "blast_presale::finalize",
    "blast_presale::share",
  ]);
  const setPartner = moveCall(ptb, "blast_presale::set_partner");
  assert.deepEqual(setPartner.typeArguments, [memeA, sui]);
  assert.deepEqual(argumentKinds(ptb, setPartner), [
    `Result:${commandIndex(ptb, "cetus::new")}`,
    "shared:0x62",
    "shared:0x9a27",
    CLOCK,
  ]);
  assert.equal(
    setPartner.arguments.length,
    abiArity("blast_presale", "set_partner"),
  );

  const burnManager = shared("0x72", true);
  const migrate = tx.migrateCetus({
    ...types,
    presale,
    ...cetus,
    burnManager,
    partner,
  });
  assert.deepEqual(moveFunctions(migrate), [
    "cetus::migrate",
    "blast_presale::pay_protocol_fees_with_partner",
  ]);
  const migrateBluefin = tx.migrateBluefin({
    ...types,
    presale,
    memeCurrency: shared("0xcc", false),
    quoteCurrency: shared("0xcd", false),
    bluefinConfig: shared("0x80", true),
    creationFee: 1_000n,
    partner,
  });
  assert.deepEqual(moveFunctions(migrateBluefin), [
    "bluefin::migrate",
    "blast_presale::pay_protocol_fees_with_partner",
  ]);
  // After migration, each collection on the partnered vault pays what it held.
  const partneredVault = shared("0xba", true);
  const collectCetus = tx.collectCetusFees({
    ...types,
    vault: partneredVault,
    cetusConfig: cetus.cetusConfig,
    burnManager: shared("0x72", false),
    pool: shared("0x90", true),
    partner,
  });
  assert.deepEqual(moveFunctions(collectCetus), [
    "cetus::collect_fees",
    "presale_vault::pay_protocol_lp_fees_with_partner",
  ]);
  const collectBluefin = tx.collectBluefinFees({
    ...types,
    vault: partneredVault,
    bluefinConfig: shared("0x80", false),
    pool: shared("0x90", true),
    partner,
  });
  assert.deepEqual(moveFunctions(collectBluefin), [
    "bluefin::collect_fees",
    "presale_vault::pay_protocol_lp_fees_with_partner",
  ]);
  // Without a partner, neither creation nor migration names one.
  for (const unpartnered of [
    tx.createCetusPresale({
      ...terms,
      ...cetus,
      tickSpacing: 200,
      startMs: 1_000n,
      capRecipient: "0xc0",
    }),
    tx.migrateCetus({
      ...types,
      presale,
      ...cetus,
      burnManager,
      partner: null,
    }),
  ]) {
    assert.ok(
      !moveFunctions(unpartnered).some((name) => name.includes("partner")),
    );
  }
});

test("creates a Bluefin presale without optional settings", () => {
  const ptb = tx.createBluefinPresale({
    ...terms,
    uncapped: null,
    hardCap: null,
    eligibility: {
      kind: "allowlisted",
      root: "11".repeat(32),
      leafCount: 2n,
    },
    tickSpacing: 60,
    feeRate: 3_000n,
    startMs: 1_000n,
    capRecipient: "0xc0",
  });
  const functions = moveFunctions(ptb);
  assert.ok(functions.includes("blast_presale::allowlisted_eligibility"));
  for (const optional of [
    "set_participant_vesting",
    "set_uncapped_phase",
    "set_hard_cap",
    "set_partner",
  ]) {
    assert.ok(!functions.includes(`blast_presale::${optional}`));
  }
  const created = moveCall(ptb, "bluefin::new");
  assert.equal(created.arguments.length, abiArity("bluefin", "new"));
  // The currency goes in mutably: the same PTB's `finalize` takes it so.
  assert.deepEqual(argumentKinds(ptb, created), [
    "object:0x7c",
    "shared-mut:0xcc",
    "shared:0x62",
    "shared:0x61",
    "shared-mut:0x60",
    "pure",
    "pure",
  ]);
});

test("commits through each route and returns the change to the wallet", () => {
  const allowlist = buildAllowlist([
    { wallet: "0xa11ce", walletCap: 500n },
    { wallet: "0xb0b", walletCap: 700n },
  ]);
  for (const route of ["open", "uncapped", "allowlisted"] as const) {
    const ptb = tx.commit({
      ...types,
      presale,
      amount: 250n,
      recipient: "0xa11ce",
      route,
      allowlist: itemAt(allowlist.proofs, 0),
    });
    const call = moveCall(ptb, `blast_presale::commit_${route}`);
    assert.deepEqual(call.typeArguments, [memeA, sui]);
    const kinds = argumentKinds(ptb, call);
    assert.equal(kinds[0], "shared-mut:0xab");
    assert.equal(kinds.at(-1), CLOCK);
    assert.equal(kinds.length, abiArity("blast_presale", `commit_${route}`));
    const transfer = ptb.getData().commands.at(-1);
    assert.equal(transfer?.$kind, "TransferObjects");
  }
  assert.throws(() =>
    tx.commit({
      ...types,
      presale,
      amount: -1n,
      recipient: "0xa",
      route: "open",
    }),
  );
});

test("builds every lifecycle call with the ABI's argument count", () => {
  const vault = shared("0xba", true);
  const round = shared("0xd0", true);
  const manifest = buildRewardManifest({
    vaultId: "0xba",
    number: 0n,
    startCheckpoint: 1n,
    endCheckpoint: 2n,
    allocations: [{ beneficiary: "0xb0b", memeAmount: 40n, quoteAmount: 5n }],
    leafDomain: PRESALE_REWARD_LEAF_DOMAIN,
  });
  const cases: Array<[Transaction, string, string[]]> = [
    [
      tx.settle({ ...types, presale }),
      "blast_presale::settle",
      ["shared-mut:0xab", CLOCK],
    ],
    [
      tx.cancelUnlaunched({ ...types, presale }),
      "blast_presale::cancel_unlaunched",
      ["shared-mut:0xab", CLOCK],
    ],
    [
      tx.claim({ ...types, presale, participants: ["0xa11ce"] }),
      "blast_presale::claim",
      ["shared-mut:0xab", "pure", CLOCK],
    ],
    [
      tx.destroyCap({ ...types, presale, presaleCapId: "0xca" }),
      "blast_presale::destroy_cap",
      ["shared:0xab", "object:0xca"],
    ],
    [
      tx.migrateCetus({
        ...types,
        presale,
        ...cetus,
        burnManager: shared("0x72", true),
      }),
      "cetus::migrate",
      [
        "shared-mut:0xab",
        "shared:0x61",
        "shared:0x60",
        "shared:0x70",
        "shared-mut:0x71",
        "shared-mut:0x72",
        CLOCK,
      ],
    ],
    [
      tx.migrateBluefin({
        ...types,
        presale,
        memeCurrency: shared("0xcc", false),
        quoteCurrency: shared("0xcd", false),
        bluefinConfig: shared("0x80", true),
        creationFee: 1_000n,
      }),
      "bluefin::migrate",
      [
        "shared-mut:0xab",
        "shared:0x61",
        "shared:0x60",
        "shared:0xcc",
        "shared:0xcd",
        "shared-mut:0x80",
        "Result:0",
        CLOCK,
      ],
    ],
    [
      tx.collectCetusFees({
        ...types,
        vault,
        cetusConfig: cetus.cetusConfig,
        burnManager: shared("0x72", false),
        pool: shared("0x90", true),
      }),
      "cetus::collect_fees",
      [
        "shared-mut:0xba",
        "shared:0x61",
        "shared:0x70",
        "shared:0x72",
        "shared-mut:0x90",
      ],
    ],
    [
      tx.collectBluefinFees({
        ...types,
        vault,
        bluefinConfig: shared("0x80", false),
        pool: shared("0x90", true),
      }),
      "bluefin::collect_fees",
      [
        "shared-mut:0xba",
        "shared:0x61",
        "shared:0x80",
        "shared-mut:0x90",
        CLOCK,
      ],
    ],
    [
      tx.claimMigrationResiduals({
        ...types,
        vault,
        presaleCapId: "0xca",
        recipient: "0xc0",
      }),
      "presale_vault::claim_migration_residuals",
      ["shared-mut:0xba", "object:0xca"],
    ],
    [
      tx.publishHolderRewardRound({
        ...types,
        vault,
        adminCapId: "0xadc",
        manifest,
        claimDeadlineMs: 9_000n,
      }),
      "holder_rewards::publish_round",
      ["shared-mut:0xba", ...ADMIN, ...Array(9).fill("pure"), CLOCK],
    ],
    [
      tx.claimHolderRewards({
        ...types,
        round,
        allocations: manifest.allocations,
      }),
      "holder_rewards::claim",
      ["shared-mut:0xd0", ...Array(5).fill("pure")],
    ],
    [
      tx.closeHolderRewardRound({ ...types, round, vault }),
      "holder_rewards::close_round",
      ["shared-mut:0xd0", "shared-mut:0xba", CLOCK],
    ],
    [
      tx.setProtocolFees({
        adminCapId: "0xadc",
        fees: {
          raiseBps: 333n,
          tokenBps: 500n,
          lpFeeMemeBps: 1_000n,
          lpFeeQuoteBps: 1_000n,
        },
      }),
      "fee_policy::set_fees",
      [
        "shared-mut:0x61",
        ...ADMIN,
        "Result:0",
        "Result:1",
        "Result:2",
        "Result:3",
      ],
    ],
    [
      tx.setPresaleProtocolFees({
        ...types,
        presale,
        adminCapId: "0xadc",
        fees: {
          raiseBps: 1_000n,
          tokenBps: 250n,
          lpFeeMemeBps: 100n,
          lpFeeQuoteBps: 200n,
        },
      }),
      "blast_presale::set_protocol_fees",
      [
        "shared-mut:0xab",
        ...ADMIN,
        "Result:0",
        "Result:1",
        "Result:2",
        "Result:3",
        CLOCK,
      ],
    ],
    [
      tx.setProtocolLpFees({
        ...types,
        vault,
        adminCapId: "0xadc",
        lpFeeMemeBps: 500n,
        lpFeeQuoteBps: 0n,
      }),
      "presale_vault::set_protocol_lp_fees",
      ["shared-mut:0xba", ...ADMIN, "Result:0", "Result:1"],
    ],
    [
      tx.setQuoteAllowed({
        adminCapId: "0xadc",
        quoteType: sui,
        allowed: true,
      }),
      "creation_policy::set_quote_allowed",
      ["shared-mut:0x62", ...ADMIN, "pure"],
    ],
    [
      tx.setMigrationWitnessAllowed({
        adminCapId: "0xadc",
        venue: "bluefin",
        allowed: false,
      }),
      "creation_policy::set_migration_witness_allowed",
      ["shared-mut:0x62", ...ADMIN, "pure"],
    ],
    [
      tx.replaceAdminCap({ superAdminCapId: "0x5ad", recipient: "0xc0" }),
      "blast_presale_admin::replace_admin_cap",
      ["shared-mut:0x63", "object:0x5ad"],
    ],
    [
      tx.revokeAdminCap({ superAdminCapId: "0x5ad" }),
      "blast_presale_admin::revoke_admin_cap",
      ["shared-mut:0x63", "object:0x5ad"],
    ],
    [
      tx.transferSuperAdmin({ superAdminCapId: "0x5ad", recipient: "0xc01d" }),
      "blast_presale_admin::transfer_super_admin",
      ["object:0x5ad", "pure"],
    ],
    [
      tx.setProtocolDestination({ adminCapId: "0xadc", destination: "0x7ea5" }),
      "fee_policy::set_destination",
      ["shared-mut:0x61", ...ADMIN, "pure"],
    ],
    [
      tx.payProtocolFeesWithPartner({ ...types, presale, partner }),
      "blast_presale::pay_protocol_fees_with_partner",
      ["shared-mut:0xab", "shared:0x61", "shared:0x9a27", CLOCK],
    ],
    [
      tx.payProtocolLpFeesWithPartner({ ...types, vault, partner }),
      "presale_vault::pay_protocol_lp_fees_with_partner",
      ["shared-mut:0xba", "shared:0x61", "shared:0x9a27", CLOCK],
    ],
    [
      tx.addPartner({ adminCapId: "0xadc", partner }),
      "creation_policy::add_partner",
      ["shared-mut:0x62", ...ADMIN, "shared:0x9a27"],
    ],
    [
      tx.removePartner({ adminCapId: "0xadc", partner }),
      "creation_policy::remove_partner",
      ["shared-mut:0x62", ...ADMIN, "shared:0x9a27", CLOCK],
    ],
  ];
  for (const [ptb, name, kinds] of cases) {
    const call = moveCall(ptb, name);
    const [module, fn] = name.split("::") as [string, string];
    assert.deepEqual(argumentKinds(ptb, call), kinds, name);
    assert.equal(call.arguments.length, abiArity(module, fn), name);
    assert.equal(call.typeArguments.length, abiTypeArity(module, fn), name);
  }
});

test("administers with the presale AdminCap and never signs in to blast_acl", () => {
  const vault = shared("0xba", true);
  const noFees = {
    raiseBps: 0n,
    tokenBps: 0n,
    lpFeeMemeBps: 0n,
    lpFeeQuoteBps: 0n,
  };
  const listQuote = tx.setQuoteAllowed({
    adminCapId: "0xadc",
    quoteType: sui,
    allowed: true,
  });
  const listVenue = tx.setMigrationWitnessAllowed({
    adminCapId: "0xadc",
    venue: "cetus",
    allowed: true,
  });
  for (const ptb of [
    tx.setProtocolFees({ adminCapId: "0xadc", fees: noFees }),
    listQuote,
    listVenue,
    tx.setProtocolDestination({ adminCapId: "0xadc", destination: "0x7ea5" }),
    tx.setPresaleProtocolFees({
      ...types,
      presale,
      adminCapId: "0xadc",
      fees: noFees,
    }),
    tx.setProtocolLpFees({
      ...types,
      vault,
      adminCapId: "0xadc",
      lpFeeMemeBps: 0n,
      lpFeeQuoteBps: 0n,
    }),
  ]) {
    assert.ok(!moveFunctions(ptb).some((name) => name.startsWith("blast_acl")));
  }
  assert.deepEqual(
    moveCall(listQuote, "creation_policy::set_quote_allowed").typeArguments,
    [sui],
  );
  assert.deepEqual(
    moveCall(listVenue, "creation_policy::set_migration_witness_allowed")
      .typeArguments,
    [normalizeStructTag("0x5e::cetus::Witness")],
  );
  for (const lpFeeMemeBps of [-1n, 10_001n]) {
    assert.throws(() =>
      tx.setProtocolLpFees({
        ...types,
        vault,
        adminCapId: "0xadc",
        lpFeeMemeBps,
        lpFeeQuoteBps: 0n,
      }),
    );
  }
  for (const raiseBps of [-1n, 10_001n]) {
    assert.throws(() =>
      tx.setProtocolFees({
        adminCapId: "0xadc",
        fees: { ...noFees, raiseBps },
      }),
    );
  }
});

test("allows an external migrator's witness and rejects types anyone can construct", () => {
  const witness = "0xabc::blast_aftermath_dao_presale::Witness";
  const allowExternal = tx.setMigrationWitnessAllowed({
    adminCapId: "0xadc",
    witnessType: witness,
    allowed: true,
  });

  const call = moveCall(
    allowExternal,
    "creation_policy::set_migration_witness_allowed",
  );
  assert.deepEqual(call.typeArguments, [normalizeStructTag(witness)]);
  assert.deepEqual(argumentKinds(allowExternal, call), [
    "shared-mut:0x62",
    ...ADMIN,
    "pure",
  ]);
  for (const witnessType of [
    "u64",
    "vector<u8>",
    "vector<0x2::sui::SUI>",
    "0x1::type_name::TypeName",
    "0x1::option::Option<0xabc::blast_aftermath_dao_presale::Witness>",
    "0x2::object::ID",
  ]) {
    assert.throws(
      () =>
        tx.setMigrationWitnessAllowed({
          adminCapId: "0xadc",
          witnessType,
          allowed: true,
        }),
      witnessType,
    );
  }
});

test("replacing the AdminCap sends the new cap to its recipient", () => {
  const ptb = tx.replaceAdminCap({
    superAdminCapId: "0x5ad",
    recipient: "0xc0",
  });
  const replace = commandIndex(ptb, "blast_presale_admin::replace_admin_cap");
  const transfer = ptb.getData().commands.at(-1);
  assert.ok(transfer?.$kind === "TransferObjects");
  assert.deepEqual(transfer.TransferObjects.objects, [
    { $kind: "Result", Result: replace },
  ]);
});

test("vested token and raise shares build their terms; fee shares cannot vest", () => {
  const vesting = { cliffMs: 100n, periodMs: 50n, periods: 4n };
  const ptb = tx.createCetusPresale({
    ...terms,
    ...cetus,
    recipientAllocations: [
      { recipient: "0xa110c", bps: 2_500n, vesting },
      { recipient: "0xb110c", bps: 1_500n },
    ],
    raiseAllocations: [{ recipient: "0x5a1e", bps: 2_000n, vesting }],
    tickSpacing: 200,
    startMs: 1_000n,
    capRecipient: "0xc0",
  });
  const vestedShare = [
    "bps::new",
    "blast_presale::vesting_terms",
    "blast_presale::vested_recipient_share",
  ];
  assert.deepEqual(moveFunctions(ptb).slice(0, 14), [
    "cetus::new",
    "blast_presale::set_supply",
    "bps::new",
    "bps::new",
    ...vestedShare,
    ...recipientShare,
    "blast_presale::set_token_allocations",
    ...vestedShare,
    "blast_presale::set_raise",
  ]);
  const terms0 = moveCall(ptb, "blast_presale::vesting_terms");
  assert.deepEqual(argumentKinds(ptb, terms0), ["pure", "pure", "pure"]);
  const vested = moveCall(ptb, "blast_presale::vested_recipient_share");
  assert.deepEqual(argumentKinds(ptb, vested), [
    "pure",
    `Result:${commandIndex(ptb, "blast_presale::vesting_terms") - 1}`,
    `Result:${commandIndex(ptb, "blast_presale::vesting_terms")}`,
  ]);
  for (const [module, fn] of [
    ["blast_presale", "vesting_terms"],
    ["blast_presale", "vested_recipient_share"],
  ] as const) {
    assert.equal(
      moveCall(ptb, `${module}::${fn}`).arguments.length,
      abiArity(module, fn),
    );
  }

  assert.throws(
    () =>
      tx.createCetusPresale({
        ...terms,
        ...cetus,
        recipientAllocations: [
          {
            recipient: "0xa110c",
            bps: 2_500n,
            vesting: { ...vesting, periods: 0n },
          },
          { recipient: "0xb110c", bps: 1_500n },
        ],
        tickSpacing: 200,
        startMs: 1_000n,
        capRecipient: "0xc0",
      }),
    /EInvalidVestingTerms/,
  );
  assert.throws(
    () =>
      tx.createCetusPresale({
        ...terms,
        ...cetus,
        feeRecipients: [{ recipient: "0xc0ffee", bps: 7_000n, vesting }],
        tickSpacing: 200,
        startMs: 1_000n,
        capRecipient: "0xc0",
      }),
    /fee recipients cannot vest/,
  );
});

test("participant vesting builds vesting_terms for set_participant_vesting after the token allocations", () => {
  const vesting = { cliffMs: 100n, periodMs: 50n, periods: 4n };
  const ptb = tx.createCetusPresale({
    ...terms,
    ...cetus,
    participantVesting: vesting,
    tickSpacing: 200,
    startMs: 1_000n,
    capRecipient: "0xc0",
  });
  const functions = moveFunctions(ptb);
  const allocations = functions.indexOf("blast_presale::set_token_allocations");
  assert.deepEqual(functions.slice(allocations + 1, allocations + 3), [
    "blast_presale::vesting_terms",
    "blast_presale::set_participant_vesting",
  ]);
  const terms0 = moveCall(ptb, "blast_presale::vesting_terms");
  assert.deepEqual(
    terms0.arguments.map((argument) => pureU64(ptb, argument)),
    [100n, 50n, 4n],
  );
  const setVesting = moveCall(ptb, "blast_presale::set_participant_vesting");
  assert.deepEqual(argumentKinds(ptb, setVesting), [
    `Result:${commandIndex(ptb, "cetus::new")}`,
    `Result:${commandIndex(ptb, "blast_presale::vesting_terms")}`,
  ]);
  assert.equal(
    setVesting.arguments.length,
    abiArity("blast_presale", "set_participant_vesting"),
  );

  assert.throws(
    () =>
      tx.createCetusPresale({
        ...terms,
        ...cetus,
        participantVesting: { ...vesting, periodMs: 0n },
        tickSpacing: 200,
        startMs: 1_000n,
        capRecipient: "0xc0",
      }),
    /EInvalidVestingTerms/,
  );
});

test("rejects a manifest from the migrators' leaf domain or another vault", () => {
  const options = {
    vaultId: "0xba",
    number: 0n,
    startCheckpoint: 1n,
    endCheckpoint: 2n,
    allocations: [{ beneficiary: "0xb0b", memeAmount: 1n, quoteAmount: 0n }],
  };
  const call = new PresaleCalls(deployment);
  const publish = (
    manifest: ReturnType<typeof buildRewardManifest>,
    vault = "0xba",
  ) =>
    call.publishHolderRewardRound({
      ...types,
      vault: shared(vault, true),
      adminCap: "0xadc",
      manifest,
      claimDeadlineMs: 1n,
    });
  assert.throws(
    () =>
      publish(
        buildRewardManifest({
          ...options,
          leafDomain: MIGRATOR_REWARD_LEAF_DOMAIN,
        }),
      ),
    /root mismatch/,
  );
  const presaleManifest = buildRewardManifest({
    ...options,
    leafDomain: PRESALE_REWARD_LEAF_DOMAIN,
  });
  assert.throws(() => publish(presaleManifest, "0xbb"), /another vault/);
});

// === ABI and PTB inspection ===

type AbiFunction = {
  name: string;
  typeParameters: unknown[];
  parameters: unknown[];
};
const abi = JSON.parse(
  readFileSync(
    new URL("../abi/production-presale-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  packages: {
    presale: { modules: Record<string, { functions: AbiFunction[] }> };
  };
};

function abiFunction(module: string, name: string): AbiFunction {
  const found = abi.packages.presale.modules[module]?.functions.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(found, `${module}::${name} is in the frozen ABI`);
  return found;
}

/** Move parameters a PTB supplies: all but the trailing `&mut TxContext`. */
function abiArity(module: string, name: string): number {
  return abiFunction(module, name).parameters.filter(
    (parameter) => !JSON.stringify(parameter).includes('"TxContext"'),
  ).length;
}

function abiTypeArity(module: string, name: string): number {
  return abiFunction(module, name).typeParameters.length;
}

function moveFunctions(ptb: Transaction): string[] {
  return ptb
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall"
        ? [`${command.MoveCall.module}::${command.MoveCall.function}`]
        : [],
    );
}

function commandIndex(ptb: Transaction, name: string): number {
  return ptb
    .getData()
    .commands.findIndex(
      (command) =>
        command.$kind === "MoveCall" &&
        `${command.MoveCall.module}::${command.MoveCall.function}` === name,
    );
}

function commandIndexOf(ptb: Transaction, kind: string, nth: number): number {
  const indexes = ptb
    .getData()
    .commands.flatMap((command, index) =>
      command.$kind === kind ? [index] : [],
    );
  return itemAt(indexes, nth);
}

function moveCall(ptb: Transaction, name: string) {
  const command = ptb.getData().commands[commandIndex(ptb, name)];
  assert.ok(command?.$kind === "MoveCall", `missing ${name}`);
  return command.MoveCall;
}

function argumentKinds(
  ptb: Transaction,
  call: ReturnType<typeof moveCall>,
): string[] {
  return call.arguments.map((argument) => {
    if (argument.$kind === "Result") return `Result:${argument.Result}`;
    if (argument.$kind === "NestedResult") {
      return `NestedResult:${argument.NestedResult.join(":")}`;
    }
    if (argument.$kind !== "Input") return argument.$kind;
    return describeInput(ptb.getData().inputs[argument.Input]);
  });
}

/** Decodes the pure `u64` input `argument` names. */
function pureU64(
  ptb: Transaction,
  argument: ReturnType<typeof moveCall>["arguments"][number] | undefined,
): bigint {
  assert.ok(argument?.$kind === "Input");
  const input = ptb.getData().inputs[argument.Input];
  assert.ok(input?.$kind === "Pure");
  return BigInt(bcs.u64().parse(fromBase64(input.Pure.bytes)));
}

function describeInput(
  input: ReturnType<Transaction["getData"]>["inputs"][number] | undefined,
): string {
  if (input?.$kind === "Pure") return "pure";
  if (input?.$kind === "UnresolvedObject") {
    return `object:0x${BigInt(input.UnresolvedObject.objectId).toString(16)}`;
  }
  if (input?.$kind !== "Object" || input.Object.$kind !== "SharedObject") {
    return String(input?.$kind);
  }
  const reference = input.Object.SharedObject;
  if (reference.objectId === SUI_CLOCK_OBJECT_ID) return CLOCK;
  const prefix = reference.mutable ? "shared-mut" : "shared";
  return `${prefix}:0x${BigInt(reference.objectId).toString(16)}`;
}

test("locks an owner's own position in a vault through either venue", () => {
  const vaultTerms = {
    ...types,
    position: "0x9051",
    feeRecipients: [{ recipient: "0xc0ffee", bps: 7_000n }],
    holderRewardsBps: 3_000n,
    partnerId: "0x9a27",
    pool: shared("0x90", false),
  };
  const cetusVault = tx.newCetusVault({
    ...vaultTerms,
    burnManager: shared("0x72", true),
  });
  const cetusCall = moveCall(cetusVault, "cetus::new_vault");
  assert.deepEqual(cetusCall.typeArguments, [memeA, sui, memeA, sui]);
  assert.equal(cetusCall.arguments.length, abiArity("cetus", "new_vault"));
  assert.deepEqual(argumentKinds(cetusVault, cetusCall), [
    "object:0x9051",
    `Result:${commandIndex(cetusVault, "blast_presale::fee_split")}`,
    "pure",
    "shared:0x62",
    "shared:0x61",
    "shared:0x90",
    "shared-mut:0x72",
    CLOCK,
  ]);

  const bluefinVault = tx.newBluefinVault({ ...vaultTerms, partnerId: null });
  const bluefinCall = moveCall(bluefinVault, "bluefin::new_vault");
  assert.deepEqual(bluefinCall.typeArguments, [memeA, sui]);
  assert.equal(bluefinCall.arguments.length, abiArity("bluefin", "new_vault"));
  assert.deepEqual(argumentKinds(bluefinVault, bluefinCall).slice(-4), [
    "shared:0x62",
    "shared:0x61",
    "shared:0x90",
    CLOCK,
  ]);
});
