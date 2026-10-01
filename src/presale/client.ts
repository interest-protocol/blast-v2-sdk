import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";

import type {
  PresaleCommitment,
  PresaleRewardRoundState,
  PresaleState,
  PresaleVaultState,
} from "./state.ts";
import {
  getPresale,
  getPresaleCommitment,
  getPresaleRewardRound,
  getPresaleVault,
} from "./state.ts";
import type { PresaleDeployment } from "./transactions.ts";
import { PresaleCalls, PresaleTransactions } from "./transactions.ts";

export class PresaleClient {
  readonly call: PresaleCalls;
  readonly tx: PresaleTransactions;
  readonly #client: ClientWithCoreApi;

  constructor(client: ClientWithCoreApi, deployment: PresaleDeployment) {
    this.#client = client;
    this.call = new PresaleCalls(deployment);
    this.tx = new PresaleTransactions(deployment);
  }

  async getPresale(objectId: string): Promise<PresaleState> {
    return getPresale(this.#client, objectId, this.#originalPackageId);
  }

  /** `wallet`'s undelivered commitment; null if none or already claimed. */
  async getCommitment(
    presaleId: string,
    wallet: string,
  ): Promise<PresaleCommitment | null> {
    return getPresaleCommitment(
      this.#client,
      presaleId,
      wallet,
      this.#originalPackageId,
    );
  }

  async getVault(objectId: string): Promise<PresaleVaultState> {
    return getPresaleVault(this.#client, objectId, this.#originalPackageId);
  }

  async getHolderRewardRound(
    objectId: string,
  ): Promise<PresaleRewardRoundState> {
    return getPresaleRewardRound(
      this.#client,
      objectId,
      this.#originalPackageId,
    );
  }

  get #originalPackageId(): string {
    return this.call.deployment.originalPackageId;
  }
}

export type PresaleExtensionOptions<Name extends string> = PresaleDeployment & {
  name?: Name;
};

/** Adds a typed `blastPresale` extension to any Sui Core API client. */
export function blastPresale<const Name extends string = "blastPresale">({
  name = "blastPresale" as Name,
  ...deployment
}: PresaleExtensionOptions<Name>): SuiClientRegistration<
  ClientWithCoreApi,
  Name,
  PresaleClient
> {
  return {
    name,
    register: (client) => new PresaleClient(client, deployment),
  };
}
