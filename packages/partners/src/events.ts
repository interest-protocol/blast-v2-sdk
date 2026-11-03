import type {
  DecodedDelayedEvent,
  DelayedKeySpecs,
} from "@interest-protocol/blast-admin-sdk/events";
import { decodeDelayedEvent } from "@interest-protocol/blast-admin-sdk/events";
import {
  addressBcs,
  suiObjectIdBcs,
  u64Bcs,
  unitKeyBcs,
} from "@interest-protocol/blast-core/bcs";
import type { SuiEventPosition } from "@interest-protocol/blast-core/events";
import {
  normalizeSuiEventPosition,
  suiEventId,
} from "@interest-protocol/blast-core/events";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from "@mysten/sui/utils";

/** The `blast_partners` events, in Move field order. */
export const partnerEventBcs = {
  /**
   * At registration and on every recipient change: the partner's recipient.
   * Share and cap terms are `blast_admin::delayed` events (`partnerDelayedKeys`).
   */
  PartnerUpdated: bcs.struct("PartnerUpdated", {
    partner_id: suiObjectIdBcs,
    recipient: addressBcs,
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

export function partnerEventId(event: { position: SuiEventPosition }): string {
  return suiEventId(event.position);
}

/**
 * `blast_partners` keys of `blast_admin::delayed` settings, each owned by the
 * partner: its share in basis points and its managing cap's ID. Registration
 * emits `DelayedCreated` for both; a proposal changes nothing until
 * `DelayedApplied`.
 */
export const partnerDelayedKeys = {
  Share: {
    key: "blast_partners::ShareKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: u64Bcs,
    valueType: "u64",
  },
  Cap: {
    key: "blast_partners::CapKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: suiObjectIdBcs,
    valueType: "0x2::object::ID",
  },
} as const satisfies DelayedKeySpecs;

export type DecodedPartnerDelayedEvent = DecodedDelayedEvent<
  typeof partnerDelayedKeys
>;

/** Decodes a `<adminPackageId>::delayed` event keyed by `blast_partners`. */
export function decodePartnerDelayedEvent(
  event: SuiClientTypes.EventEntry,
  packages: { adminPackageId: string; partnersPackageId: string },
): DecodedPartnerDelayedEvent {
  return decodeDelayedEvent(event, {
    adminPackageId: packages.adminPackageId,
    packageId: packages.partnersPackageId,
    keys: partnerDelayedKeys,
  });
}
