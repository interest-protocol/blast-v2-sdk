import assert from "node:assert/strict";
import test from "node:test";
import { packageRoleType } from "@interest-protocol/blast-admin-sdk/transactions";
import type { SharedObjectReference } from "@interest-protocol/blast-core/sui";
import {
  BLAST_SUI_PAUSE_BITS,
  MAX_BLAST_SUI_REDEEM_FEE_BPS,
} from "@interest-protocol/blast-sui-sdk";
import {
  BlastSuiCalls,
  BlastSuiTransactions,
} from "@interest-protocol/blast-sui-sdk/transactions";
import type { BlastSuiDeployment } from "@interest-protocol/blast-sui-sdk/types";
import type { TransactionObjectInput } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiObjectId,
  SUI_SYSTEM_STATE_OBJECT_ID,
} from "@mysten/sui/utils";
import {
  abiCoverage,
  moveCallArguments,
  moveCallTypeArguments,
  readAbi,
} from "./abi.ts";

const deployment: BlastSuiDeployment = {
  packageId: "0x123",
  originalPackageId: "0x122",
  packageVersion: { objectId: "0x10", initialSharedVersion: "8" },
  packageAdmin: { objectId: "0x12", initialSharedVersion: "4" },
  vault: { objectId: "0x11", initialSharedVersion: "9" },
  admin: {
    packageId: "0xad",
    acl: { objectId: "0xac", initialSharedVersion: "3" },
  },
};
const recipient = "0xbeef";
const pool = "0x55";
const abi = readAbi("production-blast-sui-v1.json", "blastSui");
const coverage = abiCoverage(abi, deployment.packageId);
const original = normalizeSuiObjectId(deployment.originalPackageId);
const roleType = (role: string) => `${original}::blast_sui_domain::${role}`;

// `#vaultCall` prefix: the vault by `&mut`, the package version by `&`.
const VAULT = ["shared-mut:0x11", "shared:0x10"];
const SYSTEM = "shared-mut:0x5";

test("builds every user and permissionless call with exact targets and argument shapes", () => {
  const calls = new BlastSuiCalls(deployment);
  const tx = new Transaction();
  const owned = (id: string): TransactionObjectInput => tx.object(id);

  tx.add(calls.mintFunSui({ poolId: pool, suiCoin: owned("0x20") }));
  tx.add(calls.redeemFunSui({ funSuiCoin: owned("0x21") }));
  const receipt = tx.add(
    calls.requestBlastSui({ poolId: pool, suiCoin: owned("0x22") }),
  );
  tx.add(calls.keepDepositReceipt({ receipt }));
  tx.add(calls.claimBlastSui({ receipt: owned("0x23"), minBlastOut: 5n }));
  tx.add(calls.cancelDepositReceipt({ receipt: owned("0x24") }));
  tx.add(calls.donateSui({ suiCoin: owned("0x25") }));
  tx.add(calls.topUpFunReserve({ suiCoin: owned("0x27") }));
  tx.add(calls.redeemBlastSui({ blastSuiCoin: owned("0x26"), minSuiOut: 6n }));
  tx.add(calls.syncVault());
  tx.add(calls.applyRedeemFee());
  tx.add(calls.applyValidator({ poolId: pool }));
  tx.add(calls.applyValidatorDelay());
  coverage.check(tx);

  assert.deepEqual(moveFunctions(tx), [
    "vault::mint_fun_sui",
    "vault::redeem_fun_sui",
    "vault::request_blast_sui",
    "deposit_receipt::keep",
    "vault::claim_blast_sui",
    "deposit_receipt::cancel",
    "vault::donate_sui",
    "vault::top_up_fun_reserve",
    "vault::redeem_blast_sui",
    "vault::sync",
    "vault::apply_redeem_fee",
    "vault::apply_validator",
    "vault::apply_validator_delay",
  ]);
  assert.ok(
    moveCalls(tx).every(
      (call) => call.package === normalizeSuiObjectId(deployment.packageId),
    ),
  );
  assert.ok(moveCallTypeArguments(tx).every((types) => types.length === 0));
  assert.deepEqual(
    moveCalls(tx).map((_, index) => moveCallArguments(tx, index)),
    [
      [...VAULT, SYSTEM, "pure", "object:0x20"],
      [...VAULT, SYSTEM, "object:0x21"],
      [...VAULT, SYSTEM, "pure", "object:0x22"],
      ["result:2"],
      [...VAULT, SYSTEM, "object:0x23", "pure"],
      ["object:0x24", SYSTEM],
      [...VAULT, SYSTEM, "object:0x25"],
      // The fun reserve top-up touches no stake, so no system state.
      [...VAULT, "object:0x27"],
      [...VAULT, SYSTEM, "object:0x26", "pure"],
      [...VAULT, SYSTEM],
      [...VAULT, "clock"],
      [...VAULT, SYSTEM, "pure", "clock"],
      [...VAULT, "clock"],
    ],
  );

  // Pool arguments are `tx.pure.id` of the normalized pool id.
  for (const index of [0, 2, 11]) {
    assert.equal(
      pureHex(tx, index, VAULT.length + 1),
      normalizeSuiObjectId(pool),
    );
  }
  assert.equal(pureU64(tx, 4, 4), 5n);
  assert.equal(pureU64(tx, 8, 4), 6n);

  // One input per shared object, at its deployment version and strongest use.
  // The system state input comes first: the builder resolves it before the
  // vault prefix.
  assert.deepEqual(sharedObjectInputs(tx), [
    {
      objectId: SUI_SYSTEM_STATE_OBJECT_ID,
      initialSharedVersion: 1,
      mutable: true,
    },
    {
      objectId: normalizeSuiObjectId("0x11"),
      initialSharedVersion: "9",
      mutable: true,
    },
    {
      objectId: normalizeSuiObjectId("0x10"),
      initialSharedVersion: "8",
      mutable: false,
    },
    {
      objectId: normalizeSuiObjectId("0x6"),
      initialSharedVersion: 1,
      mutable: false,
    },
  ]);
});

