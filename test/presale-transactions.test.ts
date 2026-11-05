import assert from "node:assert/strict";
import test from "node:test";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import { buildAllowlist } from "@interest-protocol/blast-presale-sdk/allowlist";
import { openEligibility } from "@interest-protocol/blast-presale-sdk/math";
import type {
  PresaleDeployment,
  PresaleSettings,
} from "@interest-protocol/blast-presale-sdk/transactions";
import {
  PRESALE_PAUSE_BITS,
  PresaleCalls,
  PresaleTransactions,
} from "@interest-protocol/blast-presale-sdk/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";
import { verifiedLpCoin } from "./aftermath-lp.ts";

const shared = (objectId: string): SharedObjectIdentity => ({
  objectId,
  initialSharedVersion: "3",
});
const admin = { packageId: "0xad", acl: shared("0xac1") };
const core = {
  packageId: "0xc1",
  originalPackageId: "0xc0",
  treasury: shared("0x7ea"),
};
const vault = {
  packageId: "0xb1",
  originalPackageId: "0xb0",
  registry: shared("0xb2"),
  packageVersion: shared("0xb3"),
  packageAdmin: shared("0xb4"),
  core,
  admin,
};
const deployment: PresaleDeployment = {
  packageId: "0x5f",
  originalPackageId: "0x5e",
  packageVersion: shared("0x64"),
  packageAdmin: shared("0x65"),
  creationPolicy: shared("0x62"),
  feePolicy: shared("0x61"),
  presaleRegistry: shared("0x63"),
  core,
  admin,
  partners: { packageId: "0xa7", admin },
  vault,
  migrators: {
    packageId: "0xd1",
    originalPackageId: "0xd0",
    packageVersion: shared("0xd3"),
    packageAdmin: shared("0xd4"),
    venueConfig: shared("0xd5"),
    vault,
  },
  aftermathDaoPresale: {
    packageId: "0x7a",
    originalPackageId: "0x7a",
    aftermath: {
      poolRegistry: shared("0xaf1"),
      daoFeeVersion: shared("0xaf2"),
    },
  },
};
const ptb = new PresaleTransactions(deployment);
const saleToken = normalizeStructTag("0xa::sale::SALE");
const quote = normalizeStructTag("0x2::sui::SUI");
const lp = normalizeStructTag("0xb::lp::LP");
const types = { saleTokenType: saleToken, quoteType: quote };
const presale = shared("0xab");
const partner = shared("0x9a27");
const CLOCK = "clock";
const VERSION = "shared:0x64";

type Call = { target: string; typeArguments: string[]; args: string[] };

type Data = ReturnType<Transaction["getData"]>;
type Argument = Extract<
  Data["commands"][number],
  { $kind: "MoveCall" }
>["MoveCall"]["arguments"][number];

const hex = (id: string) => `0x${BigInt(id).toString(16)}`;

/** One argument as `result:N[:M]`, `pure`, `object:<id>`, `shared[-mut]:<id>` or `clock`. */
function describe(data: Data, argument: Argument): string {
  if (argument.$kind === "Result") return `result:${argument.Result}`;
  if (argument.$kind === "NestedResult")
    return `result:${argument.NestedResult.join(":")}`;
  if (argument.$kind === "GasCoin") return "gas";
  assert.ok(argument.$kind === "Input");
  const input = data.inputs[argument.Input];
  if (input?.$kind === "Pure") return "pure";
  if (input?.$kind === "UnresolvedObject")
    return `object:${hex(input.UnresolvedObject.objectId)}`;
  assert.ok(input?.$kind === "Object" && input.Object.$kind === "SharedObject");
  const { objectId, mutable } = input.Object.SharedObject;
  if (objectId === normalizeSuiAddress(SUI_CLOCK_OBJECT_ID)) return CLOCK;
  return `${mutable ? "shared-mut" : "shared"}:${hex(objectId)}`;
}

