import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
  sharedObjectReference,
} from "../lib/sui.ts";
import type {
  BlastDeployment,
  BlastDeploymentRegistry,
  BlastNetwork,
  BlastSuiDeploymentConstants,
  LaunchpadDeploymentConstants,
  MigratorsDeploymentConstants,
} from "./types.ts";
import { BLAST_NETWORKS } from "./types.ts";

const REQUIRED_SHARED_OBJECTS = [
  "packageVersion",
  "launchConfig",
  "runtimeConfig",
  "protocolAuthority",
] as const;

/**
 * Canonical released deployments. Release tooling adds entries only after it
 * validates publish or upgrade effects against the target chain.
 */
export const BLAST_DEPLOYMENTS: BlastDeploymentRegistry = Object.freeze({});

export function defineBlastDeployment(
  deployment: BlastDeployment,
): BlastDeployment {
  if (!BLAST_NETWORKS.includes(deployment.network)) {
    throw new RangeError(`unsupported Blast network: ${deployment.network}`);
  }
  if (typeof deployment.chainIdentifier !== "string") {
    throw new TypeError("chainIdentifier must be a string");
  }
  const chainIdentifier = deployment.chainIdentifier.trim();
  if (!chainIdentifier) {
    throw new RangeError("chainIdentifier must not be empty");
  }
  if (!deployment.packages.launchpad) {
    throw new TypeError("packages.launchpad is required");
  }
  if (!deployment.packages.admin) {
    throw new TypeError("packages.admin is required");
  }
  for (const name of REQUIRED_SHARED_OBJECTS) {
    if (!deployment.sharedObjects[name]) {
      throw new TypeError(`sharedObjects.${name} is required`);
    }
  }

  const packages = normalizeRecord(
    "packages",
    deployment.packages,
    normalizeSuiPackageReference,
  );
  const sharedObjects = normalizeRecord(
    "sharedObjects",
    deployment.sharedObjects,
    normalizeSharedObjectIdentity,
  );

  return Object.freeze({
    network: deployment.network,
    chainIdentifier,
    packages,
    sharedObjects,
  }) as BlastDeployment;
}

export function getBlastDeployment(network: BlastNetwork): BlastDeployment {
  const deployment = BLAST_DEPLOYMENTS[network];
  if (!deployment) {
    throw new RangeError(`Blast V2 is not deployed on Sui ${network}`);
  }
  return deployment;
}

export function launchpadDeployment(
  deployment: BlastDeployment,
): LaunchpadDeploymentConstants {
  const packageReference = deployment.packages.launchpad;
  const objects = deployment.sharedObjects;
  return {
    packageId: packageReference.packageId,
    originalPackageId: packageReference.originalPackageId,
    adminPackageId: deployment.packages.admin.packageId,
    packageVersion: sharedObjectReference(objects.packageVersion, false),
    launchConfig: sharedObjectReference(objects.launchConfig, false),
    runtimeConfig: sharedObjectReference(objects.runtimeConfig, false),
    protocolAuthority: sharedObjectReference(objects.protocolAuthority, false),
  };
}

/** Returns the call-ready blast Sui identities from a canonical deployment. */
export function blastSuiDeployment(
  deployment: BlastDeployment,
): BlastSuiDeploymentConstants {
  const packageReference = deployment.packages.blastSui;
  if (!packageReference) {
    throw new TypeError("packages.blastSui is required");
  }
  const packageVersion = deployment.sharedObjects.blastSuiPackageVersion;
  if (!packageVersion) {
    throw new TypeError("sharedObjects.blastSuiPackageVersion is required");
  }
  const vault = deployment.sharedObjects.blastSuiVault;
  if (!vault) {
    throw new TypeError("sharedObjects.blastSuiVault is required");
  }
  return {
    packageId: packageReference.packageId,
    originalPackageId: packageReference.originalPackageId,
    packageVersion: sharedObjectReference(packageVersion, false),
    vault: sharedObjectReference(vault, true),
  };
}

export function migratorsDeployment(
  deployment: BlastDeployment,
): MigratorsDeploymentConstants {
  const packageReference = deployment.packages.migrators;
  if (!packageReference) {
    throw new TypeError("packages.migrators is required");
  }
  const migratorsVersion = deployment.sharedObjects.migratorsPackageVersion;
  if (!migratorsVersion) {
    throw new TypeError("sharedObjects.migratorsPackageVersion is required");
  }
  const lpFeePolicy = deployment.sharedObjects.lpFeePolicy;
  if (!lpFeePolicy) {
    throw new TypeError("sharedObjects.lpFeePolicy is required");
  }
  const venueConfig = deployment.sharedObjects.venueConfig;
  if (!venueConfig) {
    throw new TypeError("sharedObjects.venueConfig is required");
  }
  return {
    packageId: packageReference.packageId,
    originalPackageId: packageReference.originalPackageId,
    launchpad: launchpadDeployment(deployment),
    migratorsVersion: sharedObjectReference(migratorsVersion, false),
    lpFeePolicy: sharedObjectReference(lpFeePolicy, false),
    venueConfig: sharedObjectReference(venueConfig, false),
  };
}

function normalizeRecord<Value, Normalized>(
  namespace: string,
  values: Readonly<Record<string, Value>>,
  normalize: (name: string, value: Value) => Normalized,
): Readonly<Record<string, Normalized>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        Object.freeze(normalize(`${namespace}.${name}`, value)),
      ]),
    ),
  );
}
