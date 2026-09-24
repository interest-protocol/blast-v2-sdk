import {
  normalizeSuiAddress,
  normalizeSuiObjectId,
  toHex,
} from "@mysten/sui/utils";
import type { FeeSplit } from "../launchpad/allocation.ts";
import type { DecodedLaunchpadEvent } from "../launchpad/events.ts";
import type { LaunchpadEventProjection } from "../launchpad/reducer.ts";
import {
  createLaunchpadEventProjection,
  reduceLaunchpadEvent,
} from "../launchpad/reducer.ts";
import type { NativeTransactionPosition } from "../lib/events.ts";
import { normalizeNativeTransactionPosition } from "../lib/events.ts";
import { requireU64 } from "../lib/integers.ts";
import type { DecodedMigratorEvent, MigratorEventKind } from "./events.ts";
import { migratorEventId, migratorEventSpecs } from "./events.ts";

export type LpVaultEventProjection = {
  vaultId: string;
  /** The launch this vault completed, linked by Meme type in the product projection. */
  launchId: string | null;
  poolId: string;
  positionId: string;
  /** Separate full-range position Cetus auto-LP adds to; null until first use. */
  autoLpPositionId: string | null;
  venueType: string;
  memeType: string;
  quoteType: string;
  generation: bigint;
  feeSplit: FeeSplit;
  creatorMeme: bigint;
  creatorQuote: bigint;
  autoLpMeme: bigint;
  autoLpQuote: bigint;
  rewardsMeme: bigint;
  rewardsQuote: bigint;
  /** Protocol migration residuals, from the launch's `Migrated` event. */
  protocolMemeResidual: bigint;
  protocolQuoteResidual: bigint;
  nextRound: bigint;
  lastCheckpoint: bigint | null;
  /** Cumulative protocol LP-fee payouts. */
  protocolMemePaid: bigint;
  protocolQuotePaid: bigint;
};

export type HolderRewardRoundProjection = {
  roundId: string;
  vaultId: string;
  number: bigint;
  startCheckpoint: bigint;
  endCheckpoint: bigint;
  root: string;
  manifestDigest: string;
  leafCount: bigint;
  memeRemaining: bigint;
  quoteRemaining: bigint;
  paidIndexes: Readonly<Record<string, true>>;
};

export type LpFeePolicyProjection = {
  /** Default Meme/Quote shares, once a change is replayed; initialization sets zero/zero. */
  defaultShares: { memeBps: bigint; quoteBps: bigint };
  /** Original Meme type keyed pairs that override the defaults. */
  coinShares: Readonly<Record<string, { memeBps: bigint; quoteBps: bigint }>>;
  /** Protocol destination once redirected; initialization pays the publisher. */
  protocolDestination: string | null;
};

export type CetusPoolReservationProjection = {
  memeType: string;
  quoteType: string;
  poolCreationCapId: string;
  tickSpacing: number;
};

export type MigratorEventProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  eventCounts: Readonly<Record<MigratorEventKind, number>>;
  vaults: Readonly<Record<string, LpVaultEventProjection>>;
  rounds: Readonly<Record<string, HolderRewardRoundProjection>>;
  lpFeePolicy: LpFeePolicyProjection;
  /** Cetus pool-creation reservations, keyed by Meme type. */
  cetusPoolReservations: Readonly<
    Record<string, CetusPoolReservationProjection>
  >;
};

export type { NativeTransactionPosition } from "../lib/events.ts";

export type PackagePublicationFact = {
  source: "transactionEffects";
  kind: "packagePublication";
  position: NativeTransactionPosition;
  packageId: string;
  createdObjectIds: readonly string[];
};

export type CreatorCapOwnershipFact = {
  source: "objectOwnership";
  kind: "creatorCapOwnership";
  checkpoint: bigint;
  creatorCapId: string;
  owner: string;
};

export type ReturnedCoinRecipientsFact = {
  source: "transactionEffects";
  kind: "returnedCoinRecipients";
  position: NativeTransactionPosition;
  claim:
    | "launchCreatorFees"
    | "launchProtocolFees"
    | "lpCreatorFees"
    | "lpProtocolFees";
  memeCoin: { objectId: string; recipient: string };
  quoteCoin: { objectId: string; recipient: string };
};

