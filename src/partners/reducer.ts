import type { DecodedPartnerEvent, PartnerEventKind } from "./events.ts";
import { partnerEventBcs, partnerEventId } from "./events.ts";
import type { PartnerTerms } from "./state.ts";

export type PartnerProjection = PartnerTerms & {
  partnerId: string;
  /** Everything sent to the partner, by coin type. */
  paid: Readonly<Record<string, bigint>>;
};

/** Partners rebuilt from their events; terms match `PartnerState` once replayed. */
export type PartnersEventProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  eventCounts: Readonly<Record<PartnerEventKind, number>>;
  partners: Readonly<Record<string, PartnerProjection>>;
};

export function createPartnersEventProjection(): PartnersEventProjection {
  return {
    appliedEventIds: {},
    eventCounts: Object.fromEntries(
      Object.keys(partnerEventBcs).map((kind) => [kind, 0]),
    ) as Record<PartnerEventKind, number>,
    partners: {},
  };
}

/** Applies one event once; replaying an applied event returns `state` unchanged. */
export function reducePartnerEvent(
  state: PartnersEventProjection,
  event: DecodedPartnerEvent,
): PartnersEventProjection {
  const eventId = partnerEventId(event);
  if (state.appliedEventIds[eventId]) return state;
  const next: PartnersEventProjection = {
    ...state,
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
    eventCounts: {
      ...state.eventCounts,
      [event.kind]: state.eventCounts[event.kind] + 1,
    },
  };
  const partnerId = event.payload.partner_id;
  const current = state.partners[partnerId];
  if (event.kind === "PartnerUpdated") {
    const { recipient, share_bps, cap_id } = event.payload;
    return withPartner(next, {
      partnerId,
      recipient,
      shareBps: share_bps,
      capId: cap_id,
      paid: current?.paid ?? {},
    });
  }
  // A partner is registered, with an update, before it can be paid.
  if (!current) return next;
  const coinType = event.coinType;
  return withPartner(next, {
    ...current,
    paid: {
      ...current.paid,
      [coinType]: (current.paid[coinType] ?? 0n) + event.payload.amount,
    },
  });
}

function withPartner(
  state: PartnersEventProjection,
  partner: PartnerProjection,
): PartnersEventProjection {
  return {
    ...state,
    partners: { ...state.partners, [partner.partnerId]: partner },
  };
}
