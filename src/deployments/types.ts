import type { BlastSuiDeployment } from "../blast-sui/types.ts";
import type { LaunchpadDeployment } from "../launchpad/transactions.ts";
import type { SharedObjectIdentity, SuiPackageReference } from "../lib/sui.ts";
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
    /** Published `blast_partners` package the launchpad links (contracts ADR 0095). */
    partners: SuiPackageReference;
    /** Published immutable `blast_fun_timelock` that `blast_admin` and `blast_partners` link. */
    timelock: SuiPackageReference;
    blastSui?: SuiPackageReference;
    migrators?: SuiPackageReference;
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
    /** The singleton `blast_admin::blast_acl::ACL` every Blast package signs in to. */
    acl: SharedObjectIdentity;
    blastSuiPackageVersion?: SharedObjectIdentity;
    blastSuiPackageAdmin?: SharedObjectIdentity;
    blastSuiVault?: SharedObjectIdentity;
    migratorsPackageVersion?: SharedObjectIdentity;
    venueConfig?: SharedObjectIdentity;
    packageAdmin?: SharedObjectIdentity;
  }
>;

export type BlastDeployment = Readonly<{
  network: BlastNetwork;
  chainIdentifier: string;
  packages: BlastPackages;
  sharedObjects: BlastSharedObjects;
}>;

export type BlastDeploymentRegistry = Readonly<
  Partial<Record<BlastNetwork, BlastDeployment>>
>;

export type LaunchpadDeploymentConstants = LaunchpadDeployment;
export type BlastSuiDeploymentConstants = BlastSuiDeployment;
export type MigratorsDeploymentConstants = MigratorsDeployment;
