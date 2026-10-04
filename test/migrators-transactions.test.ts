import assert from "node:assert/strict";
import test from "node:test";

import type { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiObjectId, SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import {
  buildRewardManifest,
  MIGRATOR_REWARD_LEAF_DOMAIN,
} from "../src/holder-rewards/allocations.ts";
import type { SharedObjectReference } from "../src/lib/sui.ts";
import type { MigratorsDeployment } from "../src/migrators/transactions.ts";
import {
  MigratorCalls,
  MigratorTransactions,
} from "../src/migrators/transactions.ts";

function shared<const Mutable extends boolean>(
  objectId: string,
  initialSharedVersion: number | string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion, mutable };
}

const deployment: MigratorsDeployment = {
  packageId: "0x321",
  originalPackageId: "0x320",
  launchpad: {
    packageId: "0x123",
    originalPackageId: "0x122",
    adminPackageId: "0xad",
    partnersPackageId: "0xbe",
    timelockPackageId: "0x7e",
    packageVersion: shared("0x2", "10", false),
    launchConfig: shared("0x3", "11", false),
    runtimeConfig: shared("0x4", "12", false),
    acl: shared("0x5", "13", false),
  },
  migratorsVersion: shared("0x61", "15", false),
  lpFeePolicy: shared("0x40", "18", false),
  venueConfig: shared("0x60", "14", false),
};
const types = {
  memeType: "0xa::meme::MEME",
  quoteType: "0x2::sui::SUI",
};
const lpFeeSplit = {
  creatorBps: 5_000n,
  autoLpBps: 2_000n,
  rewardsBps: 1_000n,
  burnBps: 1_000n,
  recipients: [{ destination: "0xf", bps: 1_000n }],
};
const settings = {
  virtualQuote: 1_000n,
  graduationTarget: 3_000n,
  creationFee: 0n,
  allocationPlan: {
    curveMemeBps: 8_000n,
    lpMemeBps: 1_900n,
    lpQuoteBps: 9_900n,
    recipients: [],
  },
  lpFeeSplit,
};
const cetus = {
  cetusConfig: shared("0x70", "30", false),
  cetusPools: shared("0x71", "31", true),
};
const CLOCK = `shared:${SUI_CLOCK_OBJECT_ID}`;
const meme = normalizedType(types.memeType);
const quote = normalizedType(types.quoteType);
/** Cetus routes name the pool's coins in Cetus order after Meme and Quote (contracts ADR 0100). */
const cetusTypeArguments = {
  a: [meme, quote, meme, quote],
  b: [meme, quote, quote, meme],
};

test("starts, configures, finalizes, and shares a Cetus launch in one PTB", () => {
  const tx = new MigratorTransactions(deployment).createCetusLaunch({
    ...types,
    ...settings,
    ...cetus,
    ticket: "0xb",
    memeCurrency: shared("0xd", "22", true),
    tickSpacing: 200,
    preShareBuy: { quoteAmount: 100n, minMemeOut: 1n, recipient: "0xe" },
  });

  const launchCalls = moveFunctions(tx).filter(
    (name) => name.startsWith("launch::") || name.startsWith("cetus::"),
  );
  assert.deepEqual(launchCalls, [
    "cetus::new",
    "launch::set_virtual_quote",
    "launch::set_graduation_target",
    "launch::set_allocation_plan",
    "launch::set_lp_fee_split",
    "launch::finalize",
    "launch::buy",
    "launch::share",
  ]);
  const start = moveCall(tx, "cetus::new");
  assert.equal(start.package, normalizeSuiObjectId("0x321"));
  assert.deepEqual(start.typeArguments.length, 2);
  assert.deepEqual(argumentKinds(tx, start), [
    "object:0xb",
    "shared:0x61",
    "shared:0x2",
    "shared:0x3",
    "shared-mut:0x60",
    "shared:0x70",
    "shared-mut:0x71",
    "pure",
  ]);
  const finalize = moveCall(tx, "launch::finalize");
  assert.equal(finalize.package, normalizeSuiObjectId("0x123"));
  assert.deepEqual(argumentKinds(tx, finalize).slice(0, 3), [
    `Result:${commandIndex(tx, "cetus::new")}`,
    "shared-mut:0xd",
    "shared:0x3",
  ]);
  assert.equal(finalize.arguments.length, 4);
  assert.equal(tx.getData().commands.at(-1)?.$kind, "TransferObjects");
});

