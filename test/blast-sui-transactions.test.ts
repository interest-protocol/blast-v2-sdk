import assert from "node:assert/strict";
import test from "node:test";

import type { TransactionObjectInput } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiObjectId,
  SUI_SYSTEM_STATE_OBJECT_ID,
  SUI_TYPE_ARG,
} from "@mysten/sui/utils";
import {
  BlastSuiCalls,
  BlastSuiTransactions,
} from "../src/blast-sui/transactions.ts";
import type { BlastSuiDeployment } from "../src/blast-sui/types.ts";
import type { SharedObjectReference } from "../src/lib/sui.ts";

const deployment: BlastSuiDeployment = {
  packageId: "0x123",
  originalPackageId: "0x122",
  packageVersion: shared("0x10", "8", false),
  vault: shared("0x11", "9", true),
};
const recipient = "0xbeef";

test("builds all composable calls with current targets and exact object mutability", () => {
  const calls = new BlastSuiCalls(deployment);
  const tx = new Transaction();
  const owned = (id: string): TransactionObjectInput => tx.object(id);

  tx.add(calls.mintFunSui({ suiCoin: owned("0x20") }));
  tx.add(calls.redeemFunSui({ funSuiCoin: owned("0x21") }));
  const receipt = tx.add(calls.requestBlastSui({ suiCoin: owned("0x22") }));
  tx.add(calls.keepDepositReceipt({ receipt }));
  tx.add(calls.claimBlastSui({ receipt: owned("0x23"), minBlastOut: 5n }));
  tx.add(calls.cancelDepositReceipt({ receipt: owned("0x24") }));
  tx.add(calls.donateSui({ suiCoin: owned("0x25") }));
  tx.add(calls.redeemBlastSui({ blastSuiCoin: owned("0x26"), minSuiOut: 6n }));
  tx.add(calls.syncVault());

  assert.deepEqual(moveFunctions(tx), [
    "vault::mint_fun_sui",
    "vault::redeem_fun_sui",
    "vault::request_blast_sui",
    "deposit_receipt::keep",
    "vault::claim_blast_sui",
    "deposit_receipt::cancel",
    "vault::donate_sui",
    "vault::redeem_blast_sui",
    "vault::sync",
  ]);
  assert.ok(
    moveCalls(tx).every(
      (call) => call.package === normalizeSuiObjectId(deployment.packageId),
    ),
  );
  assert.ok(moveCalls(tx).every((call) => call.typeArguments.length === 0));

  const sharedInputs = sharedObjectInputs(tx);
  assert.ok(
    sharedInputs.some(
      (input) =>
        input.objectId === normalizeSuiObjectId(deployment.vault.objectId) &&
        BigInt(input.initialSharedVersion) === 9n &&
        input.mutable === true,
    ),
  );
  assert.ok(
    sharedInputs.some(
      (input) =>
        input.objectId ===
          normalizeSuiObjectId(deployment.packageVersion.objectId) &&
        BigInt(input.initialSharedVersion) === 8n &&
        input.mutable === false,
    ),
  );
  const system = sharedInputs.filter(
    (input) => input.objectId === SUI_SYSTEM_STATE_OBJECT_ID,
  );
  assert.deepEqual(system, [
    {
      objectId: SUI_SYSTEM_STATE_OBJECT_ID,
      initialSharedVersion: 1,
      mutable: true,
    },
  ]);
  const systemState = system[0];
  assert.ok(systemState);
  for (const index of [0, 1, 2, 4, 5, 6, 7, 8]) {
    const call = moveCalls(tx)[index];
    assert.ok(call);
    assertCallUsesSharedObject(tx, call, systemState);
  }
  const vault = sharedInputs.find(
    (input) =>
      input.objectId === normalizeSuiObjectId(deployment.vault.objectId),
  );
  const packageVersion = sharedInputs.find(
    (input) =>
      input.objectId ===
      normalizeSuiObjectId(deployment.packageVersion.objectId),
  );
  assert.ok(vault);
  assert.ok(packageVersion);
  for (const index of [0, 1, 2, 4, 6, 7, 8]) {
    const call = moveCalls(tx)[index];
    assert.ok(call);
    assertCallUsesSharedObject(tx, call, vault);
    assertCallUsesSharedObject(tx, call, packageVersion);
  }

  assert.deepEqual(moveCalls(tx)[3]?.arguments, [
    { Result: 2, $kind: "Result" },
  ]);
  const cancel = moveCalls(tx)[5];
  assert.ok(cancel);
  assert.deepEqual(argumentInputKinds(tx, cancel), [
    "UnresolvedObject",
    "SharedObject",
  ]);
});

