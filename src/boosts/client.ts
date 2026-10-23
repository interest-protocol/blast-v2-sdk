import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";

import { normalizeNativeTransactionPosition } from "../lib/events.ts";
import { requireU64 } from "../lib/integers.ts";
import type { SuiPackageReference } from "../lib/sui.ts";
import { decodeBoostsActivityEvent, queryBoostsActivity } from "./events.ts";
import { defineBoostsManifest, getBoostsProduct } from "./manifest.ts";
import {
  assertBoostsTransportChain,
  BoostsObservationError,
  createBoostsSnapshot,
} from "./math.ts";
import {
  decodeBoostsTreasurySupply,
  decodeBoostsVaultObject,
} from "./state.ts";
import type {
  BoostsBinding,
  BoostsManifest,
  BoostsObservation,
  BoostsObservationResult,
  BoostsProductKey,
  BoostsProductManifest,
  BoostsTransport,
  BoostsUnavailableCode,
  BoostsWalletBalances,
} from "./types.ts";

export class BoostsClient {
  readonly manifest: BoostsManifest;
  readonly #transport: BoostsTransport;

  constructor(transport: BoostsTransport, manifest: BoostsManifest) {
    this.#transport = transport;
    this.manifest = defineBoostsManifest(manifest);
  }

  async getProduct(
    productKey: BoostsProductKey,
  ): Promise<BoostsObservationResult> {
    const product = getBoostsProduct(this.manifest, productKey);
    let observation: BoostsObservation | null = null;
    let read: Awaited<ReturnType<BoostsTransport["readProduct"]>>;
    try {
      read = await this.#transport.readProduct(product);
    } catch {
      return {
        ok: false,
        productKey,
        code: "DATA_UNAVAILABLE",
        message: "Boosts product data is temporarily unavailable",
        retryable: true,
        observation,
      };
    }
    try {
      observation = normalizeObservation(read, this.manifest);
      const vault = decodeBoostsVaultObject(
        read.vault,
        product,
        this.manifest.adapterPackage.originalPackageId,
      );
      validateManifestBinding(vault.binding, product);
      if (vault.side !== "long") {
        throw new BoostsObservationError(
          "IDENTITY_MISMATCH",
          "vault position side does not match the configured product",
          false,
        );
      }
      const supply = decodeCurrentSupply(read, product, this.manifest);
      const observationCheckpoint = requireU64(
        "observation checkpoint",
        BigInt(observation.checkpoint),
      );
      const lastCompleted = read.lastCompletedRebalance
        ? normalizeNativeTransactionPosition(
            read.lastCompletedRebalance,
            "last completed rebalance",
          )
        : null;
      if (lastCompleted && lastCompleted.checkpoint > observationCheckpoint) {
        throw new BoostsObservationError(
          "COHERENCE_MISMATCH",
          "last completed rebalance is newer than the observation",
        );
      }
      return {
        ok: true,
        snapshot: createBoostsSnapshot(
          product,
          observation,
          vault,
          supply,
          read.market,
          requireU64("clockTimestampMs", read.clockTimestampMs),
          lastCompleted,
        ),
      };
    } catch (error) {
      const normalized = classifyObservationError(error);
      return {
        ok: false,
        productKey,
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        observation,
      };
    }
  }

  async getProducts(): Promise<
    readonly [BoostsObservationResult, ...BoostsObservationResult[]]
  > {
    const [firstProduct, ...remainingProducts] = this.manifest.products;
    return Promise.all([
      this.getProduct(firstProduct.productKey),
      ...remainingProducts.map(({ productKey }) => this.getProduct(productKey)),
    ]);
  }

