import type { BlastSuiDeployment } from "../blast-sui/types.ts";
import type { LaunchpadDeployment } from "../launchpad/transactions.ts";
import type { SharedObjectIdentity, SuiPackageReference } from "../lib/sui.ts";
import type { MigratorVenue } from "../migrators/state.ts";
import type { MigratorsDeployment } from "../migrators/transactions.ts";

export const BLAST_NETWORKS = [
  "mainnet",
  "testnet",
  "devnet",
  "localnet",
] as const;

export type BlastNetwork = (typeof BLAST_NETWORKS)[number];

export type BlastPackages = Readonly<
  Record<string, SuiPackageReference> & {
    launchpad: SuiPackageReference;
    /** Published `blast_admin` package (`blast_acl::sign_in`, Meme publish dependency). */
    admin: SuiPackageReference;
    /** Published immutable `blast_partners` package, a launchpad dependency. */
    partners: SuiPackageReference;
    /** Published `blast_fun_timelock` package, an admin and partners dependency. */
    timelock: SuiPackageReference;
    blastSui?: SuiPackageReference;
    migrators?: SuiPackageReference;
    /** Cetus CLMM: the revision Cetus calls target, and the original package that defines its types. */
    cetusClmm?: SuiPackageReference;
    /** Cetus LP Burn, which defines `lp_burn::BurnManager`. */
    cetusLpBurn?: SuiPackageReference;
    /** Bluefin Spot, which defines its `config::GlobalConfig`. */
    bluefinSpot?: SuiPackageReference;
  }
>;

/**
 * Canonical shared-object identities for one deployment.
 *
 * Mutability is intentionally absent because it belongs to each Move call,
 * not to the on-chain object. Transaction builders add the required value.
 */
export type BlastSharedObjects = Readonly<
  Record<string, SharedObjectIdentity> & {
    packageVersion: SharedObjectIdentity;
    launchConfig: SharedObjectIdentity;
    runtimeConfig: SharedObjectIdentity;
    lpFeePolicy?: SharedObjectIdentity;
    /** The singleton `blast_admin::blast_acl::ACL`. */
    acl: SharedObjectIdentity;
    blastSuiPackageVersion?: SharedObjectIdentity;
    blastSuiPackageAdmin?: SharedObjectIdentity;
    blastSuiVault?: SharedObjectIdentity;
    migratorsPackageVersion?: SharedObjectIdentity;
    venueConfig?: SharedObjectIdentity;
    /** Cetus CLMM `config::GlobalConfig`, read by every Cetus pool call. */
    cetusConfig?: SharedObjectIdentity;
    /** Cetus CLMM `factory::Pools`, where Cetus launches reserve and create their pool. */
    cetusPools?: SharedObjectIdentity;
    /** Cetus LP Burn `lp_burn::BurnManager`, which burns and then collects the migration position. */
    cetusBurnManager?: SharedObjectIdentity;
    /** Bluefin Spot `config::GlobalConfig`, read by Bluefin migration, fees, and buyback. */
    bluefinConfig?: SharedObjectIdentity;
    packageAdmin?: SharedObjectIdentity;
  }
>;

export const BLAST_DEPLOYMENT_SCHEMA_VERSION = 1;

/** A venue object's expected type: `<package's original ID>::<module>::<name>`. */
export type VenueObjectType = Readonly<{
  package: string;
  module: string;
  name: string;
}>;

/**
 * Each enabled venue's identity set: the packages whose lineage it records
 * and the shared objects that creating, migrating, and trading a launch on
 * it need, each typed by one of those packages. A manifest records a venue's
 * whole set or none of it.
 */
export const VENUE_IDENTITY_SETS = Object.freeze({
  cetus: Object.freeze({
    packages: Object.freeze(["cetusClmm", "cetusLpBurn"] as const),
    sharedObjects: Object.freeze({
      cetusConfig: {
        package: "cetusClmm",
        module: "config",
        name: "GlobalConfig",
      },
      cetusPools: { package: "cetusClmm", module: "factory", name: "Pools" },
      cetusBurnManager: {
        package: "cetusLpBurn",
        module: "lp_burn",
        name: "BurnManager",
      },
    }),
  }),
  bluefin: Object.freeze({
    packages: Object.freeze(["bluefinSpot"] as const),
    sharedObjects: Object.freeze({
      bluefinConfig: {
        package: "bluefinSpot",
        module: "config",
        name: "GlobalConfig",
      },
    }),
  }),
}) satisfies Record<
  MigratorVenue,
  {
    packages: readonly string[];
    sharedObjects: Readonly<Record<string, VenueObjectType>>;
  }
