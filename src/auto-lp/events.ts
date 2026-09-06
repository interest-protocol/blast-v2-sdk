import type { SuiClientTypes } from "@mysten/sui/client";
import type {
  DecodedPackageEvent,
  PackageEventLineage,
  PackageEventSpecs,
} from "../lib/package-events.ts";
import { decodePackageEvent, packageEventBcs } from "../lib/package-events.ts";
export const autoLpEventSpecs = {
  vault: {
    Enrolled: {
      vault_id: "id",
      pool_id: "id",
      creator_cap_id: "id",
      position_id: "id",
      executor: "address",
    },
    FeesCollected: {
      vault_id: "id",
      source_id: "id",
      meme: "u64",
      quote: "u64",
      meme_total: "u64",
      quote_total: "u64",
    },
    Contributed: {
      vault_id: "id",
      meme: "u64",
      quote: "u64",
      meme_total: "u64",
      quote_total: "u64",
    },
    Compounded: {
      vault_id: "id",
      meme: "u64",
      quote: "u64",
      shares: "u128",
      meme_total: "u64",
      quote_total: "u64",
    },
    VersionActivated: { previous_version: "u64", version: "u64" },
  },
} as const satisfies PackageEventSpecs;
export const autoLpEventBcs = packageEventBcs(autoLpEventSpecs);
export type DecodedAutoLpEvent = DecodedPackageEvent<typeof autoLpEventSpecs>;
export function decodeAutoLpEvent(
  event: SuiClientTypes.EventEntry,
  packages: PackageEventLineage,
): DecodedAutoLpEvent {
  return decodePackageEvent(event, packages, autoLpEventSpecs, autoLpEventBcs);
}