  async getWalletBalances(owner: string): Promise<BoostsWalletBalances> {
    const normalizedOwner = normalizeSuiAddress(owner);
    const chainIdentifier = await assertBoostsTransportChain(
      this.#transport,
      this.manifest,
    );
    const products = this.manifest.products;
    const collateralType = products[0].collateralType;
    if (products.some((product) => product.collateralType !== collateralType)) {
      throw new BoostsObservationError(
        "IDENTITY_MISMATCH",
        "Boosts Alpha products must use the same collateral type",
        false,
      );
    }
    const [sui, usdc, ...shareBalances] = await Promise.all([
      this.#transport.getBalance({
        owner: normalizedOwner,
        coinType: "0x2::sui::SUI",
      }),
      this.#transport.getBalance({
        owner: normalizedOwner,
        coinType: collateralType,
      }),
      ...products.map((product) =>
        this.#transport.getBalance({
          owner: normalizedOwner,
          coinType: product.shareType,
        }),
      ),
    ]);
    const productSharesAtoms: Partial<Record<BoostsProductKey, string>> = {};
    products.forEach(({ productKey }, index) => {
      const balance = shareBalances[index];
      if (balance === undefined) {
        throw new TypeError(`missing ${productKey} balance`);
      }
      productSharesAtoms[productKey] = atomicBalance(
        `${productKey} balance`,
        balance,
      );
    });
    return {
      owner: normalizedOwner,
      network: this.manifest.network,
      chainIdentifier,
      suiAtoms: atomicBalance("SUI balance", sui),
      usdcAtoms: atomicBalance("USDC balance", usdc),
      productSharesAtoms,
    };
  }

  async getPackageReference(packageId: string): Promise<SuiPackageReference> {
    await assertBoostsTransportChain(this.#transport, this.manifest);
    if (!this.#transport.getPackageReference) {
      throw new TypeError(
        "Boosts transport does not support package lineage reads",
      );
    }
    const reference = await this.#transport.getPackageReference(packageId);
    if (
      normalizeSuiObjectId(reference.packageId) !==
      normalizeSuiObjectId(packageId)
    ) {
      throw new TypeError(
        "Boosts package lineage read returned another package",
      );
    }
    return reference;
  }

  async getCoinMetadata(coinType: string) {
    await assertBoostsTransportChain(this.#transport, this.manifest);
    if (!this.#transport.getCoinMetadata) {
      throw new TypeError(
        "Boosts transport does not support coin metadata reads",
      );
    }
    return this.#transport.getCoinMetadata(coinType);
  }

  getActivity(
    productKey: BoostsProductKey,
    options: Readonly<{
      limit?: number;
      cursor?: string | null;
      maxScanPages?: number;
    }> = {},
  ) {
    return queryBoostsActivity(
      this.#transport,
      this.manifest,
      getBoostsProduct(this.manifest, productKey),
      options,
    );
  }

  async waitForIndexedVisibility(
    productKey: BoostsProductKey,
    digest: string,
    options: Readonly<{
      timeoutMs?: number;
      pollScheduleMs?: readonly number[];
      signal?: AbortSignal;
    }> = {},
  ) {
    if (!digest) throw new TypeError("transaction digest is required");
    await assertBoostsTransportChain(this.#transport, this.manifest);
    const product = getBoostsProduct(this.manifest, productKey);
    const { timeoutMs, schedule } = normalizeWaitOptions(options);
    const startedAt = Date.now();
    let attempt = 0;
    while (Date.now() - startedAt <= timeoutMs) {
      options.signal?.throwIfAborted();
      const delay = schedule[Math.min(attempt, schedule.length - 1)] ?? 0;
      if (delay > 0) await abortableDelay(delay, options.signal);
      attempt += 1;
      const transaction = await this.#transport.getIndexedTransaction(digest);
      if (!transaction) continue;
      const visible = indexedActivity(
        transaction,
        digest,
        product,
        this.manifest,
      );
      if (visible) return visible;
    }
    throw new BoostsObservationError(
      "COHERENCE_MISMATCH",
      "transaction effects and matching Boosts event did not become index-visible before timeout",
    );
  }
}

function decodeCurrentSupply(
  read: Awaited<ReturnType<BoostsTransport["readProduct"]>>,
  product: BoostsProductManifest,
  manifest: BoostsManifest,
): bigint {
  const hasInspectedSupply = read.currentSupplyAtoms !== undefined;
  const hasTreasuryCap = read.treasuryCap !== undefined;
  if (hasInspectedSupply === hasTreasuryCap) {
    throw new BoostsObservationError(
      "COHERENCE_MISMATCH",
      "product read must provide exactly one current-supply source",
    );
  }
  return hasInspectedSupply
    ? requireU64("Boosts current supply", read.currentSupplyAtoms)
    : decodeBoostsTreasurySupply(
        read.treasuryCap,
        product,
        manifest.adapterPackage.originalPackageId,
      );
}

function normalizeWaitOptions(
  options: Readonly<{
    timeoutMs?: number;
    pollScheduleMs?: readonly number[];
  }>,
): { timeoutMs: number; schedule: readonly number[] } {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  const schedule = options.pollScheduleMs ?? [0, 300, 600, 1_500, 3_500];
  if (
    schedule.length === 0 ||
    schedule.some((delay) => !Number.isSafeInteger(delay) || delay < 0)
  ) {
    throw new RangeError(
      "pollScheduleMs must contain non-negative safe integers",
    );
  }
  return { timeoutMs, schedule };
}

function indexedActivity(
  transaction: NonNullable<
    Awaited<ReturnType<BoostsTransport["getIndexedTransaction"]>>
  >,
  digest: string,
  product: BoostsProductManifest,
  manifest: BoostsManifest,
) {
  if (transaction.digest !== digest) {
    throw new BoostsObservationError(
      "COHERENCE_MISMATCH",
      "indexed transaction digest does not match the requested digest",
    );
  }
  const changedVault = transaction.changedObjectIds.some(
    (objectId) =>
      normalizeSuiObjectId(objectId) ===
      normalizeSuiObjectId(product.vault.objectId),
  );
  if (!changedVault) return null;
  const checkpoint = requireU64(
    "indexed transaction checkpoint",
    BigInt(transaction.checkpoint),
  ).toString();
  for (const [eventIndex, event] of transaction.events.entries()) {
    const decoded = decodeBoostsActivityEvent(
      {
        ...event,
        checkpoint,
        transactionDigest: digest,
        eventIndex,
      },
      manifest,
      product,
    );
    if (decoded.ok) {
      return {
        checkpoint,
        transactionDigest: digest,
        activity: decoded.activity,
      } as const;
    }
  }
  return null;
}

function normalizeObservation(
  read: Awaited<ReturnType<BoostsTransport["readProduct"]>>,
  manifest: BoostsManifest,
): BoostsObservation {
  if (
    read.network !== manifest.network ||
    read.chainIdentifier !== manifest.chainIdentifier
  ) {
    throw new BoostsObservationError(
      "IDENTITY_MISMATCH",
      "product read is from the wrong network or chain",
      false,
    );
  }
  const checkpoint = requireU64(
    "observation checkpoint",
    BigInt(read.checkpoint),
  ).toString();
  const observedAtMs = Date.parse(read.observedAt);
  if (
    !Number.isFinite(observedAtMs) ||
    new Date(observedAtMs).toISOString() !== read.observedAt
  ) {
    throw new BoostsObservationError(
      "COHERENCE_MISMATCH",
      "product read has an invalid observation time",
    );
  }
  return {
    network: manifest.network,
    chainIdentifier: manifest.chainIdentifier,
    checkpoint,
    observedAt: read.observedAt,
    source: "sui",
  };
}

function validateManifestBinding(
  binding: BoostsBinding,
  product: BoostsProductManifest,
): void {
  const expected = {
    accountObjectId: product.venueAccount,
    registryId: product.registry,
    clearingHouseId: product.clearingHouse,
  } as const;
  for (const [field, objectId] of Object.entries(expected) as Array<
    [keyof typeof expected, string]
  >) {
    if (
      normalizeSuiObjectId(binding[field]) !== normalizeSuiObjectId(objectId)
    ) {
      throw new BoostsObservationError(
        "BINDING_MISMATCH",
        `vault ${field} does not match the product manifest`,
        false,
      );
    }
  }
}

function classifyObservationError(error: unknown): {
  code: BoostsUnavailableCode;
  message: string;
  retryable: boolean;
} {
  if (error instanceof BoostsObservationError) return error;
  return {
    code: "MALFORMED_CHAIN_STATE",
    message:
      error instanceof Error ? error.message : "malformed Boosts chain state",
    retryable: false,
  };
}

function atomicBalance(name: string, value: string): string {
  try {
    return requireU64(name, BigInt(value)).toString();
  } catch {
    throw new TypeError(`${name} must be a canonical u64`);
  }
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
