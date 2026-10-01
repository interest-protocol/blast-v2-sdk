import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from "@mysten/sui/utils";

import { suiObjectIdBcs, u64Bcs } from "../lib/bcs.ts";
import type { SuiEventPosition } from "../lib/events.ts";
import { normalizeSuiEventPosition, suiEventId } from "../lib/events.ts";
import { partnerTermsBcs } from "./state.ts";

/** The `blast_partners` events, in Move field order. */
export const partnerEventBcs = {
  /** After every change, registration included: the partner's complete terms. */
  PartnerUpdated: bcs.struct("PartnerUpdated", {
    partner_id: suiObjectIdBcs,
    ...partnerTermsBcs,
  }),
  /** `amount` of the event's coin type sent to the partner's recipient. */
  PartnerPaid: bcs.struct("PartnerPaid", {
    partner_id: suiObjectIdBcs,
    amount: u64Bcs,
  }),
};

export type PartnerEventKind = keyof typeof partnerEventBcs;

export type PartnerEventPayloads = {
  [Kind in PartnerEventKind]: ReturnType<
    (typeof partnerEventBcs)[Kind]["parse"]
  >;
};

export type DecodedPartnerEvent = {
  [Kind in PartnerEventKind]: {
    source: "partners";
    kind: Kind;
    payload: PartnerEventPayloads[Kind];
    /** `PartnerPaid` only: the paid coin type `T`. */
    coinType: Kind extends "PartnerPaid" ? string : null;
    sender: string;
    position: SuiEventPosition;
  };
}[PartnerEventKind];

/** Decodes one `<partnersPackageId>::blast_partners::<Kind>` event. */
export function decodePartnerEvent(
  event: SuiClientTypes.EventEntry,
  partnersPackageId: string,
): DecodedPartnerEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as PartnerEventKind;
  const [coinType = null, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(partnersPackageId) ||
    tag.module !== "blast_partners" ||
    !Object.hasOwn(partnerEventBcs, kind) ||
    (coinType === null) === (kind === "PartnerPaid") ||
    extra.length > 0
  ) {
    throw new TypeError(`unexpected partner event type ${event.eventType}`);
  }
  return {
    source: "partners",
    kind,
    payload: partnerEventBcs[kind].parse(event.bcs),
    coinType: coinType && normalizeStructTag(coinType),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedPartnerEvent;
}

export function partnerEventId(event: DecodedPartnerEvent): string {
  return suiEventId(event.position);
}
