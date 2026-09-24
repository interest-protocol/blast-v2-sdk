import type { AllocationPlan, FeeSplit } from "./allocation.ts";
import { allocationAmountFor } from "./allocation.ts";
import type { DecodedLaunchpadEvent, LaunchpadEventKind } from "./events.ts";
import { launchpadEventId, launchpadEventSpecs } from "./events.ts";
import type { LaunchProtection } from "./state.ts";

export type LaunchMigrationProjection = {
  /** Principal the venue took from the Liquidity channel's handoff. */
  suppliedMeme: bigint;
  suppliedQuote: bigint;
  /** Handoff the venue returned, kept as protocol residuals in the LP vault. */
  residualMeme: bigint;
  residualQuote: bigint;
  liquidity: bigint;
  disposedMeme: bigint;
  nativeSupplyBurned: boolean;
  totalSupplyAfter: bigint;
};

export type LaunchAllocationPayment = {
  channelId: bigint;
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
  lifecycle: "Live" | "MigrationReady" | "Migrated";
  decimals: number;
  atomicSupply: bigint;
  sellBurnBps: bigint;
  poolTickSpacing: number;
  poolFeeRate: bigint;
  lpFeeSplit: FeeSplit;
  allocationPlan: AllocationPlan;
  /** Meme apportioned at finalization, aligned with `allocationPlan.meme`. */
  memeAmounts: bigint[];
  memeReserve: bigint;
  realQuoteReserve: bigint;
  pendingBurn: bigint;
  /** Pooled non-curve Meme allocations awaiting migration payout. */
  allocatedMeme: bigint;
  protocolMemeFees: bigint;
  creatorMemeFees: bigint;
  protocolQuoteFees: bigint;
  creatorQuoteFees: bigint;
  virtualQuote: bigint;
  graduationTarget: bigint;
  quoteFeeBps: bigint;
  memeFeeBps: bigint;
  protection: LaunchProtection | null;
  publicStartMs: bigint | null;
  protectionEndMs: bigint | null;
  preShareBuyCompleted: boolean;
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
  quotes: Readonly<Record<string, { virtualQuote: bigint }>>;
  migrationWitnesses: Readonly<Record<string, true>>;
  /**
   * Admitted Meme precisions. `LaunchConfig` starts with six and nine without
   * emitting an event, so the projection starts there too.
   */
  memeDecimals: Readonly<Record<number, true>>;
  protocolAllocation: {
    channelId: bigint;
    destination: string;
    memeBps: bigint;
    quoteBps: bigint;
  } | null;
};

