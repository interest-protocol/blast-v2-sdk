import { appendFileSync, mkdirSync } from "node:fs";
import type { SuiClientTypes } from "@mysten/sui/client";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { assertTarget, client, FINGERPRINT } from "./env.ts";
import { TransactionJournal } from "./journal.ts";

type Include = {
  effects: true;
  events: true;
  balanceChanges: true;
  objectTypes: true;
};
export type Executed = SuiClientTypes.Transaction<Include>;

/** Gas budget for simulated aborts; simulation charges nothing, so it only needs to cover the run. */
const FAILING_GAS_BUDGET = 100_000_000n;

let evidencePath: string | undefined;
const budgetMist = BigInt(process.env.E2E_BUDGET_MIST ?? "500000000");
const txBudgetMist = 100_000_000n;
const journal = new TransactionJournal<Executed>(
  process.env.E2E_STATE ?? "e2e/presale-mainnet/state.local.json",
  FINGERPRINT,
);
export function hasReceipt(label: string): boolean {
  return journal.read(label) !== undefined;
}
/** Starts one scenario's evidence log under `runs/`. */
export function beginEvidence(scenario: string): void {
  const directory = new URL("runs/", import.meta.url);
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  evidencePath = new URL(`${scenario}-${stamp}.jsonl`, directory).pathname;
  record({ kind: "begin", scenario });
}

export function record(entry: Record<string, unknown>): void {
  const line = JSON.stringify(
    { at: new Date().toISOString(), ...entry },
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  if (evidencePath) appendFileSync(evidencePath, `${line}\n`);
}

export function check(
  label: string,
  condition: boolean,
  detail?: unknown,
): void {
  record({ kind: "check", label, pass: condition, detail });
  if (!condition) {
    throw new Error(
      `check failed: ${label} ${JSON.stringify(detail, bigints)}`,
    );
  }
  console.log(`  ✓ ${label}`);
}

export function equal<T>(label: string, actual: T, expected: T): void {
  check(label, actual === expected, { actual, expected });
}

function bigints(_: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

const INCLUDE: Include = {
  effects: true,
  events: true,
  balanceChanges: true,
  objectTypes: true,
};

/**
 * Resolves `tx`'s inputs without the simulation gate, then fixes its gas so
 * building does not simulate again: the SDK refuses to build a transaction
 * whose simulation aborts, and the abort itself is what these checks inspect.
 */
async function prepareFailing(
  signer: Ed25519Keypair,
  tx: Transaction,
): Promise<void> {
  await tx.build({ client, onlyTransactionKind: true });
  const { referenceGasPrice } = await client.core.getReferenceGasPrice();
  const { objects } = await client.core.listCoins({
    owner: signer.toSuiAddress(),
    coinType: "0x2::sui::SUI",
  });
  const gas = objects
    .filter((coin) => BigInt(coin.balance) >= FAILING_GAS_BUDGET)
    .sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)))[0];
  tx.setGasPrice(BigInt(referenceGasPrice));
  tx.setGasBudget(FAILING_GAS_BUDGET);
  if (gas) {
    tx.setGasPayment([
      { objectId: gas.objectId, version: gas.version, digest: gas.digest },
    ]);
    return;
  }
  // Mainnet merges a wallet's gas coins into its address balance, so pay from
  // that balance: no coins, and a one-epoch expiration as the SDK sets it.
  const [{ chainIdentifier }, { systemState }] = await Promise.all([
    client.core.getChainIdentifier(),
    client.core.getCurrentSystemState(),
  ]);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(systemState.epoch),
      maxEpoch: String(BigInt(systemState.epoch) + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainIdentifier,
      nonce: Math.floor(Math.random() * 2 ** 32),
    },
  });
}

