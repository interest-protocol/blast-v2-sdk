import type {
  Delayed,
  DelayedAction,
  EntryProposal,
  Notice,
} from "@interest-protocol/blast-core/bcs";
import {
  delayedActionBcs,
  delayedBcs,
  delayedMapBcs,
  moveTypeNameBcs,
  suiBalanceBcs,
  suiIdBcs,
  suiObjectIdBcs,
  suiUidBcs,
  unitKeyBcs,
} from "@interest-protocol/blast-core/bcs";
import { normalizePositiveU64 } from "@interest-protocol/blast-core/integers";
import type { RewardRoundTerms } from "@interest-protocol/blast-core/rewards/state";
import { rewardRoundTermsBcs } from "@interest-protocol/blast-core/rewards/state";
import type { SharedObjectReference } from "@interest-protocol/blast-core/sui";
import type { FeeSplit } from "@interest-protocol/blast-launchpad-sdk/allocation";
import {
  bpsBcs,
  feeSplitBcs,
} from "@interest-protocol/blast-launchpad-sdk/allocation";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

/** Venues whose adapters the migrators package ships. */
export const MIGRATOR_VENUES = ["bluefin", "cetus"] as const;
export type MigratorVenue = (typeof MIGRATOR_VENUES)[number];

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
  launch_id: suiIdBcs,
  pool_id: suiIdBcs,
  partner_id: bcs.option(suiObjectIdBcs),
  protocol_meme_residual: suiBalanceBcs,
  protocol_quote_residual: suiBalanceBcs,
  unpaid_protocol_meme: suiBalanceBcs,
  unpaid_protocol_quote: suiBalanceBcs,
  fee_split: delayedBcs(unitKeyBcs, feeSplitBcs),
  creator_meme: suiBalanceBcs,
  creator_quote: suiBalanceBcs,
  auto_lp_meme: suiBalanceBcs,
  auto_lp_quote: suiBalanceBcs,
  rewards_meme: suiBalanceBcs,
  rewards_quote: suiBalanceBcs,
  burn_quote: suiBalanceBcs,
  next_round: bcs.u64(),
  last_checkpoint: bcs.option(bcs.u64()),
  round_publication: delayedActionBcs(unitKeyBcs, rewardRoundTermsBcs),
});

/** BCS layout of `blast_fun_migrators::lp_fee_policy::SharePair`. */
export const lpFeeSharePairBcs = bcs.struct("SharePair", {
  meme_bps: bpsBcs,
  quote_bps: bpsBcs,
});

/** BCS layout of `blast_fun_migrators::lp_fee_policy::LpFeePolicy`. */
export const lpFeePolicyBcs = bcs.struct("LpFeePolicy", {
  id: suiUidBcs,
  destination: delayedBcs(unitKeyBcs, bcs.Address),
  defaults: delayedBcs(unitKeyBcs, lpFeeSharePairBcs),
  /** Per-coin overrides by original Meme `TypeName`, under one shared notice. */
  coins: delayedMapBcs(unitKeyBcs, moveTypeNameBcs, lpFeeSharePairBcs),
});

export type LpVaultState = SharedObjectReference<true> & {
  memeType: string;
  quoteType: string;
  /** The launch whose migration created the vault; launch-gated calls must pass it. */
  launchId: string;
  poolId: string;
  /** The partner the launch named, paid its cut of Blast's LP fees; null for none. */
  partnerId: string | null;
  /** Protocol-owned migration residuals, claimable by an administrator. */
  protocolMemeResidual: bigint;
  protocolQuoteResidual: bigint;
  /** Blast's LP fees a partnered vault holds until `claimProtocolLpFeesWithPartner`. */
  unpaidProtocolMeme: bigint;
  unpaidProtocolQuote: bigint;
  feeSplit: FeeSplit;
  feeSplitPolicy: Delayed<null, FeeSplit>;
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
  /** Earliest checkpoint the next round may start at; null before the first round. */
  lastCheckpoint: bigint | null;
  /**
   * The vault's round notice and any scheduled round (`Action`) or notice
   * change (`Delay`); anyone publishes a ready round.
   */
  roundPublication: DelayedAction<null, RewardRoundTerms>;
};

export type LpVaultObject = SharedObjectReference<true> & {
  type: string;
  content: Uint8Array;
};