test("signs in with each blast Sui role and passes the witness to the admin call", () => {
  const sdk = new BlastSuiTransactions(deployment);
  const cases = [
    [
      sdk.scheduleRedeemFee({
        adminCapId: "0xadc",
        redeemFeeBps: 25n,
        delayMs: 7n,
      }),
      "FeeAdmin",
      "vault::schedule_redeem_fee",
      [...VAULT, "result:0", "pure", "pure", "clock"],
    ],
    [
      sdk.cancelRedeemFee({ adminCapId: "0xadc" }),
      "CancelAdmin",
      "vault::cancel_redeem_fee",
      [...VAULT, "result:0"],
    ],
    [
      sdk.scheduleValidator({ adminCapId: "0xadc", poolId: pool }),
      "ValidatorAdmin",
      "vault::schedule_validator",
      [...VAULT, "result:0", "pure", "clock"],
    ],
    [
      sdk.cancelValidator({ adminCapId: "0xadc", poolId: pool }),
      "CancelAdmin",
      "vault::cancel_validator",
      [...VAULT, "result:0", "pure"],
    ],
    [
      sdk.removeValidator({ adminCapId: "0xadc", poolId: pool }),
      "ValidatorAdmin",
      "vault::remove_validator",
      [...VAULT, "result:0", SYSTEM, "pure"],
    ],
    [
      sdk.scheduleValidatorDelay({ adminCapId: "0xadc", delayMs: 9n }),
      "ValidatorAdmin",
      "vault::schedule_validator_delay",
      [...VAULT, "result:0", "pure", "clock"],
    ],
    [
      sdk.cancelValidatorDelay({ adminCapId: "0xadc" }),
      "CancelAdmin",
      "vault::cancel_validator_delay",
      [...VAULT, "result:0"],
    ],
  ] as const;

  for (const [tx, role, target, args] of cases) {
    coverage.check(tx);
    assert.deepEqual(moveFunctions(tx), ["blast_acl::sign_in", target]);
    assert.deepEqual(moveCallTypeArguments(tx), [[roleType(role)], []]);
    assert.deepEqual(moveCallArguments(tx, 0), ["shared:0xac", "object:0xadc"]);
    assert.deepEqual(moveCallArguments(tx, 1), args);
  }

  const [
    [schedule],
    ,
    [scheduleValidator],
    [cancelValidator],
    [remove],
    [delay],
  ] = cases;
  assert.equal(pureU64(schedule, 1, 3), 25n);
  assert.equal(pureU64(schedule, 1, 4), 7n);
  assert.equal(pureU64(delay, 1, 3), 9n);
  assert.equal(pureHex(scheduleValidator, 1, 3), normalizeSuiObjectId(pool));
  assert.equal(pureHex(cancelValidator, 1, 3), normalizeSuiObjectId(pool));
  assert.equal(pureHex(remove, 1, 4), normalizeSuiObjectId(pool));
});

