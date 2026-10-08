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
import { defineAftermathPresaleDeployment } from "../presale/aftermath.ts";
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
  presale: ["venueConfig", "creationPolicy", "feePolicy", "adminRegistry"],
  blastSui: ["packageVersion", "vault"],
} as const;

/**
 * Canonical released deployments. Release tooling adds entries only after it
 * validates publish or upgrade effects against the target chain.
 */
export const BLAST_DEPLOYMENTS: BlastDeploymentRegistry = Object.freeze({});

const PRESALE_SHARED_OBJECTS = SHARED_OBJECTS.presale;

/**
 * Normalizes and freezes one standalone presale deployment. Presale publishes
 * on its own (contracts ADR 0099), so it registers before a complete
 * `BlastDeployment` exists. `aftermath`, the vendor package's configuration,
 * is kept when given.
 */
export function definePresaleDeployment(
  deployment: PresaleDeployment,
): PresaleDeployment {
  const reference = normalizeSuiPackageReference("presale", deployment);
  return Object.freeze({
    ...reference,
    ...Object.fromEntries(
      PRESALE_SHARED_OBJECTS.map((name) => [
        name,
        Object.freeze(
          normalizeSharedObjectIdentity(
            `presale.${name}`,
            required<SharedObjectIdentity>(deployment, "presale", name),
          ),
        ),
      ]),
    ),
    ...(deployment.aftermath === undefined
      ? {}
      : { aftermath: defineAftermathPresaleDeployment(deployment.aftermath) }),
  }) as PresaleDeployment;
}

/**
 * Canonical standalone presale releases, from the publish and
 * `package_admin::wrap` effects recorded in contracts
 * `deployments/sui/mainnet/2026-10-04-blast-presale-scheduled-start.json`.
 */
export const BLAST_PRESALE_DEPLOYMENTS: Readonly<
  Partial<Record<BlastNetwork, PresaleDeployment>>
> = Object.freeze({
  mainnet: definePresaleDeployment({
    packageId:
      "0x76cb0508fc94234fddd910b5616248f8a42998048a28e55f5fe1cc89e7b98400",
    originalPackageId:
      "0x76cb0508fc94234fddd910b5616248f8a42998048a28e55f5fe1cc89e7b98400",
    venueConfig: {
      objectId:
        "0x129346213a5959533e854092076dc3f2494ba1e2ef08669e86cf1d2561d9f39f",
      initialSharedVersion: "986577439",
    },
    creationPolicy: {
      objectId:
        "0xa496515a86087bad827e8190d48f103d900ad5404948dcdf9ca18f5dad738658",
      initialSharedVersion: "986577439",
    },
    feePolicy: {
      objectId:
        "0xe2a276bbd2cb922e71e1d6b35b393537df3642e07b2f4d753fdab09c5bd6fb11",
      initialSharedVersion: "986577439",
    },
    adminRegistry: {
      objectId:
        "0xe7a5cc95aa47e7bc8dfcccce070f6ebc123350c3e478588e23817ee97c8c8cd4",
      initialSharedVersion: "986577439",
    },
  }),
});

/**
 * The released presale deployment on `network`: the complete Blast release's
 * when one is registered, otherwise the standalone presale release.
 */
export function getPresaleDeployment(network: BlastNetwork): PresaleDeployment {
  const blast = BLAST_DEPLOYMENTS[network];
  if (blast) return presaleDeployment(blast);
  const presale = BLAST_PRESALE_DEPLOYMENTS[network];
  if (!presale) {
    throw new RangeError(`Blast presale is not deployed on Sui ${network}`);
  }
  return presale;
}

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
