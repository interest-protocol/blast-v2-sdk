import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";
import type { RewardRoundState } from "../holder-rewards/state.ts";
import { getRewardRound } from "../holder-rewards/state.ts";
import type { LpFeePolicyState, LpFeeShares, LpVaultState } from "./state.ts";
import { getLpFeePolicy, getLpFeeShares, getLpVault } from "./state.ts";
import type { MigratorsDeployment } from "./transactions.ts";
import { MigratorCalls, MigratorTransactions } from "./transactions.ts";

export class MigratorsClient {
  readonly call: MigratorCalls;
  readonly tx: MigratorTransactions;
  readonly #client: ClientWithCoreApi;

  constructor(client: ClientWithCoreApi, deployment: MigratorsDeployment) {
    this.#client = client;
    this.call = new MigratorCalls(deployment);
    this.tx = new MigratorTransactions(deployment);
  }

  async getLpVault(objectId: string): Promise<LpVaultState> {
    return getLpVault(
      this.#client,
      objectId,
      this.call.deployment.originalPackageId,
    );
  }

  async getLpFeePolicy(): Promise<LpFeePolicyState> {
    return getLpFeePolicy(
      this.#client,
      this.call.deployment.lpFeePolicy.objectId,
      this.call.deployment.originalPackageId,
    );
  }

  /** Blast's live LP-fee shares for `memeType`: its own pair, else the defaults. */
  async getLpFeeShares(
    memeType: string,
  ): Promise<LpFeeShares & { source: "coin" | "default" }> {
    return getLpFeeShares(this.#client, await this.getLpFeePolicy(), memeType);
  }

  async getHolderRewardRound(objectId: string): Promise<RewardRoundState> {
    return getRewardRound(
      this.#client,
      objectId,
      this.call.deployment.originalPackageId,
    );
  }
}

export type MigratorsExtensionOptions<Name extends string> =
  MigratorsDeployment & { name?: Name };

/** Adds a typed `blastMigrators` extension to any Sui Core API client. */
export function blastMigrators<const Name extends string = "blastMigrators">({
  name = "blastMigrators" as Name,
  ...deployment
}: MigratorsExtensionOptions<Name>): SuiClientRegistration<
  ClientWithCoreApi,
  Name,
  MigratorsClient
> {
  return {
    name,
    register: (client) => new MigratorsClient(client, deployment),
  };
}