export type NativeReconstructionFact =
  | PackagePublicationFact
  | CreatorCapOwnershipFact
  | ReturnedCoinRecipientsFact;

export type NativeFactProjection = {
  appliedFactIds: Readonly<Record<string, true>>;
  packagePublications: Readonly<Record<string, PackagePublicationFact>>;
  creatorCapOwners: Readonly<
    Record<
      string,
      { source: "objectOwnership"; checkpoint: bigint; owner: string }
    >
  >;
  returnedCoinRecipients: Readonly<Record<string, ReturnedCoinRecipientsFact>>;
};

export type LaunchpadProductProjection = {
  launchpad: LaunchpadEventProjection;
  migrators: MigratorEventProjection;
  native: NativeFactProjection;
};

export type LaunchpadProductInput =
  | DecodedLaunchpadEvent
  | DecodedMigratorEvent
  | NativeReconstructionFact;

export function createMigratorEventProjection(): MigratorEventProjection {
  return {
    appliedEventIds: {},
    eventCounts: Object.fromEntries(
      Object.keys(migratorEventSpecs).map((kind) => [kind, 0]),
    ) as Record<MigratorEventKind, number>,
    vaults: {},
    rounds: {},
    lpFeePolicy: {
      defaultShares: { memeBps: 0n, quoteBps: 0n },
      coinShares: {},
      protocolDestination: null,
    },
    cetusPoolReservations: {},
  };
}

export function createLaunchpadProductProjection(): LaunchpadProductProjection {
  return {
    launchpad: createLaunchpadEventProjection(),
    migrators: createMigratorEventProjection(),
    native: {
      appliedFactIds: {},
      packagePublications: {},
      creatorCapOwners: {},
      returnedCoinRecipients: {},
    },
  };
}

