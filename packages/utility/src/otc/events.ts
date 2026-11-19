import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import { moveTypeNameBcs, suiObjectIdBcs } from "../lib/bcs.ts";
import type { SuiEventPosition } from "../lib/events.ts";
import { normalizeSuiEventPosition, suiEventId } from "../lib/events.ts";
import { OTC_MODULE } from "./transactions.ts";

const AddressBcs = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});
const U64Bcs = bcs.u64().transform({
  input: (value: bigint) => value,
  output: (value) => BigInt(value),
});

/** Field layouts of the three OTC events, in the contract's field order. */
export const otcEventFields = {
  OfferCreated: {
    offer_id: suiObjectIdBcs,
    offered_type: moveTypeNameBcs,
    wanted_type: moveTypeNameBcs,
    taker: bcs.option(AddressBcs),
    partial_fills: bcs.bool(),
    offered_amount: U64Bcs,
    wanted_amount: U64Bcs,
  },
  OfferTaken: {
    offer_id: suiObjectIdBcs,
    amount: U64Bcs,
    paid: U64Bcs,
  },
  OfferCanceled: {
    offer_id: suiObjectIdBcs,
    refund: U64Bcs,
  },
};

export const otcEventBcs = {
  OfferCreated: bcs.struct("OfferCreated", otcEventFields.OfferCreated),
  OfferTaken: bcs.struct("OfferTaken", otcEventFields.OfferTaken),
  OfferCanceled: bcs.struct("OfferCanceled", otcEventFields.OfferCanceled),
};

export type OtcEventName = keyof typeof otcEventBcs;

export type OtcEventPayloads = {
  [Name in OtcEventName]: ReturnType<(typeof otcEventBcs)[Name]["parse"]>;
};

export type OtcEventPackageIdentity = {
  packageId: string;
  originalPackageId: string;
};

/**
 * One decoded OTC event. Events carry no sender field: the transaction sender of
 * `OfferCreated` is the maker, and of `OfferTaken` the taker.
 */
export type DecodedOtcEvent = {
  [Name in OtcEventName]: {
    source: "otc";
    name: Name;
    payload: OtcEventPayloads[Name];
    emitterPackageId: string;
    sender: string;
    position: SuiEventPosition;
  };
}[OtcEventName];

export function decodeOtcEvent(
  event: SuiClientTypes.EventEntry,
  packages: OtcEventPackageIdentity,
): DecodedOtcEvent {
  const currentPackageId = normalizeSuiObjectId(packages.packageId);
  if (normalizeSuiObjectId(event.packageId) !== currentPackageId) {
    throw new TypeError("OTC event has an unexpected emitter package");
  }
  const tag = parseStructTag(event.eventType);
  if (
    tag.address !== normalizeSuiAddress(packages.originalPackageId) ||
    tag.module !== OTC_MODULE ||
    tag.typeParams.length !== 0
  ) {
    throw new TypeError("OTC event has an unexpected event type");
  }
  if (!Object.hasOwn(otcEventBcs, tag.name)) {
    throw new TypeError("unsupported OTC event name");
  }
  if (event.module !== OTC_MODULE) {
    throw new TypeError("OTC event has an unexpected emitter module");
  }

  const name = tag.name as OtcEventName;
  return {
    source: "otc",
    name,
    payload: otcEventBcs[name].parse(event.bcs),
    emitterPackageId: currentPackageId,
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedOtcEvent;
}

export function otcEventId(event: DecodedOtcEvent): string {
  return suiEventId(event.position);
}
