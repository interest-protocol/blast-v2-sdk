import type { SuiClientTypes } from "@mysten/sui/client";
import type { Argument, CallArg, Command } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

import {
  BASIS_POINTS_DENOMINATOR,
  mulDivDown,
  requirePositiveU64,
  requireU64,
} from "../lib/integers.ts";
import { decodeBoostsActivityEvent } from "./events.ts";
import { getBoostsProduct } from "./manifest.ts";
import type {
  BoostsManifest,
  BoostsProductKey,
  BoostsProductManifest,
  BoostsProductSnapshotV1,
} from "./types.ts";

const TRANSACTION_FRESH_MS = 15_000;
const QUOTE_LIFETIME_MS = 60_000;
const DEFAULT_TOLERANCE_BPS = 100n;
const MIN_TOLERANCE_BPS = 10n;
const MAX_TOLERANCE_BPS = 500n;

export type BoostsOperation = "mint" | "redeem" | "rebalance";

type FreshTransactionInput = Readonly<{
  productKey: BoostsProductKey;
  sender: string;
  snapshot: BoostsProductSnapshotV1;
  nowMs: number;
}>;

export type BoostsExecutionLimits = Readonly<{
  expectedOutputAtoms: bigint;
  toleranceBps: bigint;
  minimumOutputAtoms: bigint;
  deadlineMs: bigint;
  expiresAtMs: bigint;
}>;

export type BoostsSimulation =
  | Readonly<{
      operation: "mint";
      productKey: BoostsProductKey;
      inputAtoms: bigint;
      outputAtoms: bigint;
      feeAtoms: bigint;
    }>
  | Readonly<{
      operation: "redeem";
      productKey: BoostsProductKey;
      inputAtoms: bigint;
      outputAtoms: bigint;
      feeAtoms: bigint;
    }>
  | Readonly<{
      operation: "rebalance";
      productKey: BoostsProductKey;
      outputAtoms: null;
      feeAtoms: null;
    }>;

export type BoostsTransactionShape = Readonly<{
  operation: BoostsOperation;
  sender: string;
  productType: string;
  collateralType: string;
  moveTargets: readonly string[];
  transfers: number;
}>;

export type BoostsIconUpdateInput = Readonly<{
  productKey: BoostsProductKey;
  sender: string;
  adminPackageId: string;
  corePackageId: string;
  authorityId: string;
  adminCapId: string;
  currencyId: string;
  currentName: string;
  currentDescription: string;
  iconUrl: string;
}>;

/** Parses an exact, positive decimal amount without floating-point conversion. */
export function parseBoostsAmount(
  value: string,
  decimals: number,
  label = "amount",
): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError("decimals must be an integer between 0 and 18");
  }
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new TypeError(`${label} must be a positive decimal amount`);
  }
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new RangeError(`${label} supports at most ${decimals} decimals`);
  }
  const atoms = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  return requirePositiveU64(label, atoms);
}

export function parseBoostsCollateralAmount(value: string): bigint {
  return parseBoostsAmount(value, 6, "collateral amount");
}

export function parseBoostsShareAmount(value: string): bigint {
  return parseBoostsAmount(value, 9, "share amount");
}

/** Resolves explicit shares or the connected wallet's complete native balance. */
export function resolveBoostsRedeemAmount(
  value: string | "max",
  balanceAtoms: bigint,
): bigint {
  const balance = requireU64("share balance", balanceAtoms);
  const amount = value === "max" ? balance : parseBoostsShareAmount(value);
  requirePositiveU64("share amount", amount);
  if (amount > balance) throw new RangeError("share amount exceeds balance");
  return amount;
}

/**
 * Derives the holder-safe minimum by multiplying before dividing and rounding
 * down. Any discarded atomic remainder benefits the holder by lowering the
 * minimum accepted output.
 */