test("starts a Bluefin launch at the creator's tier", () => {
  const tx = new MigratorTransactions(deployment).createBluefinLaunch({
    ...types,
    ...settings,
    ticket: "0xb",
    memeCurrency: shared("0xd", "22", true),
    tickSpacing: 200,
    feeRate: 10_000n,
    openingRoundMs: 60_000n,
    partner: shared("0x9a", "30", false),
    creatorBid: { quoteAmount: 50n },
  });
  assert.deepEqual(
    moveFunctions(tx)
      .filter((name) => name.startsWith("launch::"))
      .slice(-5),
    [
      "launch::set_opening_round",
      "launch::set_partner",
      "launch::finalize",
      "launch::join_opening_round",
      "launch::share",
    ],
  );

  const start = moveCall(tx, "bluefin::new");
  assert.deepEqual(argumentKinds(tx, start), [
    "object:0xb",
    "shared:0x61",
    "shared:0x2",
    "shared:0x3",
    "pure",
    "pure",
  ]);
  assert.equal(moveFunctions(tx).at(-1), "launch::share");
  assert.throws(
    () =>
      new MigratorCalls(deployment).newBluefinLaunch({
        ...types,
        ticket: "0xb",
        tickSpacing: 2 ** 32,
        feeRate: 1n,
      }),
    /tickSpacing must be a u32/,
  );
});

test("migrates Cetus with the reserved tier and the LP Burn manager", () => {
  for (const memeSide of ["a", "b"] as const) {
    const tx = new MigratorTransactions(deployment).migrateCetus({
      ...types,
      ...cetus,
      memeSide,
      launch: shared("0xc", "20", true),
      memeCurrency: shared("0xd", "22", true),
      burnManager: shared("0x72", "32", true),
    });
    const call = moveCall(tx, "cetus::migrate");
    assert.deepEqual(call.typeArguments, cetusTypeArguments[memeSide]);
    assert.deepEqual(argumentKinds(tx, call), [
      "shared-mut:0xc",
      "shared:0x61",
      "shared:0x2",
      "shared-mut:0xd",
      "shared:0x60",
      "shared:0x70",
      "shared-mut:0x71",
      "shared-mut:0x72",
      CLOCK,
    ]);
  }
});

test("migrates Bluefin and pays its SUI pool-creation fee", () => {
  const tx = new MigratorTransactions(deployment).migrateBluefin({
    ...types,
    launch: shared("0xc", "20", true),
    memeCurrency: shared("0xd", "22", true),
    quoteCurrency: shared("0xe", "23", false),
    bluefinConfig: shared("0x80", "40", true),
    creationFee: 5_000_000n,
  });

  assert.equal(tx.getData().commands[0]?.$kind, "$Intent");
  const call = moveCall(tx, "bluefin::migrate");
  assert.deepEqual(argumentKinds(tx, call), [
    "shared-mut:0xc",
    "shared:0x61",
    "shared:0x2",
    "shared-mut:0xd",
    "shared:0xe",
    "shared-mut:0x80",
    "Result:0",
    CLOCK,
  ]);
});

test("collects fees permissionlessly with the live LP-fee policy", () => {
  const sdk = new MigratorTransactions(deployment);
  const cetusTx = sdk.collectCetusFees({
    ...types,
    cetusConfig: cetus.cetusConfig,
    memeSide: "b",
    vault: shared("0xc", "20", true),
    memeCurrency: shared("0xd", "22", true),
    burnManager: shared("0x72", "32", false),
    pool: shared("0x73", "33", true),
  });
  const collect = moveCall(cetusTx, "cetus::collect_fees");
  assert.deepEqual(collect.typeArguments, cetusTypeArguments.b);
  assert.deepEqual(argumentKinds(cetusTx, collect), [
    "shared-mut:0xc",
    "shared:0x61",
    "shared:0x40",
    "shared-mut:0xd",
    "shared:0x70",
    "shared:0x72",
    "shared-mut:0x73",
    CLOCK,
  ]);

  const bluefinTx = sdk.collectBluefinFees({
    ...types,
    vault: shared("0xc", "20", true),
    memeCurrency: shared("0xd", "22", true),
    bluefinConfig: shared("0x80", "40", false),
    pool: shared("0x81", "41", true),
  });
  assert.deepEqual(
    argumentKinds(bluefinTx, moveCall(bluefinTx, "bluefin::collect_fees")),
    [
      "shared-mut:0xc",
      "shared:0x61",
      "shared:0x40",
      "shared-mut:0xd",
      "shared:0x80",
      "shared-mut:0x81",
      CLOCK,
    ],
  );
});