/** Every Move call `tx` makes, as `<package>::<module>::<function>` and argument descriptors. */
function calls(tx: Transaction): Call[] {
  const data = tx.getData();
  return data.commands.flatMap((command) => {
    if (command.$kind !== "MoveCall") return [];
    const call = command.MoveCall;
    return [
      {
        target: `${hex(call.package)}::${call.module}::${call.function}`,
        typeArguments: call.typeArguments,
        args: call.arguments.map((argument) => describe(data, argument)),
      },
    ];
  });
}

function only(tx: Transaction, target: string): Call {
  const found = calls(tx).filter((call) => call.target === target);
  assert.equal(found.length, 1, target);
  return found[0] as Call;
}

function targets(tx: Transaction): string[] {
  return calls(tx).map((call) => call.target);
}

/** A composition whose venue or vault step is another work package's stub. */
function pending(build: () => unknown): string | false {
  try {
    build();
    return false;
  } catch (error) {
    if (error instanceof Error && /^WP\d/.test(error.message))
      return error.message;
    throw error;
  }
}

const settings: PresaleSettings = {
  tokenSupply: 20_001n,
  burnable: false,
  tokenAllocationBps: 5_000n,
  liquidityTokenAllocationBps: 1_000n,
  recipientAllocations: [
    {
      recipient: {
        destination: "0xa110c",
        vestingTerms: {
          cliffDelayMs: 100n,
          periodDurationMs: 50n,
          periods: 4n,
        },
      },
      bps: 2_500n,
    },
    { recipient: { destination: "0xb110c", vestingTerms: null }, bps: 1_000n },
  ],
  participantVesting: null,
  raiseTarget: 1_000n,
  raiseAllocations: [
    { recipient: { destination: "0x5a1e", vestingTerms: null }, bps: 2_000n },
  ],
  commitmentDurationMs: 100n,
  liquidityWindowDurationMs: 604_800_000n,
  eligibility: openEligibility(5_000n, 2n, 500n),
  uncapped: {
    startsAfterMs: 50n,
    access: { kind: "anyone", maxParticipants: 4n, minCommitment: 250n },
  },
  hardCap: { startsAfterMs: 50n, closesWhenFilled: true },
  feeSplit: {
    routes: [
      { destination: { kind: "Owner" }, bps: 7_000n },
      { destination: { kind: "HolderRewards" }, bps: 3_000n },
    ],
  },
  partner,
};

