import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";
import type { BluefinPoolTier } from "./state.ts";
import {
  getBluefinPoolTier,
  getCetusPoolCreationCapId,
  getCetusPoolTier,
} from "./state.ts";
import type { MigratorsDeployment } from "./transactions.ts";
import { MigratorCalls, MigratorTransactions } from "./transactions.ts";

export class MigratorsClient {
  readonly call: MigratorCalls;
  readonly tx: MigratorTransactions;
  readonly #client: ClientWithCoreApi;

  constructor(client: ClientWithCoreApi, deployment: MigratorsDeployment) {
    this.#client = client;
    this.call = new MigratorCalls(deployment);
    this.tx = new MigratorTransactions(this.call.deployment);
  }

  /** The Meme's recorded Cetus tick spacing, or null before `cetus::prepare`. */
  getCetusPoolTier(memeType: string): Promise<number | null> {
    return getCetusPoolTier(this.#client, this.call.deployment, memeType);
  }

  /** The Meme's Cetus `PoolCreationCap` ID, or null before `cetus::prepare`. */
  getCetusPoolCreationCapId(memeType: string): Promise<string | null> {
    return getCetusPoolCreationCapId(
      this.#client,
      this.call.deployment,
      memeType,
    );
  }

  /** The Meme's recorded Bluefin tier, or null before `bluefin::prepare`. */
  getBluefinPoolTier(memeType: string): Promise<BluefinPoolTier | null> {
    return getBluefinPoolTier(this.#client, this.call.deployment, memeType);
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
