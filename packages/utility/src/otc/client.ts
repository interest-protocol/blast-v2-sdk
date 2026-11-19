import type {
  ClientWithCoreApi,
  SuiClientRegistration,
} from "@mysten/sui/client";

import type { TakeQuote } from "./quote.ts";
import { quoteTake } from "./quote.ts";
import type { OfferState } from "./state.ts";
import { getOffer } from "./state.ts";
import type { OtcDeployment } from "./transactions.ts";
import { OtcCalls, OtcTransactions } from "./transactions.ts";

export class OtcClient {
  readonly call: OtcCalls;
  readonly tx: OtcTransactions;
  readonly #client: ClientWithCoreApi;

  constructor(client: ClientWithCoreApi, deployment: OtcDeployment) {
    this.#client = client;
    this.call = new OtcCalls(deployment);
    this.tx = new OtcTransactions(deployment);
  }

  async getOffer(objectId: string): Promise<OfferState> {
    return getOffer(
      this.#client,
      objectId,
      this.call.deployment.originalPackageId,
    );
  }

  /** Reads the offer and quotes buying `amount` of it as `sender`, if given. */
  async quoteTake(
    objectId: string,
    amount: bigint,
    sender?: string,
  ): Promise<TakeQuote> {
    return quoteTake(await this.getOffer(objectId), amount, sender);
  }
}

export type OtcExtensionOptions<Name extends string> = OtcDeployment & {
  name?: Name;
};

/** Adds a typed `blastOtc` extension to any Sui Core API client. */
export function blastOtc<const Name extends string = "blastOtc">({
  name = "blastOtc" as Name,
  ...deployment
}: OtcExtensionOptions<Name>): SuiClientRegistration<
  ClientWithCoreApi,
  Name,
  OtcClient
> {
  return {
    name,
    register: (client) => new OtcClient(client, deployment),
  };
}
