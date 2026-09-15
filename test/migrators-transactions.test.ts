import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "@mysten/sui/transactions";
import type { SharedObjectReference } from "../src/lib/sui.ts";
import type {
  MigratorsDeployment,
  ReceivingCoinReference,
} from "../src/migrators/transactions.ts";
import {
  AFTERMATH_MAX_DAO_FEE_COINS_PER_BATCH,
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

function receiving(objectId: string): ReceivingCoinReference {
  return {
    objectId,
    version: "1",
    digest: "11111111111111111111111111111111",
  };
}

const deployment: MigratorsDeployment = {
  packageId: "0x321",
  originalPackageId: "0x320",
  launchpad: {
    packageId: "0x123",
    originalPackageId: "0x122",
    packageVersion: shared("0x2", "10", false),
    launchConfig: shared("0x3", "11", false),
    runtimeConfig: shared("0x4", "12", false),
    protocolAuthority: shared("0x5", "13", false),
  },
  migratorsVersion: shared("0x61", "15", false),
  lpFeePolicy: shared("0x40", "18", false),
  venueConfig: shared("0x60", "14", false),
};
const types = {
  memeType: "0xa::meme::MEME",
  quoteType: "0x2::sui::SUI",
};

test("exposes composable creator and protocol LP-fee calls", () => {
  const calls = new MigratorCalls(deployment);
  const creatorTx = new Transaction();
  creatorTx.add(
    calls.claimCreatorFees({
      ...types,
      vault: shared("0xc", "20", true),
      lpFeeCap: "0xd",
    }),
  );
  assert.deepEqual(moveFunctions(creatorTx), ["vault::claim_creator_fees"]);
  assert.deepEqual(moveArgumentKinds(creatorTx, 0), [
    "shared:0xc",
    "shared:0x61",
    "object:0xd",
  ]);

  const protocolTx = new Transaction();
  const witness = protocolTx.add(calls.signIn({ adminCap: "0xe" }));
  protocolTx.add(
    calls.claimProtocolFees({
      ...types,
      vault: shared("0xc", "20", true),
      adminWitness: witness,
    }),
  );
  assert.deepEqual(moveFunctions(protocolTx), [
    "acl::sign_in",
    "vault::claim_protocol_fees",
  ]);
  assert.deepEqual(moveArgumentKinds(protocolTx, 1), [
    "shared:0xc",
    "shared:0x61",
    "Result",
  ]);
});

test("signs in and issues a revocable LP-fee cap to a recipient", () => {
  const sdk = new MigratorTransactions(deployment);
  const tx = sdk.issueLpFeeCap({
    ...types,
    vault: shared("0xc", "20", true),
    launch: shared("0x10", "30", false),
    adminCapId: "0xe",
    recipient: "0xf",
  });

  assert.deepEqual(moveFunctions(tx), [
    "acl::sign_in",
    "vault::issue_lp_fee_cap",
  ]);
  assert.deepEqual(moveArgumentKinds(tx, 1), [
    "shared:0xc",
    "shared:0x61",
    "shared:0x10",
    "Result",
    "pure",
  ]);
  assert.equal(tx.getData().commands.length, 2);
});

test("claims the migration-born LP-fee cap with the live curve-fee cap", () => {
  const sdk = new MigratorTransactions(deployment);
  const tx = sdk.claimLpFeeCap({
    ...types,
    vault: shared("0xc", "20", true),
    launch: shared("0x10", "30", false),
    curveFeeCapId: "0xd",
    recipient: "0xf",
  });

  assert.deepEqual(moveFunctions(tx), ["vault::claim_lp_fee_cap"]);
  assert.deepEqual(moveArgumentKinds(tx, 0), [
    "shared:0xc",
    "shared:0x61",
    "shared:0x10",
    "object:0xd",
  ]);
  assert.deepEqual(sharedMutability(tx), [true, false, false]);
  assert.equal(tx.getData().commands.at(-1)?.$kind, "TransferObjects");
  assert.equal(transferObjectCount(tx), 1);
});

test("routes both creator LP-fee coins to the requested recipient", () => {
  const sdk = new MigratorTransactions(deployment);
  const tx = sdk.claimCreatorFees({
    ...types,
    vault: shared("0xc", "20", true),
    lpFeeCapId: "0xd",
    recipient: "0xf",
  });

  assert.deepEqual(moveFunctions(tx), ["vault::claim_creator_fees"]);
  assert.equal(tx.getData().commands.at(-1)?.$kind, "TransferObjects");
  assert.equal(transferObjectCount(tx), 2);
});

test("signs in and routes both protocol LP-fee coins", () => {
  const sdk = new MigratorTransactions(deployment);
  const tx = sdk.claimProtocolFees({
    ...types,
    vault: shared("0xc", "20", true),
    adminCapId: "0xe",
    recipient: "0xf",
  });

  assert.deepEqual(moveFunctions(tx), [
    "acl::sign_in",
    "vault::claim_protocol_fees",
  ]);
  assert.equal(transferObjectCount(tx), 2);
});

test("signs in and pins one validated Aftermath policy", () => {
  const sdk = new MigratorTransactions(deployment);
  const policy = {
    adminCapId: "0xe",
    memeWeight: 600_000_000_000_000_000n,
    quoteWeight: 400_000_000_000_000_000n,
    daoFeeBps: 200,
  };
  const tx = sdk.setAftermathPolicy(policy);

  assert.deepEqual(moveFunctions(tx), [
    "acl::sign_in",
    "aftermath::set_policy",
  ]);
  assert.deepEqual(sharedMutability(tx), [false, false, true, false]);
  assertSharedArgumentIds(tx, ["0x5", "0x2", "0x60", "0x61"]);
  assert.deepEqual(moveArgumentKinds(tx, 1), [
    "shared:0x60",
    "shared:0x61",
    "Result",
    "pure",
    "pure",
    "pure",
  ]);
  assert.equal(pureInputCount(tx), 3);
  assert.throws(
    () =>
      sdk.setAftermathPolicy({
        ...policy,
        memeWeight: 500_000_000_000_000_000n,
      }),
    /sum to 100%/,
  );
  assert.throws(
    () => sdk.setAftermathPolicy({ ...policy, daoFeeBps: -1 }),
    /DAO fee/,
  );
});

test("routes both Aftermath canonical orientations with a fresh LP cap", () => {
  const sdk = new MigratorTransactions(deployment);
  const lpType = "0x30::af_lp::AF_LP";
  assert.equal(
    sdk.call.migrationWitnessType("aftermath").endsWith("::aftermath::Witness"),
    true,
  );

  for (const memeSide of ["first", "second"] as const) {
    const tx = sdk.migrateAftermath({
      ...types,
      lpType,
      memeSide,
      launch: shared("0x10", "30", true),
      memeCurrency: shared("0x11", "31", true),
      poolRegistry: shared("0x12", "32", true),
      createPoolCap: "0x13",
      daoFeeVersion: shared("0x14", "33", false),
    });

    assert.deepEqual(moveFunctions(tx), [
      `aftermath::migrate_meme_${memeSide}`,
    ]);
    assert.deepEqual(moveTypeArguments(tx), [
      [
        normalizedType(lpType),
        normalizedType(types.memeType),
        normalizedType(types.quoteType),
      ],
    ]);
    assert.deepEqual(sharedMutability(tx), [
      true,
      false,
      false,
      false,
      true,
      true,
      false,
    ]);
    assertSharedArgumentIds(tx, [
      "0x10",
      "0x2",
      "0x61",
      "0x60",
      "0x11",
      "0x12",
      "0x14",
    ]);
    assertOwnedArgumentId(tx, 0, 6, "0x13");
    assert.equal(tx.getData().commands.length, 1);
  }
});

test("signs in and updates one existing Aftermath DAO fee", () => {
  const sdk = new MigratorTransactions(deployment);
  const tx = sdk.updateAftermathDaoFee({
    ...types,
    lpType: "0x30::af_lp::AF_LP",
    vault: shared("0x10", "30", true),
    daoFeePool: shared("0x11", "31", true),
    daoFeeVersion: shared("0x12", "32", false),
    adminCapId: "0x13",
    daoFeeBps: 350,
  });

  assert.deepEqual(moveFunctions(tx), [
    "acl::sign_in",
    "aftermath::update_dao_fee",
  ]);
  assert.deepEqual(sharedMutability(tx), [
    false,
    false,
    true,
    false,
    true,
    false,
  ]);
  assertSharedArgumentIds(tx, ["0x5", "0x2", "0x10", "0x61", "0x11", "0x12"]);
  assert.deepEqual(moveCalls(tx)[1]?.arguments[4], {
    Result: 0,
    $kind: "Result",
  });
  assert.throws(
    () =>
      sdk.updateAftermathDaoFee({
        ...types,
        lpType: "0x30::af_lp::AF_LP",
        vault: shared("0x10", "30", true),
        daoFeePool: shared("0x11", "31", true),
        daoFeeVersion: shared("0x12", "32", false),
        adminCapId: "0x13",
        daoFeeBps: 10_001,
      }),
    /DAO fee/,
  );
});

test("batches both Aftermath DAO fee coin types through one vault call", () => {
  const sdk = new MigratorTransactions(deployment);
  const tx = sdk.accrueAftermathDaoFees({
    ...types,
    lpType: "0x30::af_lp::AF_LP",
    vault: shared("0x10", "30", true),
    memeFeeCoins: [receiving("0x11"), receiving("0x12")],
    quoteFeeCoins: [receiving("0x13")],
  });

  assert.deepEqual(moveFunctions(tx), ["aftermath::accrue_dao_fees"]);
  assert.deepEqual(sharedMutability(tx), [true, false, false]);
  assertSharedArgumentIds(tx, ["0x10", "0x61", "0x40"]);
  assert.deepEqual(moveVectorLengths(tx), [2, 1]);
  assert.equal(receivingInputCount(tx), 3);
});

test("allows either Aftermath DAO fee coin vector to be empty", () => {
  const sdk = new MigratorTransactions(deployment);

  for (const [memeFeeCoins, quoteFeeCoins] of [
    [[receiving("0x11")], []],
    [[], [receiving("0x12")]],
  ] satisfies [ReceivingCoinReference[], ReceivingCoinReference[]][]) {
    const tx = sdk.accrueAftermathDaoFees({
      ...types,
      lpType: "0x30::af_lp::AF_LP",
      vault: shared("0x10", "30", true),
      memeFeeCoins,
      quoteFeeCoins,
    });

    assert.deepEqual(moveFunctions(tx), ["aftermath::accrue_dao_fees"]);
    assert.deepEqual(moveVectorLengths(tx), [
      memeFeeCoins.length,
      quoteFeeCoins.length,
    ]);
  }
});

test("rejects empty and oversized Aftermath DAO fee batches", () => {
  const sdk = new MigratorTransactions(deployment);
  const options = {
    ...types,
    lpType: "0x30::af_lp::AF_LP",
    vault: shared("0x10", "30", true),
  };

  assert.equal(AFTERMATH_MAX_DAO_FEE_COINS_PER_BATCH, 100);
  assert.throws(
    () =>
      sdk.accrueAftermathDaoFees({
        ...options,
        memeFeeCoins: [],
        quoteFeeCoins: [],
      }),
    /between 1 and 100/,
  );
  assert.throws(
    () =>
      sdk.accrueAftermathDaoFees({
        ...options,
        memeFeeCoins: Array.from(
          { length: AFTERMATH_MAX_DAO_FEE_COINS_PER_BATCH + 1 },
          (_, index) => receiving(`0x${(index + 1).toString(16)}`),
        ),
        quoteFeeCoins: [],
      }),
    /between 1 and 100/,
  );
});

test("builds the complete Bluefin migration with frozen mutability", () => {
  const sdk = new MigratorTransactions(deployment);
  assert.equal(
    sdk.call.migrationWitnessType("bluefin"),
    "0x0000000000000000000000000000000000000000000000000000000000000320::bluefin::Witness",
  );

  const tx = sdk.migrateBluefin({
    ...types,
    launch: shared("0x10", "30", true),
    memeCurrency: shared("0x11", "31", true),
    quoteCurrency: shared("0x12", "32", false),
    bluefinConfig: shared("0x13", "33", true),
  });

  assert.deepEqual(moveFunctions(tx), ["bluefin::migrate"]);
  assert.deepEqual(moveTypeArguments(tx), [
    [normalizedType(types.memeType), normalizedType(types.quoteType)],
  ]);
  assert.deepEqual(sharedMutability(tx), [
    true,
    false,
    false,
    false,
    true,
    false,
    true,
    false,
  ]);
  assertSharedArgumentIds(tx, [
    "0x10",
    "0x2",
    "0x61",
    "0x60",
    "0x11",
    "0x12",
    "0x13",
    "0x6",
  ]);
});

test("builds Bluefin LP-fee collection without unhandled results", () => {
  const sdk = new MigratorTransactions(deployment);
  const tx = sdk.collectBluefinFees({
    ...types,
    vault: shared("0x20", "40", true),
    bluefinConfig: shared("0x21", "41", false),
    pool: shared("0x22", "42", true),
  });

  assert.deepEqual(moveFunctions(tx), ["bluefin::collect_fees"]);
  assert.deepEqual(sharedMutability(tx), [
    true,
    false,
    false,
    false,
    true,
    false,
  ]);
  assertSharedArgumentIds(tx, ["0x20", "0x61", "0x40", "0x21", "0x22", "0x6"]);
  assert.equal(tx.getData().commands.length, 1);
});

test("routes both MMT migration orientations with frozen shared inputs", () => {
  const sdk = new MigratorTransactions(deployment);
  assert.equal(
    sdk.call.migrationWitnessType("mmt").endsWith("::mmt::Witness"),
    true,
  );

  for (const memeSide of ["x", "y"] as const) {
    const tx = sdk.migrateMmt({
      ...types,
      memeSide,
      launch: shared("0x10", "30", true),
      memeCurrency: shared("0x11", "31", true),
      mmtGlobalConfig: shared("0x12", "32", true),
      mmtVersion: shared("0x13", "33", false),
    });

    assert.deepEqual(moveFunctions(tx), [`mmt::migrate_meme_${memeSide}`]);
    assert.deepEqual(moveTypeArguments(tx), [
      [normalizedType(types.memeType), normalizedType(types.quoteType)],
    ]);
    assert.deepEqual(sharedMutability(tx), [
      true,
      false,
      false,
      false,
      true,
      true,
      false,
      false,
    ]);
    assertSharedArgumentIds(tx, [
      "0x10",
      "0x2",
      "0x61",
      "0x60",
      "0x11",
      "0x12",
      "0x13",
      "0x6",
    ]);
  }
});

test("routes both MMT collection orientations without unhandled results", () => {
  const sdk = new MigratorTransactions(deployment);

  for (const memeSide of ["x", "y"] as const) {
    const tx = sdk.collectMmtFees({
      ...types,
      memeSide,
      vault: shared("0x20", "40", true),
      pool: shared("0x21", "41", true),
      mmtVersion: shared("0x22", "42", false),
    });

    assert.deepEqual(moveFunctions(tx), [`mmt::collect_fees_meme_${memeSide}`]);
    assert.deepEqual(sharedMutability(tx), [
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
    assertSharedArgumentIds(tx, [
      "0x20",
      "0x61",
      "0x40",
      "0x21",
      "0x22",
      "0x6",
    ]);
    assert.equal(tx.getData().commands.length, 1);
  }
});

test("routes all four Cetus migration combinations", () => {
  const sdk = new MigratorTransactions(deployment);

  for (const memeSide of ["a", "b"] as const) {
    for (const poolKind of ["new", "existing"] as const) {
      const pool =
        poolKind === "new"
          ? { kind: "new" as const, pools: shared("0x14", "34", true) }
          : { kind: "existing" as const, pool: shared("0x14", "34", true) };
      const tx = sdk.migrateCetus({
        ...types,
        memeSide,
        pool,
        launch: shared("0x10", "30", true),
        memeCurrency: shared("0x11", "31", true),
        cetusConfig: shared("0x12", "32", false),
      });

      assert.deepEqual(moveFunctions(tx), [
        `cetus::migrate_${poolKind}_meme_${memeSide}`,
      ]);
      assert.deepEqual(moveTypeArguments(tx), [
        [normalizedType(types.memeType), normalizedType(types.quoteType)],
      ]);
      assert.deepEqual(sharedMutability(tx), [
        true,
        false,
        false,
        false,
        true,
        false,
        true,
        false,
      ]);
      assertSharedArgumentIds(tx, [
        "0x10",
        "0x2",
        "0x61",
        "0x60",
        "0x11",
        "0x12",
        "0x14",
        "0x6",
      ]);
      assert.equal(tx.getData().commands.length, 1);
    }
  }
});

test("routes both Cetus LP-fee collection orientations", () => {
  const sdk = new MigratorTransactions(deployment);

  for (const memeSide of ["a", "b"] as const) {
    const tx = sdk.collectCetusFees({
      ...types,
      memeSide,
      vault: shared("0x20", "40", true),
      cetusConfig: shared("0x21", "41", false),
      pool: shared("0x22", "42", true),
    });

    assert.deepEqual(moveFunctions(tx), [
      `cetus::collect_fees_meme_${memeSide}`,
    ]);
    assert.deepEqual(sharedMutability(tx), [true, false, false, false, true]);
    assertSharedArgumentIds(tx, ["0x20", "0x61", "0x40", "0x21", "0x22"]);
    assert.equal(tx.getData().commands.length, 1);
  }
});

test("routes all four Turbos migrations with a third fee type", () => {
  const sdk = new MigratorTransactions(deployment);
  const feeType = "0x30::fee::FEE_40000";

  for (const memeSide of ["a", "b"] as const) {
    for (const poolKind of ["new", "existing"] as const) {
      const pool =
        poolKind === "new"
          ? {
              kind: "new" as const,
              poolConfig: shared("0x14", "34", true),
              fee: shared("0x15", "35", false),
            }
          : {
              kind: "existing" as const,
              pool: shared("0x14", "34", true),
            };
      const tx = sdk.migrateTurbos({
        ...types,
        feeType,
        memeSide,
        pool,
        launch: shared("0x10", "30", true),
        memeCurrency: shared("0x11", "31", true),
        positions: shared("0x16", "36", true),
        deadline: 1_000n,
        versioned: shared("0x17", "37", false),
      });

      assert.deepEqual(moveFunctions(tx), [
        `turbos::migrate_${poolKind}_meme_${memeSide}`,
      ]);
      assert.deepEqual(moveTypeArguments(tx), [
        [
          normalizedType(types.memeType),
          normalizedType(types.quoteType),
          normalizedType(feeType),
        ],
      ]);
      assert.deepEqual(
        sharedMutability(tx),
        poolKind === "new"
          ? [true, false, false, false, true, true, false, true, false, false]
          : [true, false, false, false, true, true, true, false, false],
      );
      assertSharedArgumentIds(
        tx,
        poolKind === "new"
          ? [
              "0x10",
              "0x2",
              "0x61",
              "0x60",
              "0x11",
              "0x14",
              "0x15",
              "0x16",
              "0x6",
              "0x17",
            ]
          : [
              "0x10",
              "0x2",
              "0x61",
              "0x60",
              "0x11",
              "0x14",
              "0x16",
              "0x6",
              "0x17",
            ],
      );
      assert.equal(pureInputCount(tx), 1);
      assert.equal(tx.getData().commands.length, 1);
    }
  }
});

test("routes both Turbos collection orientations and validates deadline", () => {
  const sdk = new MigratorTransactions(deployment);

  for (const memeSide of ["a", "b"] as const) {
    const options = {
      ...types,
      feeType: "0x30::fee::FEE_40000",
      memeSide,
      vault: shared("0x20", "40", true),
      pool: shared("0x21", "41", true),
      positions: shared("0x22", "42", true),
      deadline: 1_000n,
      versioned: shared("0x23", "43", false),
    };
    const tx = sdk.collectTurbosFees(options);

    assert.deepEqual(moveFunctions(tx), [
      `turbos::collect_fees_meme_${memeSide}`,
    ]);
    assert.deepEqual(sharedMutability(tx), [
      true,
      false,
      false,
      true,
      true,
      false,
      false,
    ]);
    assertSharedArgumentIds(tx, [
      "0x20",
      "0x61",
      "0x40",
      "0x21",
      "0x22",
      "0x6",
      "0x23",
    ]);
    assert.equal(pureInputCount(tx), 1);
    assert.equal(tx.getData().commands.length, 1);
    assert.throws(
      () => sdk.collectTurbosFees({ ...options, deadline: 1n << 64n }),
      /deadline must be a u64/,
    );
  }
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

function assertOwnedArgumentId(
  tx: Transaction,
  callIndex: number,
  argumentIndex: number,
  objectId: string,
): void {
  const argument = moveCalls(tx)[callIndex]?.arguments[argumentIndex];
  assert.equal(argument?.$kind, "Input");
  assert.ok(argument?.$kind === "Input");
  const input = tx.getData().inputs[argument.Input];
  assert.equal(input?.$kind, "UnresolvedObject");
  assert.ok(input?.$kind === "UnresolvedObject");
  assert.equal(
    input.UnresolvedObject.objectId,
    `0x${objectId.replace(/^0x/, "").padStart(64, "0")}`,
  );
}

function moveArgumentKinds(tx: Transaction, callIndex: number): string[] {
  const data = tx.getData();
  const call = moveCalls(tx)[callIndex];
  assert.ok(call);
  return call.arguments.map((argument) => {
    if (argument.$kind !== "Input") return argument.$kind;
    const input = data.inputs[argument.Input];
    if (input?.$kind === "Pure") return "pure";
    if (input?.$kind === "UnresolvedObject") {
      return `object:0x${BigInt(input.UnresolvedObject.objectId).toString(16)}`;
    }
    if (input?.$kind === "Object" && input.Object.$kind === "SharedObject") {
      return `shared:0x${BigInt(input.Object.SharedObject.objectId).toString(16)}`;
    }
    return String(input?.$kind);
  });
}

function transferObjectCount(tx: Transaction): number {
  const transfer = tx.getData().commands.at(-1);
  return transfer?.$kind === "TransferObjects"
    ? transfer.TransferObjects.objects.length
    : 0;
}

function moveTypeArguments(tx: Transaction): string[][] {
  return tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall.typeArguments] : [],
    );
}

function sharedMutability(tx: Transaction): boolean[] {
  return sharedMoveArguments(tx).map((argument) => argument.mutable);
}

function assertSharedArgumentIds(tx: Transaction, objectIds: string[]): void {
  assert.deepEqual(
    sharedMoveArguments(tx).map((argument) => argument.objectId),
    objectIds.map(
      (objectId) => `0x${objectId.replace(/^0x/, "").padStart(64, "0")}`,
    ),
  );
}

function sharedMoveArguments(tx: Transaction) {
  const data = tx.getData();
  return data.commands.flatMap((command) =>
    command.$kind === "MoveCall"
      ? command.MoveCall.arguments.flatMap((argument) => {
          if (argument.$kind !== "Input") return [];
          const input = data.inputs[argument.Input];
          return input?.$kind === "Object" &&
            input.Object.$kind === "SharedObject"
            ? [input.Object.SharedObject]
            : [];
        })
      : [],
  );
}

function pureInputCount(tx: Transaction): number {
  return tx.getData().inputs.filter((input) => input.$kind === "Pure").length;
}

function receivingInputCount(tx: Transaction): number {
  return tx
    .getData()
    .inputs.filter(
      (input) => input.$kind === "Object" && input.Object.$kind === "Receiving",
    ).length;
}

function moveVectorLengths(tx: Transaction): number[] {
  return tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MakeMoveVec"
        ? [command.MakeMoveVec.elements.length]
        : [],
    );
}

function normalizedType(type: string): string {
  return type.replace(
    /^0x([0-9a-f]+)::/,
    (_match, address: string) => `0x${address.padStart(64, "0")}::`,
  );
}
