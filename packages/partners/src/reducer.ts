import { U64_MAX } from "@interest-protocol/blast-core/integers";
import type {
  DecodedPartnerDelayedEvent,
  DecodedPartnerEvent,
  PartnerEventKind,
} from "./events.ts";
import { partnerEventBcs, partnerEventId } from "./events.ts";

/** A proposed share or cap: it applies only when someone applies it, at or after `readyAtMs`. */
export type PartnerProposal<T> = { value: T; readyAtMs: bigint };

export type PartnerProjection = {
  partnerId: string;
  /** Null until the partner's `PartnerUpdated`. */
  recipient: string | null;
  /** The applied share in basis points; null until its `DelayedCreated`. */
  shareBps: bigint | null;
  /** The applied managing cap; null until its `DelayedCreated`. */
  capId: string | null;
  pendingShare: PartnerProposal<bigint> | null;
  pendingCap: PartnerProposal<string> | null;
  /** Everything sent to the partner, by coin type. */
  paid: Readonly<Record<string, bigint>>;
};

/**
 * Partners rebuilt from their events and their `blast_admin::delayed` events
 * (`decodePartnerDelayedEvent`); terms match `PartnerState` once replayed.
 */
export type PartnersEventProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  /** Counts `blast_partners` events only. */
  eventCounts: Readonly<Record<PartnerEventKind, number>>;
  partners: Readonly<Record<string, PartnerProjection>>;
  /**
   * Each `PartnerList` by parent (the product configuration's ID): every
   * partner it named and the millisecond its acceptance ends (`U64_MAX`
   * while accepted without end). A destroyed list is removed.
   */
  lists: Readonly<Record<string, Readonly<Record<string, bigint>>>>;
};

export function createPartnersEventProjection(): PartnersEventProjection {
  return {
    appliedEventIds: {},
    eventCounts: Object.fromEntries(
      Object.keys(partnerEventBcs).map((kind) => [kind, 0]),
    ) as Record<PartnerEventKind, number>,
    partners: {},
    lists: {},
  };
}

/** Applies one event once; replaying an applied event returns `state` unchanged. */
export function reducePartnerEvent(
  state: PartnersEventProjection,
  event: DecodedPartnerEvent | DecodedPartnerDelayedEvent,
): PartnersEventProjection {
  const eventId = partnerEventId(event);
  if (state.appliedEventIds[eventId]) return state;
  const applied = { ...state.appliedEventIds, [eventId]: true as const };
  if (event.source === "delayed") {
    const partnerId = event.payload.parent;
    return withPartner(
      { ...state, appliedEventIds: applied },
      reduceTerms(state.partners[partnerId] ?? empty(partnerId), event),
    );
  }
  const next: PartnersEventProjection = {
    ...state,
    appliedEventIds: applied,
    eventCounts: {
      ...state.eventCounts,
      [event.kind]: state.eventCounts[event.kind] + 1,
    },
  };
  if (event.kind === "PartnerListDestroyed") {
    const { [event.payload.parent]: _, ...lists } = state.lists;
    return { ...next, lists };
  }
  if (event.kind === "PartnerAdded" || event.kind === "PartnerRemoved") {
    const { parent, partner_id } = event.payload;
    const acceptanceEndsAtMs =
      event.kind === "PartnerAdded"
        ? U64_MAX
        : event.payload.acceptance_ends_at_ms;
    return {
      ...next,
      lists: {
        ...state.lists,
        [parent]: { ...state.lists[parent], [partner_id]: acceptanceEndsAtMs },
      },
    };
  }
  const partnerId = event.payload.partner_id;
  const current = state.partners[partnerId];
  if (event.kind === "PartnerUpdated")
    return withPartner(next, {
      ...(current ?? empty(partnerId)),
      recipient: event.payload.recipient,
    });
  // A partner is registered before it can be paid.
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

/** Applied and proposed terms; readiness alone changes nothing. */
function reduceTerms(
  partner: PartnerProjection,
  event: DecodedPartnerDelayedEvent,
): PartnerProjection {
  const [applied, pending] =
    event.name === "Share"
      ? (["shareBps", "pendingShare"] as const)
      : (["capId", "pendingCap"] as const);
  switch (event.kind) {
    case "DelayedCreated":
    case "DelayedApplied":
      return { ...partner, [applied]: event.payload.value, [pending]: null };
    case "DelayedScheduled":
      return {
        ...partner,
        [pending]: {
          value: event.payload.value,
          readyAtMs: event.payload.ready_at_ms,
        },
      };
    case "DelayedCancelled":
      return { ...partner, [pending]: null };
    default:
      return partner;
  }
}

function empty(partnerId: string): PartnerProjection {
  return {
    partnerId,
    recipient: null,
    shareBps: null,
    capId: null,
    pendingShare: null,
    pendingCap: null,
    paid: {},
  };
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
