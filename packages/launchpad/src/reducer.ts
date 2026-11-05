import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import type { DecodedProtocolFeesPaid } from "@interest-protocol/blast-core/protocol-fees";
import type {
  AllocationMemeAmounts,
  AllocationPlan,
  ProtocolAllocation,
} from "./allocation.ts";
import { apportionMeme } from "./allocation.ts";
import type {
  DecodedLaunchpadDelayedEvent,
  DecodedLaunchpadEvent,
  LaunchpadEventKind,
} from "./events.ts";
import { launchpadEventId, launchpadEventSpecs } from "./events.ts";
import type { LaunchLifecycle } from "./state.ts";
import { memeAtomicSupply } from "./template.ts";

export type LaunchMigrationProjection = {
  /** The pool's share, handed to the venue in the `Migration`. */
  meme: bigint;
  quote: bigint;
  disposedMeme: bigint;
  totalSupplyAfter: bigint;
};

export type LaunchAllocationPayment = {
  destination: string;
  meme: bigint;
  quote: bigint;
};

export type LaunchEventProjection = {
  launchId: string;
  ticketId: string;
  memeType: string;
  quoteType: string;
  /** The venue witness type the liquidity migrates to. */
  venue: string;
  launcher: string;
  metadataCapId: string;
  lifecycle: LaunchLifecycle;
  decimals: number;
  atomicSupply: bigint;
  sellBurnBps: bigint;
  lpFeeSplit: FeeSplit;
  /** The finalized plan, Blast's shares set. */
  allocationPlan: AllocationPlan;
  /** Meme apportioned at finalization. */
  memeAmounts: AllocationMemeAmounts;
  memeReserve: bigint;
  realQuoteReserve: bigint;
  pendingBurn: bigint;
  /** Pooled non-curve Meme allocations awaiting migration payout. */
  allocatedMeme: bigint;
  protocolMemeFees: bigint;
  creatorMemeFees: bigint;
  protocolQuoteFees: bigint;
  creatorQuoteFees: bigint;
  /** Blast's SUI: the creation fee until Blast claims it. */
  protocolSuiFees: bigint;
  /** Blast's one-time Meme and Quote migration fee (`ProtocolFeesAccrued`). */
  protocolMigrationFee: { meme: bigint; quote: bigint } | null;
  virtualQuote: bigint;
  graduationTarget: bigint;
  quoteFeeBps: bigint;
  memeFeeBps: bigint;
  creationFee: bigint;
  partnerId: string | null;
  openingRoundMs: bigint;
  /** Undelivered opening-round bids: the pot until settlement. */
  openingRoundBids: bigint;
  openingRoundQuote: bigint;
  openingRoundMeme: bigint;
  /** Each bidder's undelivered bid; a keeper delivers every entry after settlement. */
  openingRoundBidders: Readonly<Record<string, bigint>>;
  publicStartMs: bigint | null;
  migration: LaunchMigrationProjection | null;
  allocationPayments: LaunchAllocationPayment[];
  /** Live `CurveFeeCap`, from cap claims and reassignments. */
  curveFeeCapId: string | null;
  /** Live `CreatorMetadataCap`, from cap claims and reassignments. */
  creatorMetadataCapId: string | null;
  /** Coin metadata after the most recent launch metadata update, if any. */
  memeMetadata: LaunchMemeMetadataProjection | null;
};

export type LaunchMemeMetadataProjection = {
  name: string;
  description: string;
  iconUrl: string;
};

export type LaunchTicketEventProjection = {
  ticketId: string;
  memeType: string;
  decimals: number;
  atomicSupply: bigint;
  metadataCapId: string;
  launcher: string;
  creatorAddress: string | null;
  accountCommitment: Uint8Array | null;
  burnable: boolean;
  sellBurnBps: bigint;
};

/** Values below are null until their `DelayedCreated` event. */
export type LaunchpadConfigProjection = {
  protocolFeeShareBps: bigint | null;
  tradeFeeDefaults: {
    quoteFeeBps: bigint;
    memeFeeBps: bigint;
  } | null;
  /** Admitted Quotes; each creator picks its virtual reserve. */
  quotes: Readonly<Record<string, true>>;
  /** Admitted venue witness types. */
  venues: Readonly<Record<string, true>>;
  /**
   * Admitted Meme precisions. `LaunchConfig` starts with six and nine without
   * emitting an event, so the projection starts there too.
   */
  memeDecimals: Readonly<Record<number, true>>;
  /** Blast's one-time migration fee; `LaunchConfig` starts at 250 Meme / 150 Quote bps. */
  protocolAllocation: ProtocolAllocation;
  /** Blast's LP-fee share of new vaults; `LaunchConfig` starts at 1,500 / 1,500 bps. */
  protocolLpFees: { memeBps: bigint; quoteBps: bigint };
  /** SUI, in MIST, each launch pays at creation; zero initially. */
  creationFee: bigint;
};