test("settles and updates the fee split under the live curve-fee cap", () => {
  const sdk = new MigratorTransactions(deployment);
  const tx = sdk.settleAndUpdateCetusFeeSplit({
    ...types,
    cetusConfig: cetus.cetusConfig,
    memeSide: "a",
    vault: shared("0xc", "20", true),
    launch: shared("0x9", "19", false),
    curveFeeCapId: "0xcf",
    memeCurrency: shared("0xd", "22", true),
    burnManager: shared("0x72", "32", false),
    pool: shared("0x73", "33", true),
    feeSplit: lpFeeSplit,
  });
  const call = moveCall(tx, "cetus::settle_and_update_fee_split");
  assert.deepEqual(call.typeArguments, cetusTypeArguments.a);
  assert.deepEqual(argumentKinds(tx, call), [
    "shared-mut:0xc",
    "shared:0x61",
    "shared:0x40",
    "shared:0x9",
    "object:0xcf",
    "shared-mut:0xd",
    "shared:0x70",
    "shared:0x72",
    "shared-mut:0x73",
    `Result:${commandIndex(tx, "allocation::fee_split")}`,
    CLOCK,
  ]);
  const feeSplit = moveCall(tx, "allocation::fee_split");
  assert.equal(feeSplit.package, normalizeSuiObjectId("0x123"));

  const bluefinTx = sdk.settleAndUpdateBluefinFeeSplit({
    ...types,
    vault: shared("0xc", "20", true),
    launch: shared("0x9", "19", false),
    curveFeeCapId: "0xcf",
    memeCurrency: shared("0xd", "22", true),
    bluefinConfig: shared("0x80", "40", false),
    pool: shared("0x81", "41", true),
    feeSplit: lpFeeSplit,
  });
  assert.ok(
    moveFunctions(bluefinTx).includes("bluefin::settle_and_update_fee_split"),
  );
});

test("buys back and burns under admin sign-in with a minimum Meme out", () => {
  const sdk = new MigratorTransactions(deployment);
  const cetusTx = sdk.buybackAndBurnCetus({
    ...types,
    cetusConfig: cetus.cetusConfig,
    memeSide: "b",
    vault: shared("0xc", "20", true),
    adminCapId: "0xad1",
    memeCurrency: shared("0xd", "22", true),
    pool: shared("0x73", "33", true),
    minMemeOut: 5n,
  });
  assert.deepEqual(moveFunctions(cetusTx), [
    "blast_acl::sign_in",
    "cetus::buyback_and_burn",
  ]);
  const buyback = moveCall(cetusTx, "cetus::buyback_and_burn");
  assert.deepEqual(buyback.typeArguments, cetusTypeArguments.b);
  assert.deepEqual(argumentKinds(cetusTx, buyback), [
    "shared-mut:0xc",
    "shared:0x61",
    `Result:${commandIndex(cetusTx, "blast_acl::sign_in")}`,
    "shared-mut:0xd",
    "shared:0x70",
    "shared-mut:0x73",
    "pure",
    CLOCK,
  ]);

  const bluefinTx = sdk.buybackAndBurnBluefin({
    ...types,
    vault: shared("0xc", "20", true),
    adminCapId: "0xad1",
    memeCurrency: shared("0xd", "22", true),
    bluefinConfig: shared("0x80", "40", false),
    pool: shared("0x81", "41", true),
    minMemeOut: 5n,
  });
  assert.deepEqual(
    argumentKinds(bluefinTx, moveCall(bluefinTx, "bluefin::buyback_and_burn")),
    [
      "shared-mut:0xc",
      "shared:0x61",
      `Result:${commandIndex(bluefinTx, "blast_acl::sign_in")}`,
      "shared-mut:0xd",
      "shared:0x80",
      "shared-mut:0x81",
      "pure",
      CLOCK,
    ],
  );
  assert.throws(
    () =>
      sdk.buybackAndBurnBluefin({
        ...types,
        vault: shared("0xc", "20", true),
        adminCapId: "0xad1",
        memeCurrency: shared("0xd", "22", true),
        bluefinConfig: shared("0x80", "40", false),
        pool: shared("0x81", "41", true),
        minMemeOut: -1n,
      }),
    /u64/,
  );
});

