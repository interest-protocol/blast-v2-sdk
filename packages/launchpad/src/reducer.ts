import { U64_MAX } from "@interest-protocol/blast-core/integers";
import type {
  AllocationMemeAmounts,
  AllocationPlan,
  FeeSplit,
  ProtocolAllocation,
} from "./allocation.ts";
import { apportionMeme } from "./allocation.ts";
import type { DecodedLaunchpadEvent, LaunchpadEventKind } from "./events.ts";
import { launchpadEventId, launchpadEventSpecs } from "./events.ts";
import type { LaunchLifecycle } from "./state.ts";
import { memeAtomicSupply } from "./template.ts";

export type LaunchMigrationProjection = {
  /** The pool's share, handed to the adapter. */
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
  migrationWitnessType: string;
  launcher: string;
  metadataCapId: string;
  lifecycle: LaunchLifecycle;
  decimals: number;
  atomicSupply: bigint;
  sellBurnBps: bigint;
  poolTickSpacing: number;
  poolFeeRate: bigint;
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
  /** Live Blast metadata capability, from cap claims and reassignments. */
  blastMetadataCapId: string | null;
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

export type LaunchpadConfigProjection = {
  protocolFeeShareBps: bigint | null;
  tradeFeeDefaults: {
    quoteFeeBps: bigint;
    memeFeeBps: bigint;
  } | null;
  /** Admitted Quotes; each creator picks its virtual reserve. */
  quotes: Readonly<Record<string, true>>;
  migrationWitnesses: Readonly<Record<string, true>>;
  /**
   * Admitted Meme precisions. `LaunchConfig` starts with six and nine without
   * emitting an event, so the projection starts there too.
   */
  memeDecimals: Readonly<Record<number, true>>;
  /** Blast's one-time migration fee; `LaunchConfig` starts it at zero. */
  protocolAllocation: ProtocolAllocation;
  /** SUI, in MIST, each launch pays at creation; zero initially. */
  creationFee: bigint;
  /** Partners new launches may name, and when each stops being accepted. */
  partners: Readonly<Record<string, bigint>>;
  /**
   * Where every protocol fee claim pays Blast. `RuntimeConfig` starts it at
   * the publisher without an event, so `null` until `TreasuryChanged`.
   */
  treasury: string | null;
};

export type LaunchpadAdministrationProjection = {
  creatorCapClaims: Readonly<
    Record<
      string,
      {
        memeType: string;
        claimant: string;
        curveFeeCapId: string;
        blastMetadataCapId: string;
      }
    >
  >;
  creatorClaimSignerPublicKey: Uint8Array | null;
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
      migrationWitnesses: {},
      memeDecimals: { 6: true, 9: true },
      protocolAllocation: { memeBps: 0n, quoteBps: 0n },
      creationFee: 0n,
      partners: {},
      treasury: null,
    },
    administration: {
      creatorCapClaims: {},
      creatorClaimSignerPublicKey: null,
    },
  };
}

