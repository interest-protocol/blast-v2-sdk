import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import type { DecodedLaunchpadEvent } from "../launchpad/events.ts";
import type { LaunchpadEventProjection } from "../launchpad/reducer.ts";
import {
  createLaunchpadEventProjection,
  reduceLaunchpadEvent,
} from "../launchpad/reducer.ts";
import { requireU64 } from "../lib/integers.ts";
import type { DecodedMigratorEvent, MigratorEventKind } from "./events.ts";
import { migratorEventId, migratorEventSpecs } from "./events.ts";

export type VaultMigrationProjection = {
  sourceMemeAmount: bigint;
  sourceQuoteAmount: bigint;
  usedMemeAmount: bigint;
  usedQuoteAmount: bigint;
  residualMemeAmount: bigint;
  residualQuoteAmount: bigint;
  residualTreasury: string;
  sqrtPriceX64: bigint;
  lowerTickBits: number;
  upperTickBits: number;
  tickSpacing: number;
  feeRate: bigint;
};

export type LpVaultEventProjection = {
  vaultId: string;
  launchId: string | null;
  poolId: string;
  positionId: string;
  venueType: string;
  memeType: string;
  quoteType: string;
  protocolMemeFees: bigint;
  creatorMemeFees: bigint;
  protocolQuoteFees: bigint;
  creatorQuoteFees: bigint;
  principalLiquidity: bigint | null;
  migration: VaultMigrationProjection | null;
};

export type MigratorEventProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  eventCounts: Readonly<Record<MigratorEventKind, number>>;
  vaults: Readonly<Record<string, LpVaultEventProjection>>;
  venueTiers: Readonly<
    Record<string, { tickSpacing: number; feeRate: bigint }>
  >;
};

export type NativeTransactionPosition = {
  checkpoint: bigint;
  transactionDigest: string;
};

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
    venueTiers: {},
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
            venueType: payload.venue,
            memeType: payload.meme,
            quoteType: payload.quote,
            protocolMemeFees: 0n,
            creatorMemeFees: 0n,
            protocolQuoteFees: 0n,
            creatorQuoteFees: 0n,
            principalLiquidity: null,
            migration: null,
          },
        },
      };
    }
    case "MigrationCompleted": {
      const payload = event.payload;
      return updateVault(next, payload.vault_id, (vault) => ({
        ...vault,
        launchId: payload.launch_id,
        poolId: payload.pool_id,
        venueType: payload.venue,
        memeType: payload.meme,
        quoteType: payload.quote,
        migration: {
          sourceMemeAmount: payload.source_meme_amount,
          sourceQuoteAmount: payload.source_quote_amount,
          usedMemeAmount: payload.used_meme_amount,
          usedQuoteAmount: payload.used_quote_amount,
          residualMemeAmount: payload.residual_meme_amount,
          residualQuoteAmount: payload.residual_quote_amount,
          residualTreasury: payload.residual_treasury,
          sqrtPriceX64: payload.sqrt_price_x64,
          lowerTickBits: payload.lower_tick_bits,
          upperTickBits: payload.upper_tick_bits,
          tickSpacing: payload.tick_spacing,
          feeRate: payload.fee_rate,
        },
      }));
    }
    case "LpFeesCollected": {
      const payload = event.payload;
      return updateVault(next, payload.vault_id, (vault) => ({
        ...vault,
        poolId: payload.pool_id,
        positionId: payload.position_id,
        venueType: payload.venue,
        memeType: payload.meme,
        quoteType: payload.quote,
        protocolMemeFees: payload.protocol_meme_fee_total,
        creatorMemeFees: payload.creator_meme_fee_total,
        protocolQuoteFees: payload.protocol_quote_fee_total,
        creatorQuoteFees: payload.creator_quote_fee_total,
        principalLiquidity: payload.principal_liquidity_after,
      }));
    }
    case "CreatorFeesClaimed":
    case "ProtocolFeesClaimed": {
      const payload = event.payload;
      return updateVault(next, payload.vault_id, (vault) => ({
        ...vault,
        protocolMemeFees: payload.protocol_meme_fee_total,
        creatorMemeFees: payload.creator_meme_fee_total,
        protocolQuoteFees: payload.protocol_quote_fee_total,
        creatorQuoteFees: payload.creator_quote_fee_total,
      }));
    }
    case "VenueTierUpdated":
      return {
        ...next,
        venueTiers: {
          ...state.venueTiers,
          [event.payload.venue]: {
            tickSpacing: event.payload.new_tick_spacing,
            feeRate: event.payload.new_fee_rate,
          },
        },
      };
  }
}

export function reduceLaunchpadProductInput(
  state: LaunchpadProductProjection,
  input: LaunchpadProductInput,
): LaunchpadProductProjection {
  if (input.source === "launchpad") {
    const launchpad = reduceLaunchpadEvent(state.launchpad, input);
    return launchpad === state.launchpad ? state : { ...state, launchpad };
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
  requireNativePosition(fact.position);
  if (fact.kind === "packagePublication") {
    return {
      ...fact,
      packageId: normalizeSuiObjectId(fact.packageId),
      createdObjectIds: fact.createdObjectIds.map((id) =>
        normalizeSuiObjectId(id),
      ),
    };
  }
  return {
    ...fact,
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

function requireNativePosition(position: NativeTransactionPosition): void {
  requireU64("native fact checkpoint", position.checkpoint);
  if (!position.transactionDigest) {
    throw new TypeError("native fact transaction digest is required");
  }
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
