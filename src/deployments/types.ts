import type { SharedObjectIdentity, SuiPackageReference } from "../lib/sui.ts";

/** Blast deploys to Sui mainnet only (contracts ADR 0103). */
export const BLAST_NETWORKS = ["mainnet"] as const;

export type BlastNetwork = (typeof BLAST_NETWORKS)[number];

/**
 * Every published Blast package. `launch_ticket_template` and
 * `coin_template` have no entry: each is bytecode a launch or a standalone
 * coin publishes as its own package.
 */
export type BlastPackages = Readonly<{
  /** Immutable `blast_fun_timelock`, which `admin` and `partners` link. */
  timelock: SuiPackageReference;
  /** Immutable `blast_admin`, home of the shared ACL. */
  admin: SuiPackageReference;
  /** Immutable `blast_partners`. */
  partners: SuiPackageReference;
  launchpad: SuiPackageReference;
  migrators: SuiPackageReference;
  presale: SuiPackageReference;
  blastSui: SuiPackageReference;
}>;

/**
 * Every package's shared singletons the SDK calls or reads. Mutability is
 * absent because it belongs to each Move call, not to the on-chain object.
 */
export type BlastSharedObjects = Readonly<{
  admin: Readonly<{ acl: SharedObjectIdentity }>;
  launchpad: Readonly<{
    packageVersion: SharedObjectIdentity;
    launchConfig: SharedObjectIdentity;
    runtimeConfig: SharedObjectIdentity;
  }>;
  migrators: Readonly<{
    packageVersion: SharedObjectIdentity;
    lpFeePolicy: SharedObjectIdentity;
    venueConfig: SharedObjectIdentity;
  }>;
  presale: Readonly<{
    venueConfig: SharedObjectIdentity;
    creationPolicy: SharedObjectIdentity;
    feePolicy: SharedObjectIdentity;
    adminRegistry: SharedObjectIdentity;
  }>;
  blastSui: Readonly<{
    packageVersion: SharedObjectIdentity;
    vault: SharedObjectIdentity;
  }>;
}>;

export type BlastDeployment = Readonly<{
  network: BlastNetwork;
  chainIdentifier: string;
  packages: BlastPackages;
  sharedObjects: BlastSharedObjects;
}>;

export type BlastDeploymentRegistry = Readonly<
  Partial<Record<BlastNetwork, BlastDeployment>>
>;
