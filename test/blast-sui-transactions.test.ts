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
  admin: { packageId: "0xad", acl: shared("0xac", "3", false) },
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
  const sharedVault = sharedDescriptor(vault);
  const sharedPackageVersion = sharedDescriptor(packageVersion);
  const sharedSystem = sharedDescriptor(systemState);
  assert.deepEqual(
    moveCalls(tx).map((call) =>
      call.arguments.map((argument) => argumentDescriptor(tx, argument)),
    ),
    [
      [
        sharedVault,
        sharedPackageVersion,
        sharedSystem,
        ownedDescriptor("0x20"),
      ],
      [
        sharedVault,
        sharedPackageVersion,
        sharedSystem,
        ownedDescriptor("0x21"),
      ],
      [
        sharedVault,
        sharedPackageVersion,
        sharedSystem,
        ownedDescriptor("0x22"),
      ],
      ["Result:2"],
      [
        sharedVault,
        sharedPackageVersion,
        sharedSystem,
        ownedDescriptor("0x23"),
        "u64:5",
      ],
      [ownedDescriptor("0x24"), sharedSystem],
      [
        sharedVault,
        sharedPackageVersion,
        sharedSystem,
        ownedDescriptor("0x25"),
      ],
      [
        sharedVault,
        sharedPackageVersion,
        sharedSystem,
        ownedDescriptor("0x26"),
        "u64:6",
      ],
      [sharedVault, sharedPackageVersion, sharedSystem],
    ],
  );
});

test("transfers each exact returned Move result to the normalized recipient", () => {
  const sdk = new BlastSuiTransactions(deployment);
  const cases = [
    [sdk.mintFunSui({ amount: 1n, recipient }), { Result: 1, $kind: "Result" }],
    [
      sdk.redeemFunSui({ amount: 2n, recipient }),
      { Result: 1, $kind: "Result" },
    ],
    [
      sdk.claimBlastSui({ receiptId: "0x30", minBlastOut: 0n, recipient }),
      { Result: 0, $kind: "Result" },
    ],
    [
      sdk.cancelDepositReceipt({ receiptId: "0x31", recipient }),
      { Result: 0, $kind: "Result" },
    ],
    [
      sdk.redeemBlastSui({ amount: 3n, minSuiOut: 0n, recipient }),
      { Result: 1, $kind: "Result" },
    ],
  ] as const;

  for (const [tx, expectedResult] of cases) {
    assert.deepEqual(transferredObjects(tx), [expectedResult]);
    assert.equal(transferRecipient(tx), normalizeSuiObjectId(recipient));
  }

  const request = sdk.requestBlastSui({ amount: 4n });
  assert.deepEqual(moveCalls(request)[1]?.arguments, [
    { Result: 1, $kind: "Result" },
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

  for (const amount of [-1n, over]) {
    assert.throws(
      () => sdk.mintFunSui({ amount, recipient }),
      /amount must be a u64/,
    );
    assert.throws(
      () => sdk.redeemFunSui({ amount, recipient }),
      /amount must be a u64/,
    );
    assert.throws(
      () => sdk.requestBlastSui({ amount }),
      /amount must be a u64/,
    );
    assert.throws(() => sdk.donateSui({ amount }), /amount must be a u64/);
    assert.throws(
      () => sdk.redeemBlastSui({ amount, minSuiOut: 0n, recipient }),
      /amount must be a u64/,
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

  assert.doesNotThrow(() => sdk.mintFunSui({ amount: 0n, recipient }));
  assert.doesNotThrow(() => sdk.redeemFunSui({ amount: 0n, recipient }));
  assert.doesNotThrow(() => sdk.requestBlastSui({ amount: 0n }));
  assert.doesNotThrow(() => sdk.donateSui({ amount: 0n }));
  assert.doesNotThrow(() =>
    sdk.redeemBlastSui({ amount: 0n, minSuiOut: 0n, recipient }),
  );
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

function argumentDescriptor(
  tx: Transaction,
  argument: ReturnType<typeof moveCalls>[number]["arguments"][number],
): string {
  if (argument.$kind === "Result") return `Result:${argument.Result}`;
  if (argument.$kind === "NestedResult") {
    return `NestedResult:${argument.NestedResult.join(":")}`;
  }
  assert.equal(argument.$kind, "Input");
  assert.ok(argument.$kind === "Input");
  const input = tx.getData().inputs[argument.Input];
  assert.ok(input);
  if (input.$kind === "Object") {
    assert.equal(input.Object.$kind, "SharedObject");
    return sharedDescriptor(input.Object.SharedObject);
  }
  if (input.$kind === "UnresolvedObject") {
    return `owned:${input.UnresolvedObject.objectId}`;
  }
  assert.equal(input.$kind, "Pure");
  return `u64:${Buffer.from(input.Pure.bytes, "base64").readBigUInt64LE()}`;
}

function sharedDescriptor(reference: SharedObjectReference): string {
  return `shared:${reference.objectId}:${reference.initialSharedVersion}:${reference.mutable}`;
}

function ownedDescriptor(objectId: string): string {
  return `owned:${normalizeSuiObjectId(objectId)}`;
}

function transferredObjects(tx: Transaction) {
  const command = tx.getData().commands.at(-1);
  assert.equal(command?.$kind, "TransferObjects");
  assert.ok(command?.$kind === "TransferObjects");
  return command.TransferObjects.objects;
}

function transferRecipient(tx: Transaction): string {
  const command = tx.getData().commands.at(-1);
  assert.equal(command?.$kind, "TransferObjects");
  assert.ok(command?.$kind === "TransferObjects");
  const address = command.TransferObjects.address;
  assert.equal(address.$kind, "Input");
  assert.ok(address.$kind === "Input");
  const input = tx.getData().inputs[address.Input];
  assert.equal(input?.$kind, "Pure");
  assert.ok(input?.$kind === "Pure");
  return normalizeSuiObjectId(
    `0x${Buffer.from(input.Pure.bytes, "base64").toString("hex")}`,
  );
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