export function deriveBoostsExecutionLimits(
  input: Readonly<{
    expectedOutputAtoms: bigint;
    observedAtMs: bigint;
    nowMs: bigint;
    toleranceBps?: bigint;
    deadlineMs?: bigint;
  }>,
): BoostsExecutionLimits {
  const expectedOutputAtoms = requirePositiveU64(
    "expected output",
    input.expectedOutputAtoms,
  );
  const observedAtMs = requireU64("quote observation time", input.observedAtMs);
  const nowMs = requireU64("current time", input.nowMs);
  const toleranceBps = requireU64(
    "output tolerance",
    input.toleranceBps ?? DEFAULT_TOLERANCE_BPS,
  );
  if (toleranceBps < MIN_TOLERANCE_BPS || toleranceBps > MAX_TOLERANCE_BPS) {
    throw new RangeError("output tolerance must be between 10 and 500 bps");
  }
  const expiresAtMs = requireU64(
    "quote expiry",
    observedAtMs + BigInt(QUOTE_LIFETIME_MS),
  );
  if (nowMs > expiresAtMs) throw new RangeError("Boosts quote has expired");
  const deadlineMs = requireU64("deadline", input.deadlineMs ?? expiresAtMs);
  if (deadlineMs < nowMs || deadlineMs > expiresAtMs) {
    throw new RangeError(
      "deadline must be current and no later than the quote expiry",
    );
  }
  return {
    expectedOutputAtoms,
    toleranceBps,
    minimumOutputAtoms: mulDivDown(
      expectedOutputAtoms,
      BASIS_POINTS_DENOMINATOR - toleranceBps,
      BASIS_POINTS_DENOMINATOR,
    ),
    deadlineMs,
    expiresAtMs,
  };
}

/** Normalizes the one product event emitted by a checked Sui simulation. */
export function normalizeBoostsSimulation(
  result: SuiClientTypes.SimulateTransactionResult<{ events: true }>,
  manifest: BoostsManifest,
  productKey: BoostsProductKey,
  operation: BoostsOperation,
): BoostsSimulation {
  if (result.$kind !== "Transaction" || !result.Transaction.status.success) {
    const failed =
      result.$kind === "FailedTransaction"
        ? result.FailedTransaction
        : result.Transaction;
    throw new Error(failed.status.error?.message ?? "Boosts simulation failed");
  }
  const product = getBoostsProduct(manifest, productKey);
  const expectedKind =
    operation === "mint"
      ? "minted"
      : operation === "redeem"
        ? "redeemed"
        : "rebalanced";
  const matches = (result.Transaction.events ?? []).flatMap((event, index) => {
    const decoded = decodeBoostsActivityEvent(
      {
        ...event,
        checkpoint: "0",
        transactionDigest: "simulation",
        eventIndex: index,
      },
      manifest,
      product,
    );
    return decoded.ok && decoded.activity.kind === expectedKind
      ? [decoded.activity]
      : [];
  });
  if (matches.length !== 1) {
    throw new TypeError(
      `Boosts simulation must emit exactly one ${expectedKind} event`,
    );
  }
  const activity = matches[0];
  if (!activity) {
    throw new TypeError(
      `Boosts simulation is missing its ${expectedKind} event`,
    );
  }
  if (activity.kind === "minted") {
    return {
      operation: "mint",
      productKey,
      inputAtoms: BigInt(activity.depositAtoms),
      outputAtoms: BigInt(activity.sharesAtoms),
      feeAtoms: BigInt(activity.feeAtoms),
    };
  }
  if (activity.kind === "redeemed") {
    return {
      operation: "redeem",
      productKey,
      inputAtoms: BigInt(activity.sharesAtoms),
      outputAtoms: BigInt(activity.usdcOutAtoms),
      feeAtoms: BigInt(activity.feeAtoms),
    };
  }
  return {
    operation: "rebalance",
    productKey,
    outputAtoms: null,
    feeAtoms: null,
  };
}

export class BoostsTransactions {
  readonly manifest: BoostsManifest;

  constructor(manifest: BoostsManifest) {
    this.manifest = manifest;
  }

