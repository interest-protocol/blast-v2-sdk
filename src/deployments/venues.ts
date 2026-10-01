import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiObjectId,
  SUI_TYPE_ARG,
} from "@mysten/sui/utils";

import { suiUidBcs } from "../lib/bcs.ts";
import type { SharedObjectReference, SuiPackageReference } from "../lib/sui.ts";
import { sharedObjectReference } from "../lib/sui.ts";
import type { MigratorVenue } from "../migrators/state.ts";
import type { DeploymentRejection, ProtocolAccess } from "./identity.ts";
import type { BlastDeployment } from "./types.ts";

/**
 * A venue's recorded objects as the migrators builders take them, grouped by
 * action, each at the mutability that call needs. Spread a group into the
 * builder's options, e.g. `migrateCetus({ ...objects.migrate, ... })`.
 */
export type CetusVenueObjects = Readonly<{
  venue: "cetus";
  packages: Readonly<{
    cetusClmm: SuiPackageReference;
    cetusLpBurn: SuiPackageReference;
  }>;
  /** `newCetusLaunch` and `createCetusLaunch`. */
  create: Readonly<{
    cetusConfig: SharedObjectReference<false>;
    cetusPools: SharedObjectReference<true>;
  }>;
  /** `migrateCetus`. */
  migrate: Readonly<{
    cetusConfig: SharedObjectReference<false>;
    cetusPools: SharedObjectReference<true>;
    burnManager: SharedObjectReference<true>;
  }>;
  /** `collectCetusFees` and `settleAndUpdateCetusFeeSplit`. */
  fees: Readonly<{
    cetusConfig: SharedObjectReference<false>;
    burnManager: SharedObjectReference<false>;
  }>;
  /** `buybackAndBurnCetus`. */
  buyback: Readonly<{ cetusConfig: SharedObjectReference<false> }>;
}>;

/** Bluefin's builder inputs; `bluefin::new` itself takes no venue object. */
export type BluefinVenueObjects = Readonly<{
  venue: "bluefin";
  packages: Readonly<{ bluefinSpot: SuiPackageReference }>;
  /** `migrateBluefin`. */
  migrate: Readonly<{ bluefinConfig: SharedObjectReference<true> }>;
  /** `collectBluefinFees` and `settleAndUpdateBluefinFeeSplit`. */
  fees: Readonly<{ bluefinConfig: SharedObjectReference<false> }>;
  /** `buybackAndBurnBluefin`. */
  buyback: Readonly<{ bluefinConfig: SharedObjectReference<false> }>;
}>;

export type VenueObjects = {
  cetus: CetusVenueObjects;
  bluefin: BluefinVenueObjects;
};

/** A venue action was refused: the venue is unavailable for these reasons. */
export class VenueUnavailableError extends Error {
  readonly venue: MigratorVenue;
  readonly reasons: readonly DeploymentRejection[];

  constructor(venue: MigratorVenue, reasons: readonly DeploymentRejection[]) {
    super(
      `${venue} is unavailable: ${reasons.map(({ code }) => code).join(", ")}`,
    );
    this.name = "VenueUnavailableError";
    this.venue = venue;
    this.reasons = reasons;
  }
}

/**
 * Returns `venue`'s builder inputs from the evaluated deployment. Refuses
 * with that venue's reasons unless signing is enabled and the venue is
 * available, so every venue action reads its identities only from a
 * lineage-checked manifest.
 */
export function resolveVenueObjects<const Venue extends MigratorVenue>(
  access: ProtocolAccess,
  venue: Venue,
): VenueObjects[Venue] {
  const availability = access.venues[venue];
  if (!availability.available) {
    throw new VenueUnavailableError(venue, availability.reasons);
  }
  if (access.signing !== "enabled") {
    throw new VenueUnavailableError(venue, access.reasons);
  }
  const objects =
    venue === "cetus"
      ? cetusObjects(access.deployment)
      : bluefinObjects(access.deployment);
  return objects as VenueObjects[Venue];
}

function cetusObjects(deployment: BlastDeployment): CetusVenueObjects {
  const { cetusClmm, cetusLpBurn } = deployment.packages;
  const { cetusConfig, cetusPools, cetusBurnManager } =
    deployment.sharedObjects;
  if (
    !cetusClmm ||
    !cetusLpBurn ||
    !cetusConfig ||
    !cetusPools ||
    !cetusBurnManager
  ) {
    throw new TypeError("an available Cetus venue records its whole set");
  }
  const config = sharedObjectReference(cetusConfig, false);
  return Object.freeze({
    venue: "cetus",
    packages: Object.freeze({ cetusClmm, cetusLpBurn }),
    create: Object.freeze({
      cetusConfig: config,
      cetusPools: sharedObjectReference(cetusPools, true),
    }),
    migrate: Object.freeze({
      cetusConfig: config,
      cetusPools: sharedObjectReference(cetusPools, true),
      burnManager: sharedObjectReference(cetusBurnManager, true),
    }),
    fees: Object.freeze({
      cetusConfig: config,
      burnManager: sharedObjectReference(cetusBurnManager, false),
    }),
    buyback: Object.freeze({ cetusConfig: config }),
  });
}

