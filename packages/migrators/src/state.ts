import {
  suiUidBcs,
  u64Bcs,
  unitKeyBcs,
} from "@interest-protocol/blast-core/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";
import type { MigratorsDeployment } from "./transactions.ts";

/**
 * BCS layout of `venue_config::VenueConfig`: its UID only. Venue records are
 * dynamic fields of it, keyed by venue-sealed field-less structs
 * (`PoolTierKey<Meme>()`, `CreationCapKey<Meme>()`) that encode as one zero
 * byte.
 */
export const venueConfigBcs = bcs.struct("VenueConfig", { id: suiUidBcs });

/** `bluefin::PoolTier`: the Bluefin pool tier a Meme's migration uses. */
export const bluefinPoolTierBcs = bcs.struct("PoolTier", {
  tick_spacing: bcs.u32(),
  fee_rate: u64Bcs,
});

/** A Bluefin pool tier; `feeRate` is in Bluefin fee units (1,000,000 is 100%). */
export type BluefinPoolTier = { tickSpacing: number; feeRate: bigint };

type VenueConfigReader = Pick<
  MigratorsDeployment,
  "originalPackageId" | "venueConfig"
>;

/**
 * The tick spacing `cetus::prepare` recorded for `memeType`
 * (`cetus::PoolTierKey<Meme>`), or null before the Meme is prepared for
 * Cetus. Pass the Meme's original (defining) type address.
 */
export async function getCetusPoolTier(
  client: ClientWithCoreApi,
  migrators: VenueConfigReader,
  memeType: string,
): Promise<number | null> {
  const value = await venueField(client, migrators, "cetus", memeType);
  return value === null ? null : bcs.u32().parse(value);
}

/**
 * The tier `bluefin::prepare` recorded for `memeType`
 * (`bluefin::PoolTierKey<Meme>`), or null before the Meme is prepared for
 * Bluefin.
 */
export async function getBluefinPoolTier(
  client: ClientWithCoreApi,
  migrators: VenueConfigReader,
  memeType: string,
): Promise<BluefinPoolTier | null> {
  const value = await venueField(client, migrators, "bluefin", memeType);
  if (value === null) return null;
  const tier = bluefinPoolTierBcs.parse(value);
  return { tickSpacing: tier.tick_spacing, feeRate: tier.fee_rate };
}

/**
 * The ID of the Meme type's Cetus `PoolCreationCap`, kept in `VenueConfig`
 * under `cetus::CreationCapKey<Meme>` (the `pool_creation_cap_id` of its
 * `CetusPoolReserved`), or null before the Meme is prepared for Cetus.
 */
export async function getCetusPoolCreationCapId(
  client: ClientWithCoreApi,
  migrators: VenueConfigReader,
  memeType: string,
): Promise<string | null> {
  try {
    const { object } = await client.core.getDynamicObjectField({
      parentId: normalizeSuiObjectId(migrators.venueConfig.objectId),
      name: venueKey(migrators, "cetus", "CreationCapKey", memeType),
    });
    return normalizeSuiObjectId(object.objectId);
  } catch (error) {
    if (error instanceof ObjectError && error.reason === "notFound")
      return null;
    throw error;
  }
}

/**
 * The `VenueConfig` dynamic-field name `<original>::<venue>::<key><Meme>()`:
 * the key type with the Meme's original type address, and one zero byte.
 */
function venueKey(
  migrators: Pick<MigratorsDeployment, "originalPackageId">,
  venue: "cetus" | "bluefin",
  key: "PoolTierKey" | "CreationCapKey",
  memeType: string,
): { type: string; bcs: Uint8Array } {
  return {
    type: normalizeStructTag(
      `${normalizeSuiObjectId(migrators.originalPackageId)}::${venue}::${key}<${normalizeStructTag(memeType)}>`,
    ),
    bcs: unitKeyBcs.serialize(null).toBytes(),
  };
}

async function venueField(
  client: ClientWithCoreApi,
  migrators: VenueConfigReader,
  venue: "cetus" | "bluefin",
  memeType: string,
): Promise<Uint8Array | null> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: normalizeSuiObjectId(migrators.venueConfig.objectId),
      name: venueKey(migrators, venue, "PoolTierKey", memeType),
    });
    return dynamicField.value.bcs;
  } catch (error) {
    if (error instanceof ObjectError && error.reason === "notFound")
      return null;
    throw error;
  }
}
