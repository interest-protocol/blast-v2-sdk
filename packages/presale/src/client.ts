import type { CoinSourceOptions } from "@interest-protocol/blast-core/coins";
import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";
import type { AftermathPoolCreation } from "./aftermath.ts";
import { findAftermathPoolCreation } from "./aftermath.ts";
import { findNativeAftermathPoolCreation } from "./aftermath-native.ts";
import type {
  PresaleCommitment,
  PresaleCreationPolicyState,
  PresaleFeePolicyState,
  PresaleRewardRoundState,
  PresaleState,
  PresaleVaultState,
} from "./state.ts";
import {
  getPresale,
  getPresaleCommitment,
  getPresaleCreationPolicy,
  getPresaleFeePolicy,
  getPresaleRewardRound,
  getPresaleVault,
} from "./state.ts";
import type { PresaleDeployment } from "./transactions.ts";
import { PresaleCalls, PresaleTransactions } from "./transactions.ts";

export class PresaleClient {
  readonly call: PresaleCalls;
  readonly tx: PresaleTransactions;
  readonly #client: ClientWithCoreApi;

  constructor(
    client: ClientWithCoreApi,
    deployment: PresaleDeployment,
    options: CoinSourceOptions = {},
  ) {
    this.#client = client;
    this.call = new PresaleCalls(deployment);
    this.tx = new PresaleTransactions(deployment, options);
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

  /** The deployment's `FeePolicy`: current rates and payout destination. */
  async getFeePolicy(): Promise<PresaleFeePolicyState> {
    return getPresaleFeePolicy(
      this.#client,
      this.call.deployment.feePolicy.objectId,
      this.#originalPackageId,
    );
  }

  /** The deployment's `CreationPolicy`: the Quote types and migrators new presales may use. */
  async getCreationPolicy(): Promise<PresaleCreationPolicyState> {
    return getPresaleCreationPolicy(
      this.#client,
      this.call.deployment.creationPolicy.objectId,
      this.#originalPackageId,
    );
  }

  /** Native reservation and verified shared input; the input is null once migration consumes it. */
  async getNativeAftermathPoolCreation(
    presaleId: string,
    options: { creationDigest?: string; pageLimit?: number } = {},
  ) {
    return findNativeAftermathPoolCreation(this.#client, {
      presaleId,
      originalPackageId: this.#originalPackageId,
      ...options,
    });
  }

  /**
   * `presaleId`'s Aftermath binding: its `PoolCreation` (null once migrated)
   * and `Lp` type, from the `PoolCreationReserved` event. Pass the sale's
   * creation digest to read one transaction instead of scanning the vendor's
   * events. Null for a sale the vendor did not create. Needs
   * `deployment.aftermath`.
   */
  async getAftermathPoolCreation(
    presaleId: string,
    options: { creationDigest?: string } = {},
  ): Promise<AftermathPoolCreation | null> {
    const { aftermath } = this.call.deployment;
    if (!aftermath) {
      throw new TypeError("deployment.aftermath is required for Aftermath");
    }
    return findAftermathPoolCreation(this.#client, {
      presaleId,
      packageId: aftermath.packageId,
      ...options,
    });
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
