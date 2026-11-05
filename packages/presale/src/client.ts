import type { CoinSourceOptions } from "@interest-protocol/blast-core/coins";
import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";
import { findPoolCreation } from "./aftermath-dao.ts";
import type {
  PresaleCommitment,
  PresaleCreationPolicyState,
  PresaleFeePolicyState,
  PresaleState,
} from "./state.ts";
import {
  getPresale,
  getPresaleCommitment,
  getPresaleCreationPolicy,
  getPresaleFeePolicy,
  presaleId,
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

  /** The one presale of `saleTokenType`, at its derived ID. */
  async getPresaleBySaleToken(saleTokenType: string): Promise<PresaleState> {
    return this.getPresale(presaleId(this.call.deployment, saleTokenType));
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

  /** The deployment's `FeePolicy`: the rates new sales snapshot. */
  async getFeePolicy(): Promise<PresaleFeePolicyState> {
    return getPresaleFeePolicy(
      this.#client,
      this.call.deployment.feePolicy.objectId,
      this.#originalPackageId,
    );
  }

  /** The deployment's `CreationPolicy`: the Quotes, venues and partners new sales may use. */
  async getCreationPolicy(): Promise<PresaleCreationPolicyState> {
    return getPresaleCreationPolicy(
      this.#client,
      this.call.deployment.creationPolicy.objectId,
      this.#originalPackageId,
    );
  }

  /**
   * A vendor sale's `PoolCreation`, from its creation transaction's
   * `PoolCreationReserved`. Needs `deployment.aftermathDaoPresale`.
   */
  async getPoolCreation(creationDigest: string) {
    const { aftermathDaoPresale } = this.call.deployment;
    if (!aftermathDaoPresale) {
      throw new TypeError("deployment.aftermathDaoPresale is required");
    }
    return findPoolCreation(this.#client, {
      deployment: aftermathDaoPresale,
      creationDigest,
    });
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
