import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import type { CreatorFeeAuthority } from "../launchpad/state.ts";
import {
  creatorFeeAuthorityBcs,
  decodeCreatorFeeAuthority,
} from "../launchpad/state.ts";
import { suiBalanceBcs, suiIdBcs, suiUidBcs } from "../lib/bcs.ts";
import { normalizePositiveU64 } from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";

const FeeLedgerBcs = bcs.struct("FeeLedger", {
  protocol_meme: suiBalanceBcs,
  creator_meme: suiBalanceBcs,
  protocol_quote: suiBalanceBcs,
  creator_quote: suiBalanceBcs,
});
const TierKeyBcs = bcs.struct("TierKey", {});
const AftermathPolicyKeyBcs = bcs.struct("PolicyKey", {});
const AFTERMATH_FIXED_ONE = 1_000_000_000_000_000_000n;
const AFTERMATH_MIN_WEIGHT = 10_000_000_000_000_000n;
const AFTERMATH_MIN_DAO_FEE_BPS = 0;
const AFTERMATH_MAX_DAO_FEE_BPS = 10_000;

/** Unavoidable 0.01% fee retained by the permanently locked base LP. */
export const AFTERMATH_BASE_SWAP_IN_FEE = 100_000_000_000_000n;

/** BCS layout of `blast_fun_migrators::vault::LpVault<Meme, Quote>`. */
export const lpVaultBcs = bcs.struct("LpVault", {
  id: suiUidBcs,
  pool_id: suiIdBcs,
  lp_fee_authority: creatorFeeAuthorityBcs,
  protocol_meme_residual: suiBalanceBcs,
  protocol_quote_residual: suiBalanceBcs,
  fee_ledger: FeeLedgerBcs,
});

/** BCS layout of `blast_fun_migrators::venue_config::Tier`. */
export const venueTierBcs = bcs.struct("Tier", {
  tick_spacing: bcs.u32(),
  fee_rate: bcs.u64(),
});

/** BCS layout of `blast_fun_migrators::aftermath::AftermathPolicy`. */
export const aftermathPolicyBcs = bcs.struct("AftermathPolicy", {
  meme_weight: bcs.u64(),
  quote_weight: bcs.u64(),
  dao_fee_bps: bcs.u16(),
});

export const TIERED_MIGRATOR_VENUES = [
  "bluefin",
  "cetus",
  "mmt",
  "turbos",
] as const;

export const MIGRATOR_VENUES = [
  ...TIERED_MIGRATOR_VENUES,
  "aftermath",
] as const;

export type TieredMigratorVenue = (typeof TIERED_MIGRATOR_VENUES)[number];
export type MigratorVenue = (typeof MIGRATOR_VENUES)[number];

export const VENUE_DEFAULT_TIERS: Readonly<
  Record<
    TieredMigratorVenue,
    Readonly<{ tickSpacing: number; feeRate: number }>
  >
> = Object.freeze({
  bluefin: Object.freeze({ tickSpacing: 200, feeRate: 10_000 }),
  cetus: Object.freeze({ tickSpacing: 260, feeRate: 40_000 }),
  mmt: Object.freeze({ tickSpacing: 400, feeRate: 20_000 }),
  turbos: Object.freeze({ tickSpacing: 800, feeRate: 40_000 }),
});

export type AftermathPolicy = Readonly<{
  memeWeight: bigint;
  quoteWeight: bigint;
  daoFeeBps: number;
  source: "default" | "override";
}>;

export const AFTERMATH_DEFAULT_POLICY: AftermathPolicy = Object.freeze({
  memeWeight: 500_000_000_000_000_000n,
  quoteWeight: 500_000_000_000_000_000n,
  daoFeeBps: 200,
  source: "default",
});

export type LpVaultState = SharedObjectReference<true> & {
  memeType: string;
  quoteType: string;
  poolId: string;
  lpFeeAuthority: CreatorFeeAuthority;
  protocolMemeFees: bigint;
  creatorMemeFees: bigint;
  protocolQuoteFees: bigint;
  creatorQuoteFees: bigint;
  protocolMemeResidual: bigint;
  protocolQuoteResidual: bigint;
};

export type LpVaultObject = SharedObjectReference<true> & {
  type: string;
  content: Uint8Array;
};

