import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
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
import type { AftermathPolicy } from "./state.ts";
import { AFTERMATH_DEFAULT_POLICY } from "./state.ts";

export type ClmmVaultMigrationProjection = {
  kind: "clmm";
  sourceMemeAmount: bigint;
  sourceQuoteAmount: bigint;
  usedMemeAmount: bigint;
  usedQuoteAmount: bigint;
  residualMemeAmount: bigint;
  residualQuoteAmount: bigint;
  sqrtPriceX64: bigint;
  lowerTickBits: number;
  upperTickBits: number;
  tickSpacing: number;
  feeRate: bigint;
};

export type AftermathVaultMigrationProjection = {
  kind: "aftermath";
  innerPoolId: string;
  daoFeePoolId: string;
  sourceMemeAmount: bigint;
  sourceQuoteAmount: bigint;
  usedMemeAmount: bigint;
  usedQuoteAmount: bigint;
  residualMemeAmount: 0n;
  residualQuoteAmount: 0n;
  lpType: string;
  lockedLpAmount: bigint;
  memeWeight: bigint;
  quoteWeight: bigint;
  flatness: bigint;
  swapInFee: bigint;
  daoFeeBps: number;
};

export type VaultMigrationProjection =
  | ClmmVaultMigrationProjection
  | AftermathVaultMigrationProjection;

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
  protocolMemeResidual: bigint;
  protocolQuoteResidual: bigint;
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
  aftermathPolicy: AftermathPolicy;
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
    venueTiers: {},
    aftermathPolicy: AFTERMATH_DEFAULT_POLICY,
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
            protocolMemeResidual: 0n,
            protocolQuoteResidual: 0n,
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
        protocolMemeResidual: payload.residual_meme_amount,
        protocolQuoteResidual: payload.residual_quote_amount,
        migration: {
          kind: "clmm",
          sourceMemeAmount: payload.source_meme_amount,
          sourceQuoteAmount: payload.source_quote_amount,
          usedMemeAmount: payload.used_meme_amount,
          usedQuoteAmount: payload.used_quote_amount,
          residualMemeAmount: payload.residual_meme_amount,
          residualQuoteAmount: payload.residual_quote_amount,
          sqrtPriceX64: payload.sqrt_price_x64,
          lowerTickBits: payload.lower_tick_bits,
          upperTickBits: payload.upper_tick_bits,
          tickSpacing: payload.tick_spacing,
          feeRate: payload.fee_rate,
        },
      }));
    }
    case "AftermathMigrationCompleted": {
      const payload = event.payload;
      return updateVault(next, payload.vault_id, (vault) => ({
        ...vault,
        launchId: payload.launch_id,
        poolId: payload.dao_fee_pool_id,
        venueType: payload.venue,
        memeType: payload.meme,
        quoteType: payload.quote,
        protocolMemeResidual: 0n,
        protocolQuoteResidual: 0n,
        migration: {
          kind: "aftermath",
          innerPoolId: payload.inner_pool_id,
          daoFeePoolId: payload.dao_fee_pool_id,
          sourceMemeAmount: payload.meme_amount,
          sourceQuoteAmount: payload.quote_amount,
          usedMemeAmount: payload.meme_amount,
          usedQuoteAmount: payload.quote_amount,
          residualMemeAmount: 0n,
          residualQuoteAmount: 0n,
          lpType: payload.lp,
          lockedLpAmount: payload.locked_lp_amount,
          memeWeight: payload.meme_weight,
          quoteWeight: payload.quote_weight,
          flatness: payload.flatness,
          swapInFee: payload.swap_in_fee,
          daoFeeBps: payload.dao_fee_bps,
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
        protocolMemeFees:
          vault.protocolMemeFees + payload.protocol_meme_fee_delta,
        creatorMemeFees: vault.creatorMemeFees + payload.creator_meme_fee_delta,
        protocolQuoteFees:
          vault.protocolQuoteFees + payload.protocol_quote_fee_delta,
        creatorQuoteFees:
          vault.creatorQuoteFees + payload.creator_quote_fee_delta,
        principalLiquidity: payload.principal_liquidity,
      }));
    }
    case "CreatorFeesClaimed": {
      const payload = event.payload;
      return updateVault(next, payload.vault_id, (vault) => ({
        ...vault,
        creatorMemeFees: 0n,
        creatorQuoteFees: 0n,
      }));
    }
    case "ProtocolFeesClaimed": {
      const payload = event.payload;
      return updateVault(next, payload.vault_id, (vault) => ({
        ...vault,
        protocolMemeFees: 0n,
        protocolQuoteFees: 0n,
        protocolMemeResidual: 0n,
        protocolQuoteResidual: 0n,
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
    case "AftermathPolicyUpdated":
      return {
        ...next,
        aftermathPolicy: {
          memeWeight: event.payload.new_meme_weight,
          quoteWeight: event.payload.new_quote_weight,
          daoFeeBps: event.payload.new_dao_fee_bps,
          source: "override",
        },
      };
    case "AftermathDaoFeeUpdated":
      return updateVault(next, event.payload.vault_id, (vault) => {
        if (vault.migration?.kind !== "aftermath") {
          throw new TypeError(
            `vault ${vault.vaultId} has no Aftermath migration`,
          );
        }
        if (vault.poolId !== event.payload.dao_fee_pool_id) {
          throw new TypeError(
            `vault ${vault.vaultId} has an unexpected DAO fee pool`,
          );
        }
        return {
          ...vault,
          migration: {
            ...vault.migration,
            daoFeeBps: event.payload.new_dao_fee_bps,
          },
        };
      });
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