test("createPresale with the vendor: prepare, new, setters, finalize, rates, share, cap", async () => {
  const lpCoin = await verifiedLpCoin(lp, "0xcf");
  const tx = ptb.createPresale({
    ...types,
    ...settings,
    venue: "aftermathDao",
    adminCap: "0xadc",
    lpCoin,
    treasuryCap: "0x7c",
    currency: shared("0xcc"),
    commitmentStartsAtMs: 1_000n,
    capRecipient: "0xc0ffee",
    protocolFees: {
      adminCapId: "0xa11",
      fees: {
        raiseBps: 300n,
        tokenBps: 500n,
        lpFeeMemeBps: 1_000n,
        lpFeeQuoteBps: 1_000n,
      },
    },
  });
  const presaleCalls = targets(tx).filter(
    (target) =>
      target.startsWith("0x5f::blast_presale::") || target.startsWith("0x7a"),
  );
  assert.deepEqual(presaleCalls, [
    "0x7a::blast_aftermath_dao_presale::prepare",
    "0x5f::blast_presale::new",
    "0x5f::blast_presale::set_supply",
    "0x5f::blast_presale::recipient_share",
    "0x5f::blast_presale::recipient_share",
    "0x5f::blast_presale::set_token_allocations",
    "0x5f::blast_presale::recipient_share",
    "0x5f::blast_presale::set_raise",
    "0x5f::blast_presale::set_windows",
    "0x5f::blast_presale::open_eligibility",
    "0x5f::blast_presale::set_eligibility",
    "0x5f::blast_presale::uncapped_for_anyone",
    "0x5f::blast_presale::set_uncapped_phase",
    "0x5f::blast_presale::set_hard_cap",
    "0x5f::blast_presale::set_fee_split",
    "0x5f::blast_presale::set_partner",
    "0x5f::blast_presale::finalize",
    "0x5f::blast_presale::set_protocol_fees",
    "0x5f::blast_presale::share",
  ]);

  const prepare = only(tx, "0x7a::blast_aftermath_dao_presale::prepare");
  assert.deepEqual(prepare.typeArguments, [
    lp,
    saleToken,
    quote,
    normalizeStructTag("0x5e::blast_presale_package::PackageWitness"),
  ]);
  assert.deepEqual(prepare.args, ["object:0xadc", "object:0xcf"]);
  const created = only(tx, "0x5f::blast_presale::new");
  assert.deepEqual(created.typeArguments, [saleToken, quote]);
  assert.deepEqual(created.args, [
    "object:0x7c",
    VERSION,
    "result:0",
    "shared:0x62",
    "shared:0x61",
  ]);
  assert.deepEqual(only(tx, "0x5f::blast_presale::set_partner").args, [
    "result:1",
    VERSION,
    "shared:0x62",
    "shared:0x9a27",
    CLOCK,
  ]);
  const finalize = only(tx, "0x5f::blast_presale::finalize");
  assert.deepEqual(finalize.args, [
    "result:1",
    VERSION,
    "shared-mut:0x63",
    "shared-mut:0xcc",
  ]);
  const finalizeIndex = tx
    .getData()
    .commands.findIndex(
      (command) =>
        command.$kind === "MoveCall" &&
        command.MoveCall.function === "finalize",
    );
  const rates = only(tx, "0x5f::blast_presale::set_protocol_fees");
  assert.equal(rates.args[0], `result:${finalizeIndex}:0`);
  assert.equal(rates.args[1], VERSION);
  assert.equal(rates.args[3], "shared:0x61");
  assert.equal(rates.args.length, 9);
  assert.equal(rates.args[8], CLOCK);
  assert.deepEqual(only(tx, "0x5f::blast_presale::share").args, [
    `result:${finalizeIndex}:0`,
    VERSION,
    "pure",
    CLOCK,
  ]);
  // The FeeAdmin witness is a core role, signed in through the admin ACL.
  const signIn = only(tx, "0xad::blast_acl::sign_in");
  assert.deepEqual(signIn.typeArguments, [
    normalizeStructTag("0xc0::blast_domain::FeeAdmin"),
  ]);
  // Core builds every rate, recipient, vesting term and the fee split.
  assert.ok(targets(tx).includes("0xc1::payout::vesting_terms"));
  assert.ok(targets(tx).includes("0xc1::fee_split::new"));
  const commands = tx.getData().commands;
  const transfer = commands.at(-1);
  assert.equal(transfer?.$kind, "TransferObjects");
  assert.deepEqual(
    transfer?.$kind === "TransferObjects" && transfer.TransferObjects.objects,
    [{ $kind: "NestedResult", NestedResult: [finalizeIndex, 1] }],
  );
});

test("createPresale refuses an unverified LP coin and a missing vendor", async () => {
  const lpCoin = await verifiedLpCoin(lp, "0xcf");
  const base = {
    ...types,
    ...settings,
    venue: "aftermathDao" as const,
    adminCap: "0xadc",
    treasuryCap: "0x7c",
    currency: shared("0xcc"),
    commitmentStartsAtMs: 0n,
    capRecipient: "0xc0ffee",
  };
  assert.throws(
    () =>
      ptb.createPresale({ ...base, lpCoin: { ...lpCoin } as typeof lpCoin }),
    /verifyAftermathLpCoin/,
  );
  const { aftermathDaoPresale: _, ...withoutVendor } = deployment;
  assert.throws(
    () =>
      new PresaleTransactions(withoutVendor).createPresale({ ...base, lpCoin }),
    /aftermathDaoPresale is required/,
  );
});

