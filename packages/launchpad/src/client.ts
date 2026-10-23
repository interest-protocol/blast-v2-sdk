import type { CoinSourceOptions } from "@interest-protocol/blast-core/coins";
import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";
import type {
  BuyPreview,
  OpeningRoundSettlementPreview,
  SellPreview,
} from "./curve.ts";
import {
  previewBuy,
  previewOpeningRoundSettlement,
  previewSell,
} from "./curve.ts";
import type { LaunchConfigState, LaunchState } from "./state.ts";
import { getLaunch, getLaunchConfig, getOpeningRoundBid } from "./state.ts";
import type { LaunchpadDeployment } from "./transactions.ts";
import { LaunchpadCalls, LaunchpadTransactions } from "./transactions.ts";

export class LaunchpadClient {
  readonly call: LaunchpadCalls;
  readonly tx: LaunchpadTransactions;
  readonly #client: ClientWithCoreApi;

  constructor(
    client: ClientWithCoreApi,
    deployment: LaunchpadDeployment,
    options: CoinSourceOptions = {},
  ) {
    this.#client = client;
    this.call = new LaunchpadCalls(deployment);
    this.tx = new LaunchpadTransactions(deployment, options);
  }

  async getLaunch(objectId: string): Promise<LaunchState> {
    return getLaunch(
      this.#client,
      objectId,
      this.call.deployment.originalPackageId,
    );
  }

  /** Previews settling the launch's opening-round pot as it stands. */
  async previewOpeningRoundSettlement(
    launchId: string,
  ): Promise<OpeningRoundSettlementPreview> {
    const launch = await this.getLaunch(launchId);
    if (launch.lifecycle !== "OpeningRound") {
      throw new RangeError(
        `launch ${launch.objectId} is ${launch.lifecycle}, not OpeningRound`,
      );
    }
    return previewOpeningRoundSettlement(launch, launch.openingRoundQuote);
  }

  /** `bidder`'s undelivered opening-round Quote; zero without a bid. */
  async getOpeningRoundBid(launchId: string, bidder: string): Promise<bigint> {
    return getOpeningRoundBid(
      this.#client,
      launchId,
      bidder,
      this.call.deployment.originalPackageId,
    );
  }

  /** The admission policy new launches snapshot, including the exact creation fee. */
  async getLaunchConfig(): Promise<LaunchConfigState> {
    return getLaunchConfig(
      this.#client,
      this.call.deployment.launchConfig.objectId,
      this.call.deployment.originalPackageId,
    );
  }

  async previewBuy(launchId: string, quoteAmount: bigint): Promise<BuyPreview> {
    const launch = await this.getLiveLaunch(launchId);
    return previewBuy(launch, quoteAmount);
  }

  async previewSell(
    launchId: string,
    memeAmount: bigint,
  ): Promise<SellPreview> {
    const launch = await this.getLiveLaunch(launchId);
    return previewSell(launch, memeAmount, launch.sellBurnBps);
  }

  private async getLiveLaunch(launchId: string): Promise<LaunchState> {
    const launch = await this.getLaunch(launchId);
    if (launch.lifecycle !== "Live") {
      throw new RangeError(
        `launch ${launch.objectId} is ${launch.lifecycle}, not Live`,
      );
    }
    return launch;
  }
}

export type LaunchpadExtensionOptions<Name extends string> =
  LaunchpadDeployment & { name?: Name };

/** Adds a typed `blastLaunchpad` extension to any Sui Core API client. */
export function blastLaunchpad<const Name extends string = "blastLaunchpad">({
  name = "blastLaunchpad" as Name,
  ...deployment
}: LaunchpadExtensionOptions<Name>): SuiClientRegistration<
  ClientWithCoreApi,
  Name,
  LaunchpadClient
> {
  return {
    name,
    register: (client) => new LaunchpadClient(client, deployment),
  };
}