  mint(
    input: FreshTransactionInput &
      Readonly<{
        amountAtoms: bigint;
        availableAtoms: bigint;
        minimumSharesAtoms: bigint;
        deadlineMs: bigint;
      }>,
  ): Transaction {
    const { product, sender } = this.#prepare("mint", input);
    const amount = requireAffordable(
      "collateral",
      input.amountAtoms,
      input.availableAtoms,
    );
    const minimum = requireU64("minimum shares", input.minimumSharesAtoms);
    const deadline = requireLiveDeadline(
      input.deadlineMs,
      input.nowMs,
      input.snapshot.observation.observedAt,
    );
    const transaction = new Transaction();
    transaction.setSender(sender);
    const cash = transaction.coin({
      type: product.collateralType,
      balance: amount,
    });
    const shares = transaction.moveCall({
      target: `${this.manifest.adapterPackage.packageId}::operations::mint`,
      typeArguments: [product.productType, product.collateralType],
      arguments: [
        ...boundObjects(transaction, product),
        cash,
        transaction.pure.u64(minimum),
        transaction.pure.u64(deadline),
        transaction.object(product.clock),
      ],
    });
    transaction.transferObjects([shares], sender);
    assertBoostsTransactionShape(transaction, this.manifest, {
      operation: "mint",
      productKey: input.productKey,
      sender,
    });
    return transaction;
  }

  redeem(
    input: FreshTransactionInput &
      Readonly<{
        sharesAtoms: bigint;
        availableAtoms: bigint;
        minimumCollateralAtoms: bigint;
        deadlineMs: bigint;
      }>,
  ): Transaction {
    const { product, sender } = this.#prepare("redeem", input);
    const amount = requireAffordable(
      "shares",
      input.sharesAtoms,
      input.availableAtoms,
    );
    const minimum = requireU64(
      "minimum collateral",
      input.minimumCollateralAtoms,
    );
    const deadline = requireLiveDeadline(
      input.deadlineMs,
      input.nowMs,
      input.snapshot.observation.observedAt,
    );
    const transaction = new Transaction();
    transaction.setSender(sender);
    const shares = transaction.coin({
      type: product.shareType,
      balance: amount,
    });
    const cash = transaction.moveCall({
      target: `${this.manifest.adapterPackage.packageId}::operations::redeem`,
      typeArguments: [product.productType, product.collateralType],
      arguments: [
        ...boundObjects(transaction, product),
        shares,
        transaction.pure.u64(minimum),
        transaction.pure.u64(deadline),
        transaction.object(product.clock),
      ],
    });
    transaction.transferObjects([cash], sender);
    assertBoostsTransactionShape(transaction, this.manifest, {
      operation: "redeem",
      productKey: input.productKey,
      sender,
    });
    return transaction;
  }

  rebalance(
    input: FreshTransactionInput & Readonly<{ suiBalanceAtoms: bigint }>,
  ): Transaction {
    const { product, sender } = this.#prepare("rebalance", input);
    requirePositiveU64("SUI gas balance", input.suiBalanceAtoms);
    if (!input.snapshot.rebalance.needed) {
      throw new RangeError("rebalance is not needed in the fresh observation");
    }
    const transaction = new Transaction();
    transaction.setSender(sender);
    transaction.moveCall({
      target: `${this.manifest.adapterPackage.packageId}::operations::rebalance`,
      typeArguments: [product.productType, product.collateralType],
      arguments: [
        ...boundObjects(transaction, product),
        transaction.object(product.clock),
      ],
    });
    assertBoostsTransactionShape(transaction, this.manifest, {
      operation: "rebalance",
      productKey: input.productKey,
      sender,
    });
    return transaction;
  }

  #prepare(
    operation: BoostsOperation,
    input: FreshTransactionInput,
  ): { product: BoostsProductManifest; sender: string } {
    const product = getBoostsProduct(this.manifest, input.productKey);
    assertFreshSnapshot(
      this.manifest,
      product,
      input.snapshot,
      operation,
      input.nowMs,
    );
    return { product, sender: normalizeSuiAddress(input.sender) };
  }
}