test("createPresale through a migrators venue starts with its prepare", (t) => {
  for (const venue of [
    {
      venue: "cetus" as const,
      cetus: { config: shared("0xce1"), pools: shared("0xce2") },
      tickSpacing: 60,
    },
    { venue: "bluefin" as const, tickSpacing: 60, feeRate: 3_000n },
  ]) {
    const build = () =>
      ptb.createPresale({
        ...types,
        ...settings,
        ...venue,
        treasuryCap: "0x7c",
        currency: shared("0xcc"),
        commitmentStartsAtMs: 0n,
        capRecipient: "0xc0ffee",
      });
    const stub = pending(build);
    if (stub) {
      t.skip(stub);
      continue;
    }
    const tx = build();
    assert.equal(targets(tx)[0], `0xd1::${venue.venue}::prepare`);
    assert.deepEqual(only(tx, "0x5f::blast_presale::new").args[2], "result:0");
  }
});

test("migrate through the vendor: settle, migrate, venue migrate, partner payout", () => {
  const tx = ptb.migrate({
    ...types,
    presale,
    venue: "aftermathDao",
    lpType: lp,
    poolCreation: shared("0xb00"),
    settle: true,
    partner,
  });
  assert.deepEqual(targets(tx), [
    "0x5f::blast_presale::settle",
    "0x5f::blast_presale::migrate",
    "0x7a::blast_aftermath_dao_presale::migrate",
    "0x5f::blast_presale::pay_protocol_fees_with_partner",
  ]);
  assert.deepEqual(only(tx, "0x5f::blast_presale::migrate").args, [
    "shared-mut:0xab",
    VERSION,
    "shared:0x7ea",
    CLOCK,
  ]);
  const venue = only(tx, "0x7a::blast_aftermath_dao_presale::migrate");
  assert.deepEqual(venue.typeArguments, [lp, saleToken, quote]);
  assert.deepEqual(venue.args, [
    "result:1",
    "shared-mut:0xb00",
    "shared-mut:0xaf1",
    "shared:0xaf2",
  ]);
  assert.deepEqual(
    only(tx, "0x5f::blast_presale::pay_protocol_fees_with_partner").args,
    ["shared-mut:0xab", VERSION, "shared:0x7ea", "shared:0x9a27"],
  );
  const unpartnered = ptb.migrate({
    ...types,
    presale,
    venue: "aftermathDao",
    lpType: lp,
    poolCreation: shared("0xb00"),
  });
  assert.deepEqual(targets(unpartnered), [
    "0x5f::blast_presale::migrate",
    "0x7a::blast_aftermath_dao_presale::migrate",
  ]);
});

test("migrate through a migrators venue redeems the presale's Migration", (t) => {
  for (const venue of [
    {
      venue: "cetus" as const,
      cetus: {
        config: shared("0xce1"),
        pools: shared("0xce2"),
        burnManager: shared("0xce3"),
      },
    },
    {
      venue: "bluefin" as const,
      currency: shared("0xcc"),
      quoteCurrency: shared("0xcd"),
      bluefinConfig: shared("0xbf"),
      creationFee: 1_000_000n,
    },
  ]) {
    const build = () => ptb.migrate({ ...types, presale, ...venue });
    const stub = pending(build);
    if (stub) {
      t.skip(stub);
      continue;
    }
    const tx = build();
    assert.deepEqual(targets(tx).slice(0, 2), [
      "0x5f::blast_presale::migrate",
      `0xd1::${venue.venue}::migrate`,
    ]);
  }
});

