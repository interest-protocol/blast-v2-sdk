import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiObjectId,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";

import {
  buildRewardManifest,
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
  admin: { packageId: "0xad", acl: shared("0xac", false) },
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
  uncapped: uncappedForAnyone(50n, 4n, 250n, true),
  feeRecipients: [{ recipient: "0xc0ffee", bps: 7_000n }],
  rewardsFeeBps: 3_000n,
};
const cetus = {
  cetusConfig: shared("0x70", false),
  cetusPools: shared("0x71", true),
};

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

test("creates, shares, and keeps the cap of a Cetus presale in one PTB", () => {
  const ptb = tx.createCetusPresale({
    ...terms,
    ...cetus,
    tickSpacing: 200,
    capRecipient: "0xc0",
  });
  assert.deepEqual(moveFunctions(ptb), [
    "blast_presale::recipient_allocation",
    "blast_presale::recipient_allocation",
    "blast_presale::recipient_allocation",
    "blast_presale::open_eligibility",
    "blast_presale::uncapped_for_anyone",
    "option::some",
    "blast_presale::fee_recipient",
    "cetus::new",
    "blast_presale::share",
  ]);
  const created = moveCall(ptb, "cetus::new");
  assert.deepEqual(created.typeArguments, [memeA, sui]);
  assert.deepEqual(argumentKinds(ptb, created), [
    "object:0x7c",
    "shared-mut:0xcc",
    "pure",
    "pure",
    "pure",
    `Result:${commandIndexOf(ptb, "MakeMoveVec", 0)}`,
    "pure",
    "pure",
    `Result:${commandIndexOf(ptb, "MakeMoveVec", 1)}`,
    "pure",
    "pure",
    `Result:${commandIndex(ptb, "blast_presale::open_eligibility")}`,
    `Result:${commandIndex(ptb, "option::some")}`,
    `Result:${commandIndexOf(ptb, "MakeMoveVec", 2)}`,
    "pure",
    "shared-mut:0x60",
    "shared:0x70",
    "shared-mut:0x71",
    "pure",
  ]);
  const share = moveCall(ptb, "blast_presale::share");
  assert.deepEqual(argumentKinds(ptb, share), [
    `NestedResult:${commandIndex(ptb, "cetus::new")}:0`,
    CLOCK,
  ]);
  assert.equal(ptb.getData().commands.at(-1)?.$kind, "TransferObjects");
  const vectors = ptb
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MakeMoveVec" ? [command.MakeMoveVec.type] : [],
    );
  assert.deepEqual(vectors, [
    normalizeStructTag("0x5e::blast_presale::RecipientAllocation"),
    normalizeStructTag("0x5e::blast_presale::RecipientAllocation"),
    normalizeStructTag("0x5e::blast_presale::FeeRecipient"),
  ]);
});

test("creates a Bluefin presale without an uncapped phase", () => {
  const ptb = tx.createBluefinPresale({
    ...terms,
    uncapped: null,
    eligibility: {
      kind: "allowlisted",
      root: "11".repeat(32),
      leafCount: 2n,
    },
    tickSpacing: 60,
    feeRate: 3_000n,
    capRecipient: "0xc0",
  });
  assert.ok(
    moveFunctions(ptb).includes("blast_presale::allowlisted_eligibility"),
  );
  const none = moveCall(ptb, "option::none");
  assert.deepEqual(none.typeArguments, [
    normalizeStructTag("0x5e::blast_presale::UncappedPhase"),
  ]);
  const created = moveCall(ptb, "bluefin::new");
  assert.equal(created.arguments.length, abiArity("bluefin", "new"));
  assert.deepEqual(argumentKinds(ptb, created).slice(-2), ["pure", "pure"]);
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
      ["shared-mut:0xab", "pure"],
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
      ["shared-mut:0xba", "shared:0x70", "shared:0x72", "shared-mut:0x90"],
    ],
    [
      tx.collectBluefinFees({
        ...types,
        vault,
        bluefinConfig: shared("0x80", false),
        pool: shared("0x90", true),
      }),
      "bluefin::collect_fees",
      ["shared-mut:0xba", "shared:0x80", "shared-mut:0x90", CLOCK],
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
      ["shared-mut:0xba", "Result:0", ...Array(9).fill("pure"), CLOCK],
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
  ];
  for (const [ptb, name, kinds] of cases) {
    const call = moveCall(ptb, name);
    const [module, fn] = name.split("::") as [string, string];
    assert.deepEqual(argumentKinds(ptb, call), kinds, name);
    assert.equal(call.arguments.length, abiArity(module, fn), name);
    assert.equal(call.typeArguments.length, abiTypeArity(module, fn), name);
  }
});

test("signs in as the presale RewardsAdmin through blast_acl", () => {
  const ptb = tx.publishHolderRewardRound({
    ...types,
    vault: shared("0xba", true),
    adminCapId: "0xadc",
    manifest: buildRewardManifest({
      vaultId: "0xba",
      number: 0n,
      startCheckpoint: 1n,
      endCheckpoint: 2n,
      allocations: [{ beneficiary: "0xb0b", memeAmount: 1n, quoteAmount: 0n }],
      leafDomain: PRESALE_REWARD_LEAF_DOMAIN,
    }),
    claimDeadlineMs: 9_000n,
  });
  const signIn = moveCall(ptb, "blast_acl::sign_in");
  assert.equal(signIn.package, normalizeSuiObjectId("0xad"));
  assert.deepEqual(signIn.typeArguments, [
    normalizeStructTag("0x5e::blast_presale_domain::RewardsAdmin"),
  ]);
  assert.deepEqual(argumentKinds(ptb, signIn), ["shared:0xac", "object:0xadc"]);
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
      adminWitness: { $kind: "Input", Input: 0, type: "object" },
      manifest,
      claimDeadlineMs: 1n,
    });
  assert.throws(() => publish(buildRewardManifest(options)), /root mismatch/);
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