export function reduceMigratorEvent(
  state: MigratorEventProjection,
  event: DecodedMigratorEvent,
): MigratorEventProjection {
  const eventId = migratorEventId(event);
  if (state.appliedEventIds[eventId]) return state;
  const next: MigratorEventProjection = {
    ...state,
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
    eventCounts: {
      ...state.eventCounts,
      [event.kind]: state.eventCounts[event.kind] + 1,
    },
  };

  switch (event.kind) {
    case "VaultCreated": {
      const payload = event.payload;
      return {
        ...next,
        vaults: {
          ...state.vaults,
          [payload.vault_id]: {
            vaultId: payload.vault_id,
            launchId: null,
            poolId: payload.pool_id,
            positionId: payload.position_id,
            autoLpPositionId: null,
            venueType: payload.venue,
            memeType: payload.meme,
            quoteType: payload.quote,
            generation: 0n,
            feeSplit: payload.fee_split,
            creatorMeme: 0n,
            creatorQuote: 0n,
            autoLpMeme: 0n,
            autoLpQuote: 0n,
            rewardsMeme: 0n,
            rewardsQuote: 0n,
            protocolMemeResidual: 0n,
            protocolQuoteResidual: 0n,
            nextRound: 0n,
            lastCheckpoint: null,
            protocolMemePaid: 0n,
            protocolQuotePaid: 0n,
          },
        },
      };
    }
    case "FeesCollected": {
      const payload = event.payload;
      return updateVault(next, payload.vault_id, (vault) => ({
        ...vault,
        creatorMeme: vault.creatorMeme + payload.creator_meme,
        creatorQuote: vault.creatorQuote + payload.creator_quote,
        autoLpMeme: vault.autoLpMeme + payload.auto_lp_meme,
        autoLpQuote: vault.autoLpQuote + payload.auto_lp_quote,
        rewardsMeme: vault.rewardsMeme + payload.rewards_meme,
        rewardsQuote: vault.rewardsQuote + payload.rewards_quote,
        protocolMemePaid: vault.protocolMemePaid + payload.protocol_meme,
        protocolQuotePaid: vault.protocolQuotePaid + payload.protocol_quote,
      }));
    }
    case "AutoLiquidityAdded": {
      const payload = event.payload;
      return updateVault(next, payload.vault_id, (vault) => ({
        ...vault,
        autoLpMeme: payload.meme_pending,
        autoLpQuote: payload.quote_pending,
      }));
    }
    case "AutoLpPositionOpened": {
      const payload = event.payload;
      return updateVault(next, payload.vault_id, (vault) => ({
        ...vault,
        autoLpPositionId: payload.position_id,
      }));
    }
    case "FeeSplitChanged": {
      const payload = event.payload;
      return updateVault(next, payload.vault_id, (vault) => ({
        ...vault,
        generation: payload.new_generation,
        feeSplit: payload.new_fee_split,
      }));
    }
    case "CreatorFeesClaimed":
      return updateVault(next, event.payload.vault_id, (vault) => ({
        ...vault,
        creatorMeme: 0n,
        creatorQuote: 0n,
      }));
    case "ProtocolFeesClaimed":
      return updateVault(next, event.payload.vault_id, (vault) => ({
        ...vault,
        protocolMemeResidual: 0n,
        protocolQuoteResidual: 0n,
      }));
    case "RoundPublished": {
      const payload = event.payload;
      const updated = updateVault(next, payload.vault_id, (vault) => ({
        ...vault,
        rewardsMeme: payload.meme_unallocated,
        rewardsQuote: payload.quote_unallocated,
        nextRound: payload.number + 1n,
        lastCheckpoint: payload.end_checkpoint,
      }));
      return {
        ...updated,
        rounds: {
          ...state.rounds,
          [payload.round_id]: {
            roundId: payload.round_id,
            vaultId: payload.vault_id,
            number: payload.number,
            startCheckpoint: payload.start_checkpoint,
            endCheckpoint: payload.end_checkpoint,
            root: toHex(payload.root),
            manifestDigest: toHex(payload.manifest_digest),
            leafCount: payload.leaf_count,
            memeRemaining: payload.meme_amount,
            quoteRemaining: payload.quote_amount,
            paidIndexes: {},
          },
        },
      };
    }
    case "RewardPaid": {
      const payload = event.payload;
      const round = state.rounds[payload.round_id];
      if (!round) return next;
      return {
        ...next,
        rounds: {
          ...state.rounds,
          [payload.round_id]: {
            ...round,
            memeRemaining: payload.meme_remaining,
            quoteRemaining: payload.quote_remaining,
            paidIndexes: {
              ...round.paidIndexes,
              [payload.index.toString()]: true,
            },
          },
        },
      };
    }
    case "LpFeePolicyChanged": {
      const payload = event.payload;
      const pair =
        payload.new_meme_bps === null || payload.new_quote_bps === null
          ? null
          : { memeBps: payload.new_meme_bps, quoteBps: payload.new_quote_bps };
      if (payload.meme === null) {
        if (!pair) return next;
        return {
          ...next,
          lpFeePolicy: { ...state.lpFeePolicy, defaultShares: pair },
        };
      }
      const coinShares = { ...state.lpFeePolicy.coinShares };
      if (pair) coinShares[payload.meme] = pair;
      else delete coinShares[payload.meme];
      return { ...next, lpFeePolicy: { ...state.lpFeePolicy, coinShares } };
    }
    case "LpFeeDestinationChanged":
      return {
        ...next,
        lpFeePolicy: {
          ...state.lpFeePolicy,
          protocolDestination: event.payload.new_destination,
        },
      };
    case "CetusPoolReserved": {
      const payload = event.payload;
      return {
        ...next,
        cetusPoolReservations: {
          ...state.cetusPoolReservations,
          [payload.meme]: {
            memeType: payload.meme,
            quoteType: payload.quote,
            poolCreationCapId: payload.pool_creation_cap_id,
            tickSpacing: payload.tick_spacing,
          },
        },
      };
    }
  }
}

export function reduceLaunchpadProductInput(
  state: LaunchpadProductProjection,
  input: LaunchpadProductInput,
): LaunchpadProductProjection {
  if (input.source === "launchpad") {
    const launchpad = reduceLaunchpadEvent(state.launchpad, input);
    if (launchpad === state.launchpad) return state;
    if (input.kind !== "Migrated") return { ...state, launchpad };
    return {
      ...state,
      launchpad,
      migrators: linkMigratedLaunch(state.migrators, launchpad, input.payload),
    };
  }
  if (input.source === "migrators") {
    const migrators = reduceMigratorEvent(state.migrators, input);
    return migrators === state.migrators ? state : { ...state, migrators };
  }
  const native = reduceNativeFact(state.native, input);
  return native === state.native ? state : { ...state, native };
}

