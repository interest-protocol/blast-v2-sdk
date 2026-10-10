import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { TransactionError } from "@mysten/sui/client";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";
import { suiObjectIdBcs } from "../lib/bcs.ts";
import { requireU64 } from "../lib/integers.ts";
import { decodeBoostsActivityEvent } from "./events.ts";
import { getBoostsProduct } from "./manifest.ts";
import {
  decodeBoostsCapturedSnapshot,
  decodeBoostsVaultObject,
} from "./state.ts";
import type {
  BoostsManifest,
  BoostsProductManifest,
  BoostsProductRead,
  BoostsTransport,
  BoostsVaultObject,
} from "./types.ts";

const OBSERVATION_COMMAND = 0;
const SNAPSHOT_OUTPUT = 0;
const TREASURY_CAP_OUTPUT = 1;
const SUPPLY_OUTPUT = 2;
const CLOCK_OUTPUT = 3;
const MAX_REBALANCE_EVENT_PAGES = 10;
const MAX_OBSERVATION_ATTEMPTS = 4;
const ZERO_ADDRESS = normalizeSuiAddress("0x0");

/** Creates the browser-safe, signer-free Boosts transport for Sui gRPC. */
export function createBoostsGrpcTransport(
  client: SuiGrpcClient,
  manifest: BoostsManifest,
): BoostsTransport {
  return new BoostsGrpcTransport(client, manifest);
}

export class BoostsGrpcTransport implements BoostsTransport {
  readonly #client: SuiGrpcClient;
  readonly #manifest: BoostsManifest;

  constructor(client: SuiGrpcClient, manifest: BoostsManifest) {
    this.#client = client;
    this.#manifest = manifest;
  }

  async readProduct(
    product: BoostsProductManifest,
  ): Promise<BoostsProductRead> {
    this.#assertManifestProduct(product);
    const chainIdentifier = await this.getChainIdentifier();
    if (chainIdentifier !== this.#manifest.chainIdentifier) {
      throw new TypeError("Boosts gRPC client is connected to the wrong chain");
    }

    let lastRace: unknown;
    for (let attempt = 0; attempt < MAX_OBSERVATION_ATTEMPTS; attempt += 1) {
      try {
        return await this.#readProductAttempt(product, chainIdentifier);
      } catch (error) {
        if (!isObservationRace(error)) throw error;
        lastRace = error;
      }
    }
    throw lastRace;
  }