export function reduceLaunchpadEvent(
  state: LaunchpadEventProjection,
  event: DecodedLaunchpadEvent,
): LaunchpadEventProjection {
  const eventId = launchpadEventId(event);
  if (state.appliedEventIds[eventId]) return state;

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
            memeType: payload.meme,
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
            quoteType: payload.quote,
            migrationWitnessType: payload.migration_witness,
            launcher: ticket.launcher,
            metadataCapId: ticket.metadataCapId,
            lifecycle: payload.opening_round_ms > 0n ? "OpeningRound" : "Live",
            decimals: ticket.decimals,
            atomicSupply: ticket.atomicSupply,
            sellBurnBps: ticket.sellBurnBps,
            poolTickSpacing: payload.pool_tick_spacing,
            poolFeeRate: payload.pool_fee_rate,
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
            blastMetadataCapId: null,
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
        openingRoundQuote: launch.openingRoundQuote + payload.quote,
        openingRoundBidders: {
          ...launch.openingRoundBidders,
          [event.sender]:
            (launch.openingRoundBidders[event.sender] ?? 0n) + payload.quote,
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
        openingRoundMeme: payload.meme,
        openingRoundQuote: payload.quote,
      }));
    }
    case "OpeningRoundDelivered": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        openingRoundBids: launch.openingRoundBids - payload.bid,
        openingRoundMeme: launch.openingRoundMeme - payload.meme,
        openingRoundQuote: launch.openingRoundQuote - payload.quote,
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
    case "ProtocolFeesClaimed":
      return updateLaunch(next, event.payload.launch_id, (launch) => ({
        ...launch,
        protocolMemeFees: 0n,
        protocolQuoteFees: 0n,
        protocolSuiFees: 0n,
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
        allocatedMeme: launch.allocatedMeme - payload.meme,
        realQuoteReserve: launch.realQuoteReserve - payload.quote,
        allocationPayments: [
          ...launch.allocationPayments,
          {
            destination: payload.destination,
            meme: payload.meme,
            quote: payload.quote,
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
          meme: payload.meme,
          quote: payload.quote,
          disposedMeme: payload.disposed_meme,
          totalSupplyAfter: payload.total_supply_after,
        },
      }));
    }
    case "ProtocolFeeShareChanged":
      return updateConfig(next, {
        ...state.config,
        protocolFeeShareBps: event.payload.pos0,
      });
    case "LaunchTradeFeesChanged":
      return updateConfig(next, {
        ...state.config,
        tradeFeeDefaults: {
          quoteFeeBps: event.payload.quote_fee_bps,
          memeFeeBps: event.payload.meme_fee_bps,
        },
      });
    case "QuoteSet": {
      const { quote, allowed } = event.payload;
      return updateConfig(next, {
        ...state.config,
        quotes: withEntry(state.config.quotes, quote, allowed || undefined),
      });
    }
    case "CreationFeeChanged":
      return updateConfig(next, {
        ...state.config,
        creationFee: event.payload.pos0,
      });
    case "PartnerAdded":
      return updateConfig(next, {
        ...state.config,
        partners: withEntry(
          state.config.partners,
          event.payload.partner_id,
          U64_MAX,
        ),
      });
    case "PartnerRemoved": {
      const { partner_id, accepted_until_ms } = event.payload;
      return updateConfig(next, {
        ...state.config,
        partners: withEntry(
          state.config.partners,
          partner_id,
          accepted_until_ms,
        ),
      });
    }
    case "MemeDecimalsSet": {
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
    case "ProtocolAllocationSet": {
      const payload = event.payload;
      return updateConfig(next, {
        ...state.config,
        protocolAllocation: {
          memeBps: payload.meme_bps,
          quoteBps: payload.quote_bps,
        },
      });
    }
    case "MigrationWitnessSet": {
      const { migration_witness, allowed } = event.payload;
      return updateConfig(next, {
        ...state.config,
        migrationWitnesses: withEntry(
          state.config.migrationWitnesses,
          migration_witness,
          allowed || undefined,
        ),
      });
    }
    case "CreatorCapsClaimed": {
      const payload = event.payload;
      const claimed = updateLaunchesByMeme(next, payload.meme, (launch) => ({
        ...launch,
        curveFeeCapId: payload.curve_fee_cap_id,
        blastMetadataCapId: payload.blast_metadata_cap_id,
      }));
      return updateAdministration(claimed, {
        ...state.administration,
        creatorCapClaims: {
          ...state.administration.creatorCapClaims,
          [payload.meme]: {
            memeType: payload.meme,
            claimant: event.sender,
            curveFeeCapId: payload.curve_fee_cap_id,
            blastMetadataCapId: payload.blast_metadata_cap_id,
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
    case "MetadataCapReassigned": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        blastMetadataCapId: payload.blast_metadata_cap_id,
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
    case "TreasuryChanged":
      return updateConfig(next, {
        ...state.config,
        treasury: event.payload.pos0,
      });
    case "CreatorClaimSignerSet":
      return updateAdministration(next, {
        ...state.administration,
        creatorClaimSignerPublicKey:
          event.payload.pos0.length === 0 ? null : event.payload.pos0,
      });
  }
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