test("owner actions prove ownership with the PresaleCap first", (t) => {
  const owner = {
    ...types,
    presale,
    presaleCap: "0xcab",
    vault: shared("0xba"),
  };
  for (const build of [
    () => ptb.claimOwnerBalances({ ...owner, recipient: "0xc0ffee" }),
    () => ptb.scheduleFeeSplit({ ...owner, feeSplit: settings.feeSplit }),
    () => ptb.cancelFeeSplit(owner),
  ]) {
    const stub = pending(build);
    if (stub) {
      t.skip(stub);
      continue;
    }
    const tx = build();
    assert.equal(targets(tx)[0], "0x5f::blast_presale::prove_owner");
  }
  const proof = new Transaction();
  proof.add(ptb.call.proveOwner(owner));
  assert.deepEqual(only(proof, "0x5f::blast_presale::prove_owner").args, [
    "shared:0xab",
    VERSION,
    "object:0xcab",
  ]);
});

test("commits through each route and returns the change", () => {
  const allowlist = buildAllowlist([
    { wallet: "0xa11ce", walletCap: 500n },
    { wallet: "0xb0b", walletCap: 700n },
  ]);
  const proof = allowlist.proofs[1];
  assert.ok(proof);
  for (const [route, target, arity] of [
    ["open", "commit_open", 4],
    ["uncapped", "commit_uncapped", 4],
    ["allowlisted", "commit_allowlisted", 7],
  ] as const) {
    const tx = ptb.commit({
      ...types,
      presale,
      amount: 250n,
      recipient: "0xb0b",
      ...(route === "allowlisted" ? { route, allowlist: proof } : { route }),
    });
    const call = only(tx, `0x5f::blast_presale::${target}`);
    assert.equal(call.args.length, arity);
    assert.deepEqual(call.args.slice(0, 2), ["shared-mut:0xab", VERSION]);
    assert.equal(call.args.at(-1), CLOCK);
    assert.equal(tx.getData().commands.at(-1)?.$kind, "TransferObjects");
  }
  assert.throws(
    () =>
      ptb.call.commitAllowlisted({
        ...types,
        presale,
        quoteIn: { $kind: "GasCoin", GasCoin: true },
        allowlist: { ...proof, proof: ["00"] },
      }),
    /32 bytes/,
  );
});

test("sale calls take the presale mutably after its version", () => {
  const claim = ptb.claim({
    ...types,
    presale,
    participants: ["0xa11ce", "0xb0b"],
  });
  assert.deepEqual(
    calls(claim).map((call) => call.args),
    [
      ["shared-mut:0xab", VERSION, "pure", CLOCK],
      ["shared-mut:0xab", VERSION, "pure", CLOCK],
    ],
  );
  assert.throws(() => ptb.claim({ ...types, presale, participants: [] }));
  assert.deepEqual(
    only(ptb.settle({ ...types, presale }), "0x5f::blast_presale::settle").args,
    ["shared-mut:0xab", VERSION, CLOCK],
  );
  assert.deepEqual(
    only(
      ptb.cancelUnlaunched({ ...types, presale }),
      "0x5f::blast_presale::cancel_unlaunched",
    ).args,
    ["shared-mut:0xab", VERSION, CLOCK],
  );
  assert.deepEqual(
    only(
      ptb.destroyCap({ ...types, presale, presaleCap: "0xcab" }),
      "0x5f::blast_presale::destroy_cap",
    ).args,
    ["shared:0xab", "object:0xcab"],
  );
});

test("setProtocolFees signs in as FeeAdmin and checks each rate's ceiling", () => {
  const fees = {
    raiseBps: 1_000n,
    tokenBps: 1_000n,
    lpFeeMemeBps: 3_000n,
    lpFeeQuoteBps: 3_000n,
  };
  const tx = ptb.setProtocolFees({
    ...types,
    presale,
    adminCapId: "0xa11",
    fees,
  });
  const call = only(tx, "0x5f::blast_presale::set_protocol_fees");
  assert.deepEqual(call.args, [
    "shared-mut:0xab",
    VERSION,
    "result:0",
    "shared:0x61",
    "result:1",
    "result:2",
    "result:3",
    "result:4",
    CLOCK,
  ]);
  for (const key of Object.keys(fees) as (keyof typeof fees)[]) {
    assert.throws(() =>
      ptb.setProtocolFees({
        ...types,
        presale,
        adminCapId: "0xa11",
        fees: { ...fees, [key]: fees[key] + 1n },
      }),
    );
  }
});