export type LaunchpadAdministrationProjection = {
  creatorCapClaims: Readonly<
    Record<
      string,
      {
        memeType: string;
        claimant: string;
        curveFeeCapId: string;
        creatorMetadataCapId: string;
      }
    >
  >;
  /** Hex Ed25519 keys that may sign account claims; any one verifies. */
  creatorClaimSigners: Readonly<Record<string, true>>;
  /**
   * Latest proposals by `delayedPolicyKey`. Crossing ready_at_ms never
   * applies their values.
   */
  pendingPolicies: Readonly<Record<string, DecodedLaunchpadDelayedEvent>>;
  /** Applied delays by `delayedPolicyKey`, without a set member. */
  policyDelays: Readonly<Record<string, bigint>>;
};

export type LaunchpadEventProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  eventCounts: Readonly<Record<LaunchpadEventKind, number>>;
  launches: Readonly<Record<string, LaunchEventProjection>>;
  tickets: Readonly<Record<string, LaunchTicketEventProjection>>;
  config: LaunchpadConfigProjection;
  administration: LaunchpadAdministrationProjection;
};

export function createLaunchpadEventProjection(): LaunchpadEventProjection {
  return {
    appliedEventIds: {},
    eventCounts: Object.fromEntries(
      Object.keys(launchpadEventSpecs).map((kind) => [kind, 0]),
    ) as Record<LaunchpadEventKind, number>,
    launches: {},
    tickets: {},
    config: {
      protocolFeeShareBps: null,
      tradeFeeDefaults: null,
      quotes: {},
      venues: {},
      memeDecimals: { 6: true, 9: true },
      protocolAllocation: { memeBps: 250n, quoteBps: 150n },
      protocolLpFees: { memeBps: 1_500n, quoteBps: 1_500n },
      creationFee: 0n,
    },
    administration: {
      creatorCapClaims: {},
      creatorClaimSigners: {},
      pendingPolicies: {},
      policyDelays: {},
    },
  };
}

/**
 * Applies one launchpad event, one `delayed` event decoded by
 * `decodeLaunchpadDelayedEvent`, or one core `ProtocolFeesPaid` (a launch's
 * fees paid to the treasury and partner), once. `eventCounts` counts launchpad
 * events.
 */
