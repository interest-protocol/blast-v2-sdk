import { suiEventId } from "@interest-protocol/blast-core/events";
import type { DecodedMigratorsEvent } from "./events.ts";
import type { BluefinPoolTier } from "./state.ts";

/** A Meme's Cetus reservation: its `PoolCreationCap` and tick spacing. */
export type CetusReservation = {
  quoteType: string;
  poolCreationCapId: string;
  tickSpacing: number;
};

/** A Meme's recorded Bluefin tier. */
export type BluefinReservation = BluefinPoolTier & { quoteType: string };

/**
 * The `VenueConfig` records rebuilt from `blast_migrators` events, by Meme
 * type. Each venue keys its own records, so `cetus` and `bluefin` match
 * `getCetusPoolTier`/`getCetusPoolCreationCapId` and `getBluefinPoolTier`
 * once every event is applied.
 */
export type VenueReservationProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  cetus: Readonly<Record<string, CetusReservation>>;
  bluefin: Readonly<Record<string, BluefinReservation>>;
};

export function createVenueReservationProjection(): VenueReservationProjection {
  return { appliedEventIds: {}, cetus: {}, bluefin: {} };
}

/** Applies one event once; replaying an applied event returns `state` unchanged. */
export function reduceVenueReservationEvent(
  state: VenueReservationProjection,
  event: DecodedMigratorsEvent,
): VenueReservationProjection {
  const eventId = suiEventId(event.position);
  if (state.appliedEventIds[eventId]) return state;
  const appliedEventIds = {
    ...state.appliedEventIds,
    [eventId]: true as const,
  };
  switch (event.kind) {
    case "CetusPoolReserved":
      return {
        ...state,
        appliedEventIds,
        cetus: {
          ...state.cetus,
          [event.memeType]: {
            quoteType: event.quoteType,
            poolCreationCapId: event.payload.pool_creation_cap_id,
            tickSpacing: event.payload.tick_spacing,
          },
        },
      };
    case "BluefinPoolTierRecorded":
      return {
        ...state,
        appliedEventIds,
        bluefin: {
          ...state.bluefin,
          [event.memeType]: {
            quoteType: event.quoteType,
            tickSpacing: event.payload.tick_spacing,
            feeRate: event.payload.fee_rate,
          },
        },
      };
  }
}