  async #readProductAttempt(
    product: BoostsProductManifest,
    chainIdentifier: string,
  ): Promise<BoostsProductRead> {
    const simulation = await this.#client.simulateTransaction({
      transaction: buildObservationTransaction(this.#manifest, product),
      checksEnabled: false,
      include: { commandResults: true, effects: true },
    });
    if (simulation.$kind !== "Transaction") {
      throw new TypeError("Boosts observation simulation failed");
    }

    const effects = simulation.Transaction.effects;
    if (!effects?.status.success) {
      throw new TypeError("Boosts observation simulation failed");
    }
    const exactInputs = exactReadOnlyInputs(effects, product);
    const clockTimestampMs = decodeU64Output(
      simulation.commandResults,
      OBSERVATION_COMMAND,
      CLOCK_OUTPUT,
      "clock timestamp",
    );
    const { checkpoint, observedAt } =
      await this.#currentObservation(clockTimestampMs);
    const vaultObject = await this.#readExactVault(
      product,
      exactInputs.get(normalizeSuiObjectId(product.vault.objectId)),
    );
    const vault = decodeBoostsVaultObject(
      vaultObject,
      product,
      this.#manifest.adapterPackage.originalPackageId,
    );
    const commandResults = simulation.commandResults;
    const market = decodeBoostsCapturedSnapshot(
      commandOutput(
        commandResults,
        OBSERVATION_COMMAND,
        SNAPSHOT_OUTPUT,
        "market snapshot",
      ),
      vault.binding,
    );
    const treasuryCap = suiObjectIdBcs.parse(
      commandOutput(
        commandResults,
        OBSERVATION_COMMAND,
        TREASURY_CAP_OUTPUT,
        "treasury cap identity",
      ),
    );
    if (treasuryCap !== normalizeSuiObjectId(product.treasuryCap)) {
      throw new TypeError(
        "Boosts retained TreasuryCap identity does not match the manifest",
      );
    }
    const currentSupplyAtoms = decodeU64Output(
      commandResults,
      OBSERVATION_COMMAND,
      SUPPLY_OUTPUT,
      "current supply",
    );

    return {
      network: this.#manifest.network,
      chainIdentifier,
      checkpoint,
      observedAt,
      clockTimestampMs,
      vault: vaultObject,
      currentSupplyAtoms,
      market,
      lastCompletedRebalance: await this.#lastCompletedRebalance(
        product,
        BigInt(checkpoint),
      ),
    };
  }

  async getChainIdentifier(): Promise<string> {
    return (await this.#client.getChainIdentifier()).chainIdentifier;
  }

  async getPackageReference(packageId: string) {
    const normalized = normalizeSuiObjectId(packageId);
    const response = await this.#client.movePackageService.getPackage({
      packageId: normalized,
    }).response;
    const value = response.package;
    if (!value?.storageId || !value.originalId) {
      throw new TypeError("Boosts package lineage is unavailable");
    }
    return {
      packageId: normalizeSuiObjectId(value.storageId),
      originalPackageId: normalizeSuiObjectId(value.originalId),
    };
  }

  async getCoinMetadata(coinType: string) {
    const { coinMetadata } = await this.#client.getCoinMetadata({ coinType });
    return coinMetadata
      ? {
          decimals: coinMetadata.decimals,
          name: coinMetadata.name,
          symbol: coinMetadata.symbol,
        }
      : null;
  }

  async getBalance(input: {
    owner: string;
    coinType: string;
  }): Promise<string> {
    return (await this.#client.getBalance(input)).balance.balance;
  }

  listEvents(
    input: SuiClientTypes.ListEventsOptions,
  ): Promise<SuiClientTypes.ListEventsResponse> {
    return this.#client.listEvents(input);
  }

  async getIndexedTransaction(digest: string) {
    const result = await this.#client
      .getTransaction({
        digest,
        include: { effects: true, events: true, protoJson: true },
      })
      .catch((error: unknown) => {
        if (error instanceof TransactionError && error.reason === "notFound") {
          return null;
        }
        throw error;
      });
    if (result === null) return null;
    const transaction =
      result.$kind === "Transaction"
        ? result.Transaction
        : result.FailedTransaction;
    const checkpoint = protoCheckpoint(result.protoJson);
    if (checkpoint === null) return null;
    return {
      digest: transaction.digest,
      checkpoint,
      events: transaction.events,
      changedObjectIds:
        transaction.effects?.changedObjects.map(({ objectId }) => objectId) ??
        [],
    };
  }

  async getCheckpointTimestampMs(checkpoint: string): Promise<string | null> {
    const value = requireU64("checkpoint", BigInt(checkpoint));
    const response = await this.#client.ledgerService.getCheckpoint({
      checkpointId: { oneofKind: "sequenceNumber", sequenceNumber: value },
      readMask: { paths: ["summary.timestamp"] },
    });
    const timestamp = response.response.checkpoint?.summary?.timestamp;
    return timestamp ? protobufTimestampMs(timestamp).toString() : null;
  }

  async #currentObservation(clockTimestampMs: bigint) {
    const info = await this.#client.ledgerService.getServiceInfo({}).response;
    if (info.chainId !== this.#manifest.chainIdentifier) {
      throw new TypeError("Boosts gRPC client is connected to the wrong chain");
    }
    if (info.checkpointHeight === undefined) {
      throw new TypeError("Boosts current checkpoint metadata is unavailable");
    }
    if (clockTimestampMs > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError("Boosts observation timestamp is not representable");
    }
    // Current observations use the simulated Clock; unchanged inputs may outlive RPC history.
    return {
      checkpoint: requireU64(
        "observation checkpoint",
        info.checkpointHeight,
      ).toString(),
      observedAt: new Date(Number(clockTimestampMs)).toISOString(),
    };
  }

  async #readExactVault(
    product: BoostsProductManifest,
    exact: ExactInput | undefined,
  ): Promise<BoostsVaultObject> {
    if (!exact) throw new TypeError("Boosts simulation did not read the vault");
    const { object } = await this.#client.getObject({
      objectId: product.vault.objectId,
      include: { content: true },
    });
    if (object.version !== exact.version || object.digest !== exact.digest) {
      throw new TypeError("Boosts vault changed during the read");
    }
    if (object.owner.$kind !== "Shared") {
      throw new TypeError("Boosts vault is not shared");
    }
    return {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      mutable: true,
      type: object.type,
      content: object.content,
    };
  }

  async #lastCompletedRebalance(
    product: BoostsProductManifest,
    observationCheckpoint: bigint,
  ) {
    const eventType = normalizeStructTag(
      `${this.#manifest.adapterPackage.originalPackageId}::blast_events::Event<${this.#manifest.adapterPackage.originalPackageId}::events::Rebalanced<${product.productType}>>`,
    );
    let before: string | null = null;
    for (
      let pageIndex = 0;
      pageIndex < MAX_REBALANCE_EVENT_PAGES;
      pageIndex += 1
    ) {
      const page = await this.listEvents({
        filter: { eventType },
        limit: 25,
        before,
        order: "descending",
      });
      const completed = lastRebalanceInPage(
        page.events,
        this.#manifest,
        product,
        observationCheckpoint,
      );
      if (completed) return completed;
      if (!page.hasNextPage || page.endCursor === null) return null;
      before = page.endCursor;
    }
    throw new TypeError("Boosts rebalance history exceeded the bounded scan");
  }

  #assertManifestProduct(product: BoostsProductManifest) {
    const expected = getBoostsProduct(this.#manifest, product.productKey);
    if (
      normalizeSuiObjectId(product.vault.objectId) !==
        normalizeSuiObjectId(expected.vault.objectId) ||
      normalizeStructTag(product.productType) !==
        normalizeStructTag(expected.productType) ||
      normalizeStructTag(product.collateralType) !==
        normalizeStructTag(expected.collateralType)
    ) {
      throw new TypeError("Boosts product is not in this transport manifest");
    }
  }
}

