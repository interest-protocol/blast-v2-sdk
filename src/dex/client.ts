import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";
import type { DexTradeLimits } from "./math.ts";
import {
  previewDexBuy,
  previewDexPositionFees,
  previewDexSell,
} from "./math.ts";
import {
  getCanonicalDexPool,
  getDexFactory,
  getDexPool,
  getDexPosition,
  getNativeLpPosition,
  getNativeLpVault,
} from "./state.ts";
import type { DexDeployment } from "./transactions.ts";
import { DexCalls, DexTransactions } from "./transactions.ts";

export class DexClient {
  readonly call: DexCalls;
  readonly tx: DexTransactions;
  readonly #client: ClientWithCoreApi;
  constructor(client: ClientWithCoreApi, deployment: DexDeployment) {
    this.#client = client;
    this.call = new DexCalls(deployment);
    this.tx = new DexTransactions(deployment);
  }
  getPool(objectId: string) {
    return getDexPool(
      this.#client,
      objectId,
      this.call.deployment.originalPackageId,
    );
  }
  getPosition(objectId: string) {
    return getDexPosition(
      this.#client,
      objectId,
      this.call.deployment.originalPackageId,
    );
  }
  getFactory() {
    return getDexFactory(
      this.#client,
      this.call.deployment.factory.objectId,
      this.call.deployment.originalPackageId,
    );
  }
  getCanonicalPool(originalMemeType: string) {
    return getCanonicalDexPool(
      this.#client,
      this.call.deployment.factory.objectId,
      originalMemeType,
      this.call.deployment.originalPackageId,
    );
  }
  getNativeVault(objectId: string) {
    return getNativeLpVault(
      this.#client,
      objectId,
      this.call.deployment.originalPackageId,
    );
  }
  getNativePosition(vaultId: string) {
    return getNativeLpPosition(
      this.#client,
      vaultId,
      this.call.deployment.originalPackageId,
    );
  }
  async previewBuy(
    poolId: string,
    quoteAmount: bigint,
    timestampMs: bigint,
    limits?: DexTradeLimits,
  ) {
    return previewDexBuy(
      await this.getPool(poolId),
      quoteAmount,
      timestampMs,
      limits,
    );
  }
  async previewSell(
    poolId: string,
    memeAmount: bigint,
    timestampMs: bigint,
    limits?: DexTradeLimits,
  ) {
    return previewDexSell(
      await this.getPool(poolId),
      memeAmount,
      timestampMs,
      limits,
    );
  }
  async previewPositionFees(positionId: string) {
    const position = await this.getPosition(positionId);
    return previewDexPositionFees(
      await this.getPool(position.poolId),
      position,
    );
  }
}
export function blastDex<const Name extends string = "blastDex">({
  name = "blastDex" as Name,
  ...deployment
}: DexDeployment & { name?: Name }): SuiClientRegistration<
  ClientWithCoreApi,
  Name,
  DexClient
> {
  return { name, register: (client) => new DexClient(client, deployment) };
}