/** Validates the exact bytes before signing; retries resubmit the same signed transaction. */
export async function exec(
  label: string,
  signer: Ed25519Keypair,
  tx: Transaction,
  options: { sponsor?: Ed25519Keypair } = {},
): Promise<Executed> {
  await assertTarget();
  let receipt = journal.read(label);
  if (receipt?.executed) {
    check(`${label}: saved receipt succeeded`, receipt.executed.status.success);
    return receipt.executed;
  }
  if (!receipt) {
    journal.reserve(txBudgetMist, budgetMist);
    tx.setSender(signer.toSuiAddress());
    if (options.sponsor) tx.setGasOwner(options.sponsor.toSuiAddress());
    tx.setGasBudget(txBudgetMist);
    const bytes = await tx.build({ client });
    const simulation = await client.core.simulateTransaction({
      transaction: bytes,
      checksEnabled: true,
      include: { effects: true },
    });
    if (simulation.$kind !== "Transaction")
      throw new Error(
        `${label}: validation failed before signing: ${simulation.FailedTransaction.status.error?.message}`,
      );
    const signatures = [(await signer.signTransaction(bytes)).signature];
    if (options.sponsor)
      signatures.push((await options.sponsor.signTransaction(bytes)).signature);
    receipt = {
      transaction: Buffer.from(bytes).toString("base64"),
      signatures,
    };
    journal.write(label, receipt);
  }
  const result = await client.core.executeTransaction({
    transaction: Uint8Array.from(Buffer.from(receipt.transaction, "base64")),
    signatures: receipt.signatures,
    include: INCLUDE,
  });
  const executed = result.Transaction ?? result.FailedTransaction;
  journal.write(label, { ...receipt, executed });
  record({
    kind: "tx",
    label,
    digest: executed.digest,
    status: executed.status,
    gas: executed.effects.gasUsed,
    events: executed.events,
    balanceChanges: executed.balanceChanges,
  });
  if (!executed.status.success)
    throw new Error(
      `${label} failed (${executed.digest}): ${executed.status.error?.message}; reconcile this receipt before continuing`,
    );
  await client.core.waitForTransaction({ digest: executed.digest });
  console.log(`  · ${label} ${executed.digest}`);
  return executed;
}

export type ExpectedAbort =
  /** A Move abort from `module`; `code` is the clever error code or plain abort code. */
  | { module: string; code: number; package?: string }
  /** Any failure whose message matches, for venue or framework errors. */
  | { message: RegExp };

/**
 * Simulates `tx` against current mainnet state and requires it to abort as
 * `expected`. Failures are only simulated; nothing is submitted or paid.
 */
export async function expectAbort(
  label: string,
  signer: Ed25519Keypair,
  tx: Transaction,
  expected: ExpectedAbort,
): Promise<void> {
  tx.setSenderIfNotSet(signer.toSuiAddress());
  await prepareFailing(signer, tx);
  const result = await client.core.simulateTransaction({
    transaction: await tx.build({ client }),
    checksEnabled: true,
    include: { effects: true },
  });
  const simulated = result.Transaction ?? result.FailedTransaction;
  const error = simulated.status.error;
  const abort = error?.$kind === "MoveAbort" ? error.MoveAbort : undefined;
  const code = abort?.cleverError?.errorCode ?? Number(abort?.abortCode);
  const matches =
    result.$kind === "FailedTransaction" &&
    ("message" in expected
      ? expected.message.test(error?.message ?? "")
      : abort?.location?.module === expected.module &&
        code === expected.code &&
        (!expected.package ||
          normalizeStructTag(`${abort.location.package}::m::T`) ===
            normalizeStructTag(`${expected.package}::m::T`)));
  record({
    kind: "abort-simulated",
    label,
    expected: "message" in expected ? String(expected.message) : expected,
    actual: error ?? "success",
    pass: matches,
  });
  if (!matches) {
    throw new Error(
      `${label}: expected abort ${JSON.stringify(expected, (_, v) =>
        v instanceof RegExp ? String(v) : v,
      )}, got ${result.$kind === "FailedTransaction" ? error?.message : "success"}`,
    );
  }
  console.log(`  ✓ ${label} aborts as expected (simulated)`);
}

