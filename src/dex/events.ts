import type { SuiClientTypes } from "@mysten/sui/client";
import type {
  DecodedPackageEvent,
  PackageEventLineage,
  PackageEventSpecs,
} from "../lib/package-events.ts";
import { decodePackageEvent, packageEventBcs } from "../lib/package-events.ts";
export const dexEventSpecs = {
  pool: {
    PoolCreated: {
      pool_id: "id",
      position_id: "id",
      meme: "u64",
      quote: "u64",
      total_shares: "u128",
      burn_bps: "u64",
      max_fee_bps: "u64",
      timestamp_seconds: "u64",
    },
    PositionCreated: { pool_id: "id", position_id: "id" },
    PositionClosed: { pool_id: "id", position_id: "id" },
    Swapped: {
      pool_id: "id",
      buy: "bool",
      meme_principal: "u64",
      quote_principal: "u64",
      quote_fee: "u64",
      meme_burn: "u64",
      meme_reserve: "u64",
      quote_reserve: "u64",
      fee_balance: "u64",
      volume_x32: "u128",
      timestamp_seconds: "u64",
    },
    LiquidityChanged: {
      pool_id: "id",
      position_id: "id",
      added: "bool",
      shares: "u128",
      meme: "u64",
      quote: "u64",
      total_shares: "u128",
    },
    FeesClaimed: { pool_id: "id", position_id: "id", quote: "u64" },
    MaximumFeeChanged: {
      pool_id: "id",
      previous_bps: "u64",
      maximum_bps: "u64",
    },
    VersionActivated: { previous_version: "u64", version: "u64" },
  },
  migration: {
    Migrated: {
      launch_id: "id",
      pool_id: "id",
      vault_id: "id",
      position_id: "id",
      meme: "u64",
      quote: "u64",
    },
    FeesCollected: {
      vault_id: "id",
      quote: "u64",
      protocol_share_bps: "u64",
      protocol_delta: "u64",
      creator_delta: "u64",
      protocol_total: "u64",
      creator_total: "u64",
    },
    CreatorFeesClaimed: { vault_id: "id", quote: "u64" },
    ProtocolFeesClaimed: { vault_id: "id", quote: "u64" },
  },
} as const satisfies PackageEventSpecs;
export const dexEventBcs = packageEventBcs(dexEventSpecs);
export type DecodedDexEvent = DecodedPackageEvent<typeof dexEventSpecs>;
export function decodeDexEvent(
  event: SuiClientTypes.EventEntry,
  packages: PackageEventLineage,
): DecodedDexEvent {
  return decodePackageEvent(event, packages, dexEventSpecs, dexEventBcs, {
    "pool.PoolCreated": 2,
  });
}
