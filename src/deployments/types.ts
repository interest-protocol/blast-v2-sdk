import type { SharedObjectIdentity, SuiPackageReference } from "../lib/sui.ts";

export const BLAST_NETWORKS = [
  "mainnet",
  "testnet",
  "devnet",
  "localnet",
] as const;

export type BlastNetwork = (typeof BLAST_NETWORKS)[number];

/**
 * Every published Blast package. `meme_template` has no entry: it is
 * bytecode each launch publishes as its own Meme package.
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