/** The single object `executed` created whose type matches `type` (prefix match on the struct). */
export function created(executed: Executed, type: string | RegExp): string {
  const ids = createdAll(executed, type);
  if (ids.length !== 1) {
    throw new Error(`expected one created ${type}, found ${ids.length}`);
  }
  return ids[0] as string;
}

export function createdAll(
  executed: Executed,
  type: string | RegExp,
): string[] {
  const types = executed.objectTypes ?? {};
  const prefix =
    typeof type === "string" ? normalizeTypePrefix(type) : undefined;
  return (executed.effects?.changedObjects ?? [])
    .filter((change) => change.idOperation === "Created")
    .map((change) => change.objectId)
    .filter((id) => {
      const objectType = types[id];
      if (!objectType) return false;
      return prefix
        ? objectType.startsWith(prefix)
        : (type as RegExp).test(objectType);
    });
}

/** Expands every address in a type prefix to 64 hex digits, as the API reports types. */
function normalizeTypePrefix(type: string): string {
  return type.replace(/0x[0-9a-fA-F]+(?=::)/g, (address) =>
    normalizeSuiAddress(address),
  );
}

/** The initial shared version of a shared object `executed` created. */
export function sharedVersion(executed: Executed, objectId: string): string {
  const change = executed.effects?.changedObjects.find(
    (entry) => entry.objectId === objectId,
  );
  const owner = change?.outputOwner;
  if (owner?.$kind !== "Shared") {
    throw new Error(`${objectId} is not shared by ${executed.digest}`);
  }
  return String(owner.Shared.initialSharedVersion);
}

/** Events of `executed` whose type ends with `::module::Name` (generic arguments ignored). */
export function events(
  executed: Executed,
  name: string,
): Record<string, unknown>[] {
  return (executed.events ?? [])
    .filter((event) => event.eventType.split("<")[0]?.endsWith(`::${name}`))
    .map((event) => event.json ?? {});
}

export function event(
  executed: Executed,
  name: string,
): Record<string, unknown> {
  const found = events(executed, name);
  if (found.length !== 1) {
    throw new Error(`expected one ${name} event, found ${found.length}`);
  }
  return found[0] as Record<string, unknown>;
}

/** The net balance change of `coinType` for `address` in `executed`. */
export function balanceChange(
  executed: Executed,
  address: string,
  coinType: string,
): bigint {
  const type = normalizeStructTag(coinType);
  return (executed.balanceChanges ?? [])
    .filter(
      (change) =>
        change.address === address &&
        normalizeStructTag(change.coinType) === type,
    )
    .reduce((sum, change) => sum + BigInt(change.amount), 0n);
}

export async function balance(
  address: string,
  coinType: string,
): Promise<bigint> {
  const { balance } = await client.core.getBalance({
    owner: address,
    coinType,
  });
  return BigInt(balance.balance);
}

/**
 * Simulates `tx` against current mainnet state and requires success, for a
 * path whose real execution would consume a one-time resource.
 */
export async function expectSuccess(
  label: string,
  signer: Ed25519Keypair,
  tx: Transaction,
): Promise<void> {
  tx.setSenderIfNotSet(signer.toSuiAddress());
  await prepareFailing(signer, tx);
  const result = await client.core.simulateTransaction({
    transaction: await tx.build({ client }),
    checksEnabled: true,
    include: { effects: true },
  });
  const simulated = result.Transaction ?? result.FailedTransaction;
  record({
    kind: "success-simulated",
    label,
    pass: result.$kind === "Transaction",
    actual: simulated.status.error ?? "success",
  });
  if (result.$kind !== "Transaction") {
    throw new Error(
      `${label}: expected success, got ${simulated.status.error?.message}`,
    );
  }
  console.log(`  ✓ ${label} succeeds (simulated)`);
}