export type LaunchpadAdministrationProjection = {
  creatorCapClaims: Readonly<
    Record<
      string,
      {
        memeType: string;
        claimant: string;
        curveFeeCapId: string;
        metadataCapId: string;
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
      protocolAllocation: null,
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
            atomicSupply: payload.atomic_supply,
            metadataCapId: payload.metadata_cap_id,
            launcher: event.sender,
            creatorAddress: payload.creator_address,
            accountCommitment: payload.account_commitment,
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
      const memeReserve = allocationAmountFor(
        payload.allocation_plan.meme,
        payload.meme_amounts,
        0n,
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
            lifecycle: "Live",
            decimals: payload.decimals,
            atomicSupply: payload.atomic_supply,
            sellBurnBps: ticket.sellBurnBps,
            poolTickSpacing: payload.pool_tick_spacing,
            poolFeeRate: payload.pool_fee_rate,
            lpFeeSplit: payload.lp_fee_split,
            allocationPlan: payload.allocation_plan,
            memeAmounts: payload.meme_amounts,
            memeReserve,
            realQuoteReserve: 0n,
            pendingBurn: 0n,
            allocatedMeme: payload.atomic_supply - memeReserve,
            protocolMemeFees: 0n,
            creatorMemeFees: 0n,
            protocolQuoteFees: 0n,
            creatorQuoteFees: 0n,
            virtualQuote: payload.virtual_quote,
            graduationTarget: payload.graduation_target,
            quoteFeeBps: payload.quote_fee_bps,
            memeFeeBps: payload.meme_fee_bps,
            protection: null,
            publicStartMs: null,
            protectionEndMs: null,
            preShareBuyCompleted: false,
            migration: null,
            allocationPayments: [],
            curveFeeCapId: null,
            blastMetadataCapId: null,
            memeMetadata: null,
          },
        },
      };
    }
    case "ProtectionConfigured": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        protection: {
          windowMs: payload.window_ms,
          cumulativeSenderBps: payload.cumulative_sender_bps,
          cumulativeAtomicLimit: payload.cumulative_atomic_limit,
          perTransactionBps: payload.per_transaction_bps,
          perTransactionAtomicLimit: payload.per_transaction_atomic_limit,
        },
      }));
    }
    case "LaunchShared": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        publicStartMs: payload.public_start_ms,
        protectionEndMs:
          payload.public_start_ms + (launch.protection?.windowMs ?? 0n),
        preShareBuyCompleted: payload.pre_share_buy_completed,
      }));
    }
    case "Bought":
    case "PreShareBought": {
      const payload = event.payload;
      const memeReserve =
        event.kind === "Bought"
          ? event.payload.meme_reserve
          : event.payload.post_meme_reserve;
      const realQuoteReserve =
        event.kind === "Bought"
          ? event.payload.real_quote_reserve
          : event.payload.post_real_quote_reserve;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        lifecycle:
          realQuoteReserve >= launch.graduationTarget
            ? "MigrationReady"
            : launch.lifecycle,
        preShareBuyCompleted:
          launch.preShareBuyCompleted || event.kind === "PreShareBought",
        memeReserve,
        realQuoteReserve,
        ...accrueTradeFees(launch, payload),
      }));
    }
    case "Sold": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        memeReserve: payload.meme_reserve,
        realQuoteReserve: payload.real_quote_reserve,
        pendingBurn: payload.pending_burn_total,
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
      }));
    case "MigrationAllocationPaid": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        allocatedMeme: launch.allocatedMeme - payload.meme,
        allocationPayments: [
          ...launch.allocationPayments,
          {
            channelId: payload.channel_id,
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
          suppliedMeme: payload.supplied_meme,
          suppliedQuote: payload.supplied_quote,
          residualMeme: payload.residual_meme,
          residualQuote: payload.residual_quote,
          liquidity: payload.liquidity,
          disposedMeme: payload.disposed_meme,
          nativeSupplyBurned: payload.native_supply_burned,
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
    case "QuoteAllowed": {
      const payload = event.payload;
      return updateConfig(next, {
        ...state.config,
        quotes: {
          ...state.config.quotes,
          [payload.quote]: { virtualQuote: payload.virtual_quote },
        },
      });
    }
    case "QuoteDisallowed": {
      const quotes = { ...state.config.quotes };
      delete quotes[event.payload.pos0];
      return updateConfig(next, { ...state.config, quotes });
    }
    case "MemeDecimalsAllowed":
      return updateConfig(next, {
        ...state.config,
        memeDecimals: {
          ...state.config.memeDecimals,
          [event.payload.pos0]: true,
        },
      });
    case "MemeDecimalsDisallowed": {
      const memeDecimals = { ...state.config.memeDecimals };
      delete memeDecimals[event.payload.pos0];
      return updateConfig(next, { ...state.config, memeDecimals });
    }
    case "ProtocolAllocationConfigured": {
      const payload = event.payload;
      return updateConfig(next, {
        ...state.config,
        protocolAllocation: {
          channelId: payload.channel_id,
          destination: payload.destination,
          memeBps: payload.meme_bps,
          quoteBps: payload.quote_bps,
        },
      });
    }
    case "MigrationWitnessAllowed":
      return updateConfig(next, {
        ...state.config,
        migrationWitnesses: {
          ...state.config.migrationWitnesses,
          [event.payload.pos0]: true,
        },
      });
    case "MigrationWitnessDisallowed": {
      const migrationWitnesses = { ...state.config.migrationWitnesses };
      delete migrationWitnesses[event.payload.pos0];
      return updateConfig(next, { ...state.config, migrationWitnesses });
    }
    case "CreatorCapsClaimed": {
      const payload = event.payload;
      const claimed = updateLaunchesByMeme(next, payload.meme, (launch) => ({
        ...launch,
        curveFeeCapId: payload.curve_fee_cap_id,
        blastMetadataCapId: payload.metadata_cap_id,
      }));
      return updateAdministration(claimed, {
        ...state.administration,
        creatorCapClaims: {
          ...state.administration.creatorCapClaims,
          [payload.meme]: {
            memeType: payload.meme,
            claimant: event.sender,
            curveFeeCapId: payload.curve_fee_cap_id,
            metadataCapId: payload.metadata_cap_id,
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
        blastMetadataCapId: payload.metadata_cap_id,
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
    case "CreatorClaimSignerSet":
      return updateAdministration(next, {
        ...state.administration,
        creatorClaimSignerPublicKey: event.payload.pos0,
      });
    case "CreatorClaimSignerRevoked":
      return updateAdministration(next, {
        ...state.administration,
        creatorClaimSignerPublicKey: null,
      });
  }
}

function accrueTradeFees(
  launch: LaunchEventProjection,
  deltas: {
    protocol_meme_fee_delta: bigint;
    creator_meme_fee_delta: bigint;
    protocol_quote_fee_delta: bigint;
    creator_quote_fee_delta: bigint;
  },
) {
  return {
    protocolMemeFees: launch.protocolMemeFees + deltas.protocol_meme_fee_delta,
    creatorMemeFees: launch.creatorMemeFees + deltas.creator_meme_fee_delta,
    protocolQuoteFees:
      launch.protocolQuoteFees + deltas.protocol_quote_fee_delta,
    creatorQuoteFees: launch.creatorQuoteFees + deltas.creator_quote_fee_delta,
  };
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