test("signs in with the one role each migrators administrator action takes", () => {
  const sdk = new MigratorTransactions(deployment);
  const role = (tx: Transaction) =>
    moveCall(tx, "blast_acl::sign_in").typeArguments[0]?.split("::").at(-1);
  const vault = shared("0xc", "20", true);
  assert.equal(
    role(
      sdk.claimProtocolFees({
        ...types,
        vault,
        adminCapId: "0x1",
        recipient: "0xe",
      }),
    ),
    "TreasuryAdmin",
  );
  assert.equal(
    role(
      sdk.setLpFeeProtocolDestination({
        adminCapId: "0x1",
        destination: "0xb",
      }),
    ),
    "TreasuryAdmin",
  );
  assert.equal(
    role(
      sdk.setLpFeeDefaultShares({
        adminCapId: "0x1",
        memeBps: 1n,
        quoteBps: 1n,
      }),
    ),
    "FeeAdmin",
  );
  assert.equal(
    role(
      sdk.setLpFeeCoinShares({
        memeType: types.memeType,
        adminCapId: "0x1",
        memeBps: 1n,
        quoteBps: 1n,
      }),
    ),
    "FeeAdmin",
  );
  assert.equal(
    role(
      sdk.clearLpFeeCoinShares({ memeType: types.memeType, adminCapId: "0x1" }),
    ),
    "FeeAdmin",
  );
  assert.equal(
    role(
      sdk.buybackAndBurnBluefin({
        ...types,
        vault,
        adminCapId: "0x1",
        memeCurrency: shared("0xd", "22", true),
        bluefinConfig: shared("0x80", "40", false),
        pool: shared("0x81", "41", true),
        minMemeOut: 1n,
      }),
    ),
    "BuybackAdmin",
  );
  const manifest = buildRewardManifest({
    vaultId: "0xc",
    number: 0n,
    startCheckpoint: 1n,
    endCheckpoint: 2n,
    allocations: [{ beneficiary: "0xa", memeAmount: 1n, quoteAmount: 0n }],
    leafDomain: MIGRATOR_REWARD_LEAF_DOMAIN,
  });
  assert.equal(
    role(
      sdk.publishHolderRewardRound({
        ...types,
        vault,
        adminCapId: "0x1",
        manifest,
      }),
    ),
    "RewardsAdmin",
  );
  assert.equal(
    moveCall(
      sdk.setLpFeeDefaultShares({
        adminCapId: "0x1",
        memeBps: 1n,
        quoteBps: 1n,
      }),
      "blast_acl::sign_in",
    ).typeArguments[0],
    `${normalizeSuiObjectId("0x122")}::blast_fun_domain::FeeAdmin`,
  );
});

test("claims creator LP fees with the launch's live curve-fee cap", () => {
  const tx = new MigratorTransactions(deployment).claimCreatorFees({
    ...types,
    vault: shared("0xc", "20", true),
    launch: shared("0x9", "19", false),
    curveFeeCapId: "0xcf",
    recipient: "0xe",
  });
  assert.deepEqual(
    argumentKinds(tx, moveCall(tx, "vault::claim_creator_fees")),
    ["shared-mut:0xc", "shared:0x61", "shared:0x9", "object:0xcf"],
  );
  assert.equal(transferObjectCount(tx), 2);
});

test("composes admin sign-in with residual claims and LP-fee policy changes", () => {
  const sdk = new MigratorTransactions(deployment);
  const claim = sdk.claimProtocolFees({
    ...types,
    vault: shared("0xc", "20", true),
    adminCapId: "0xad1",
    recipient: "0xe",
  });
  assert.deepEqual(moveFunctions(claim), [
    "blast_acl::sign_in",
    "vault::claim_protocol_fees",
  ]);

  const cases = [
    [
      "set_default_shares",
      sdk.setLpFeeDefaultShares({
        adminCapId: "0xad1",
        memeBps: 100n,
        quoteBps: 200n,
      }),
      [],
    ],
    [
      "set_coin_shares",
      sdk.setLpFeeCoinShares({
        memeType: types.memeType,
        adminCapId: "0xad1",
        memeBps: 100n,
        quoteBps: 200n,
      }),
      [normalizedType(types.memeType)],
    ],
    [
      "clear_coin_shares",
      sdk.clearLpFeeCoinShares({
        memeType: types.memeType,
        adminCapId: "0xad1",
      }),
      [normalizedType(types.memeType)],
    ],
    [
      "set_protocol_destination",
      sdk.setLpFeeProtocolDestination({
        adminCapId: "0xad1",
        destination: "0xb",
      }),
      [],
    ],
  ] as const;
  for (const [functionName, tx, typeArguments] of cases) {
    const call = moveCall(tx, `lp_fee_policy::${functionName}`);
    assert.deepEqual(call.typeArguments, typeArguments);
    const kinds = argumentKinds(tx, call);
    assert.deepEqual(kinds.slice(0, 3), [
      "shared-mut:0x40",
      "shared:0x61",
      `Result:${commandIndex(tx, "blast_acl::sign_in")}`,
    ]);
  }
  assert.throws(
    () =>
      sdk.setLpFeeDefaultShares({
        adminCapId: "0xad1",
        memeBps: 10_001n,
        quoteBps: 0n,
      }),
    /10,000 basis points/,
  );
});