function bluefinObjects(deployment: BlastDeployment): BluefinVenueObjects {
  const { bluefinSpot } = deployment.packages;
  const { bluefinConfig } = deployment.sharedObjects;
  if (!bluefinSpot || !bluefinConfig) {
    throw new TypeError("an available Bluefin venue records its whole set");
  }
  const readOnly = sharedObjectReference(bluefinConfig, false);
  return Object.freeze({
    venue: "bluefin",
    packages: Object.freeze({ bluefinSpot }),
    migrate: Object.freeze({
      bluefinConfig: sharedObjectReference(bluefinConfig, true),
    }),
    fees: Object.freeze({ bluefinConfig: readOnly }),
    buyback: Object.freeze({ bluefinConfig: readOnly }),
  });
}

/** Why Bluefin's pool-creation fee could not be read. */
export type BluefinPoolCreationFeeErrorCode =
  | "venue-unrecorded"
  | "foreign-lineage"
  | "fee-field-missing"
  | "fee-field-invalid"
  | "fee-entry-missing";

export class BluefinPoolCreationFeeError extends Error {
  readonly code: BluefinPoolCreationFeeErrorCode;

  constructor(code: BluefinPoolCreationFeeErrorCode, message: string) {
    super(message);
    this.name = "BluefinPoolCreationFeeError";
    this.code = code;
  }
}

const MOVE_STRING = "0x1::string::String";
const FEE_TABLE_TYPE = normalizeStructTag(
  "0x2::table::Table<0x1::string::String, u64>",
);
/** Move `type_name` text for SUI: the full address without `0x`. */
const SUI_TYPE_NAME = normalizeStructTag(SUI_TYPE_ARG).slice(2);
const feeTableBcs = bcs.struct("Table", { id: suiUidBcs, size: bcs.u64() });

/**
 * Reads Bluefin's current SUI pool-creation fee, in MIST, which
 * `bluefin::migrate` requires exactly. The recorded Bluefin `GlobalConfig`
 * (of the recorded Bluefin Spot lineage) holds a dynamic field keyed by the
 * `String` `"pool_creation_fee"`: a `Table<String, u64>` whose entry keyed
 * by SUI's type name is the fee. Every missing step is a typed failure; there
 * is no default.
 */
export async function getBluefinPoolCreationFee(
  client: ClientWithCoreApi,
  deployment: BlastDeployment,
): Promise<bigint> {
  const spot = deployment.packages.bluefinSpot;
  const config = deployment.sharedObjects.bluefinConfig;
  if (!spot || !config) {
    throw new BluefinPoolCreationFeeError(
      "venue-unrecorded",
      "the deployment records no Bluefin set",
    );
  }
  const { object } = await client.core.getObject({ objectId: config.objectId });
  if (
    normalizeStructTag(object.type) !==
    normalizeStructTag(`${spot.originalPackageId}::config::GlobalConfig`)
  ) {
    throw new BluefinPoolCreationFeeError(
      "foreign-lineage",
      `${config.objectId} is not the recorded Bluefin Spot GlobalConfig`,
    );
  }
  const table = await stringField(client, config.objectId, "pool_creation_fee");
  if (!table) {
    throw new BluefinPoolCreationFeeError(
      "fee-field-missing",
      "the Bluefin config has no pool_creation_fee table",
    );
  }
  if (normalizeStructTag(table.type) !== FEE_TABLE_TYPE) {
    throw new BluefinPoolCreationFeeError(
      "fee-field-invalid",
      `pool_creation_fee holds ${table.type}`,
    );
  }
  const tableId = normalizeSuiObjectId(
    feeTableBcs.parse(table.bcs).id.id.bytes,
  );
  const entry = await stringField(client, tableId, SUI_TYPE_NAME);
  if (!entry) {
    throw new BluefinPoolCreationFeeError(
      "fee-entry-missing",
      "Bluefin's pool-creation fee table has no SUI entry",
    );
  }
  if (entry.type !== "u64") {
    throw new BluefinPoolCreationFeeError(
      "fee-field-invalid",
      `the SUI fee entry holds ${entry.type}`,
    );
  }
  return BigInt(bcs.u64().parse(entry.bcs));
}

/** The value of `parentId`'s dynamic field keyed by the Move `String` `key`, or null. */
async function stringField(
  client: ClientWithCoreApi,
  parentId: string,
  key: string,
): Promise<{ type: string; bcs: Uint8Array } | null> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId,
      name: { type: MOVE_STRING, bcs: bcs.string().serialize(key).toBytes() },
    });
    return dynamicField.value;
  } catch (error) {
    if (error instanceof ObjectError && error.reason === "notFound") {
      return null;
    }
    throw error;
  }
}
