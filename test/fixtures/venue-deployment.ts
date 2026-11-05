import type {
  BlastDeploymentInput,
  DeploymentRuntimeObservation,
} from "@interest-protocol/blast-deployments-sdk";
import { NON_PRODUCTION_MANIFEST } from "./non-production-deployment.ts";

/**
 * Literal venue identities for deployment-manifest tests. Nothing here is
 * computed by the SDK. The Cetus and Bluefin values are copied from contracts
 * 442116a; the Aftermath values from contracts a1a8f6c
 * `sui/vendors/aftermath_dao_presale` (interface manifests and README):
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
    /** The vendor venue: a fixture ID (sha256("blast-sdk-nonprod-29")). */
    aftermathDaoPresale: {
      packageId:
        "0xd4a033a3000b2682d4815ecfa7ae1cbd15ac1dc1131ad1f142ae703deaab14a2",
      originalPackageId:
        "0xd4a033a3000b2682d4815ecfa7ae1cbd15ac1dc1131ad1f142ae703deaab14a2",
    },
    /** Aftermath AMM, as the vendor's `interfaces/aftermath_amm/Move.toml` pins it. */
    aftermathAmm: {
      packageId:
        "0xf948935b111990c2b604900c9b2eeb8f24dcf9868a45d1ea1653a5f282c10e29",
      originalPackageId:
        "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c",
    },
    /** Aftermath DAO-fee pools, as `interfaces/aftermath_dao_fee/Move.toml` pins them. */
    aftermathDaoFee: {
      packageId:
        "0x5ad6890968efcf3d20899e0cec735214f1067b96e77e77d86408989998468bb2",
      originalPackageId:
        "0x6f60a091637054e23915b8745c0c0d47b1d49618ee3435b5f68eccf6a44fb53d",
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
    /** The objects the vendor's README records, with their mainnet initial shared versions. */
    aftermath: {
      poolRegistry: {
        objectId:
          "0xfcc774493db2c45c79f688f88d28023a3e7d98e4ee9f48bbf5c7990f651577ae",
        initialSharedVersion: "6808332",
      },
      daoFeeVersion: {
        objectId:
          "0xb4bfb0f917f12ad2a772bea9b4f22431f6f5f9653162c3ae6fae5b99b21392b7",
        initialSharedVersion: "293243902",
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
    "aftermath.poolRegistry":
      "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c::pool_registry::PoolRegistry",
    "aftermath.daoFeeVersion":
      "0x6f60a091637054e23915b8745c0c0d47b1d49618ee3435b5f68eccf6a44fb53d::version::Version",
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

export type VenueName = "cetus" | "bluefin" | "aftermathDao";

/** The non-production manifest with the given venues' complete sets and routes. */
export function manifestWithVenues(
  venues: readonly VenueName[],
): BlastDeploymentInput {
  const { packages, sharedObjects } = VENUE_LINEAGE;
  const cetus = venues.includes("cetus");
  const bluefin = venues.includes("bluefin");
  const aftermath = venues.includes("aftermathDao");
  return {
    ...NON_PRODUCTION_MANIFEST,
    packages: {
      ...NON_PRODUCTION_MANIFEST.packages,
      ...(cetus && {
        cetusClmm: packages.cetusClmm,
        cetusLpBurn: packages.cetusLpBurn,
      }),
      ...(bluefin && { bluefinSpot: packages.bluefinSpot }),
      ...(aftermath && {
        aftermathDaoPresale: packages.aftermathDaoPresale,
        aftermathAmm: packages.aftermathAmm,
        aftermathDaoFee: packages.aftermathDaoFee,
      }),
    },
    sharedObjects: {
      ...NON_PRODUCTION_MANIFEST.sharedObjects,
      ...(cetus && { cetus: sharedObjects.cetus }),
      ...(bluefin && { bluefin: sharedObjects.bluefin }),
      ...(aftermath && { aftermath: sharedObjects.aftermath }),
    },
    routes: [
      ...(cetus
        ? [{ venue: "cetus", tiers: [{ tickSpacing: 200, feeRate: "10000" }] }]
        : []),
      ...NON_PRODUCTION_MANIFEST.routes,
      ...(aftermath ? [{ venue: "aftermathDao", tiers: [] }] : []),
    ],
  };
}

/**
 * What a node reports for a manifest: its chain, every shared object at its
 * expected type, and each pausable package's `paused` mask (`paused`, all
 * zero by default).
 */
export function runtimeFor(
  input: BlastDeploymentInput,
  paused: Readonly<Record<string, number>> = {},
): DeploymentRuntimeObservation {
  const original = (name: string) =>
    input.packages[name]?.originalPackageId ?? "0x0";
  const admin = original("admin");
  const otw = (group: string, module: string, name: string) =>
    `${original(group)}::${module}::${name}`;
  const administered = (group: string, module: string, name: string) => ({
    [`${group}.packageVersion`]: `${admin}::package_version::PackageVersion<${otw(group, module, name)}>`,
    [`${group}.packageAdmin`]: `${admin}::package_admin::PackageAdmin<${otw(group, module, name)}>`,
  });
  const types: Record<string, string> = {
    "admin.acl": `${admin}::blast_acl::ACL`,
    "core.treasury": `${original("core")}::blast_treasury::Treasury`,
    "vault.registry": `${original("vault")}::blast_vault_package::VaultRegistry`,
    ...administered("vault", "blast_vault_package", "BLAST_VAULT_PACKAGE"),
    ...administered("launchpad", "blast_fun", "BLAST_FUN"),
    "launchpad.launchConfig": `${original("launchpad")}::launch_config::LaunchConfig`,
    "launchpad.runtimeConfig": `${original("launchpad")}::runtime_config::RuntimeConfig`,
    "launchpad.launchRegistry": `${original("launchpad")}::launch::LaunchRegistry`,
    ...administered(
      "presale",
      "blast_presale_package",
      "BLAST_PRESALE_PACKAGE",
    ),
    "presale.creationPolicy": `${original("presale")}::creation_policy::CreationPolicy`,
    "presale.feePolicy": `${original("presale")}::fee_policy::FeePolicy`,
    "presale.presaleRegistry": `${original("presale")}::blast_presale::PresaleRegistry`,
    ...administered("migrators", "blast_migrators", "BLAST_MIGRATORS"),
    "migrators.venueConfig": `${original("migrators")}::venue_config::VenueConfig`,
    "cetus.config": `${original("cetusClmm")}::config::GlobalConfig`,
    "cetus.pools": `${original("cetusClmm")}::factory::Pools`,
    "cetus.burnManager": `${original("cetusLpBurn")}::lp_burn::BurnManager`,
    "bluefin.config": `${original("bluefinSpot")}::config::GlobalConfig`,
    "aftermath.poolRegistry": `${original("aftermathAmm")}::pool_registry::PoolRegistry`,
    "aftermath.daoFeeVersion": `${original("aftermathDaoFee")}::version::Version`,
  };
  const pausable = ["vault", "launchpad", "presale", "migrators"];
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
              ...(name === "packageVersion" && pausable.includes(group)
                ? { paused: paused[group] ?? 0 }
                : {}),
            },
          ];
        }),
      ),
    ),
  };
}