/** Builds the issuer-authorized transaction that changes only a coin icon. */
export function buildBoostsIconUpdateTransaction(
  manifest: BoostsManifest,
  input: BoostsIconUpdateInput,
): Transaction {
  const product = getBoostsProduct(manifest, input.productKey);
  if (input.currentName !== product.name) {
    throw new TypeError(
      "current coin name does not match the product manifest",
    );
  }
  if (typeof input.currentDescription !== "string") {
    throw new TypeError("current coin description must be a string");
  }
  requireHttpsUrl("icon URL", input.iconUrl);

  const transaction = new Transaction();
  transaction.setSender(normalizeSuiAddress(input.sender));
  const adminWitness = transaction.moveCall({
    target: `${normalizeSuiObjectId(input.adminPackageId)}::acl::sign_in`,
    typeArguments: [
      `${normalizeSuiObjectId(input.corePackageId)}::blast_boosts_core::BLAST_BOOSTS_CORE`,
    ],
    arguments: [
      transaction.object(normalizeSuiObjectId(input.authorityId)),
      transaction.object(normalizeSuiObjectId(input.adminCapId)),
    ],
  });
  transaction.moveCall({
    target: `${manifest.adapterPackage.packageId}::vault::update_metadata`,
    typeArguments: [product.productType, product.collateralType],
    arguments: [
      transaction.sharedObjectRef({ ...product.vault, mutable: false }),
      transaction.object(product.protocol),
      adminWitness,
      transaction.object(normalizeSuiObjectId(input.currencyId)),
      transaction.pure.string(input.currentName),
      transaction.pure.string(input.currentDescription),
      transaction.pure.string(input.iconUrl),
    ],
  });
  return transaction;
}

export function inspectBoostsTransactionShape(
  transaction: Transaction,
): BoostsTransactionShape {
  const data = transaction.getData();
  if (!data.sender)
    throw new TypeError("Boosts transaction sender is required");
  const moveCalls = data.commands.flatMap((command) =>
    command.$kind === "MoveCall" ? [command.MoveCall] : [],
  );
  if (moveCalls.length !== 1) {
    throw new TypeError(
      "Boosts transaction must contain exactly one Move call",
    );
  }
  const call = moveCalls[0];
  if (!call) {
    throw new TypeError("Boosts transaction is missing its Move call");
  }
  if (call.module !== "operations" || !isBoostsOperation(call.function)) {
    throw new TypeError("Boosts transaction has an unsupported Move target");
  }
  if (call.typeArguments.length !== 2) {
    throw new TypeError("Boosts transaction must have two type arguments");
  }
  const [productType, collateralType] = call.typeArguments;
  if (!productType || !collateralType) {
    throw new TypeError("Boosts transaction has incomplete type arguments");
  }
  return {
    operation: call.function,
    sender: data.sender,
    productType: normalizeStructTag(productType),
    collateralType: normalizeStructTag(collateralType),
    moveTargets: [
      `${normalizeSuiObjectId(call.package)}::${call.module}::${call.function}`,
    ],
    transfers: data.commands.filter(
      (command) => command.$kind === "TransferObjects",
    ).length,
  };
}

export function assertBoostsTransactionShape(
  transaction: Transaction,
  manifest: BoostsManifest,
  expected: Readonly<{
    operation: BoostsOperation;
    productKey: BoostsProductKey;
    sender: string;
  }>,
): BoostsTransactionShape {
  const data = transaction.getData();
  const product = getBoostsProduct(manifest, expected.productKey);
  const shape = inspectBoostsTransactionShape(transaction);
  const sender = normalizeSuiAddress(expected.sender);
  const expectedTarget = `${manifest.adapterPackage.packageId}::operations::${expected.operation}`;
  if (
    shape.operation !== expected.operation ||
    shape.sender !== sender ||
    shape.productType !== normalizeStructTag(product.productType) ||
    shape.collateralType !== normalizeStructTag(product.collateralType) ||
    shape.moveTargets[0] !== expectedTarget
  ) {
    throw new TypeError(
      "Boosts transaction does not match the expected operation",
    );
  }
  const command = data.commands.find(
    (candidate): candidate is Extract<Command, { $kind: "MoveCall" }> =>
      candidate.$kind === "MoveCall",
  );
  if (!command) {
    throw new TypeError("Boosts transaction is missing its Move call");
  }
  assertExactMoveArguments(
    command.MoveCall.arguments,
    data.inputs,
    product,
    expected.operation,
  );
  const expectedCommands =
    expected.operation === "rebalance"
      ? ["MoveCall"]
      : ["$Intent", "MoveCall", "TransferObjects"];
  if (
    data.commands.length !== expectedCommands.length ||
    data.commands.some(
      (command, index) => command.$kind !== expectedCommands[index],
    )
  ) {
    throw new TypeError("Boosts transaction contains an unexpected command");
  }
  if (expected.operation === "rebalance") {
    if (shape.transfers !== 0) {
      throw new TypeError("rebalance must not transfer an object");
    }
  } else {
    assertCoinIntent(transaction, product, expected.operation);
    assertReturnedCoinTransfer(transaction, sender);
  }
  return shape;
}