export type VenueTier = {
  venue: MigratorVenue;
  tickSpacing: number;
  feeRate: number;
  source: "default" | "override";
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
    lpFeeAuthority: decodeCreatorFeeAuthority(parsed.lp_fee_authority),
    protocolMemeFees: BigInt(parsed.fee_ledger.protocol_meme.value),
    creatorMemeFees: BigInt(parsed.fee_ledger.creator_meme.value),
    protocolQuoteFees: BigInt(parsed.fee_ledger.protocol_quote.value),
    creatorQuoteFees: BigInt(parsed.fee_ledger.creator_quote.value),
    protocolMemeResidual: BigInt(parsed.protocol_meme_residual.value),
    protocolQuoteResidual: BigInt(parsed.protocol_quote_residual.value),
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

export async function getVenueTier(
  client: ClientWithCoreApi,
  venueConfigId: string,
  venue: TieredMigratorVenue,
  originalPackageId: string,
): Promise<VenueTier> {
  const original = normalizeSuiAddress(originalPackageId);
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: normalizeSuiObjectId(venueConfigId),
      name: {
        type: `${original}::venue_config::TierKey<${original}::${venue}::Venue>`,
        bcs: TierKeyBcs.serialize({}).toBytes(),
      },
    });
    const expectedType = normalizeStructTag(`${original}::venue_config::Tier`);
    if (normalizeStructTag(dynamicField.value.type) !== expectedType) {
      throw new TypeError(`venue ${venue} tier has an unexpected type`);
    }
    const tier = venueTierBcs.parse(dynamicField.value.bcs);
    const feeRate = Number(tier.fee_rate);
    if (
      tier.tick_spacing <= 0 ||
      !Number.isSafeInteger(feeRate) ||
      feeRate <= 0
    ) {
      throw new RangeError(`venue ${venue} tier is invalid`);
    }
    return {
      venue,
      tickSpacing: tier.tick_spacing,
      feeRate,
      source: "override",
    };
  } catch (error) {
    if (!(error instanceof ObjectError) || error.reason !== "notFound") {
      throw error;
    }
    return { venue, ...VENUE_DEFAULT_TIERS[venue], source: "default" };
  }
}

export async function getAftermathPolicy(
  client: ClientWithCoreApi,
  venueConfigId: string,
  originalPackageId: string,
): Promise<AftermathPolicy> {
  const original = normalizeSuiAddress(originalPackageId);
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: normalizeSuiObjectId(venueConfigId),
      name: {
        type: `${original}::aftermath::PolicyKey`,
        bcs: AftermathPolicyKeyBcs.serialize({}).toBytes(),
      },
    });
    const expectedType = normalizeStructTag(
      `${original}::aftermath::AftermathPolicy`,
    );
    if (normalizeStructTag(dynamicField.value.type) !== expectedType) {
      throw new TypeError("Aftermath policy has an unexpected type");
    }
    const parsed = aftermathPolicyBcs.parse(dynamicField.value.bcs);
    const policy: AftermathPolicy = {
      memeWeight: BigInt(parsed.meme_weight),
      quoteWeight: BigInt(parsed.quote_weight),
      daoFeeBps: parsed.dao_fee_bps,
      source: "override",
    };
    assertValidAftermathPolicy(policy);
    return policy;
  } catch (error) {
    if (!(error instanceof ObjectError) || error.reason !== "notFound") {
      throw error;
    }
    return AFTERMATH_DEFAULT_POLICY;
  }
}

function assertValidAftermathPolicy(policy: AftermathPolicy): void {
  if (
    policy.memeWeight < AFTERMATH_MIN_WEIGHT ||
    policy.quoteWeight < AFTERMATH_MIN_WEIGHT ||
    policy.memeWeight + policy.quoteWeight !== AFTERMATH_FIXED_ONE
  ) {
    throw new RangeError(
      "Aftermath weights must each be at least 1% and sum to 100%",
    );
  }
  if (
    !Number.isInteger(policy.daoFeeBps) ||
    policy.daoFeeBps < AFTERMATH_MIN_DAO_FEE_BPS ||
    policy.daoFeeBps > AFTERMATH_MAX_DAO_FEE_BPS
  ) {
    throw new RangeError(
      "Aftermath DAO fee must be between 0 and 10,000 basis points",
    );
  }
}

function normalizeTypeParameter(
  type: ReturnType<typeof parseStructTag>["typeParams"][number],
): string {
  if (typeof type === "string") {
    throw new TypeError("LP vault coin type must be a struct type");
  }
  return normalizeStructTag(type);
}
