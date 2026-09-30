import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import type { FeeSplit } from "../launchpad/allocation.ts";
import { bpsBcs, feeSplitBcs } from "../launchpad/allocation.ts";
import {
  moveTypeNameBcs,
  suiBalanceBcs,
  suiIdBcs,
  suiUidBcs,
} from "../lib/bcs.ts";
import { normalizePositiveU64 } from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";

/** Venues whose adapters the migrators package ships. */
export const MIGRATOR_VENUES = ["bluefin", "cetus"] as const;
export type MigratorVenue = (typeof MIGRATOR_VENUES)[number];

/** The migration route a launch recorded at creation, in its venue's units. */
export type LaunchMigrationRoute = {
  venue: MigratorVenue;
  tickSpacing: number;
  feeRate: bigint;
};

/**
 * Identifies a launch's recorded route from its `migration_witness` (the
 * adapter's `Witness` type, by original package ID) and its pool tier. Rejects
 * a witness from another migrators package or a venue this SDK cannot route.
 */
export function launchMigrationRoute(
  launch: {
    migrationWitnessType: string;
    poolTickSpacing: number;
    poolFeeRate: bigint;
  },
  migratorsOriginalPackageId: string,
): LaunchMigrationRoute {
  const tag = parseStructTag(launch.migrationWitnessType);
  if (tag.address !== normalizeSuiAddress(migratorsOriginalPackageId)) {
    throw new TypeError(
      "the launch migrates through another migrators package",
    );
  }
  const venue = tag.module as MigratorVenue;
  if (!MIGRATOR_VENUES.includes(venue) || tag.name !== "Witness") {
    throw new RangeError(
      `unsupported migration route ${tag.module}::${tag.name}`,
    );
  }
  return {
    venue,
    tickSpacing: launch.poolTickSpacing,
    feeRate: launch.poolFeeRate,
  };
}

/** BCS layout of `blast_fun_migrators::vault::LpVault<Meme, Quote>`. */
export const lpVaultBcs = bcs.struct("LpVault", {
  id: suiUidBcs,
  pool_id: suiIdBcs,
  protocol_meme_residual: suiBalanceBcs,
  protocol_quote_residual: suiBalanceBcs,
  generation: bcs.u64(),
  fee_split: feeSplitBcs,
  creator_meme: suiBalanceBcs,
  creator_quote: suiBalanceBcs,
  auto_lp_meme: suiBalanceBcs,
  auto_lp_quote: suiBalanceBcs,
  rewards_meme: suiBalanceBcs,
  rewards_quote: suiBalanceBcs,
  burn_quote: suiBalanceBcs,
  next_round: bcs.u64(),
  last_checkpoint: bcs.option(bcs.u64()),
});

/** BCS layout of `blast_fun_migrators::lp_fee_policy::SharePair`. */
export const lpFeeSharePairBcs = bcs.struct("SharePair", {
  meme_bps: bpsBcs,
  quote_bps: bpsBcs,
});

/** BCS layout of `blast_fun_migrators::lp_fee_policy::LpFeePolicy`. */
export const lpFeePolicyBcs = bcs.struct("LpFeePolicy", {
  id: suiUidBcs,
  destination: bcs.Address,
  defaults: lpFeeSharePairBcs,
  coins: bcs.struct("Table", { id: suiUidBcs, size: bcs.u64() }),
});

export type LpVaultState = SharedObjectReference<true> & {
  memeType: string;
  quoteType: string;
  poolId: string;
  /** Protocol-owned migration residuals, claimable by an administrator. */
  protocolMemeResidual: bigint;
  protocolQuoteResidual: bigint;
  /** Split generation stamped on every collection; zero at migration. */
  generation: bigint;
  feeSplit: FeeSplit;
  /** Creator LP fees claimable by the launch's live `CurveFeeCap`. */
  creatorMeme: bigint;
  creatorQuote: bigint;
  /** Auto-LP amounts the pool did not take yet; the next collection retries. */
  autoLpMeme: bigint;
  autoLpQuote: bigint;
  /** Rewards not yet reserved by a holder-reward round. */
  rewardsMeme: bigint;
  rewardsQuote: bigint;
  /** Burn-share Quote waiting for a buyback admin to swap it for Meme to burn. */
  burnQuote: bigint;
  /** Number the next holder-reward round must carry. */
  nextRound: bigint;
  /** Checkpoint the next round must start at; null before the first round. */
  lastCheckpoint: bigint | null;
};

export type LpVaultObject = SharedObjectReference<true> & {
  type: string;
  content: Uint8Array;
};

export type LpFeeShares = { memeBps: bigint; quoteBps: bigint };

export type LpFeePolicyState = SharedObjectReference<false> & {
  /** Address every collection pays Blast's share to. */
  protocolDestination: string;
  defaultShares: LpFeeShares;
  /** Table of per-coin share pairs, keyed by original Meme `TypeName`. */
  coinSharesTableId: string;
  coinSharesCount: bigint;
};