function boundObjects(
  transaction: Transaction,
  product: BoostsProductManifest,
) {
  return [
    transaction.sharedObjectRef(product.vault),
    transaction.object(product.protocol),
    transaction.object(product.venueAccount),
    transaction.object(product.registry),
    transaction.object(product.clearingHouse),
    transaction.object(product.baseOracleStorage),
    transaction.object(product.collateralOracleStorage),
  ];
}

function assertFreshSnapshot(
  manifest: BoostsManifest,
  product: BoostsProductManifest,
  snapshot: BoostsProductSnapshotV1,
  operation: BoostsOperation,
  nowMs: number,
): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError("current time must be a non-negative safe integer");
  }
  if (
    snapshot.observation.network !== manifest.network ||
    snapshot.observation.chainIdentifier !== manifest.chainIdentifier ||
    snapshot.identity.productKey !== product.productKey ||
    normalizeStructTag(snapshot.identity.productType) !== product.productType ||
    normalizeStructTag(snapshot.identity.collateralType) !==
      product.collateralType ||
    normalizeStructTag(snapshot.identity.shareType) !== product.shareType ||
    normalizeSuiObjectId(snapshot.identity.vault) !== product.vault.objectId
  ) {
    throw new TypeError("Boosts snapshot does not match the product manifest");
  }
  requireU64("observation checkpoint", BigInt(snapshot.observation.checkpoint));
  const observedAtMs = Date.parse(snapshot.observation.observedAt);
  if (
    !Number.isFinite(observedAtMs) ||
    new Date(observedAtMs).toISOString() !== snapshot.observation.observedAt ||
    observedAtMs > nowMs ||
    nowMs - observedAtMs > TRANSACTION_FRESH_MS
  ) {
    throw new RangeError("Boosts transaction observation is not fresh");
  }
  if (
    snapshot.lifecycle !== "active" ||
    snapshot.availability[operation] !== true
  ) {
    throw new RangeError(`Boosts ${operation} is not available`);
  }
}

function requireAffordable(
  label: string,
  amountAtoms: bigint,
  availableAtoms: bigint,
): bigint {
  const amount = requirePositiveU64(`${label} amount`, amountAtoms);
  const available = requireU64(`${label} balance`, availableAtoms);
  if (amount > available)
    throw new RangeError(`${label} amount exceeds balance`);
  return amount;
}

function requireLiveDeadline(
  deadlineMs: bigint,
  nowMs: number,
  observedAt: string,
): bigint {
  const deadline = requireU64("deadline", deadlineMs);
  if (deadline < BigInt(nowMs)) throw new RangeError("deadline has expired");
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isSafeInteger(observedAtMs)) {
    throw new TypeError("observation time is invalid");
  }
  if (deadline > BigInt(observedAtMs + QUOTE_LIFETIME_MS)) {
    throw new RangeError("deadline exceeds the quote expiry");
  }
  return deadline;
}

function assertExactMoveArguments(
  args: readonly Argument[],
  inputs: readonly CallArg[],
  product: BoostsProductManifest,
  operation: BoostsOperation,
): void {
  const objectIds = [
    product.vault.objectId,
    product.protocol,
    product.venueAccount,
    product.registry,
    product.clearingHouse,
    product.baseOracleStorage,
    product.collateralOracleStorage,
  ];
  const expectedLength = operation === "rebalance" ? 8 : 11;
  if (args.length !== expectedLength) {
    throw new TypeError("Boosts transaction has the wrong Move argument count");
  }
  objectIds.forEach((objectId, index) => {
    assertObjectInput(
      args[index],
      inputs,
      objectId,
      index === 0 ? product.vault : null,
    );
  });
  if (operation === "rebalance") {
    assertObjectInput(args[7], inputs, product.clock, null);
    return;
  }
  const coin = args[7];
  if (coin?.$kind !== "Result" || coin.Result !== 0) {
    throw new TypeError(
      "Boosts input coin must come from the exact coin-selection intent",
    );
  }
  assertPureU64Input(args[8], inputs, "minimum output");
  assertPureU64Input(args[9], inputs, "deadline");
  assertObjectInput(args[10], inputs, product.clock, null);
}