export function reduceLaunchpadEvent(
  state: LaunchpadEventProjection,
  event:
    | DecodedLaunchpadEvent
    | DecodedLaunchpadDelayedEvent
    | DecodedProtocolFeesPaid,
): LaunchpadEventProjection {
  const eventId = launchpadEventId(event);
  if (state.appliedEventIds[eventId]) return state;
  if (event.source === "core")
    // `protocol_fees::pay` empties the ledger it pays from.
    return updateLaunch(
      {
        ...state,
        appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
      },
      event.payload.origin,
      (launch) => ({
        ...launch,
        protocolMemeFees: 0n,
        protocolQuoteFees: 0n,
        protocolSuiFees: 0n,
      }),
    );
  if (event.source === "delayed")
    return reduceDelayed(
      {
        ...state,
        administration: reduceDelayedPolicy(state.administration, event),
        appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
      },
      event,
    );

  const next: LaunchpadEventProjection = {
    ...state,
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
    eventCounts: {
      ...state.eventCounts,
      [event.kind]: state.eventCounts[event.kind] + 1,
    },
  };

  switch (event.kind) {
    case "LaunchTicketCreated": {
      const payload = event.payload;
      return {
        ...next,
        tickets: {
          ...state.tickets,
          [payload.ticket_id]: {
            ticketId: payload.ticket_id,
            memeType: event.memeType as string,
            decimals: payload.decimals,
            atomicSupply: memeAtomicSupply(payload.decimals),
            metadataCapId: payload.metadata_cap_id,
            launcher: event.sender,
            creatorAddress:
              payload.creator.kind === "address"
                ? payload.creator.address
                : null,
            accountCommitment:
              payload.creator.kind === "account"
                ? payload.creator.accountCommitment
                : null,
            burnable: payload.burnable,
            sellBurnBps: payload.sell_burn_bps,
          },
        },
      };
    }
    case "LaunchCreated": {
      const payload = event.payload;
      const ticket = state.tickets[payload.ticket_id];
      if (!ticket)
        throw new Error(`unknown launch ticket ${payload.ticket_id}`);
      const memeAmounts = apportionMeme(
        payload.allocation_plan,
        ticket.atomicSupply,
      );
      return {
        ...next,
        launches: {
          ...state.launches,
          [payload.launch_id]: {
            launchId: payload.launch_id,
            ticketId: payload.ticket_id,
            memeType: ticket.memeType,
            quoteType: event.quoteType as string,
            venue: payload.venue,
            launcher: ticket.launcher,
            metadataCapId: ticket.metadataCapId,
            lifecycle: payload.opening_round_ms > 0n ? "OpeningRound" : "Live",
            decimals: ticket.decimals,
            atomicSupply: ticket.atomicSupply,
            sellBurnBps: ticket.sellBurnBps,
            lpFeeSplit: payload.lp_fee_split,
            allocationPlan: payload.allocation_plan,
            memeAmounts,
            memeReserve: memeAmounts.curve,
            realQuoteReserve: 0n,
            pendingBurn: 0n,
            allocatedMeme: ticket.atomicSupply - memeAmounts.curve,
            protocolMemeFees: 0n,
            creatorMemeFees: 0n,
            protocolQuoteFees: 0n,
            creatorQuoteFees: 0n,
            protocolSuiFees: payload.creation_fee,
            protocolMigrationFee: null,
            virtualQuote: payload.virtual_quote,
            graduationTarget: payload.graduation_target,
            quoteFeeBps: payload.quote_fee_bps,
            memeFeeBps: payload.meme_fee_bps,
            creationFee: payload.creation_fee,
            partnerId: payload.partner_id,
            openingRoundMs: payload.opening_round_ms,
            openingRoundBids: 0n,
            openingRoundQuote: 0n,
            openingRoundMeme: 0n,
            openingRoundBidders: {},
            publicStartMs: null,
            migration: null,
            allocationPayments: [],
            curveFeeCapId: null,
            creatorMetadataCapId: null,
            memeMetadata: null,
          },
        },
      };
    }
    case "LaunchShared": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        publicStartMs: payload.public_start_ms,
      }));
    }
    case "OpeningRoundJoined": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        openingRoundBids: payload.bids,
        openingRoundQuote: launch.openingRoundQuote + payload.quote_amount,
        openingRoundBidders: {
          ...launch.openingRoundBidders,
          [event.sender]:
            (launch.openingRoundBidders[event.sender] ?? 0n) +
            payload.quote_amount,
        },
      }));
    }
    case "OpeningRoundSettled": {
      // The pot's `Bought` precedes this event and already set MigrationReady
      // when it reached the target.
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        lifecycle:
          launch.lifecycle === "OpeningRound" ? "Live" : launch.lifecycle,
        openingRoundBids: payload.bids,
        openingRoundMeme: payload.meme_amount,
        openingRoundQuote: payload.quote_amount,
      }));
    }
    case "OpeningRoundDelivered": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        openingRoundBids: launch.openingRoundBids - payload.bid,
        openingRoundMeme: launch.openingRoundMeme - payload.meme_amount,
        openingRoundQuote: launch.openingRoundQuote - payload.quote_amount,
        openingRoundBidders: withEntry(
          launch.openingRoundBidders,
          payload.bidder,
          undefined,
        ),
      }));
    }
    case "Bought": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        lifecycle:
          payload.real_quote_reserve >= launch.graduationTarget
            ? "MigrationReady"
            : launch.lifecycle,
        memeReserve: payload.meme_reserve,
        realQuoteReserve: payload.real_quote_reserve,
        ...accrueTradeFees(launch, payload),
      }));
    }
    case "Sold": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        memeReserve: payload.meme_reserve,
        realQuoteReserve: payload.real_quote_reserve,
        pendingBurn: launch.pendingBurn + payload.pending_burn,
        ...accrueTradeFees(launch, payload),
      }));
    }
    case "CreatorFeesClaimed":
      return updateLaunch(next, event.payload.launch_id, (launch) => ({
        ...launch,
        creatorMemeFees: 0n,
        creatorQuoteFees: 0n,
      }));
    case "ProtocolFeesAccrued": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        allocatedMeme: launch.allocatedMeme - payload.meme_amount,
        realQuoteReserve: launch.realQuoteReserve - payload.quote_amount,
        protocolMemeFees: launch.protocolMemeFees + payload.meme_amount,
        protocolQuoteFees: launch.protocolQuoteFees + payload.quote_amount,
        protocolMigrationFee: {
          meme: payload.meme_amount,
          quote: payload.quote_amount,
        },
      }));
    }
    case "MigrationAllocationPaid": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        lifecycle: "Migrated",
        allocatedMeme: launch.allocatedMeme - payload.meme_amount,
        realQuoteReserve: launch.realQuoteReserve - payload.quote_amount,
        allocationPayments: [
          ...launch.allocationPayments,
          {
            destination: payload.destination,
            meme: payload.meme_amount,
            quote: payload.quote_amount,
          },
        ],
      }));
    }
    case "Migrated": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        lifecycle: "Migrated",
        memeReserve: 0n,
        realQuoteReserve: 0n,
        pendingBurn: 0n,
        allocatedMeme: 0n,
        migration: {
          meme: payload.meme_amount,
          quote: payload.quote_amount,
          disposedMeme: payload.disposed_meme,
          totalSupplyAfter: payload.total_supply_after,
        },
      }));
    }
    case "QuoteAllowed":
      return updateConfig(next, {
        ...state.config,
        quotes: withEntry(
          state.config.quotes,
          event.quoteType as string,
          event.payload.allowed || undefined,
        ),
      });
    case "MemeDecimalsAllowed": {
      const { decimals, allowed } = event.payload;
      return updateConfig(next, {
        ...state.config,
        memeDecimals: withEntry(
          state.config.memeDecimals,
          decimals,
          allowed || undefined,
        ),
      });
    }
    case "CreatorCapsClaimed": {
      const payload = event.payload;
      const memeType = event.memeType as string;
      const claimed = updateLaunchesByMeme(next, memeType, (launch) => ({
        ...launch,
        curveFeeCapId: payload.curve_fee_cap_id,
        creatorMetadataCapId: payload.creator_metadata_cap_id,
      }));
      return updateAdministration(claimed, {
        ...next.administration,
        creatorCapClaims: {
          ...next.administration.creatorCapClaims,
          [memeType]: {
            memeType,
            claimant: event.sender,
            curveFeeCapId: payload.curve_fee_cap_id,
            creatorMetadataCapId: payload.creator_metadata_cap_id,
          },
        },
      });
    }
    case "CurveFeeCapReassigned": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        curveFeeCapId: payload.curve_fee_cap_id,
      }));
    }
    case "CreatorMetadataCapReassigned": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        creatorMetadataCapId: payload.creator_metadata_cap_id,
      }));
    }
    case "MemeMetadataUpdated": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        memeMetadata: {
          name: payload.name,
          description: payload.description,
          iconUrl: payload.icon_url,
        },
      }));
    }
  }
  return next;
}