test("unpauses with the package UnpauseAdmin, a shared vault and package admin", () => {
  const sdk = new BlastSuiTransactions(deployment);
  const tx = coverage.check(sdk.unpause({ adminCapId: "0xadc", bits: 7 }));

  assert.equal(
    sdk.call.otw,
    normalizeStructTag(`${original}::blast_sui_package::BLAST_SUI_PACKAGE`),
  );
  assert.deepEqual(moveCallTypeArguments(tx), [
    [packageRoleType(deployment.admin, sdk.call.otw, "UnpauseAdmin")],
    [],
  ]);
  assert.deepEqual(moveCallTypeArguments(tx)[0], [
    normalizeStructTag(
      `0xad::package_admin::UnpauseAdmin<${original}::blast_sui_package::BLAST_SUI_PACKAGE>`,
    ),
  ]);
  assert.deepEqual(moveFunctions(tx).at(-1), "vault::unpause");
  assert.deepEqual(moveCallArguments(tx, 1), [
    "shared:0x11",
    "shared-mut:0x10",
    "result:0",
    "shared:0x12",
    "pure",
  ]);
  assert.equal(pureByte(tx, 1, 4), 7);
});

test("accepts only nonzero pause masks within funMint, request and claim", () => {
  assert.deepEqual(BLAST_SUI_PAUSE_BITS, { funMint: 1, request: 2, claim: 4 });
  const calls = new BlastSuiCalls(deployment);
  for (const bits of [1, 2, 4, 3, 7]) {
    const tx = new Transaction();
    tx.add(calls.unpause({ unpauseAdmin: "0xadc", bits }));
    assert.equal(pureByte(tx, 0, 4), bits);
  }
  for (const bits of [0, 8, 15, 0xff, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => calls.unpause({ unpauseAdmin: "0xadc", bits }),
      (error: unknown) =>
        error instanceof RangeError &&
        error.message === "pause bits must be a nonzero mask within 7",
    );
  }
});

test("caps the scheduled redeem fee at 100 basis points before building", () => {
  assert.equal(MAX_BLAST_SUI_REDEEM_FEE_BPS, 100n);
  const calls = new BlastSuiCalls(deployment);
  const sdk = new BlastSuiTransactions(deployment);
  assert.doesNotThrow(() =>
    calls.scheduleRedeemFee({
      adminWitness: "0xadc",
      redeemFeeBps: 100n,
      delayMs: 0n,
    }),
  );
  assert.doesNotThrow(() =>
    sdk.scheduleRedeemFee({
      adminCapId: "0xadc",
      redeemFeeBps: 0n,
      delayMs: 0n,
    }),
  );
  for (const redeemFeeBps of [101n, 10_000n]) {
    assert.throws(
      () =>
        calls.scheduleRedeemFee({
          adminWitness: "0xadc",
          redeemFeeBps,
          delayMs: 0n,
        }),
      (error: unknown) =>
        error instanceof RangeError &&
        error.message === "redeemFeeBps must be at most 100",
    );
    assert.throws(
      () =>
        sdk.scheduleRedeemFee({
          adminCapId: "0xadc",
          redeemFeeBps,
          delayMs: 0n,
        }),
      /redeemFeeBps must be at most 100/,
    );
  }
  assert.throws(
    () =>
      calls.scheduleRedeemFee({
        adminWitness: "0xadc",
        redeemFeeBps: -1n,
        delayMs: 0n,
      }),
    /redeemFeeBps must be a u64/,
  );
});

