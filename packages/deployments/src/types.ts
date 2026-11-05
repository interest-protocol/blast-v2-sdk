import type {
  SharedObjectIdentity,
  SuiPackageReference,
} from "@interest-protocol/blast-core/sui";

/** Blast deploys to Sui mainnet only (contracts ADR 0103). */
export const BLAST_NETWORKS = ["mainnet"] as const;

export type BlastNetwork = (typeof BLAST_NETWORKS)[number];

/**
 * Every published package a deployment names, each with its current and
 * original package IDs. `launch_ticket_template` and `coin_template` have no
 * entry: each is bytecode a launch or a standalone coin publishes as its own
 * package.
 *
 * The seven launch-stack packages of contracts ADR 0137 and
 * `blast_fun_vesting` (which types `blast_fun_linear_vesting::Vesting`) are
 * required. A venue's packages are recorded whole or not at all.
 */
export type BlastPackages = Readonly<{
  /** Immutable `blast_admin`, home of the shared ACL and package administration. */
  admin: SuiPackageReference;
  /** Immutable `blast_partners`. */
  partners: SuiPackageReference;
  /** Immutable `blast_core`, home of the shared `Treasury`. */
  core: SuiPackageReference;
  /** `blast_fun_vesting`, which types the vesting objects payouts create. */
  vesting: SuiPackageReference;
  vault: SuiPackageReference;
  launchpad: SuiPackageReference;
  presale: SuiPackageReference;
  migrators: SuiPackageReference;
  blastSui?: SuiPackageReference;
  /** The `blast_aftermath_dao_presale` vendor venue. */
  aftermathDaoPresale?: SuiPackageReference;
  /** Cetus CLMM: the revision Cetus calls target, and the original package that defines its types. */
  cetusClmm?: SuiPackageReference;
  /** Cetus LP Burn, which defines `lp_burn::BurnManager`. */
  cetusLpBurn?: SuiPackageReference;
  /** Bluefin Spot, which defines its `config::GlobalConfig`. */
  bluefinSpot?: SuiPackageReference;
  /** Aftermath AMM, which defines `pool_registry::PoolRegistry`. */
  aftermathAmm?: SuiPackageReference;
  /** Aftermath DAO-fee pools, which define `version::Version`. */
  aftermathDaoFee?: SuiPackageReference;
}>;

/**
 * Every package's shared singletons the SDK calls or reads, grouped by the
 * package that owns them. Mutability is intentionally absent because it
 * belongs to each Move call, not to the on-chain object; transaction builders
 * add the required value.
 *
 * Each upgradeable package records its `PackageVersion<OTW>` and
 * `PackageAdmin<OTW>`. A group is present exactly when its package is, so
 * each group's path (`launchpad.launchConfig`, `cetus.pools`) names both the
 * owner and the object.
 */
export type BlastSharedObjects = Readonly<{
  admin: Readonly<{
    /** The singleton `blast_admin::blast_acl::ACL`. */
    acl: SharedObjectIdentity;
  }>;
  core: Readonly<{
    /** `blast_treasury::Treasury`, every protocol fee's destination. */
    treasury: SharedObjectIdentity;
  }>;
  vault: Readonly<{
    /** `blast_vault_package::VaultRegistry`, the admitted package and venue witnesses. */
    registry: SharedObjectIdentity;
    packageVersion: SharedObjectIdentity;
    packageAdmin: SharedObjectIdentity;
  }>;
  launchpad: Readonly<{
    packageVersion: SharedObjectIdentity;
    packageAdmin: SharedObjectIdentity;
    launchConfig: SharedObjectIdentity;
    runtimeConfig: SharedObjectIdentity;
    /** `launch::LaunchRegistry`, the parent of every derived launch ID. */
    launchRegistry: SharedObjectIdentity;
  }>;
  presale: Readonly<{
    packageVersion: SharedObjectIdentity;
    packageAdmin: SharedObjectIdentity;
    creationPolicy: SharedObjectIdentity;
    feePolicy: SharedObjectIdentity;
    /** `blast_presale::PresaleRegistry`, the parent of every derived presale ID. */
    presaleRegistry: SharedObjectIdentity;
  }>;
  migrators: Readonly<{
    packageVersion: SharedObjectIdentity;
    packageAdmin: SharedObjectIdentity;
    venueConfig: SharedObjectIdentity;
  }>;
  blastSui?: Readonly<{
    packageVersion: SharedObjectIdentity;
    vault: SharedObjectIdentity;
  }>;
  /** Cetus CLMM's and Cetus LP Burn's singletons. */
  cetus?: Readonly<{
    /** `config::GlobalConfig`, read by every Cetus pool call. */
    config: SharedObjectIdentity;
    /** `factory::Pools`, where Cetus sales reserve and create their pool. */
    pools: SharedObjectIdentity;
    /** `lp_burn::BurnManager`, which burns and then collects the migration position. */
    burnManager: SharedObjectIdentity;
  }>;
  /** Bluefin Spot's singleton. */
  bluefin?: Readonly<{
    /** `config::GlobalConfig`, read by Bluefin migration, fees, and buyback. */
    config: SharedObjectIdentity;
  }>;
  /** Aftermath's singletons the vendor venue's migration takes. */
  aftermath?: Readonly<{
    /** Aftermath AMM `pool_registry::PoolRegistry`, taken mutably. */
    poolRegistry: SharedObjectIdentity;
    /** Aftermath DAO-fee pools `version::Version`, taken read-only. */
    daoFeeVersion: SharedObjectIdentity;
  }>;
}>;