function accrueTradeFees(
  launch: LaunchEventProjection,
  fees: {
    protocol_meme_fee: bigint;
    creator_meme_fee: bigint;
    protocol_quote_fee: bigint;
    creator_quote_fee: bigint;
  },
) {
  return {
    protocolMemeFees: launch.protocolMemeFees + fees.protocol_meme_fee,
    creatorMemeFees: launch.creatorMemeFees + fees.creator_meme_fee,
    protocolQuoteFees: launch.protocolQuoteFees + fees.protocol_quote_fee,
    creatorQuoteFees: launch.creatorQuoteFees + fees.creator_quote_fee,
  };
}

/** Copies `record` with `key` set to `value`, or removed when `value` is undefined. */
function withEntry<Key extends string | number, Value>(
  record: Readonly<Record<Key, Value>>,
  key: Key,
  value: Value | undefined,
): Record<Key, Value> {
  const copy = { ...record } as Record<Key, Value>;
  if (value === undefined) delete copy[key];
  else copy[key] = value;
  return copy;
}

function updateLaunch(
  state: LaunchpadEventProjection,
  launchId: string,
  update: (launch: LaunchEventProjection) => LaunchEventProjection,
): LaunchpadEventProjection {
  const launch = state.launches[launchId];
  if (!launch) return state;
  return {
    ...state,
    launches: { ...state.launches, [launchId]: update(launch) },
  };
}

function updateLaunchesByMeme(
  state: LaunchpadEventProjection,
  memeType: string,
  update: (launch: LaunchEventProjection) => LaunchEventProjection,
): LaunchpadEventProjection {
  const matches = Object.values(state.launches).filter(
    (launch) => launch.memeType === memeType,
  );
  if (matches.length === 0) return state;
  const launches = { ...state.launches };
  for (const launch of matches) launches[launch.launchId] = update(launch);
  return { ...state, launches };
}

