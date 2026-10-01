import type { AdminDeployment } from "../admin/transactions.ts";
import type { BlastSuiDeployment } from "../blast-sui/types.ts";
import type { LaunchpadDeployment } from "../launchpad/transactions.ts";
import type { SharedObjectIdentity, SuiPackageReference } from "../lib/sui.ts";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "../lib/sui.ts";
import type { MigratorsDeployment } from "../migrators/transactions.ts";
import type { PartnersDeployment } from "../partners/transactions.ts";
import type { PresaleDeployment } from "../presale/transactions.ts";
import type {
  BlastDeployment,
  BlastDeploymentRegistry,
  BlastNetwork,
  BlastPackages,
} from "./types.ts";
import { BLAST_NETWORKS } from "./types.ts";

const PACKAGES = [
  "timelock",
  "admin",
  "partners",
  "launchpad",
  "migrators",
  "presale",
  "blastSui",
] as const satisfies readonly (keyof BlastPackages)[];

const SHARED_OBJECTS = {
  admin: ["acl"],
  launchpad: ["packageVersion", "launchConfig", "runtimeConfig"],
  migrators: ["packageVersion", "lpFeePolicy", "venueConfig"],
  presale: ["venueConfig", "feePolicy"],
  blastSui: ["packageVersion", "vault"],
} as const;

/**
 * Canonical released deployments. Release tooling adds entries only after it
 * validates publish or upgrade effects against the target chain.
 */
export const BLAST_DEPLOYMENTS: BlastDeploymentRegistry = Object.freeze({});

/** Normalizes and freezes one complete deployment of every Blast package. */
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
  const packages = Object.fromEntries(
    PACKAGES.map((name) => [
      name,
      Object.freeze(
        normalizeSuiPackageReference(
          `packages.${name}`,
          required<SuiPackageReference>(deployment.packages, "packages", name),
        ),
      ),
    ]),
  );
  const sharedObjects = Object.fromEntries(
    Object.entries(SHARED_OBJECTS).map(([owner, names]) => {
      const objects = required<object>(
        deployment.sharedObjects,
        "sharedObjects",
        owner,
      );
      return [
        owner,
        Object.freeze(
          Object.fromEntries(
            names.map((name) => {
              const label = `sharedObjects.${owner}.${name}`;
              return [
                name,
                Object.freeze(
                  normalizeSharedObjectIdentity(
                    label,
                    required<SharedObjectIdentity>(
                      objects,
                      `sharedObjects.${owner}`,
                      name,
                    ),
                  ),
                ),
              ];
            }),
          ),
        ),
      ];
    }),
  );
  return Object.freeze({
    network: deployment.network,
    chainIdentifier,
    packages: Object.freeze(packages),
    sharedObjects: Object.freeze(sharedObjects),
  }) as unknown as BlastDeployment;
}

export function getBlastDeployment(network: BlastNetwork): BlastDeployment {
  const deployment = BLAST_DEPLOYMENTS[network];
  if (!deployment) {
    throw new RangeError(`Blast V2 is not deployed on Sui ${network}`);
  }
  return deployment;
}

export function adminDeployment(deployment: BlastDeployment): AdminDeployment {
  return {
    packageId: deployment.packages.admin.packageId,
    acl: deployment.sharedObjects.admin.acl,
  };
}

export function partnersDeployment(
  deployment: BlastDeployment,
): PartnersDeployment {
  return {
    packageId: deployment.packages.partners.packageId,
    admin: adminDeployment(deployment),
  };
}

export function launchpadDeployment(
  deployment: BlastDeployment,
): LaunchpadDeployment {
  const { packages } = deployment;
  return {
    ...packages.launchpad,
    admin: adminDeployment(deployment),
    partnersPackageId: packages.partners.packageId,
    timelockPackageId: packages.timelock.packageId,
    ...deployment.sharedObjects.launchpad,
  };
}

export function migratorsDeployment(
  deployment: BlastDeployment,
): MigratorsDeployment {
  const objects = deployment.sharedObjects.migrators;
  return {
    ...deployment.packages.migrators,
    launchpad: launchpadDeployment(deployment),
    migratorsVersion: objects.packageVersion,
    lpFeePolicy: objects.lpFeePolicy,
    venueConfig: objects.venueConfig,
  };
}

export function presaleDeployment(
  deployment: BlastDeployment,
): PresaleDeployment {
  return {
    ...deployment.packages.presale,
    ...deployment.sharedObjects.presale,
    admin: adminDeployment(deployment),
  };
}

export function blastSuiDeployment(
  deployment: BlastDeployment,
): BlastSuiDeployment {
  return {
    ...deployment.packages.blastSui,
    ...deployment.sharedObjects.blastSui,
    admin: adminDeployment(deployment),
  };
}

function required<Value>(
  values: object,
  namespace: string,
  name: string,
): Value {
  const value = (values as Record<string, Value | undefined>)[name];
  if (value === undefined) {
    throw new TypeError(`${namespace}.${name} is required`);
  }
  return value;
}