export function decodeLpVaultObject(
  object: LpVaultObject,
  originalPackageId?: string,
): LpVaultState {
  const tag = parseStructTag(object.type);
  if (tag.module !== "vault" || tag.name !== "LpVault") {
    throw new TypeError(`object ${object.objectId} is not an LP vault`);
  }
  if (tag.typeParams.length !== 2) {
    throw new TypeError(
      `LP vault ${object.objectId} must have two type arguments`,
    );
  }
  if (
    originalPackageId !== undefined &&
    tag.address !== normalizeSuiAddress(originalPackageId)
  ) {
    throw new TypeError(
      `LP vault ${object.objectId} has an unexpected package`,
    );
  }
  if (object.mutable !== true) {
    throw new TypeError(`LP vault ${object.objectId} must be mutable`);
  }

  const parsed = lpVaultBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (normalizeSuiObjectId(parsed.id.id.bytes) !== objectId) {
    throw new TypeError(`LP vault ${object.objectId} has a mismatched UID`);
  }

  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    mutable: true,
    memeType: normalizeTypeParameter(tag.typeParams[0]!),
    quoteType: normalizeTypeParameter(tag.typeParams[1]!),
    poolId: normalizeSuiObjectId(parsed.pool_id.bytes),
    protocolMemeResidual: BigInt(parsed.protocol_meme_residual.value),
    protocolQuoteResidual: BigInt(parsed.protocol_quote_residual.value),
    generation: BigInt(parsed.generation),
    feeSplit: parsed.fee_split,
    creatorMeme: BigInt(parsed.creator_meme.value),
    creatorQuote: BigInt(parsed.creator_quote.value),
    autoLpMeme: BigInt(parsed.auto_lp_meme.value),
    autoLpQuote: BigInt(parsed.auto_lp_quote.value),
    rewardsMeme: BigInt(parsed.rewards_meme.value),
    rewardsQuote: BigInt(parsed.rewards_quote.value),
    burnQuote: BigInt(parsed.burn_quote.value),
    nextRound: BigInt(parsed.next_round),
    lastCheckpoint:
      parsed.last_checkpoint === null ? null : BigInt(parsed.last_checkpoint),
  };
}

export async function getLpVault(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId?: string,
): Promise<LpVaultState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`LP vault ${object.objectId} is not a shared object`);
  }
  return decodeLpVaultObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      mutable: true,
      type: object.type,
      content: object.content,
    },
    originalPackageId,
  );
}

/** Reads the shared `LpFeePolicy` singleton. */
export async function getLpFeePolicy(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<LpFeePolicyState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`LP-fee policy ${object.objectId} is not shared`);
  }
  const expected = normalizeStructTag(
    `${normalizeSuiAddress(originalPackageId)}::lp_fee_policy::LpFeePolicy`,
  );
  if (normalizeStructTag(object.type) !== expected) {
    throw new TypeError(`object ${object.objectId} is not the LP-fee policy`);
  }
  const parsed = lpFeePolicyBcs.parse(object.content);
  if (
    normalizeSuiObjectId(parsed.id.id.bytes) !==
    normalizeSuiObjectId(object.objectId)
  ) {
    throw new TypeError(
      `LP-fee policy ${object.objectId} has a mismatched UID`,
    );
  }
  return {
    objectId: normalizeSuiObjectId(object.objectId),
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.owner.Shared.initialSharedVersion,
    ),
    mutable: false,
    protocolDestination: normalizeSuiAddress(parsed.destination),
    defaultShares: {
      memeBps: parsed.defaults.meme_bps,
      quoteBps: parsed.defaults.quote_bps,
    },
    coinSharesTableId: normalizeSuiObjectId(parsed.coins.id.id.bytes),
    coinSharesCount: BigInt(parsed.coins.size),
  };
}

/**
 * Mirrors `lp_fee_policy::shares<Meme>`: the coin's own pair when an
 * administrator set one, otherwise the default pair. `source` says which.
 */
export async function getLpFeeShares(
  client: ClientWithCoreApi,
  policy: Pick<LpFeePolicyState, "coinSharesTableId" | "defaultShares">,
  memeType: string,
): Promise<LpFeeShares & { source: "coin" | "default" }> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: policy.coinSharesTableId,
      name: {
        type: "0x1::type_name::TypeName",
        bcs: moveTypeNameBcs
          .serialize(originalTypeNameText(memeType))
          .toBytes(),
      },
    });
    const pair = lpFeeSharePairBcs.parse(dynamicField.value.bcs);
    return { memeBps: pair.meme_bps, quoteBps: pair.quote_bps, source: "coin" };
  } catch (error) {
    if (!(error instanceof ObjectError) || error.reason !== "notFound") {
      throw error;
    }
    return { ...policy.defaultShares, source: "default" };
  }
}

/** Move `TypeName` text: the normalized tag without the `0x` address prefix. */
function originalTypeNameText(type: string): string {
  const normalized = normalizeStructTag(type);
  return normalized.startsWith("0x") ? normalized.slice(2) : normalized;
}

function normalizeTypeParameter(
  type: ReturnType<typeof parseStructTag>["typeParams"][number],
): string {
  if (typeof type === "string") {
    throw new TypeError("LP vault coin type must be a struct type");
  }
  return normalizeStructTag(type);
}