test("creation and fee policy calls name their roles and arity", () => {
  const venue = normalizeStructTag("0xd0::cetus::Venue");
  const role = (tx: Transaction) =>
    only(tx, "0xad::blast_acl::sign_in").typeArguments[0];
  const cases: [Transaction, string, string, string[]][] = [
    [
      ptb.setQuoteAllowed({
        adminCapId: "0xa11",
        quoteType: quote,
        allowed: true,
      }),
      "set_quote_allowed",
      "ListingAdmin",
      ["shared-mut:0x62", VERSION, "result:0", "pure"],
    ],
    [
      ptb.scheduleVenue({ adminCapId: "0xa11", venueType: venue }),
      "schedule_venue",
      "VenueAdmin",
      ["shared-mut:0x62", VERSION, "result:0", CLOCK],
    ],
    [
      ptb.cancelVenue({ adminCapId: "0xa11", venueType: venue }),
      "cancel_venue",
      "CancelAdmin",
      ["shared-mut:0x62", VERSION, "result:0"],
    ],
    [
      ptb.removeVenue({ adminCapId: "0xa11", venueType: venue }),
      "remove_venue",
      "VenueAdmin",
      ["shared-mut:0x62", VERSION, "result:0"],
    ],
    [
      ptb.scheduleVenueDelay({ adminCapId: "0xa11", delayMs: 172_800_000n }),
      "schedule_venue_delay",
      "VenueAdmin",
      ["shared-mut:0x62", VERSION, "result:0", "pure", CLOCK],
    ],
    [
      ptb.cancelVenueDelay({ adminCapId: "0xa11" }),
      "cancel_venue_delay",
      "CancelAdmin",
      ["shared-mut:0x62", VERSION, "result:0"],
    ],
    [
      ptb.addPartner({ adminCapId: "0xa11", partner }),
      "add_partner",
      "FeeAdmin",
      ["shared-mut:0x62", VERSION, "result:0", "shared:0x9a27"],
    ],
    [
      ptb.removePartner({ adminCapId: "0xa11", partner }),
      "remove_partner",
      "FeeAdmin",
      ["shared-mut:0x62", VERSION, "result:0", "shared:0x9a27", CLOCK],
    ],
  ];
  for (const [tx, name, roleName, args] of cases) {
    const call = only(tx, `0x5f::creation_policy::${name}`);
    assert.deepEqual(call.args, args, name);
    assert.equal(
      role(tx),
      normalizeStructTag(`0xc0::blast_domain::${roleName}`),
    );
  }
  assert.deepEqual(
    only(
      ptb.applyVenue({ venueType: venue }),
      "0x5f::creation_policy::apply_venue",
    ),
    {
      target: "0x5f::creation_policy::apply_venue",
      typeArguments: [venue],
      args: ["shared-mut:0x62", VERSION, CLOCK],
    },
  );
  assert.deepEqual(
    only(ptb.applyVenueDelay(), "0x5f::creation_policy::apply_venue_delay")
      .args,
    ["shared-mut:0x62", VERSION, CLOCK],
  );
  for (const bad of [
    "u64",
    "vector<u8>",
    "0x2::object::ID",
    "0x1::option::Option<u64>",
  ]) {
    assert.throws(() =>
      ptb.scheduleVenue({ adminCapId: "0xa11", venueType: bad }),
    );
  }

  const fees = {
    raiseBps: 200n,
    tokenBps: 100n,
    lpFeeMemeBps: 1_500n,
    lpFeeQuoteBps: 1_500n,
  };
  const schedule = ptb.scheduleFees({ adminCapId: "0xa11", fees, delayMs: 0n });
  assert.equal(
    only(schedule, "0x5f::fee_policy::schedule_fees").args.length,
    9,
  );
  assert.equal(
    role(schedule),
    normalizeStructTag("0xc0::blast_domain::FeeAdmin"),
  );
  assert.deepEqual(only(ptb.applyFees(), "0x5f::fee_policy::apply_fees").args, [
    "shared-mut:0x61",
    VERSION,
    CLOCK,
  ]);
  assert.deepEqual(
    only(
      ptb.cancelFees({ adminCapId: "0xa11" }),
      "0x5f::fee_policy::cancel_fees",
    ).args,
    ["shared-mut:0x61", VERSION, "result:0"],
  );
});

