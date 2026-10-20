import type { BlastSuiDeployment } from "../blast-sui/types.ts";
import type { LaunchpadDeployment } from "../launchpad/transactions.ts";
import type { SharedObjectIdentity, SuiPackageReference } from "../lib/sui.ts";
import type { MigratorVenue } from "../migrators/state.ts";
import type { MigratorsDeployment } from "../migrators/transactions.ts";

/** Blast deploys to Sui mainnet only (contracts ADR 0103). */
export const BLAST_NETWORKS = ["mainnet"] as const;

export type BlastNetwork = (typeof BLAST_NETWORKS)[number];

/**
 * Every published package a deployment names, each with its current and
 * original package IDs. `launch_ticket_template` and `coin_template` have no
 * entry: each is bytecode a launch or a standalone coin publishes as its own
 * package.
 *
 * `timelock`, `admin`, `partners` and `launchpad` are the core every manifest
 * records. A package a manifest does not record is absent, and the accessor
 * that needs it refuses; the presale publishes on its own (contracts ADR
 * 0099), so a launchpad manifest may predate it. A venue's packages are
 * recorded whole or not at all.
 */
export type BlastPackages = Readonly<{
  /** Immutable `blast_fun_timelock`, which `admin` and `partners` link. */
  timelock: SuiPackageReference;
  /** Immutable `blast_admin`, home of the shared ACL. */
  admin: SuiPackageReference;
  /** Immutable `blast_partners`. */
  partners: SuiPackageReference;
  launchpad: SuiPackageReference;
  migrators?: SuiPackageReference;
  presale?: SuiPackageReference;
  blastSui?: SuiPackageReference;
  /** Cetus CLMM: the revision Cetus calls target, and the original package that defines its types. */
  cetusClmm?: SuiPackageReference;
  /** Cetus LP Burn, which defines `lp_burn::BurnManager`. */
  cetusLpBurn?: SuiPackageReference;
  /** Bluefin Spot, which defines its `config::GlobalConfig`. */
  bluefinSpot?: SuiPackageReference;
}>;

/**
 * Every package's shared singletons the SDK calls or reads, grouped by the
 * package that owns them. Mutability is intentionally absent because it
 * belongs to each Move call, not to the on-chain object; transaction builders
 * add the required value.
 *
 * A group is present exactly when its package is, so each group's path
 * (`launchpad.launchConfig`, `cetus.pools`) names both the owner and the
 * object.
 */
export type BlastSharedObjects = Readonly<{
  admin: Readonly<{
    /** The singleton `blast_admin::blast_acl::ACL`. */
    acl: SharedObjectIdentity;
  }>;
  launchpad: Readonly<{
    packageVersion: SharedObjectIdentity;
    launchConfig: SharedObjectIdentity;
    runtimeConfig: SharedObjectIdentity;
  }>;
  migrators?: Readonly<{
    packageVersion: SharedObjectIdentity;
    lpFeePolicy: SharedObjectIdentity;
    venueConfig: SharedObjectIdentity;
  }>;
  presale?: Readonly<{
    packageVersion: SharedObjectIdentity;
    venueConfig: SharedObjectIdentity;
    creationPolicy: SharedObjectIdentity;
    feePolicy: SharedObjectIdentity;
  }>;
  blastSui?: Readonly<{
    packageVersion: SharedObjectIdentity;
    vault: SharedObjectIdentity;
  }>;
  /** Cetus CLMM's and Cetus LP Burn's singletons. */
  cetus?: Readonly<{
    /** `config::GlobalConfig`, read by every Cetus pool call. */
    config: SharedObjectIdentity;
    /** `factory::Pools`, where Cetus launches reserve and create their pool. */
    pools: SharedObjectIdentity;
    /** `lp_burn::BurnManager`, which burns and then collects the migration position. */
    burnManager: SharedObjectIdentity;
  }>;
  /** Bluefin Spot's singleton. */
  bluefin?: Readonly<{
    /** `config::GlobalConfig`, read by Bluefin migration, fees, and buyback. */
    config: SharedObjectIdentity;
  }>;
}>;

/** Every shared-object group a manifest may record, in canonical order. */
export const SHARED_OBJECT_GROUPS = [
  "admin",
  "launchpad",
  "migrators",
  "presale",
  "blastSui",
  "cetus",
  "bluefin",
] as const satisfies readonly (keyof BlastSharedObjects)[];

export type SharedObjectGroup = (typeof SHARED_OBJECT_GROUPS)[number];

export const BLAST_DEPLOYMENT_SCHEMA_VERSION = 1;

/** A venue object's expected type: `<package's original ID>::<module>::<name>`. */
export type VenueObjectType = Readonly<{
  package: string;
  module: string;
  name: string;
}>;

/**
 * Each enabled venue's identity set: the packages whose lineage it records
 * and, under the venue's own shared-object group, the singletons that
 * creating, migrating, and trading a launch on it need, each typed by one of
 * those packages. A manifest records a venue's whole set or none of it.
 */
export const VENUE_IDENTITY_SETS = Object.freeze({
  cetus: Object.freeze({
    packages: Object.freeze(["cetusClmm", "cetusLpBurn"] as const),
    sharedObjects: Object.freeze({
      config: {
        package: "cetusClmm",
        module: "config",
        name: "GlobalConfig",
      },
      pools: { package: "cetusClmm", module: "factory", name: "Pools" },
      burnManager: {
        package: "cetusLpBurn",
        module: "lp_burn",
        name: "BurnManager",
      },
    }),
  }),
  bluefin: Object.freeze({
    packages: Object.freeze(["bluefinSpot"] as const),
    sharedObjects: Object.freeze({
      config: {
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
 * (fixtures and rehearsals) never can. Blast runs on mainnet only, so the
 * label is the manifest's own claim rather than a network: production signing
 * additionally requires the released registry lineage and a runtime
 * observation, and a manifest carrying any fixture identity is refused.
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

/**
 * A manifest as JSON carries it: shared objects arrive grouped by their owner
 * package, exactly as `BlastSharedObjects` records them, and route venues and
 * versions arrive as plain values.
 */
export type BlastDeploymentInput = Readonly<{
  schemaVersion: number;
  environment: string;
  network: string;
  chainIdentifier: string;
  explorer: Readonly<{ baseUrl: string }>;
  packages: Readonly<Record<string, SuiPackageReference>>;
  sharedObjects: Readonly<
    Record<string, Readonly<Record<string, SharedObjectIdentity>>>
  >;
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
