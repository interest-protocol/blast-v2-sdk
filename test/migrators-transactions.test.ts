import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "@mysten/sui/transactions";
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
    packageVersion: shared("0x2", "10", false),
    launchConfig: shared("0x3", "11", false),
    runtimeConfig: shared("0x4", "12", false),
    protocolAuthority: shared("0x5", "13", false),
  },
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
      creatorCap: "0xd",
    }),
  );
  assert.deepEqual(moveFunctions(creatorTx), ["vault::claim_creator_fees"]);

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
});

test("routes both creator LP-fee coins to the requested recipient", () => {
  const sdk = new MigratorTransactions(deployment);
  const tx = sdk.claimCreatorFees({
    ...types,
    vault: shared("0xc", "20", true),
    creatorCapId: "0xd",
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
    "0x4",
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
  assert.deepEqual(sharedMutability(tx), [true, false, false, true, false]);
  assertSharedArgumentIds(tx, ["0x20", "0x4", "0x21", "0x22", "0x6"]);
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
      "0x4",
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
    assert.deepEqual(sharedMutability(tx), [true, false, true, false, false]);
    assertSharedArgumentIds(tx, ["0x20", "0x4", "0x21", "0x22", "0x6"]);
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
        "0x4",
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
    assert.deepEqual(sharedMutability(tx), [true, false, false, true]);
    assertSharedArgumentIds(tx, ["0x20", "0x4", "0x21", "0x22"]);
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
              "0x4",
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
              "0x4",
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
      true,
      true,
      false,
      false,
    ]);
    assertSharedArgumentIds(tx, ["0x20", "0x4", "0x21", "0x22", "0x6", "0x23"]);
    assert.equal(pureInputCount(tx), 1);
    assert.equal(tx.getData().commands.length, 1);
    assert.throws(
      () => sdk.collectTurbosFees({ ...options, deadline: 1n << 64n }),
      /deadline must be a u64/,
    );
  }
});

test("routes all four Full Sail migrations including rewarder custody", () => {
  const sdk = new MigratorTransactions(deployment);

  for (const memeSide of ["a", "b"] as const) {
    for (const poolKind of ["new", "existing"] as const) {
      const pool =
        poolKind === "new"
          ? { kind: "new" as const, pools: shared("0x14", "34", true) }
          : { kind: "existing" as const, pool: shared("0x14", "34", true) };
      const tx = sdk.migrateFullSail({
        ...types,
        memeSide,
        pool,
        launch: shared("0x10", "30", true),
        memeCurrency: shared("0x11", "31", true),
        fullSailConfig: shared("0x12", "32", false),
        rewarderGlobalVault: shared("0x13", "33", true),
      });

      assert.deepEqual(moveFunctions(tx), [
        `fullsail::migrate_${poolKind}_meme_${memeSide}`,
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
        true,
        false,
      ]);
      assertSharedArgumentIds(tx, [
        "0x10",
        "0x2",
        "0x4",
        "0x60",
        "0x11",
        "0x12",
        "0x13",
        "0x14",
        "0x6",
      ]);
      assert.equal(tx.getData().commands.length, 1);
    }
  }
});

test("routes both Full Sail collection orientations without rewarder inputs", () => {
  const sdk = new MigratorTransactions(deployment);

  for (const memeSide of ["a", "b"] as const) {
    const tx = sdk.collectFullSailFees({
      ...types,
      memeSide,
      vault: shared("0x20", "40", true),
      fullSailConfig: shared("0x21", "41", false),
      pool: shared("0x22", "42", true),
    });

    assert.deepEqual(moveFunctions(tx), [
      `fullsail::collect_fees_meme_${memeSide}`,
    ]);
    assert.deepEqual(sharedMutability(tx), [true, false, false, true]);
    assertSharedArgumentIds(tx, ["0x20", "0x4", "0x21", "0x22"]);
    assert.equal(tx.getData().commands.length, 1);
  }
});

function moveFunctions(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall"
        ? [`${command.MoveCall.module}::${command.MoveCall.function}`]
        : [],
    );
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

function normalizedType(type: string): string {
  return type.replace(
    /^0x([0-9a-f]+)::/,
    (_match, address: string) => `0x${address.padStart(64, "0")}::`,
  );
}
