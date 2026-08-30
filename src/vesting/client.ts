import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";
import type { VestingCheckpoint, VestingPreview } from "./schedules.ts";
import { linearVestedAt, vestingPreview } from "./schedules.ts";
import type { CheckpointVestingState, VestingState } from "./state.ts";
import {
  getAllCheckpoints,
  getCheckpointPage,
  getCheckpointVestedAt,
  getCurrentTimestampMs,
  getVesting,
} from "./state.ts";
import type { VestingDeployment } from "./transactions.ts";
import { VestingCalls, VestingTransactions } from "./transactions.ts";

export class VestingClient {
  readonly call: VestingCalls;
  readonly tx: VestingTransactions;
  readonly #client: ClientWithCoreApi;

  constructor(client: ClientWithCoreApi, deployment: VestingDeployment) {
    this.#client = client;
    this.call = new VestingCalls(deployment);
    this.tx = new VestingTransactions(deployment);
  }

  async getVesting(objectId: string): Promise<VestingState> {
    return getVesting(
      this.#client,
      objectId,
      this.call.deployment.originalPackageId,
    );
  }

  async getCurrentTimestampMs(): Promise<bigint> {
    return getCurrentTimestampMs(this.#client);
  }

  async getCheckpointPage(
    vesting: CheckpointVestingState,
    start: bigint = 0n,
    limit?: number,
  ): Promise<VestingCheckpoint[]> {
    return limit === undefined
      ? getCheckpointPage(vesting, start)
      : getCheckpointPage(vesting, start, limit);
  }

  async getAllCheckpoints(
    vesting: CheckpointVestingState,
  ): Promise<VestingCheckpoint[]> {
    return getAllCheckpoints(vesting);
  }

  async preview(
    objectId: string,
    timestampMs: bigint,
  ): Promise<VestingPreview> {
    const state = await this.getVesting(objectId);
    const vested =
      state.kind === "linear"
        ? linearVestedAt(state.totalAmount, state.schedule, timestampMs)
        : getCheckpointVestedAt(state, timestampMs);
    return vestingPreview(state.totalAmount, vested, state.released);
  }
}

export type VestingExtensionOptions<Name extends string> = VestingDeployment & {
  name?: Name;
};

/** Adds a typed `blastVesting` extension to any Sui Core API client. */
export function blastVesting<const Name extends string = "blastVesting">({
  name = "blastVesting" as Name,
  ...deployment
}: VestingExtensionOptions<Name>): SuiClientRegistration<
  ClientWithCoreApi,
  Name,
  VestingClient
> {
  return {
    name,
    register: (client) => new VestingClient(client, deployment),
  };
}
