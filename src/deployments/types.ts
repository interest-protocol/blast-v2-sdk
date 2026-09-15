import type { BlastSuiDeployment } from "../blast-sui/types.ts";
import type { LaunchpadDeployment } from "../launchpad/transactions.ts";
import type { SharedObjectIdentity, SuiPackageReference } from "../lib/sui.ts";
import type { MigratorsDeployment } from "../migrators/transactions.ts";
import type { VestingDeployment } from "../vesting/transactions.ts";

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
    blastSui?: SuiPackageReference;
    migrators?: SuiPackageReference;
    vesting?: SuiPackageReference;
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
    protocolAuthority: SharedObjectIdentity;
    blastSuiPackageVersion?: SharedObjectIdentity;
    blastSuiProtocolAuthority?: SharedObjectIdentity;
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
export type VestingDeploymentConstants = VestingDeployment;