function assertObjectInput(
  argument: Argument | undefined,
  inputs: readonly CallArg[],
  expectedId: string,
  shared: BoostsProductManifest["vault"] | null,
): void {
  if (argument?.$kind !== "Input" || argument.type !== "object") {
    throw new TypeError("Boosts bound object argument is invalid");
  }
  const input = inputs[argument.Input];
  const expected = normalizeSuiObjectId(expectedId);
  if (shared) {
    if (
      input?.$kind !== "Object" ||
      input.Object.$kind !== "SharedObject" ||
      normalizeSuiObjectId(input.Object.SharedObject.objectId) !== expected ||
      BigInt(input.Object.SharedObject.initialSharedVersion) !==
        BigInt(shared.initialSharedVersion) ||
      input.Object.SharedObject.mutable !== true
    ) {
      throw new TypeError("Boosts vault shared-object reference is invalid");
    }
    return;
  }
  if (
    input?.$kind !== "UnresolvedObject" ||
    normalizeSuiObjectId(input.UnresolvedObject.objectId) !== expected
  ) {
    throw new TypeError("Boosts bound object identity is invalid");
  }
}

function assertPureU64Input(
  argument: Argument | undefined,
  inputs: readonly CallArg[],
  label: string,
): void {
  if (argument?.$kind !== "Input" || argument.type !== "pure") {
    throw new TypeError(`Boosts ${label} argument is invalid`);
  }
  const input = inputs[argument.Input];
  if (
    input?.$kind !== "Pure" ||
    Uint8Array.from(atob(input.Pure.bytes), (byte) => byte.charCodeAt(0))
      .length !== 8
  ) {
    throw new TypeError(`Boosts ${label} must be a pure u64`);
  }
}

function isBoostsOperation(value: string): value is BoostsOperation {
  return value === "mint" || value === "redeem" || value === "rebalance";
}

function requireHttpsUrl(label: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:") {
    throw new TypeError(`${label} must be a valid HTTPS URL`);
  }
}

function assertCoinIntent(
  transaction: Transaction,
  product: BoostsProductManifest,
  operation: "mint" | "redeem",
): void {
  const intent = transaction.getData().commands[0];
  if (
    intent?.$kind !== "$Intent" ||
    intent.$Intent.name !== "CoinWithBalance" ||
    intent.$Intent.data.outputKind !== "coin" ||
    normalizeStructTag(String(intent.$Intent.data.type)) !==
      (operation === "mint" ? product.collateralType : product.shareType) ||
    requirePositiveU64(
      "coin selection amount",
      BigInt(intent.$Intent.data.balance as bigint | string | number),
    ) <= 0n
  ) {
    throw new TypeError("Boosts transaction has an invalid coin selection");
  }
}

function assertReturnedCoinTransfer(
  transaction: Transaction,
  sender: string,
): void {
  const data = transaction.getData();
  const transfer = data.commands[2];
  if (
    transfer?.$kind !== "TransferObjects" ||
    transfer.TransferObjects.objects.length !== 1 ||
    transfer.TransferObjects.objects[0]?.$kind !== "Result" ||
    transfer.TransferObjects.objects[0].Result !== 1 ||
    transfer.TransferObjects.address.$kind !== "Input"
  ) {
    throw new TypeError(
      "Boosts returned coin must be transferred to the sender",
    );
  }
  const input = data.inputs[transfer.TransferObjects.address.Input];
  if (input?.$kind !== "Pure" || decodeAddress(input.Pure.bytes) !== sender) {
    throw new TypeError("Boosts returned coin recipient must be the sender");
  }
}

function decodeAddress(bytes: string): string {
  const raw = Uint8Array.from(atob(bytes), (character) =>
    character.charCodeAt(0),
  );
  if (raw.length !== 32) throw new TypeError("invalid Sui address input");
  return normalizeSuiAddress(
    `0x${Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
}