test("transfers each returned Move result to the normalized recipient", () => {
  const sdk = new BlastSuiTransactions(deployment);
  const cases = [
    [sdk.mintFunSui({ poolId: pool, amount: 1n, recipient }), 1],
    [sdk.redeemFunSui({ amount: 2n, recipient }), 1],
    [sdk.claimBlastSui({ receiptId: "0x30", minBlastOut: 0n, recipient }), 0],
    [sdk.cancelDepositReceipt({ receiptId: "0x31", recipient }), 0],
    [sdk.redeemBlastSui({ amount: 3n, minSuiOut: 0n, recipient }), 1],
  ] as const;

  for (const [tx, result] of cases) {
    coverage.check(tx);
    assert.deepEqual(transferredObjects(tx), [
      { Result: result, $kind: "Result" },
    ]);
    assert.equal(transferRecipient(tx), normalizeSuiObjectId(recipient));
  }

  const request = coverage.check(
    sdk.requestBlastSui({ poolId: pool, amount: 4n }),
  );
  assert.deepEqual(moveFunctions(request), [
    "vault::request_blast_sui",
    "deposit_receipt::keep",
  ]);
  assert.deepEqual(moveCalls(request)[1]?.arguments, [
    { Result: 1, $kind: "Result" },
  ]);
  assert.equal(pureHex(request, 0, 3), normalizeSuiObjectId(pool));
  assert.equal(hasTransfer(request), false);

  for (const tx of [
    sdk.donateSui({ amount: 5n }),
    sdk.topUpFunReserve({ amount: 6n }),
    sdk.syncVault(),
    sdk.applyRedeemFee(),
    sdk.applyValidator({ poolId: pool }),
    sdk.applyValidatorDelay(),
  ]) {
    coverage.check(tx);
    assert.equal(hasTransfer(tx), false);
  }
});

test("selects canonical coin types and the configured SUI source", () => {
  const sdk = new BlastSuiTransactions(deployment);
  assert.deepEqual(
    coinIntent(sdk.mintFunSui({ poolId: pool, amount: 1n, recipient })),
    {
      type: "gas",
      balance: 1n,
    },
  );
  assert.deepEqual(
    coinIntent(sdk.requestBlastSui({ poolId: pool, amount: 2n })),
    {
      type: "gas",
      balance: 2n,
    },
  );
  assert.deepEqual(coinIntent(sdk.donateSui({ amount: 3n })), {
    type: "gas",
    balance: 3n,
  });
  assert.deepEqual(coinIntent(sdk.topUpFunReserve({ amount: 4n })), {
    type: "gas",
    balance: 4n,
  });
  assert.deepEqual(coinIntent(sdk.redeemFunSui({ amount: 5n, recipient })), {
    type: normalizeStructTag(`${original}::fun_sui::FUN_SUI`),
    balance: 5n,
  });
  assert.deepEqual(
    coinIntent(sdk.redeemBlastSui({ amount: 6n, minSuiOut: 0n, recipient })),
    {
      type: normalizeStructTag(`${original}::blast_sui::BLAST_SUI`),
      balance: 6n,
    },
  );

  // Without the gas coin, SUI is selected as an ordinary coin type.
  const owned = new BlastSuiTransactions(deployment, { useGasCoin: false });
  assert.equal(
    coinIntent(owned.donateSui({ amount: 1n }))?.type,
    normalizeStructTag("0x2::sui::SUI"),
  );
  assert.equal(
    coinIntent(owned.donateSui({ amount: 1n, useGasCoin: true }))?.type,
    "gas",
  );
});

