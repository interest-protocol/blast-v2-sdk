import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";

import { requirePositiveU64 } from "../lib/integers.ts";
import type { DecodedOtcEvent } from "./events.ts";
import { otcEventId } from "./events.ts";
import { takeCost } from "./quote.ts";

export type OfferProjection = {
  offerId: string;
  offeredType: string;
  wantedType: string;
  /** The sender of `OfferCreated`. */
  maker: string;
  taker: string | null;
  partialFills: boolean;
  offeredAmount: bigint;
  wantedAmount: bigint;
  /** Escrow still for sale. */
  remaining: bigint;
  /** Total the maker has been paid in `Wanted`. */
  paidTotal: bigint;
  fills: number;
  /** `filled` once nothing remains; the offer object lives on until the maker cancels it. */
  status: "open" | "filled" | "canceled";
};

export type OtcProjection = {
  appliedEventIds: Record<string, true>;
  offers: Record<string, OfferProjection>;
};

export function createOtcProjection(): OtcProjection {
  return { appliedEventIds: {}, offers: {} };
}

/** Applies one decoded OTC event; replaying an applied event is a no-op. */
export function reduceOtcEvent(
  state: OtcProjection,
  event: DecodedOtcEvent,
): OtcProjection {
  const eventId = otcEventId(event);
  if (state.appliedEventIds[eventId]) return state;

  const offerId = normalizeSuiObjectId(event.payload.offer_id);
  const offer =
    event.name === "OfferCreated"
      ? createOffer(state, event)
      : event.name === "OfferTaken"
        ? takeOffer(requireOffer(state, offerId), event)
        : cancelOffer(requireOffer(state, offerId), event);
  return {
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
    offers: { ...state.offers, [offerId]: offer },
  };
}

function createOffer(
  state: OtcProjection,
  event: Extract<DecodedOtcEvent, { name: "OfferCreated" }>,
): OfferProjection {
  const payload = event.payload;
  const offerId = normalizeSuiObjectId(payload.offer_id);
  if (state.offers[offerId]) {
    throw new TypeError(`OTC offer ${offerId} was already created`);
  }
  const offeredAmount = requirePositiveU64(
    "offered amount",
    payload.offered_amount,
  );
  return {
    offerId,
    offeredType: normalizeStructTag(payload.offered_type),
    wantedType: normalizeStructTag(payload.wanted_type),
    maker: event.sender,
    taker: payload.taker,
    partialFills: payload.partial_fills,
    offeredAmount,
    wantedAmount: requirePositiveU64("wanted amount", payload.wanted_amount),
    remaining: offeredAmount,
    paidTotal: 0n,
    fills: 0,
    status: "open",
  };
}

function takeOffer(
  offer: OfferProjection,
  event: Extract<DecodedOtcEvent, { name: "OfferTaken" }>,
): OfferProjection {
  if (offer.status !== "open") {
    throw new TypeError(`OTC offer ${offer.offerId} is not open`);
  }
  if (offer.taker !== null && event.sender !== offer.taker) {
    throw new TypeError("OTC take sender is not the named taker");
  }
  const amount = requirePositiveU64("take amount", event.payload.amount);
  if (amount > offer.remaining) {
    throw new RangeError("take amount exceeds the remaining escrow");
  }
  if (!offer.partialFills && amount !== offer.remaining) {
    throw new RangeError("all-or-nothing offer was partly taken");
  }
  if (event.payload.paid !== takeCost(offer, amount)) {
    throw new RangeError("take payment does not match the offer rate");
  }
  const remaining = offer.remaining - amount;
  return {
    ...offer,
    remaining,
    paidTotal: offer.paidTotal + event.payload.paid,
    fills: offer.fills + 1,
    status: remaining === 0n ? "filled" : "open",
  };
}

function cancelOffer(
  offer: OfferProjection,
  event: Extract<DecodedOtcEvent, { name: "OfferCanceled" }>,
): OfferProjection {
  if (offer.status === "canceled") {
    throw new TypeError(`OTC offer ${offer.offerId} is already canceled`);
  }
  if (event.sender !== offer.maker) {
    throw new TypeError("only the maker may cancel an OTC offer");
  }
  if (event.payload.refund !== offer.remaining) {
    throw new RangeError("cancel refund must equal the remaining escrow");
  }
  return { ...offer, remaining: 0n, status: "canceled" };
}

function requireOffer(state: OtcProjection, offerId: string): OfferProjection {
  const offer = state.offers[offerId];
  if (!offer) throw new TypeError(`unknown OTC offer ${offerId}`);
  return offer;
}