>;

/**
 * A production manifest may enable production signing; a non-production one
 * (fixtures, localnet, devnet, testnet rehearsals) never can.
 */
export type DeploymentEnvironment = "production" | "non-production";

/** One pool tier an adapter route accepts, in that venue's native units. */
export type MigrationRouteTier = Readonly<{
  tickSpacing: number;
  /** Venue fee rate as a u64 decimal string. */
  feeRate: string;
}>;

/** A migration adapter this deployment admits, with its creator-selectable tiers. */
export type MigrationRoute = Readonly<{
  venue: MigratorVenue;
  tiers: readonly MigrationRouteTier[];
}>;

/** What the release was built from: the contracts commit and the SDK's ABI artifact digests. */
export type DeploymentSource = Readonly<{
  /** 40-hex contracts commit. */
  contractsCommit: string;
  /** sha256 hex of `abi/production-launchpad-v1.json` and `abi/production-blast-sui-v1.json`. */
  abi: Readonly<{ launchpad: string; blastSui: string }>;
}>;

/** Base58 digests of the transactions that published or configured the release, by step. */
export type DeploymentRelease = Readonly<{
  transactions: Readonly<Record<string, string>>;
}>;

/** One post-deploy verification the release process recorded. */
export type PostDeployEvidence = Readonly<{
  check: string;
  transactionDigest: string | null;
  /** u64 decimal string. */
  checkpoint: string;
  /** u64 decimal string, milliseconds since the Unix epoch. */
  verifiedAtMs: string;
}>;

/**
 * The normalized runtime identity of one Blast V2 deployment, the single
 * schema every runtime (web, indexer, keeper) consumes.
 */
export type BlastDeployment = Readonly<{
  schemaVersion: typeof BLAST_DEPLOYMENT_SCHEMA_VERSION;
  environment: DeploymentEnvironment;
  network: BlastNetwork;
  /** The chain's genesis checkpoint digest as the Core API reports it. */
  chainIdentifier: string;
  explorer: Readonly<{ baseUrl: string }>;
  packages: BlastPackages;
  sharedObjects: BlastSharedObjects;
  routes: readonly MigrationRoute[];
  source: DeploymentSource;
  release: DeploymentRelease;
  /** The SDK release the manifest was validated with. */
  sdk: Readonly<{ version: string; commit: string }>;
  evidence: readonly PostDeployEvidence[];
}>;

/** A manifest as JSON carries it: route venues and versions arrive as plain values. */
export type BlastDeploymentInput = Readonly<{
  schemaVersion: number;
  environment: string;
  network: string;
  chainIdentifier: string;
  explorer: Readonly<{ baseUrl: string }>;
  packages: Readonly<Record<string, SuiPackageReference>>;
  sharedObjects: Readonly<Record<string, SharedObjectIdentity>>;
  routes: readonly Readonly<{
    venue: string;
    tiers: readonly Readonly<{
      tickSpacing: number;
      feeRate: string | number | bigint;
    }>[];
  }>[];
  source: Readonly<{
    contractsCommit: string;
    abi: Readonly<{ launchpad: string; blastSui: string }>;
  }>;
  release: Readonly<{ transactions: Readonly<Record<string, string>> }>;
  sdk: Readonly<{ version: string; commit: string }>;
  evidence: readonly Readonly<{
    check: string;
    transactionDigest: string | null;
    checkpoint: string | number;
    verifiedAtMs: string | number;
  }>[];
}>;

export type BlastDeploymentRegistry = Readonly<
  Partial<Record<BlastNetwork, BlastDeployment>>
>;

export type LaunchpadDeploymentConstants = LaunchpadDeployment;
export type BlastSuiDeploymentConstants = BlastSuiDeployment;
export type MigratorsDeploymentConstants = MigratorsDeployment;