test("validates all atomic amounts, minimum outputs and delays as u64", () => {
  const calls = new BlastSuiCalls(deployment);
  const sdk = new BlastSuiTransactions(deployment);
  const over = 1n << 64n;

  for (const amount of [-1n, over]) {
    for (const build of [
      () => sdk.mintFunSui({ poolId: pool, amount, recipient }),
      () => sdk.redeemFunSui({ amount, recipient }),
      () => sdk.requestBlastSui({ poolId: pool, amount }),
      () => sdk.donateSui({ amount }),
      () => sdk.topUpFunReserve({ amount }),
      () => sdk.redeemBlastSui({ amount, minSuiOut: 0n, recipient }),
    ]) {
      assert.throws(build, /amount must be a u64/);
    }
  }
  for (const value of [-1n, over]) {
    assert.throws(
      () => calls.claimBlastSui({ receipt: "0x30", minBlastOut: value }),
      /minBlastOut must be a u64/,
    );
    assert.throws(
      () => calls.redeemBlastSui({ blastSuiCoin: "0x31", minSuiOut: value }),
      /minSuiOut must be a u64/,
    );
    assert.throws(
      () =>
        sdk.claimBlastSui({ receiptId: "0x30", minBlastOut: value, recipient }),
      /minBlastOut must be a u64/,
    );
    assert.throws(
      () => sdk.redeemBlastSui({ amount: 1n, minSuiOut: value, recipient }),
      /minSuiOut must be a u64/,
    );
    assert.throws(
      () =>
        sdk.scheduleRedeemFee({
          adminCapId: "0xadc",
          redeemFeeBps: 1n,
          delayMs: value,
        }),
      /delayMs must be a u64/,
    );
    assert.throws(
      () => sdk.scheduleValidatorDelay({ adminCapId: "0xadc", delayMs: value }),
      /delayMs must be a u64/,
    );
  }

  assert.doesNotThrow(() =>
    sdk.mintFunSui({ poolId: pool, amount: 0n, recipient }),
  );
  assert.doesNotThrow(() => sdk.requestBlastSui({ poolId: pool, amount: 0n }));
  assert.doesNotThrow(() =>
    sdk.redeemBlastSui({ amount: 0n, minSuiOut: over - 1n, recipient }),
  );
});

test("exercises every frozen blast Sui builder", () => {
  const builders = Object.values(abi).flatMap((module) =>
    module.functions.filter((candidate) => candidate.sdk === "builder"),
  );
  coverage.assertEveryBuilder(builders.length);
  assert.equal(builders.length, 21);
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

function pureBytes(tx: Transaction, call: number, argument: number): Buffer {
  const arg = moveCalls(tx)[call]?.arguments[argument];
  assert.ok(arg?.$kind === "Input");
  const input = tx.getData().inputs[arg.Input];
  assert.ok(input?.$kind === "Pure");
  return Buffer.from(input.Pure.bytes, "base64");
}

function pureHex(tx: Transaction, call: number, argument: number): string {
  const bytes = pureBytes(tx, call, argument);
  assert.equal(bytes.length, 32);
  return `0x${bytes.toString("hex")}`;
}

function pureU64(tx: Transaction, call: number, argument: number): bigint {
  const bytes = pureBytes(tx, call, argument);
  assert.equal(bytes.length, 8);
  return bytes.readBigUInt64LE();
}

function pureByte(tx: Transaction, call: number, argument: number): number {
  const bytes = pureBytes(tx, call, argument);
  assert.equal(bytes.length, 1);
  return bytes[0] as number;
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

function transferredObjects(tx: Transaction) {
  const command = tx.getData().commands.at(-1);
  assert.ok(command?.$kind === "TransferObjects");
  return command.TransferObjects.objects;
}

function transferRecipient(tx: Transaction): string {
  const command = tx.getData().commands.at(-1);
  assert.ok(command?.$kind === "TransferObjects");
  const address = command.TransferObjects.address;
  assert.ok(address.$kind === "Input");
  const input = tx.getData().inputs[address.Input];
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

function coinIntent(tx: Transaction) {
  const command = tx
    .getData()
    .commands.find(
      (candidate) =>
        candidate.$kind === "$Intent" &&
        candidate.$Intent.name === "CoinWithBalance",
    );
  if (command?.$kind !== "$Intent") return undefined;
  const data = command.$Intent.data as { type: string; balance: bigint };
  return { type: data.type, balance: BigInt(data.balance) };
}