function reduceNativeFact(
  state: NativeFactProjection,
  fact: NativeReconstructionFact,
): NativeFactProjection {
  const normalized = normalizeNativeFact(fact);
  const factId = nativeFactId(normalized);
  if (state.appliedFactIds[factId]) return state;
  const next = {
    ...state,
    appliedFactIds: { ...state.appliedFactIds, [factId]: true as const },
  };

  switch (normalized.kind) {
    case "packagePublication":
      return {
        ...next,
        packagePublications: {
          ...state.packagePublications,
          [normalized.packageId]: normalized,
        },
      };
    case "creatorCapOwnership":
      return {
        ...next,
        creatorCapOwners: {
          ...state.creatorCapOwners,
          [normalized.creatorCapId]: {
            source: "objectOwnership",
            checkpoint: normalized.checkpoint,
            owner: normalized.owner,
          },
        },
      };
    case "returnedCoinRecipients":
      return {
        ...next,
        returnedCoinRecipients: {
          ...state.returnedCoinRecipients,
          [factId]: normalized,
        },
      };
  }
}

/**
 * The migration transaction attaches the vault (`VaultCreated`) before the
 * launch completes (`Migrated`). One launch exists per Meme type, so the
 * vault holding that Meme type is the launch's vault.
 */
function linkMigratedLaunch(
  state: MigratorEventProjection,
  launchpad: LaunchpadEventProjection,
  payload: Extract<DecodedLaunchpadEvent, { kind: "Migrated" }>["payload"],
): MigratorEventProjection {
  const launch = launchpad.launches[payload.launch_id];
  if (!launch) return state;
  const vault = Object.values(state.vaults).find(
    (candidate) =>
      candidate.memeType === launch.memeType &&
      candidate.quoteType === launch.quoteType,
  );
  if (!vault) return state;
  return updateVault(state, vault.vaultId, (current) => ({
    ...current,
    launchId: payload.launch_id,
    protocolMemeResidual: payload.residual_meme,
    protocolQuoteResidual: payload.residual_quote,
  }));
}

function updateVault(
  state: MigratorEventProjection,
  vaultId: string,
  update: (vault: LpVaultEventProjection) => LpVaultEventProjection,
): MigratorEventProjection {
  const vault = state.vaults[vaultId];
  if (!vault) return state;
  return { ...state, vaults: { ...state.vaults, [vaultId]: update(vault) } };
}

function normalizeNativeFact(
  fact: NativeReconstructionFact,
): NativeReconstructionFact {
  if (fact.kind === "creatorCapOwnership") {
    requireU64("creator-cap ownership checkpoint", fact.checkpoint);
    return {
      ...fact,
      creatorCapId: normalizeSuiObjectId(fact.creatorCapId),
      owner: normalizeSuiAddress(fact.owner),
    };
  }
  const position = normalizeNativeTransactionPosition(
    fact.position,
    "native fact",
  );
  if (fact.kind === "packagePublication") {
    return {
      ...fact,
      position,
      packageId: normalizeSuiObjectId(fact.packageId),
      createdObjectIds: fact.createdObjectIds.map((id) =>
        normalizeSuiObjectId(id),
      ),
    };
  }
  return {
    ...fact,
    position,
    memeCoin: {
      objectId: normalizeSuiObjectId(fact.memeCoin.objectId),
      recipient: normalizeSuiAddress(fact.memeCoin.recipient),
    },
    quoteCoin: {
      objectId: normalizeSuiObjectId(fact.quoteCoin.objectId),
      recipient: normalizeSuiAddress(fact.quoteCoin.recipient),
    },
  };
}

function nativeFactId(fact: NativeReconstructionFact): string {
  if (fact.kind === "creatorCapOwnership") {
    return `${fact.checkpoint}:ownership:${fact.creatorCapId}`;
  }
  if (fact.kind === "returnedCoinRecipients") {
    return `${fact.position.transactionDigest}:${fact.kind}:${fact.memeCoin.objectId}:${fact.quoteCoin.objectId}`;
  }
  return `${fact.position.transactionDigest}:${fact.kind}:${fact.packageId}`;
}
