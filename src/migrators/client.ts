import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";
import type { LpVaultState, MigratorVenue, VenueTier } from "./state.ts";
import { getLpVault, getVenueTier } from "./state.ts";
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

  async getVenueTier(venue: MigratorVenue): Promise<VenueTier> {
    return getVenueTier(
      this.#client,
      this.call.deployment.venueConfig.objectId,
      venue,
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