test("routes frontend outputs and selects canonical coin types", () => {
  const sdk = new BlastSuiTransactions(deployment);
  const mint = sdk.mintFunSui({ amount: 1n, recipient });
  const redeemFun = sdk.redeemFunSui({ amount: 2n, recipient });
  const claim = sdk.claimBlastSui({
    receiptId: "0x30",
    minBlastOut: 0n,
    recipient,
  });
  const cancel = sdk.cancelDepositReceipt({ receiptId: "0x31", recipient });
  const redeemBlast = sdk.redeemBlastSui({
    amount: 3n,
    minSuiOut: 0n,
    recipient,
  });
  const cases = [mint, redeemFun, claim, cancel, redeemBlast];
  for (const tx of cases) {
    assert.equal(tx.getData().commands.at(-1)?.$kind, "TransferObjects");
  }

  const request = sdk.requestBlastSui({ amount: 4n });
  assert.deepEqual(moveFunctions(request), [
    "vault::request_blast_sui",
    "deposit_receipt::keep",
  ]);
  assert.equal(hasTransfer(request), false);
  const donate = sdk.donateSui({ amount: 5n });
  const sync = sdk.syncVault();
  assert.equal(hasTransfer(donate), false);
  assert.equal(hasTransfer(sync), false);

  assert.equal(coinType(mint), "gas");
  assert.equal(
    coinType(redeemFun),
    normalizeStructTag(`${deployment.originalPackageId}::fun_sui::FUN_SUI`),
  );
  assert.equal(coinType(request), "gas");
  assert.equal(coinType(donate), "gas");
  assert.equal(
    coinType(redeemBlast),
    normalizeStructTag(`${deployment.originalPackageId}::blast_sui::BLAST_SUI`),
  );
  assert.equal(SUI_TYPE_ARG.endsWith("::sui::SUI"), true);
});

test("validates all atomic amounts and minimum outputs as u64", () => {
  const calls = new BlastSuiCalls(deployment);
  const sdk = new BlastSuiTransactions(deployment);
  const over = 1n << 64n;

  for (const amount of [0n, -1n, over]) {
    assert.throws(() => sdk.mintFunSui({ amount, recipient }), /positive u64/);
    assert.throws(
      () => sdk.redeemFunSui({ amount, recipient }),
      /positive u64/,
    );
    assert.throws(() => sdk.requestBlastSui({ amount }), /positive u64/);
    assert.throws(() => sdk.donateSui({ amount }), /positive u64/);
    assert.throws(
      () => sdk.redeemBlastSui({ amount, minSuiOut: 0n, recipient }),
      /positive u64/,
    );
  }
  for (const min of [-1n, over]) {
    assert.throws(
      () => calls.claimBlastSui({ receipt: "0x30", minBlastOut: min }),
      /minBlastOut must be a u64/,
    );
    assert.throws(
      () => calls.redeemBlastSui({ blastSuiCoin: "0x31", minSuiOut: min }),
      /minSuiOut must be a u64/,
    );
    assert.throws(
      () =>
        sdk.claimBlastSui({ receiptId: "0x30", minBlastOut: min, recipient }),
      /minBlastOut must be a u64/,
    );
    assert.throws(
      () => sdk.redeemBlastSui({ amount: 1n, minSuiOut: min, recipient }),
      /minSuiOut must be a u64/,
    );
  }

  assert.doesNotThrow(() => sdk.requestBlastSui({ amount: 1n }));
});

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

function sharedObjectInputs(tx: Transaction): SharedObjectReference[] {
  return tx
    .getData()
    .inputs.flatMap((input) =>
      input.$kind === "Object" && input.Object.$kind === "SharedObject"
        ? [input.Object.SharedObject]
        : [],
    );
}

function assertCallUsesSharedObject(
  tx: Transaction,
  call: ReturnType<typeof moveCalls>[number],
  expected: SharedObjectReference,
): void {
  assert.ok(
    call.arguments.some((argument) => {
      if (argument.$kind !== "Input") return false;
      const input = tx.getData().inputs[argument.Input];
      return (
        input?.$kind === "Object" &&
        input.Object.$kind === "SharedObject" &&
        input.Object.SharedObject.objectId === expected.objectId &&
        input.Object.SharedObject.mutable === expected.mutable &&
        BigInt(input.Object.SharedObject.initialSharedVersion) ===
          BigInt(expected.initialSharedVersion)
      );
    }),
  );
}

function argumentInputKinds(
  tx: Transaction,
  call: ReturnType<typeof moveCalls>[number],
): string[] {
  return call.arguments.flatMap((argument) => {
    if (argument.$kind !== "Input") return [];
    const input = tx.getData().inputs[argument.Input];
    if (input?.$kind === "Object") return [input.Object.$kind];
    return input ? [input.$kind] : [];
  });
}

function hasTransfer(tx: Transaction): boolean {
  return tx
    .getData()
    .commands.some((command) => command.$kind === "TransferObjects");
}

function coinType(tx: Transaction): string | undefined {
  const command = tx
    .getData()
    .commands.find(
      (candidate) =>
        candidate.$kind === "$Intent" &&
        candidate.$Intent.name === "CoinWithBalance",
    );
  return command?.$kind === "$Intent"
    ? (command.$Intent.data.type as string | undefined)
    : undefined;
}

function shared<const Mutable extends boolean>(
  objectId: string,
  initialSharedVersion: string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion, mutable };
}