type ExactInput = Readonly<{ version: string; digest: string }>;

function isObservationRace(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    (error.message === "Boosts observation input changed during the read" ||
      error.message === "Boosts vault changed during the read")
  );
}

function buildObservationTransaction(
  manifest: BoostsManifest,
  product: BoostsProductManifest,
): Transaction {
  const transaction = new Transaction();
  transaction.setSender(ZERO_ADDRESS);
  const adapter = normalizeSuiAddress(manifest.adapterPackage.packageId);
  const vault = transaction.sharedObjectRef({
    ...product.vault,
    mutable: false,
  });
  transaction.moveCall({
    target: `${adapter}::operations::observe`,
    typeArguments: [product.productType, product.collateralType],
    arguments: [
      vault,
      transaction.object(product.protocol),
      transaction.object(product.venueAccount),
      transaction.object(product.registry),
      transaction.object(product.clearingHouse),
      transaction.object(product.baseOracleStorage),
      transaction.object(product.collateralOracleStorage),
      transaction.object(product.clock),
    ],
  });
  return transaction;
}

function exactReadOnlyInputs(
  effects: SuiClientTypes.TransactionEffects,
  product: BoostsProductManifest,
): ReadonlyMap<string, ExactInput> {
  const expectedIds = [
    product.vault.objectId,
    product.protocol,
    product.venueAccount,
    product.registry,
    product.clearingHouse,
    product.baseOracleStorage,
    product.collateralOracleStorage,
    product.clock,
  ].map((objectId) => normalizeSuiObjectId(objectId));
  const inputs = new Map<string, ExactInput>();
  for (const object of effects.unchangedConsensusObjects) {
    if (
      object.kind !== "ReadOnlyRoot" ||
      object.version === null ||
      object.digest === null
    ) {
      continue;
    }
    inputs.set(normalizeSuiObjectId(object.objectId), {
      version: object.version,
      digest: object.digest,
    });
  }
  for (const objectId of expectedIds) {
    if (!inputs.has(objectId)) {
      throw new TypeError(
        "Boosts simulation did not expose every exact read-only input",
      );
    }
  }
  return new Map(
    expectedIds.map((objectId) => {
      const input = inputs.get(objectId);
      if (!input) throw new TypeError("Boosts observation input is missing");
      return [objectId, input];
    }),
  );
}

function commandOutput(
  results: readonly SuiClientTypes.CommandResult[],
  command: number,
  outputIndex: number,
  label: string,
): Uint8Array {
  const output = results[command]?.returnValues[outputIndex]?.bcs;
  if (!output) throw new TypeError(`Boosts simulation omitted ${label}`);
  return output;
}

function decodeU64Output(
  results: readonly SuiClientTypes.CommandResult[],
  command: number,
  outputIndex: number,
  label: string,
): bigint {
  return requireU64(
    label,
    BigInt(
      bcs.u64().parse(commandOutput(results, command, outputIndex, label)),
    ),
  );
}

function protobufTimestampMs(timestamp: {
  seconds: bigint;
  nanos: number;
}): bigint {
  if (
    timestamp.seconds < 0n ||
    timestamp.nanos < 0 ||
    timestamp.nanos >= 1_000_000_000
  ) {
    throw new TypeError("invalid checkpoint timestamp");
  }
  return (
    timestamp.seconds * 1_000n + BigInt(Math.trunc(timestamp.nanos / 1_000_000))
  );
}

function protoCheckpoint(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const checkpoint = (value as { checkpoint?: unknown }).checkpoint;
  return typeof checkpoint === "string" ? checkpoint : null;
}

function lastRebalanceInPage(
  events: readonly SuiClientTypes.EventEntry[],
  manifest: BoostsManifest,
  product: BoostsProductManifest,
  observationCheckpoint: bigint,
) {
  for (const event of events) {
    if (event.checkpoint === null) continue;
    const checkpoint = requireU64(
      "rebalance checkpoint",
      BigInt(event.checkpoint),
    );
    if (checkpoint > observationCheckpoint) continue;
    const decoded = decodeBoostsActivityEvent(event, manifest, product);
    if (decoded.ok && decoded.activity.kind === "rebalanced") {
      return {
        checkpoint,
        transactionDigest: decoded.activity.transactionDigest,
      };
    }
  }
  return null;
}