test("publishes a holder-reward round and relays its claims", () => {
  const vault = shared("0xd", "20", true);
  const manifest = buildRewardManifest({
    vaultId: "0xd",
    number: 0n,
    startCheckpoint: 10n,
    endCheckpoint: 20n,
    allocations: [
      { beneficiary: "0xa", memeAmount: 10n, quoteAmount: 20n },
      { beneficiary: "0xb", memeAmount: 30n, quoteAmount: 40n },
      { beneficiary: "0xc", memeAmount: 50n, quoteAmount: 60n },
    ],
    leafDomain: MIGRATOR_REWARD_LEAF_DOMAIN,
  });
  const sdk = new MigratorTransactions(deployment);
  const publish = sdk.publishHolderRewardRound({
    ...types,
    vault,
    adminCapId: "0xad1",
    manifest,
  });
  const call = moveCall(publish, "blast_holder_rewards::publish_round");
  assert.deepEqual(argumentKinds(publish, call).slice(0, 3), [
    "shared-mut:0xd",
    "shared:0x61",
    `Result:${commandIndex(publish, "blast_acl::sign_in")}`,
  ]);
  assert.equal(call.arguments.length, 11);
  assert.throws(
    () =>
      sdk.publishHolderRewardRound({
        ...types,
        vault: shared("0xe", "20", true),
        adminCapId: "0xad1",
        manifest,
      }),
    /another vault/,
  );

  const relay = sdk.claimHolderRewards({
    ...types,
    round: shared("0x50", "30", true),
    allocations: manifest.allocations,
  });
  assert.deepEqual(moveFunctions(relay), [
    "blast_holder_rewards::claim",
    "blast_holder_rewards::claim",
    "blast_holder_rewards::claim",
  ]);
  const claim = moveCalls(relay)[0];
  assert.ok(claim);
  assert.deepEqual(argumentKinds(relay, claim), [
    "shared-mut:0x50",
    "shared:0x61",
    "pure",
    "pure",
    "pure",
    "pure",
    "pure",
  ]);
});

function moveFunctions(tx: Transaction): string[] {
  return moveCalls(tx).map((call) => `${call.module}::${call.function}`);
}

function moveCalls(tx: Transaction) {
  return tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall] : [],
    );
}

function commandIndex(tx: Transaction, name: string): number {
  return tx
    .getData()
    .commands.findIndex(
      (command) =>
        command.$kind === "MoveCall" &&
        `${command.MoveCall.module}::${command.MoveCall.function}` === name,
    );
}

function moveCall(tx: Transaction, name: string) {
  const command = tx.getData().commands[commandIndex(tx, name)];
  assert.ok(command?.$kind === "MoveCall", `missing ${name}`);
  return command.MoveCall;
}

function argumentKinds(
  tx: Transaction,
  call: ReturnType<typeof moveCall>,
): string[] {
  return call.arguments.map((argument) => {
    if (argument.$kind === "Result") return `Result:${argument.Result}`;
    if (argument.$kind !== "Input") return argument.$kind;
    return describeInput(tx.getData().inputs[argument.Input]);
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
  if (reference.objectId === SUI_CLOCK_OBJECT_ID) {
    return `shared:${SUI_CLOCK_OBJECT_ID}`;
  }
  const prefix = reference.mutable ? "shared-mut" : "shared";
  return `${prefix}:0x${BigInt(reference.objectId).toString(16)}`;
}

function transferObjectCount(tx: Transaction): number {
  const transfer = tx.getData().commands.at(-1);
  return transfer?.$kind === "TransferObjects"
    ? transfer.TransferObjects.objects.length
    : 0;
}

function normalizedType(type: string): string {
  return type.replace(
    /^0x([0-9a-f]+)::/,
    (_match, address: string) => `0x${address.padStart(64, "0")}::`,
  );
}
