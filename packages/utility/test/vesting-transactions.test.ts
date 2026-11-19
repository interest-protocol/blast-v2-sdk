import assert from "node:assert/strict";
import test from "node:test";

import type { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiObjectId, SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import type {
  SharedObjectReference,
  VestingDeployment,
} from "../src/vesting/transactions.ts";
import { VestingTransactions } from "../src/vesting/transactions.ts";

const deployment: VestingDeployment = {
  packageId: "0x123",
  originalPackageId: "0x122",
};
const coinType = "0x2::sui::SUI";
const linear = {
  startMs: 100_000n,
  cliffMs: 20_000n,
  periodMs: 10_000n,
  periods: 10n,
};
const checkpoints = [
  { timestampMs: 100_000n, cumulativeAmount: 200n },
  { timestampMs: 150_000n, cumulativeAmount: 456n },
  { timestampMs: 200_000n, cumulativeAmount: 1_000n },
] as const;

test("builds an atomic linear irrevocable create and share transaction", () => {
  const sdk = new VestingTransactions(deployment);
  const tx = sdk.createLinearIrrevocable({
    coinType,
    totalAmount: 1_000n,
    beneficiary: "0xb0b",
    schedule: linear,
    currentTimestampMs: 40_000n,
  });

  assert.deepEqual(moveFunctions(tx), [
    "blast_fun_linear_vesting::new_irrevocable",
    "blast_fun_linear_vesting::share",
  ]);
  assertClockIsImmutable(tx);
  assertLastArgumentIsClock(tx, moveCalls(tx)[0]!);
  const share = moveCalls(tx)[1]!;
  assert.deepEqual(share.arguments[0], { Result: 1, $kind: "Result" });
});

test("builds a checkpoint schedule and routes its cancel cap", () => {
  const sdk = new VestingTransactions(deployment);
  const tx = sdk.createCheckpointCancelable({
    coinType,
    totalAmount: 1_000n,
    beneficiary: "0xb0b",
    refundRecipient: "0xcafe",
    cancelCapRecipient: "0xca11",
    checkpoints,
    currentTimestampMs: 40_000n,
  });

  assert.deepEqual(moveFunctions(tx), [
    "blast_fun_checkpoint_vesting::new_schedule",
    "blast_fun_checkpoint_vesting::add",
    "blast_fun_checkpoint_vesting::add",
    "blast_fun_checkpoint_vesting::add",
    "blast_fun_checkpoint_vesting::new_cancelable",
    "blast_fun_checkpoint_vesting::share",
  ]);
  assert.equal(tx.getData().commands.at(-1)?.$kind, "TransferObjects");
  assertClockIsImmutable(tx);
  assertLastArgumentIsClock(tx, moveCalls(tx)[4]!);
});

test("uses decoded position metadata for claim, cancel, and close", () => {
  const sdk = new VestingTransactions(deployment);
  const position = {
    kind: "checkpoints" as const,
    coinType,
    ...shared("0xc", "20", true),
  };

  assert.deepEqual(moveFunctions(sdk.claim(position)), [
    "blast_fun_checkpoint_vesting::claim",
  ]);
  assert.deepEqual(
    moveFunctions(sdk.cancel({ ...position, cancelCapId: "0xd" })),
    ["blast_fun_checkpoint_vesting::cancel"],
  );
  assert.deepEqual(moveFunctions(sdk.closeIrrevocable(position)), [
    "blast_fun_checkpoint_vesting::close_irrevocable",
  ]);
  assert.deepEqual(sharedInputs(sdk.claim(position)), [
    normalizedShared(shared("0xc", "20", true)),
    normalizedShared(shared(SUI_CLOCK_OBJECT_ID, 1, false)),
  ]);
  // The live package's close_irrevocable takes only the vesting object.
  const close = moveCalls(sdk.closeIrrevocable(position))[0]!;
  assert.equal(close.arguments.length, 1);
  assert.deepEqual(sharedInputs(sdk.closeIrrevocable(position)), [
    normalizedShared(shared("0xc", "20", true)),
  ]);
});

test("rejects stale starts, mismatched totals, and invalid shared inputs", () => {
  const sdk = new VestingTransactions(deployment);
  assert.throws(
    () =>
      sdk.createLinearIrrevocable({
        coinType,
        totalAmount: 1_000n,
        beneficiary: "0xb0b",
        schedule: linear,
        currentTimestampMs: 40_001n,
      }),
    /minimumLeadTimeMs/,
  );
  assert.throws(
    () =>
      sdk.createCheckpointIrrevocable({
        coinType,
        totalAmount: 999n,
        beneficiary: "0xb0b",
        checkpoints,
        currentTimestampMs: 40_000n,
      }),
    /must equal totalAmount/,
  );
  assert.throws(
    () =>
      sdk.claim({
        kind: "linear",
        coinType,
        ...shared("0xc", "20", false),
      } as unknown as Parameters<typeof sdk.claim>[0]),
    /vesting\.mutable must be true/,
  );
});

function shared<const Mutable extends boolean>(
  objectId: string,
  initialSharedVersion: number | string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion, mutable };
}

function moveCalls(tx: Transaction) {
  return tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall] : [],
    );
}

function moveFunctions(tx: Transaction): string[] {
  return moveCalls(tx).map((call) => `${call.module}::${call.function}`);
}

function sharedInputs(tx: Transaction): SharedObjectReference[] {
  return tx
    .getData()
    .inputs.flatMap((input) =>
      input.$kind === "Object" && input.Object.$kind === "SharedObject"
        ? [input.Object.SharedObject]
        : [],
    );
}

function normalizedShared<const Mutable extends boolean>(
  reference: SharedObjectReference<Mutable>,
): SharedObjectReference<Mutable> {
  return {
    ...reference,
    objectId: normalizeSuiObjectId(reference.objectId),
  };
}

function assertClockIsImmutable(tx: Transaction): void {
  assert.ok(
    sharedInputs(tx).some(
      (input) =>
        input.objectId === SUI_CLOCK_OBJECT_ID &&
        BigInt(input.initialSharedVersion) === 1n &&
        input.mutable === false,
    ),
  );
}

function assertLastArgumentIsClock(
  tx: Transaction,
  call: ReturnType<typeof moveCalls>[number],
): void {
  const argument = call.arguments.at(-1);
  assert.equal(argument?.$kind, "Input");
  if (argument?.$kind !== "Input") return;
  const input = tx.getData().inputs[argument.Input];
  assert.equal(input?.$kind, "Object");
  if (input?.$kind !== "Object") return;
  assert.equal(input.Object.$kind, "SharedObject");
  if (input.Object.$kind !== "SharedObject") return;
  assert.equal(input.Object.SharedObject.objectId, SUI_CLOCK_OBJECT_ID);
  assert.equal(input.Object.SharedObject.mutable, false);
}
