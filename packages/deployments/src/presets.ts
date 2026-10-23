import {
  requirePositiveU64,
  requireU64,
} from "@interest-protocol/blast-core/integers";
import type {
  CreatorAllocationPlan,
  FeeSplit,
} from "@interest-protocol/blast-launchpad-sdk/allocation";
import {
  normalizeAllocationPlan,
  normalizeFeeSplit,
} from "@interest-protocol/blast-launchpad-sdk/allocation";
import type { ProtocolAccess, SdkRelease } from "./identity.ts";
import { SDK_RELEASE } from "./identity.ts";
import { normalizeRoute } from "./registry.ts";
import type { MigrationRouteTier } from "./types.ts";

/** The launch settings a Quick preset fills in. */
export type QuickPresetValues = Readonly<{
  virtualQuote: bigint;
  graduationTarget: bigint;
  openingRoundMs: bigint;
  route: Readonly<{ venue: string } & MigrationRouteTier>;
  allocationPlan: CreatorAllocationPlan;
  lpFeeSplit: FeeSplit;
}>;

/**
 * A Quick launch preset, valid only for the one deployment whose fingerprint
 * it names and for SDK versions in `[sdk.minimum, sdk.below)`. `values` stays
 * null until reviewed production values exist.
 */
export type QuickPreset = Readonly<{
  id: string;
  deploymentFingerprint: string;
  sdk: Readonly<{ minimum: string; below: string }>;
  values: QuickPresetValues | null;
}>;

export type QuickPresetResolution =
  | Readonly<{ status: "available"; values: QuickPresetValues }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "signing-disabled"
        | "deployment-mismatch"
        | "sdk-incompatible"
        | "values-absent";
    }>;

/** Released Quick presets. None exist: production values are not yet approved. */
export const QUICK_PRESETS: readonly QuickPreset[] = Object.freeze([]);

/** Validates and freezes one preset. */
export function defineQuickPreset(preset: QuickPreset): QuickPreset {
  if (typeof preset.id !== "string" || preset.id.trim() === "") {
    throw new TypeError("a Quick preset needs an id");
  }
  if (!/^[0-9a-f]{64}$/.test(preset.deploymentFingerprint)) {
    throw new TypeError(
      "deploymentFingerprint must be a sha256 hex fingerprint",
    );
  }
  const minimum = parseVersion(preset.sdk.minimum);
  const below = parseVersion(preset.sdk.below);
  if (compareVersions(minimum, below) >= 0) {
    throw new RangeError("the SDK range must be non-empty: minimum < below");
  }
  return Object.freeze({
    id: preset.id,
    deploymentFingerprint: preset.deploymentFingerprint,
    sdk: Object.freeze({ ...preset.sdk }),
    values: preset.values === null ? null : normalizeValues(preset.values),
  });
}

/**
 * Returns the preset's values only when protocol access is enabled for the
 * exact deployment it names and this SDK is inside its range.
 */
export function resolveQuickPreset(
  preset: QuickPreset,
  access: ProtocolAccess,
  sdk: SdkRelease = SDK_RELEASE,
): QuickPresetResolution {
  if (access.signing !== "enabled") {
    return unavailable("signing-disabled");
  }
  if (access.fingerprint !== preset.deploymentFingerprint) {
    return unavailable("deployment-mismatch");
  }
  const version = parseVersion(sdk.version);
  if (
    compareVersions(version, parseVersion(preset.sdk.minimum)) < 0 ||
    compareVersions(version, parseVersion(preset.sdk.below)) >= 0
  ) {
    return unavailable("sdk-incompatible");
  }
  if (preset.values === null) return unavailable("values-absent");
  return Object.freeze({ status: "available", values: preset.values });
}

function normalizeValues(values: QuickPresetValues): QuickPresetValues {
  const [tier] = normalizeRoute({
    venue: values.route.venue,
    tiers: [values.route],
  }).tiers;
  return Object.freeze({
    virtualQuote: requirePositiveU64("virtualQuote", values.virtualQuote),
    graduationTarget: requirePositiveU64(
      "graduationTarget",
      values.graduationTarget,
    ),
    openingRoundMs: requireU64("openingRoundMs", values.openingRoundMs),
    route: Object.freeze({ venue: values.route.venue, ...tier! }),
    allocationPlan: normalizeAllocationPlan(values.allocationPlan),
    lpFeeSplit: normalizeFeeSplit(values.lpFeeSplit),
  });
}

function unavailable(
  reason: Extract<QuickPresetResolution, { status: "unavailable" }>["reason"],
): QuickPresetResolution {
  return Object.freeze({ status: "unavailable", reason });
}

function parseVersion(version: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new TypeError(`invalid SDK version ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
