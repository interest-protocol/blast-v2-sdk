import type {
  BlastDeploymentInput,
  DeploymentRuntimeObservation,
} from "@interest-protocol/blast-deployments-sdk";
import { NON_PRODUCTION_MANIFEST } from "./non-production-deployment.ts";

/**
 * Literal venue identities for deployment-manifest tests. Nothing here is
 * computed by the SDK; every value is copied from contracts 442116a:
 *
 * - `sui/launchpad/ptb_tests/fork/fetch.py` (package lines 59-64: each venue
 *   package's original ID, pinned revision ID, and version; `SUI_TYPE`);
 * - `sui/launchpad/ptb_tests/fork/snapshot/manifest.json` (object IDs and
 *   types) and `snapshot/objects/*.bcs` (each object's `Shared` owner and
 *   initial shared version, and the Bluefin fee field contents).
 *
 * They are mainnet venue identities used as fixture data only; no Blast
 * production identity is added.
 */
export const VENUE_LINEAGE = {
  packages: {
    /** Cetus CLMM revision 15. */
    cetusClmm: {
      packageId:
        "0x260693ec785a6e6c9d81d58c7d2ff72f1288ae0fa6a9725abe05a6478b11f084",
      originalPackageId:
        "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
    },
    /** Cetus LP Burn revision 8. */
    cetusLpBurn: {
      packageId:
        "0xc4aabc874f5060d3147d8f74c14e3a8a1f9f8d92edea138a51635395ed167cd9",
      originalPackageId:
        "0x12d73de9a6bc3cb658ec9dc0fe7de2662be1cea5c76c092fcc3606048cdbac27",
    },
    /** Bluefin Spot revision 17. */
    bluefinSpot: {
      packageId:
        "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c",
      originalPackageId:
        "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267",
    },
  },
  sharedObjects: {
    cetus: {
      config: {
        objectId:
          "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f",
        initialSharedVersion: "1574190",
      },
      pools: {
        objectId:
          "0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0",
        initialSharedVersion: "1574190",
      },
      burnManager: {
        objectId:
          "0x1d94aa32518d0cb00f9de6ed60d450c9a2090761f326752ffad06b2e9404f845",
        initialSharedVersion: "327723159",
      },
    },
    bluefin: {
      config: {
        objectId:
          "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352",
        initialSharedVersion: "406496849",
      },
    },
  },
  /** Each object's type as the snapshot recorded it, by its manifest path. */
  types: {
    "cetus.config":
      "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::config::GlobalConfig",
    "cetus.pools":
      "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::factory::Pools",
    "cetus.burnManager":
      "0x12d73de9a6bc3cb658ec9dc0fe7de2662be1cea5c76c092fcc3606048cdbac27::lp_burn::BurnManager",
    "bluefin.config":
      "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::config::GlobalConfig",
  },
} as const;

/**
 * Bluefin's SUI pool-creation fee, as the snapshot holds it under the
 * Bluefin `GlobalConfig`. Each `*Field` is a `dynamic_field::Field` object's
 * contents (`snapshot/objects/bluefin_pool_creation_fee_{table,sui}.bcs`):
 * its UID (32 bytes), then the BCS name, then the BCS value.
 */
export const BLUEFIN_FEE_SNAPSHOT = {
  /** `Field<String, Table<String, u64>>` keyed `"pool_creation_fee"`. */
  tableField:
    "92e15c7664162a7f16566c1d41f565318ced495c8182225553272df635d1c6d111706f6f6c5f6372656174696f6e5f666565ec09276b1ea16e78ffc03aa00240a0f640a102025411d27df674e205af36087c0100000000000000",
  tableFieldType:
    "0x0000000000000000000000000000000000000000000000000000000000000002::dynamic_field::Field<0x0000000000000000000000000000000000000000000000000000000000000001::string::String,0x0000000000000000000000000000000000000000000000000000000000000002::table::Table<0x0000000000000000000000000000000000000000000000000000000000000001::string::String,u64>>",
  /** `Field<String, u64>` keyed by the SUI type name, in the table above. */
  suiField:
    "f7a673a8d7d5743640aea605bf9d658a34182e5a0be2dbf7f822cddf36837aed4a303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030323a3a7375693a3a5355490000000000000000",
  suiFieldType:
    "0x0000000000000000000000000000000000000000000000000000000000000002::dynamic_field::Field<0x0000000000000000000000000000000000000000000000000000000000000001::string::String,u64>",
  /** `fetch.py` `SUI_TYPE`: the key Bluefin's table uses for SUI. */
  suiTypeName:
    "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
} as const;

