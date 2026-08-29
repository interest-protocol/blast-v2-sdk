import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
  sharedObjectReference,
} from "../lib/sui.ts";
import type {
  BlastDeployment,
  BlastDeploymentRegistry,
  BlastNetwork,
  LaunchpadDeploymentConstants,
  VestingDeploymentConstants,
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
    packageVersion: sharedObjectReference(objects.packageVersion, false),
    launchConfig: sharedObjectReference(objects.launchConfig, false),
    runtimeConfig: sharedObjectReference(objects.runtimeConfig, false),
    protocolAuthority: sharedObjectReference(
      objects.protocolAuthority,
      false,
    ),
  };
}

export function vestingDeployment(
  deployment: BlastDeployment,
): VestingDeploymentConstants {
  const packageReference = deployment.packages.vesting;
  if (!packageReference) {
    throw new TypeError("packages.vesting is required");
  }
  return {
    packageId: packageReference.packageId,
    originalPackageId: packageReference.originalPackageId,
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