test("unpause signs in as UnpauseAdmin<BLAST_PRESALE_PACKAGE>", () => {
  const tx = ptb.unpause({ adminCapId: "0xa11", bits: 7 });
  assert.deepEqual(only(tx, "0xad::blast_acl::sign_in").typeArguments, [
    normalizeStructTag(
      "0xad::package_admin::UnpauseAdmin<0x5e::blast_presale_package::BLAST_PRESALE_PACKAGE>",
    ),
  ]);
  assert.deepEqual(only(tx, "0x5f::creation_policy::unpause").args, [
    "shared:0x62",
    "shared-mut:0x64",
    "result:0",
    "shared:0x65",
    "shared:0x61",
    "pure",
  ]);
  assert.deepEqual(PRESALE_PAUSE_BITS, { Create: 1, Commit: 2, Migrate: 4 });
  for (const bits of [0, 8, 1.5]) {
    assert.throws(() => ptb.unpause({ adminCapId: "0xa11", bits }));
  }
});

test("configureNow and armNotices sign in once per role", () => {
  const vendorVenue = normalizeStructTag(
    "0x7a::blast_aftermath_dao_presale::Venue",
  );
  const configure = ptb.configureNow({
    adminCapId: "0xa11",
    fees: {
      raiseBps: 200n,
      tokenBps: 100n,
      lpFeeMemeBps: 1_500n,
      lpFeeQuoteBps: 1_500n,
    },
    quotes: [{ quoteType: quote, allowed: true }],
    venues: [normalizeStructTag("0xd0::cetus::Venue"), vendorVenue],
    partners: [partner],
  });
  assert.deepEqual(
    targets(configure).filter((target) => !target.startsWith("0xc1::")),
    [
      "0xad::blast_acl::sign_in",
      "0x5f::fee_policy::schedule_fees",
      "0x5f::fee_policy::apply_fees",
      "0xad::blast_acl::sign_in",
      "0x5f::creation_policy::set_quote_allowed",
      "0xad::blast_acl::sign_in",
      "0x5f::creation_policy::schedule_venue",
      "0x5f::creation_policy::apply_venue",
      "0x5f::creation_policy::schedule_venue",
      "0x5f::creation_policy::apply_venue",
      "0x5f::creation_policy::add_partner",
    ],
  );
  const arm = ptb.armNotices({
    adminCapId: "0xa11",
    venueDelayMs: 172_800_000n,
  });
  assert.deepEqual(targets(arm), [
    "0xad::blast_acl::sign_in",
    "0x5f::creation_policy::schedule_venue_delay",
    "0x5f::creation_policy::apply_venue_delay",
  ]);
});

test("PresaleCalls names the package's OTW and witness", () => {
  const presaleCalls = new PresaleCalls(deployment);
  assert.equal(
    presaleCalls.otw,
    normalizeStructTag("0x5e::blast_presale_package::BLAST_PRESALE_PACKAGE"),
  );
  assert.equal(
    presaleCalls.packageWitnessType,
    normalizeStructTag("0x5e::blast_presale_package::PackageWitness"),
  );
  assert.equal(
    ptb.aftermathDaoPresale?.venueType,
    normalizeStructTag("0x7a::blast_aftermath_dao_presale::Venue"),
  );
});
