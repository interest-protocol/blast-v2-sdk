import { bcs } from "@mysten/sui/bcs";
import { ObjectError } from "@mysten/sui/client";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import { normalizePositiveU64 } from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";

const IdBcs = bcs.struct("ID", { bytes: bcs.Address });
const UidBcs = bcs.struct("UID", { id: IdBcs });
const BalanceBcs = bcs.struct("Balance", { value: bcs.u64() });
const FeeLedgerBcs = bcs.struct("FeeLedger", {
  protocol_meme: BalanceBcs,
  creator_meme: BalanceBcs,
  protocol_quote: BalanceBcs,
  creator_quote: BalanceBcs,
});
const TierKeyBcs = bcs.struct("TierKey", {});

/** BCS layout of `blast_fun_migrators::vault::LpVault<Meme, Quote>`. */
export const lpVaultBcs = bcs.struct("LpVault", {
  id: UidBcs,
  pool_id: IdBcs,
  fee_ledger: FeeLedgerBcs,
});

/** BCS layout of `blast_fun_migrators::venue_config::Tier`. */
export const venueTierBcs = bcs.struct("Tier", {
  tick_spacing: bcs.u32(),
  fee_rate: bcs.u64(),
});

export const MIGRATOR_VENUES = [
  "bluefin",
  "cetus",
  "mmt",
  "turbos",
  "fullsail",
] as const;

export type MigratorVenue = (typeof MIGRATOR_VENUES)[number];

export const VENUE_DEFAULT_TIERS: Readonly<
  Record<MigratorVenue, Readonly<{ tickSpacing: number; feeRate: number }>>
> = Object.freeze({
  bluefin: Object.freeze({ tickSpacing: 200, feeRate: 10_000 }),
  cetus: Object.freeze({ tickSpacing: 260, feeRate: 40_000 }),
  mmt: Object.freeze({ tickSpacing: 400, feeRate: 20_000 }),
  turbos: Object.freeze({ tickSpacing: 800, feeRate: 40_000 }),
  fullsail: Object.freeze({ tickSpacing: 20, feeRate: 10_000 }),
});

export type LpVaultState = SharedObjectReference<true> & {
  memeType: string;
  quoteType: string;
  poolId: string;
  protocolMemeFees: bigint;
  creatorMemeFees: bigint;
  protocolQuoteFees: bigint;
  creatorQuoteFees: bigint;
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
    throw new TypeError(`LP vault ${object.objectId} must have two type arguments`);
  }
  if (
    originalPackageId !== undefined &&
    tag.address !== normalizeSuiAddress(originalPackageId)
  ) {
    throw new TypeError(`LP vault ${object.objectId} has an unexpected package`);
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
    protocolMemeFees: BigInt(parsed.fee_ledger.protocol_meme.value),
    creatorMemeFees: BigInt(parsed.fee_ledger.creator_meme.value),
    protocolQuoteFees: BigInt(parsed.fee_ledger.protocol_quote.value),
    creatorQuoteFees: BigInt(parsed.fee_ledger.creator_quote.value),
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
  venue: MigratorVenue,
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
    const expectedType = normalizeStructTag(
      `${original}::venue_config::Tier`,
    );
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

function normalizeTypeParameter(
  type: ReturnType<typeof parseStructTag>["typeParams"][number],
): string {
  if (typeof type === "string") {
    throw new TypeError("LP vault coin type must be a struct type");
  }
  return normalizeStructTag(type);
}