/** Every shared-object group a manifest may record, in canonical order. */
export const SHARED_OBJECT_GROUPS = [
  "admin",
  "core",
  "vault",
  "launchpad",
  "presale",
  "migrators",
  "blastSui",
  "cetus",
  "bluefin",
  "aftermath",
] as const satisfies readonly (keyof BlastSharedObjects)[];

export type SharedObjectGroup = (typeof SHARED_OBJECT_GROUPS)[number];

export const BLAST_DEPLOYMENT_SCHEMA_VERSION = 2;

/**
 * The SDK's frozen ABI artifacts (`abi/production-<name>-v1.json`), each a
 * key of `DeploymentSource.abi`.
 */
export const ARTIFACT_KEYS = [
  "admin",
  "partners",
  "core",
  "vault",
  "migrators",
  "launchpad",
  "presale",
  "aftermathDaoPresale",
  "blastSui",
  "boosts",
] as const;

export type ArtifactKey = (typeof ARTIFACT_KEYS)[number];

/** A venue object's expected type: `<package's original ID>::<module>::<name>`. */
export type VenueObjectType = Readonly<{
  package: string;
  module: string;
  name: string;
}>;

/**
 * Each venue's identity set: the packages whose lineage it records and, under
 * its shared-object `group`, the singletons that creating, migrating, and
 * trading a sale on it need, each typed by one of those packages. A manifest
 * records a venue's whole set or none of it. `aftermathDao` is the presale
 * vendor venue `blast_aftermath_dao_presale`.
 */
export const VENUE_IDENTITY_SETS = Object.freeze({
  cetus: Object.freeze({
    group: "cetus",
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
    group: "bluefin",
    packages: Object.freeze(["bluefinSpot"] as const),
    sharedObjects: Object.freeze({
      config: {
        package: "bluefinSpot",
        module: "config",
        name: "GlobalConfig",
      },
    }),
  }),
  aftermathDao: Object.freeze({
    group: "aftermath",
    packages: Object.freeze([
      "aftermathDaoPresale",
      "aftermathAmm",
      "aftermathDaoFee",
    ] as const),
    sharedObjects: Object.freeze({
      poolRegistry: {
        package: "aftermathAmm",
        module: "pool_registry",
        name: "PoolRegistry",
      },
      daoFeeVersion: {
        package: "aftermathDaoFee",
        module: "version",
        name: "Version",
      },
    }),
  }),
}) satisfies Record<
  string,
  {
    group: SharedObjectGroup;
    packages: readonly (keyof BlastPackages)[];
    sharedObjects: Readonly<Record<string, VenueObjectType>>;
  }
>;

/**
 * A venue a deployment may route sales through: the two `blast_migrators`
 * venues, which serve both products, and the presale-only vendor.
 */
export type Venue = keyof typeof VENUE_IDENTITY_SETS;

/** Every venue, in canonical order. */
export const VENUES = Object.freeze(
  Object.keys(VENUE_IDENTITY_SETS) as Venue[],
);

/**
 * A production manifest may enable production signing; a non-production one
 * (fixtures and rehearsals) never can. Blast runs on mainnet only, so the
 * label is the manifest's own claim rather than a network: production signing
 * additionally requires the released registry lineage and a runtime
 * observation, and a manifest carrying any fixture identity is refused.
 */
export type DeploymentEnvironment = "production" | "non-production";

/** One pool tier a venue route accepts, in that venue's native units. */
export type MigrationRouteTier = Readonly<{
  tickSpacing: number;
  /** Venue fee rate as a u64 decimal string. */
  feeRate: string;
}>;

/**
 * A venue this deployment admits, with its creator-selectable tiers. The
 * vendor's `aftermathDao` (presale only) has no tiers.
 */
export type MigrationRoute = Readonly<{
  venue: Venue;
  tiers: readonly MigrationRouteTier[];
}>;

/** What the release was built from: the contracts commit and the SDK's ABI artifact digests. */
export type DeploymentSource = Readonly<{
  /** 40-hex contracts commit. */
  contractsCommit: string;
  /** sha256 hex of each `abi/production-<name>-v1.json`. */
  abi: Readonly<Record<ArtifactKey, string>>;
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
    abi: Readonly<Record<string, string>>;
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