export type LpFeeShares = { memeBps: bigint; quoteBps: bigint };

export type LpFeePolicyState = SharedObjectReference<false> & {
  /** Address every collection pays Blast's share to. */
  protocolDestination: string;
  protocolDestinationPolicy: Delayed<null, string>;
  defaultSharesPolicy: Delayed<null, { meme_bps: bigint; quote_bps: bigint }>;
  defaultShares: LpFeeShares;
  /** Table of applied per-coin share pairs, keyed by original Meme `TypeName`. */
  coinSharesTableId: string;
  coinSharesCount: bigint;
  /** The notice each per-coin change waits; pending changes keep theirs. */
  coinSharesDelayMs: bigint;
  /** Pending per-coin changes by Meme type; a null value clears the override. */
  pendingCoinShares: Readonly<
    Record<string, EntryProposal<{ meme_bps: bigint; quote_bps: bigint }>>
  >;
  pendingCoinSharesDelay: Notice | null;
};

export function decodeLpVaultObject(
  object: LpVaultObject,
  originalPackageId: string,
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
  if (tag.address !== normalizeSuiAddress(originalPackageId)) {
    throw new TypeError(
      `LP vault ${object.objectId} has an unexpected package`,
    );
  }
  if (object.mutable !== true) {
    throw new TypeError(`LP vault ${object.objectId} must be mutable`);
  }

  const parsed = lpVaultBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (
    normalizeSuiObjectId(parsed.id.id.bytes) !== objectId ||
    parsed.fee_split.owner !== objectId ||
    parsed.round_publication.owner !== objectId
  ) {
    throw new TypeError(`LP vault ${object.objectId} has a mismatched UID`);
  }

  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    mutable: true,
    memeType: normalizeTypeParameter(tag.typeParams[0]),
    quoteType: normalizeTypeParameter(tag.typeParams[1]),
    launchId: normalizeSuiObjectId(parsed.launch_id.bytes),
    poolId: normalizeSuiObjectId(parsed.pool_id.bytes),
    partnerId: parsed.partner_id,
    protocolMemeResidual: BigInt(parsed.protocol_meme_residual.value),
    protocolQuoteResidual: BigInt(parsed.protocol_quote_residual.value),
    unpaidProtocolMeme: BigInt(parsed.unpaid_protocol_meme.value),
    unpaidProtocolQuote: BigInt(parsed.unpaid_protocol_quote.value),
    feeSplit: parsed.fee_split.value,
    feeSplitPolicy: parsed.fee_split,
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
    roundPublication: parsed.round_publication,
  };
}

export async function getLpVault(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
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
  const policyId = normalizeSuiObjectId(object.objectId);
  if (
    normalizeSuiObjectId(parsed.id.id.bytes) !== policyId ||
    parsed.destination.owner !== policyId ||
    parsed.defaults.owner !== policyId ||
    parsed.coins.owner !== policyId
  ) {
    throw new TypeError(
      `LP-fee policy ${object.objectId} has a mismatched UID`,
    );
  }
  return {
    objectId: policyId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.owner.Shared.initialSharedVersion,
    ),
    mutable: false,
    protocolDestination: normalizeSuiAddress(parsed.destination.value),
    protocolDestinationPolicy: parsed.destination,
    defaultSharesPolicy: parsed.defaults,
    defaultShares: {
      memeBps: parsed.defaults.value.meme_bps,
      quoteBps: parsed.defaults.value.quote_bps,
    },
    coinSharesTableId: parsed.coins.entries.id,
    coinSharesCount: parsed.coins.entries.size,
    coinSharesDelayMs: parsed.coins.delay_ms,
    pendingCoinShares: Object.fromEntries(
      parsed.coins.pending.map(({ entry, proposal }) => [entry, proposal]),
    ),
    pendingCoinSharesDelay: parsed.coins.pending_delay,
  };
}

/**
 * Mirrors `lp_fee_policy::shares<Meme>`: the coin's applied pair when an
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
  type: ReturnType<typeof parseStructTag>["typeParams"][number] | undefined,
): string {
  if (type === undefined || typeof type === "string") {
    throw new TypeError("LP vault coin type must be a struct type");
  }
  return normalizeStructTag(type);
}
