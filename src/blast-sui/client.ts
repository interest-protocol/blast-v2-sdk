import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";
import type { CoinSourceOptions } from "../lib/coins.ts";
import type {
  BlastSuiDepositReceiptState,
  BlastSuiVaultState,
} from "./state.ts";
import { getBlastSuiDepositReceipt, getBlastSuiVault } from "./state.ts";
import { BlastSuiCalls, BlastSuiTransactions } from "./transactions.ts";
import type { BlastSuiDeployment } from "./types.ts";

export class BlastSuiClient {
  readonly call: BlastSuiCalls;
  readonly tx: BlastSuiTransactions;
  readonly #client: ClientWithCoreApi;

  constructor(
    client: ClientWithCoreApi,
    deployment: BlastSuiDeployment,
    options: CoinSourceOptions = {},
  ) {
    this.#client = client;
    this.call = new BlastSuiCalls(deployment);
    this.tx = new BlastSuiTransactions(deployment, options);
  }

  async getVault(): Promise<BlastSuiVaultState> {
    return getBlastSuiVault(
      this.#client,
      this.call.deployment.vault.objectId,
      this.call.deployment.originalPackageId,
    );
  }

  async getDepositReceipt(
    objectId: string,
  ): Promise<BlastSuiDepositReceiptState> {
    return getBlastSuiDepositReceipt(
      this.#client,
      objectId,
      this.call.deployment.originalPackageId,
    );
  }
}

export type BlastSuiExtensionOptions<Name extends string> =
  BlastSuiDeployment & { name?: Name };

/** Adds a typed `blastSui` extension to any Sui Core API client. */
export function blastSui<const Name extends string = "blastSui">({
  name = "blastSui" as Name,
  ...deployment
}: BlastSuiExtensionOptions<Name>): SuiClientRegistration<
  ClientWithCoreApi,
  Name,
  BlastSuiClient
> {
  return {
    name,
    register: (client) => new BlastSuiClient(client, deployment),
  };
}