function updateConfig(
  state: LaunchpadEventProjection,
  config: LaunchpadConfigProjection,
): LaunchpadEventProjection {
  return { ...state, config };
}

function updateAdministration(
  state: LaunchpadEventProjection,
  administration: LaunchpadAdministrationProjection,
): LaunchpadEventProjection {
  return { ...state, administration };
}

/** Applied launchpad settings and venue and signer memberships from delayed events. */
function reduceDelayed(
  state: LaunchpadEventProjection,
  event: DecodedLaunchpadDelayedEvent,
): LaunchpadEventProjection {
  const config = state.config;
  if (event.kind === "DelayedCreated" || event.kind === "DelayedApplied") {
    switch (event.name) {
      case "TradeFees":
        return updateConfig(state, {
          ...config,
          tradeFeeDefaults: {
            quoteFeeBps: event.payload.value.quote_fee_bps,
            memeFeeBps: event.payload.value.meme_fee_bps,
          },
        });
      case "ProtocolAllocation":
        return updateConfig(state, {
          ...config,
          protocolAllocation: { ...event.payload.value },
        });
      case "ProtocolLpFees":
        return updateConfig(state, {
          ...config,
          protocolLpFees: {
            memeBps: event.payload.value.meme_bps,
            quoteBps: event.payload.value.quote_bps,
          },
        });
      case "CreationFee":
        return updateConfig(state, {
          ...config,
          creationFee: event.payload.value,
        });
      case "ProtocolFeeShare":
        return updateConfig(state, {
          ...config,
          protocolFeeShareBps: event.payload.value,
        });
    }
  }
  const change = membershipChange(event);
  if (change === null) return state;
  const [member, admitted] = change;
  if (event.name === "ClaimSigners")
    return updateAdministration(state, {
      ...state.administration,
      creatorClaimSigners: withEntry(
        state.administration.creatorClaimSigners,
        member,
        admitted,
      ),
    });
  return updateConfig(state, {
    ...config,
    venues: withEntry(config.venues, member, admitted),
  });
}

/** A set member applied (`true`) or removed (`undefined`); null for any other event. */
function membershipChange(
  event: DecodedLaunchpadDelayedEvent,
): [string, true | undefined] | null {
  if (event.name !== "ClaimSigners" && event.name !== "Venues") return null;
  if (event.kind === "MemberRemoved") return [event.payload.member, undefined];
  if (event.kind === "SetApplied" && event.payload.change.kind === "Admission")
    return [event.payload.change.member, true];
  return null;
}

/**
 * The projection key of a delayed value: its registry name, then the owning
 * `Launch` for cap reassignments, then the member for a venue or signer
 * admission.
 */
export function delayedPolicyKey(
  event: Pick<DecodedLaunchpadDelayedEvent, "name" | "payload">,
): string {
  let key: string = event.name;
  if (
    event.name === "CurveFeeCapReassignment" ||
    event.name === "CreatorMetadataCapReassignment"
  )
    key += `:${event.payload.owner}`;
  if (
    (event.name === "Venues" || event.name === "ClaimSigners") &&
    "change" in event.payload &&
    event.payload.change.kind === "Admission"
  )
    key += `:${event.payload.change.member}`;
  return key;
}

/** Proposals and applied delays; readiness alone changes nothing. */
function reduceDelayedPolicy(
  state: LaunchpadAdministrationProjection,
  event: DecodedLaunchpadDelayedEvent,
): LaunchpadAdministrationProjection {
  const key = delayedPolicyKey(event);
  const pending = { ...state.pendingPolicies };
  const delays = { ...state.policyDelays };
  switch (event.kind) {
    case "DelayedScheduled":
    case "ActionScheduled":
    case "SetScheduled":
      pending[key] = event;
      break;
    case "DelayedCancelled":
    case "ActionCancelled":
    case "SetCancelled":
      delete pending[key];
      break;
    case "DelayedApplied":
    case "ActionApplied":
    case "SetApplied":
      delete pending[key];
      // An admission's delay_ms is the notice it waited, not a new set notice.
      if (event.kind !== "SetApplied" || event.payload.change.kind === "Delay")
        delays[key] = event.payload.delay_ms;
      break;
    case "DelayedCreated":
    case "ActionCreated":
    case "SetCreated":
      delays[key] = event.payload.delay_ms;
      break;
    default:
      return state;
  }
  return { ...state, pendingPolicies: pending, policyDelays: delays };
}
