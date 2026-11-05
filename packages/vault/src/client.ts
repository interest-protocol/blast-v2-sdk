import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";
import type {
  RoundState,
  VaultPositions,
  VaultRegistryState,
  VaultState,
} from "./state.ts";
import { getRound, getVault, getVaultRegistry } from "./state.ts";
import type { VaultCalls, VaultDeployment } from "./transactions.ts";
import { VaultTransactions } from "./transactions.ts";

export class VaultClient {
  readonly call: VaultCalls;
  readonly tx: VaultTransactions;
  readonly #client: ClientWithCoreApi;

  constructor(client: ClientWithCoreApi, deployment: VaultDeployment) {
    this.#client = client;
    this.tx = new VaultTransactions(deployment);
    this.call = this.tx.call;
  }

  /** A shared vault, its venue and its positions. */
  async getVault(objectId: string): Promise<VaultState & VaultPositions> {
    return getVault(this.#client, objectId, this.call.deployment);
  }

  async getRound(objectId: string): Promise<RoundState> {
    return getRound(this.#client, objectId, this.call.deployment);
  }

  /** The admitted venue and package witnesses. */
  async getVaultRegistry(): Promise<VaultRegistryState> {
    return getVaultRegistry(this.#client, this.call.deployment);
  }
}

export type VaultExtensionOptions<Name extends string> = VaultDeployment & {
  name?: Name;
};

/** Adds a typed `blastVault` extension to any Sui Core API client. */
export function blastVault<const Name extends string = "blastVault">({
  name = "blastVault" as Name,
  ...deployment
}: VaultExtensionOptions<Name>): SuiClientRegistration<
  ClientWithCoreApi,
  Name,
  VaultClient
> {
  return {
    name,
    register: (client) => new VaultClient(client, deployment),
  };
}
