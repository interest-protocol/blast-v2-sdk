import type { DecodedLaunchpadEvent, LaunchpadEventKind } from "./events.ts";
import { launchpadEventId, launchpadEventSpecs } from "./events.ts";

export type LaunchMigrationProjection = {
  memeAmount: bigint;
  quoteAmount: bigint;
  disposedMeme: bigint;
  nativeSupplyBurned: boolean;
  totalSupplyAfter: bigint;
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
  sellBurnBps: bigint;
  initialMemeSupply: bigint;
  memeReserve: bigint;
  realQuoteReserve: bigint;
  pendingBurn: bigint;
  protocolMemeGraduationFee: bigint;
  memeLiquidityProvision: bigint;
  protocolMemeFees: bigint;
  creatorMemeFees: bigint;
  protocolQuoteFees: bigint;
  creatorQuoteFees: bigint;
  virtualQuote: bigint;
  migrationQuoteTarget: bigint;
  quoteFeeBps: bigint;
  memeFeeBps: bigint;
  quoteMigrationFeeBps: bigint;
  protocolMemeGraduationFeeBps: bigint;
  memeLiquidityProvisionBps: bigint;
  migration: LaunchMigrationProjection | null;
};

export type LaunchTicketEventProjection = {
  ticketId: string;
  memeType: string;
  initialSupply: bigint;
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
  graduationDefaults: {
    quoteMigrationFeeBps: bigint;
    protocolMemeGraduationFeeBps: bigint;
    memeLiquidityProvisionBps: bigint;
  } | null;
  quotes: Readonly<
    Record<string, { virtualQuote: bigint; migrationQuoteTarget: bigint }>
  >;
  migrationWitnesses: Readonly<Record<string, true>>;
};

export type LaunchpadAdministrationProjection = {
  creatorCapClaims: Readonly<
    Record<
      string,
      {
        memeType: string;
        claimant: string;
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
      graduationDefaults: null,
      quotes: {},
      migrationWitnesses: {},
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
            initialSupply: payload.initial_supply,
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
            sellBurnBps: ticket.sellBurnBps,
            initialMemeSupply: ticket.initialSupply,
            memeReserve: payload.meme_reserve,
            realQuoteReserve: 0n,
            pendingBurn: 0n,
            protocolMemeGraduationFee: payload.protocol_meme_graduation_fee,
            memeLiquidityProvision: payload.meme_liquidity_provision,
            protocolMemeFees: 0n,
            creatorMemeFees: 0n,
            protocolQuoteFees: 0n,
            creatorQuoteFees: 0n,
            virtualQuote: payload.virtual_quote,
            migrationQuoteTarget: payload.migration_quote_target,
            quoteFeeBps: payload.quote_fee_bps,
            memeFeeBps: payload.meme_fee_bps,
            quoteMigrationFeeBps: payload.quote_migration_fee_bps,
            protocolMemeGraduationFeeBps:
              payload.protocol_meme_graduation_fee_bps,
            memeLiquidityProvisionBps: payload.meme_liquidity_provision_bps,
            migration: null,
          },
        },
      };
    }
    case "Bought": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        lifecycle:
          payload.real_quote_reserve >= launch.migrationQuoteTarget
            ? "MigrationReady"
            : launch.lifecycle,
        memeReserve: payload.meme_reserve,
        realQuoteReserve: payload.real_quote_reserve,
        protocolMemeFees:
          launch.protocolMemeFees + payload.protocol_meme_fee_delta,
        creatorMemeFees: launch.creatorMemeFees + payload.creator_meme_fee_delta,
        protocolQuoteFees:
          launch.protocolQuoteFees + payload.protocol_quote_fee_delta,
        creatorQuoteFees:
          launch.creatorQuoteFees + payload.creator_quote_fee_delta,
      }));
    }
    case "Sold": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        memeReserve: payload.meme_reserve,
        realQuoteReserve: payload.real_quote_reserve,
        pendingBurn: payload.pending_burn_total,
        protocolMemeFees:
          launch.protocolMemeFees + payload.protocol_meme_fee_delta,
        creatorMemeFees:
          launch.creatorMemeFees + payload.creator_meme_fee_delta,
        protocolQuoteFees:
          launch.protocolQuoteFees + payload.protocol_quote_fee_delta,
        creatorQuoteFees:
          launch.creatorQuoteFees + payload.creator_quote_fee_delta,
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
    case "Migrated": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        lifecycle: "Migrated",
        memeReserve: 0n,
        realQuoteReserve: 0n,
        pendingBurn: 0n,
        protocolMemeGraduationFee: 0n,
        memeLiquidityProvision: 0n,
        protocolMemeFees:
          launch.protocolMemeFees + payload.protocol_meme_graduation_fee,
        protocolQuoteFees:
          launch.protocolQuoteFees + payload.quote_migration_fee,
        migration: {
          memeAmount: payload.migration_meme,
          quoteAmount: payload.migration_quote,
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
    case "GraduationDefaultsChanged":
      return updateConfig(next, {
        ...state.config,
        graduationDefaults: {
          quoteMigrationFeeBps: event.payload.quote_migration_fee_bps,
          protocolMemeGraduationFeeBps:
            event.payload.protocol_meme_graduation_fee_bps,
          memeLiquidityProvisionBps:
            event.payload.meme_liquidity_provision_bps,
        },
      });
    case "QuoteAllowed": {
      const payload = event.payload;
      return updateConfig(next, {
        ...state.config,
        quotes: {
          ...state.config.quotes,
          [payload.quote]: {
            virtualQuote: payload.virtual_quote,
            migrationQuoteTarget: payload.migration_quote_target,
          },
        },
      });
    }
    case "QuoteParametersChanged": {
      const payload = event.payload;
      return updateConfig(next, {
        ...state.config,
        quotes: {
          ...state.config.quotes,
          [payload.quote]: {
            virtualQuote: payload.virtual_quote,
            migrationQuoteTarget: payload.migration_quote_target,
          },
        },
      });
    }
    case "QuoteDisallowed": {
      const quotes = { ...state.config.quotes };
      delete quotes[event.payload.pos0];
      return updateConfig(next, { ...state.config, quotes });
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
    case "CreatorCapClaimed": {
      const payload = event.payload;
      return updateAdministration(next, {
        ...state.administration,
        creatorCapClaims: {
          ...state.administration.creatorCapClaims,
          [payload.pos0]: {
            memeType: payload.pos0,
            claimant: event.sender,
          },
        },
      });
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