export type VenueName = "cetus" | "bluefin";

/** The non-production manifest with the given venues' complete sets and routes. */
export function manifestWithVenues(
  venues: readonly VenueName[],
): BlastDeploymentInput {
  const { packages, sharedObjects } = VENUE_LINEAGE;
  const cetus = venues.includes("cetus");
  const bluefin = venues.includes("bluefin");
  return {
    ...NON_PRODUCTION_MANIFEST,
    packages: {
      ...NON_PRODUCTION_MANIFEST.packages,
      ...(cetus && {
        cetusClmm: packages.cetusClmm,
        cetusLpBurn: packages.cetusLpBurn,
      }),
      ...(bluefin && { bluefinSpot: packages.bluefinSpot }),
    },
    sharedObjects: {
      ...NON_PRODUCTION_MANIFEST.sharedObjects,
      ...(cetus && { cetus: sharedObjects.cetus }),
      ...(bluefin && { bluefin: sharedObjects.bluefin }),
    },
    routes: [
      ...(cetus
        ? [{ venue: "cetus", tiers: [{ tickSpacing: 200, feeRate: "10000" }] }]
        : []),
      ...NON_PRODUCTION_MANIFEST.routes,
    ],
  };
}

/** What a node reports for a manifest: its chain and every shared object at its expected type. */
export function runtimeFor(
  input: BlastDeploymentInput,
): DeploymentRuntimeObservation {
  const original = (name: string) =>
    input.packages[name]?.originalPackageId ?? "0x0";
  const types: Record<string, string> = {
    "launchpad.packageVersion": `${original("launchpad")}::blast_fun::PackageVersion`,
    "launchpad.launchConfig": `${original("launchpad")}::launch_config::LaunchConfig`,
    "launchpad.runtimeConfig": `${original("launchpad")}::runtime_config::RuntimeConfig`,
    "admin.acl": `${original("admin")}::blast_acl::ACL`,
    "migrators.packageVersion": `${original("migrators")}::blast_fun_migrators::PackageVersion`,
    "migrators.lpFeePolicy": `${original("migrators")}::lp_fee_policy::LpFeePolicy`,
    "migrators.venueConfig": `${original("migrators")}::venue_config::VenueConfig`,
    "presale.packageVersion": `${original("presale")}::blast_presale_package::PackageVersion`,
    "presale.venueConfig": `${original("presale")}::venue_config::VenueConfig`,
    "presale.creationPolicy": `${original("presale")}::creation_policy::CreationPolicy`,
    "presale.feePolicy": `${original("presale")}::fee_policy::FeePolicy`,
    "cetus.config": `${original("cetusClmm")}::config::GlobalConfig`,
    "cetus.pools": `${original("cetusClmm")}::factory::Pools`,
    "cetus.burnManager": `${original("cetusLpBurn")}::lp_burn::BurnManager`,
    "bluefin.config": `${original("bluefinSpot")}::config::GlobalConfig`,
  };
  return {
    chainIdentifier: input.chainIdentifier,
    sharedObjects: Object.fromEntries(
      Object.entries(input.sharedObjects).flatMap(([group, objects]) =>
        Object.entries(objects).map(([name, identity]) => {
          const path = `${group}.${name}`;
          return [
            path,
            {
              objectId: identity.objectId,
              type: types[path] ?? "0x2::object::UID",
              initialSharedVersion: String(identity.initialSharedVersion),
            },
          ];
        }),
      ),
    ),
  };
}
