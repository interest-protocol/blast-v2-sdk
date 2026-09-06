import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";
import { DexClient } from "../dex/client.ts";
import {
  getAutoLpControl,
  getAutoLpCreatorCap,
  getAutoLpPosition,
  getAutoLpVault,
  previewAutoLpCompound,
} from "./state.ts";
import type { AutoLpDeployment } from "./transactions.ts";
import { AutoLpCalls, AutoLpTransactions } from "./transactions.ts";
export class AutoLpClient {
  readonly call: AutoLpCalls;
  readonly tx: AutoLpTransactions;
  readonly #client: ClientWithCoreApi;
  constructor(client: ClientWithCoreApi, deployment: AutoLpDeployment) {
    this.#client = client;
    this.call = new AutoLpCalls(deployment);
    this.tx = new AutoLpTransactions(deployment);
  }
  getVault(objectId: string) {
    return getAutoLpVault(
      this.#client,
      objectId,
      this.call.deployment.originalPackageId,
    );
  }
  getControl() {
    return getAutoLpControl(
      this.#client,
      this.call.deployment.control.objectId,
      this.call.deployment.originalPackageId,
    );
  }
  getPosition(vaultId: string) {
    const dex = this.call.deployment.dex;
    return getAutoLpPosition(
      this.#client,
      vaultId,
      this.call.deployment.originalPackageId,
      dex.originalPackageId ?? dex.packageId,
    );
  }
  getCreatorCap(vaultId: string, launchpadOriginalPackageId: string) {
    return getAutoLpCreatorCap(
      this.#client,
      vaultId,
      this.call.deployment.originalPackageId,
      launchpadOriginalPackageId,
    );
  }
  /** Reads are not atomic across objects; signed input/output limits remain authoritative. */
  async previewCompound(vaultId: string) {
    const vault = await this.getVault(vaultId);
    const [pool, position] = await Promise.all([
      new DexClient(this.#client, this.call.deployment.dex).getPool(
        vault.poolId,
      ),
      this.getPosition(vaultId),
    ]);
    return previewAutoLpCompound(vault, pool, position);
  }
}
export function blastAutoLp<const Name extends string = "blastAutoLp">({
  name = "blastAutoLp" as Name,
  ...deployment
}: AutoLpDeployment & { name?: Name }): SuiClientRegistration<
  ClientWithCoreApi,
  Name,
  AutoLpClient
> {
  return { name, register: (client) => new AutoLpClient(client, deployment) };
}
