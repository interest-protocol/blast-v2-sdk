import { isValidTransactionDigest } from "@mysten/sui/utils";

import type { AdminDeployment } from "../admin/transactions.ts";
import { normalizeAdminDeployment } from "../admin/transactions.ts";
import { requirePositiveU64, requireU64 } from "../lib/integers.ts";
import type { SharedObjectIdentity } from "../lib/sui.ts";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "../lib/sui.ts";
import type { MigratorVenue } from "../migrators/state.ts";
import { MIGRATOR_VENUES } from "../migrators/state.ts";
import type { PartnersDeployment } from "../partners/transactions.ts";
import { defineAftermathPresaleDeployment } from "../presale/aftermath.ts";
import type { PresaleDeployment } from "../presale/transactions.ts";
import type {
  BlastDeployment,
  BlastDeploymentInput,
  BlastDeploymentRegistry,
  BlastNetwork,
  BlastPackages,
  BlastSharedObjects,
  BlastSuiDeploymentConstants,
  LaunchpadDeploymentConstants,
  MigrationRoute,
  MigratorsDeploymentConstants,
  PostDeployEvidence,
  SharedObjectGroup,
} from "./types.ts";
import {
  BLAST_DEPLOYMENT_SCHEMA_VERSION,
  BLAST_NETWORKS,
  VENUE_IDENTITY_SETS,
} from "./types.ts";

/** The packages every manifest records, whatever else it carries. */
const REQUIRED_PACKAGES = ["launchpad", "admin", "partners", "timelock"];

/** Each shared-object group's complete key set, in canonical order. */
const SHARED_OBJECT_KEYS = {
  admin: ["acl"],
  launchpad: ["packageVersion", "launchConfig", "runtimeConfig"],
  migrators: ["packageVersion", "lpFeePolicy", "venueConfig"],
  presale: ["venueConfig", "creationPolicy", "feePolicy"],
  blastSui: ["packageVersion", "vault"],
  cetus: ["config", "pools", "burnManager"],
  bluefin: ["config"],
} as const satisfies Record<SharedObjectGroup, readonly string[]>;

/** Groups every manifest records: the launchpad and the ACL it signs in through. */
const CORE_GROUPS = ["admin", "launchpad"] as const;

/**
 * Groups a manifest records exactly when it records the package that owns
 * them. A venue's group follows `VENUE_IDENTITY_SETS` instead.
 */
const PACKAGE_GROUPS = ["migrators", "presale", "blastSui"] as const;

/**
 * Genesis checkpoint digest of Sui mainnet, the only chain Blast deploys to
 * (contracts ADR 0103), in the form every Core API transport of `@mysten/sui`
 * reports from `getChainIdentifier`. Source: contracts 442116a,
 * `sui/migrators/scripts/check_mainnet_abi.mjs`. Its first four bytes are
 * JSON-RPC's `sui_getChainIdentifier` value `35834a8a`.
 */
const SUI_CHAIN_IDENTIFIERS: Readonly<Record<BlastNetwork, string>> = {
  mainnet: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
};
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Why a manifest is not a valid deployment identity. */
export class DeploymentManifestError extends Error {
  readonly code: "invalid-manifest" | "unsupported-route";

  constructor(code: DeploymentManifestError["code"], message: string) {
    super(message);
    this.name = "DeploymentManifestError";
    this.code = code;
  }
}

/**
 * Canonical released deployments, the only production identities. Release
 * tooling adds an entry only after it validates publish effects and
 * post-deploy evidence on the target chain; until then every network is
 * absent and production signing stays disabled.
 */
export const BLAST_DEPLOYMENTS: BlastDeploymentRegistry = Object.freeze({});

const PRESALE_SHARED_OBJECTS = SHARED_OBJECT_KEYS.presale;

/**
 * Normalizes and freezes one standalone presale deployment. Presale publishes
 * on its own (contracts ADR 0099), so it registers before a complete
 * `BlastDeployment` exists; it still needs the published `blast_admin` ACL.
 * `aftermath`, the vendor package's configuration, is kept when given.
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
    admin: Object.freeze(
      normalizeAdminDeployment(
        required<AdminDeployment>(deployment, "presale", "admin"),
      ),
    ),
  }) as PresaleDeployment;
}

/**
 * Canonical standalone presale releases. Mainnet is the fresh 2026-10-11
 * version-one publication from contracts `4b170eef`, using the shared
 * immutable blast_admin ACL and the freshly published Aftermath vendor.
 */
export const BLAST_PRESALE_DEPLOYMENTS: Readonly<
  Partial<Record<BlastNetwork, PresaleDeployment>>
> = Object.freeze({
  mainnet: definePresaleDeployment({
    packageId:
      "0xf9c404c0368cf014b44cac79dc5037da2aa34e16952673433d1c87ae3d2f8ca4",
    originalPackageId:
      "0xf9c404c0368cf014b44cac79dc5037da2aa34e16952673433d1c87ae3d2f8ca4",
    venueConfig: {
      objectId:
        "0xebfd4e31f8fddf1b8d5b4a45835c7397156f6f62eeefef46b7b1b42aa29c6d39",
      initialSharedVersion: "1",
    },
    creationPolicy: {
      objectId:
        "0x4ce001c53e9da536fc7d04a87383e90ca76e27492b3cad92cf9e167af0dc83d8",
      initialSharedVersion: "1",
    },
    feePolicy: {
      objectId:
        "0x3da5bfd3275991b70a445a2022e07925ce9a927dd47d7c3fd583563089a9afae",
      initialSharedVersion: "1",
    },
    admin: {
      packageId:
        "0x726fb49b880faa89719b95c6ef3a91be794f771ed3560fe5894d0a605c8469f9",
      acl: {
        objectId:
          "0xc9fbcfc4eda38626d7daad17902cc145b4008beb20470135438298aa7a005a6d",
        initialSharedVersion: "1",
      },
    },
    // The immutable Aftermath DAO-pool vendor published with it.
    aftermath: defineAftermathPresaleDeployment({
      packageId:
        "0x2fe674f6c42f49b7647be760a10f89f843396b9294af8fab5bfbc929fb7aab01",
    }),
  }),
});

/**
 * The released presale deployment on `network`: the complete Blast release's
 * when one is registered and records the presale, otherwise the standalone
 * presale release.
 */
export function getPresaleDeployment(network: BlastNetwork): PresaleDeployment {
  const blast = BLAST_DEPLOYMENTS[network];
  if (blast?.packages.presale && blast.sharedObjects.presale) {
    return presaleDeployment(blast);
  }
  const presale = BLAST_PRESALE_DEPLOYMENTS[network];
  if (!presale) {
    throw new RangeError(`Blast presale is not deployed on Sui ${network}`);
  }
  return presale;
}

/**
 * Validates, normalizes, and freezes one manifest into the runtime identity
 * schema. Shape only: `evaluateProtocolAccess` decides whether it may sign.
 * Blast runs on mainnet only, so every manifest names mainnet and carries its
 * genesis digest; `environment` is the manifest's own claim, and a
 * non-production one can never sign in production.
 */
export function defineBlastDeployment(
  input: BlastDeploymentInput,
): BlastDeployment {
  try {
    return normalizeDeployment(input);
  } catch (error) {
    if (error instanceof DeploymentManifestError) throw error;
    throw new DeploymentManifestError(
      "invalid-manifest",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** The released deployment on `network`; throws while none is released. */
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
): LaunchpadDeploymentConstants {
  const { packages, sharedObjects } = deployment;
  const objects = sharedObjects.launchpad;
  return {
    packageId: packages.launchpad.packageId,
    originalPackageId: packages.launchpad.originalPackageId,
    admin: adminDeployment(deployment),
    partnersPackageId: packages.partners.packageId,
    timelockPackageId: packages.timelock.packageId,
    packageVersion: objects.packageVersion,
    launchConfig: objects.launchConfig,
    runtimeConfig: objects.runtimeConfig,
  };
}

/** Returns the call-ready blast Sui identities from a canonical deployment. */
export function blastSuiDeployment(
  deployment: BlastDeployment,
): BlastSuiDeploymentConstants {
  const packageReference = requireGroup(
    deployment.packages.blastSui,
    "packages.blastSui",
  );
  const objects = requireGroup(
    deployment.sharedObjects.blastSui,
    "sharedObjects.blastSui",
  );
  return {
    packageId: packageReference.packageId,
    originalPackageId: packageReference.originalPackageId,
    packageVersion: objects.packageVersion,
    vault: objects.vault,
    admin: adminDeployment(deployment),
  };
}

export function migratorsDeployment(
  deployment: BlastDeployment,
): MigratorsDeploymentConstants {
  const packageReference = requireGroup(
    deployment.packages.migrators,
    "packages.migrators",
  );
  const objects = requireGroup(
    deployment.sharedObjects.migrators,
    "sharedObjects.migrators",
  );
  return {
    packageId: packageReference.packageId,
    originalPackageId: packageReference.originalPackageId,
    launchpad: launchpadDeployment(deployment),
    migratorsVersion: objects.packageVersion,
    lpFeePolicy: objects.lpFeePolicy,
    venueConfig: objects.venueConfig,
  };
}

/** Returns the call-ready presale identities from a canonical deployment. */
export function presaleDeployment(
  deployment: BlastDeployment,
): PresaleDeployment {
  const packageReference = requireGroup(
    deployment.packages.presale,
    "packages.presale",
  );
  const objects = requireGroup(
    deployment.sharedObjects.presale,
    "sharedObjects.presale",
  );
  return {
    ...packageReference,
    ...objects,
    admin: adminDeployment(deployment),
  };
}

/** Checks one route tier in its venue's native units. */
export function normalizeRoute(route: {
  venue: string;
  tiers: readonly { tickSpacing: number; feeRate: string | number | bigint }[];
}): MigrationRoute {
  if (!(MIGRATOR_VENUES as readonly string[]).includes(route.venue)) {
    throw new DeploymentManifestError(
      "unsupported-route",
      `unsupported route ${String(route.venue)}`,
    );
  }
  const venue = route.venue as MigratorVenue;
  if (!Array.isArray(route.tiers) || route.tiers.length === 0) {
    throw new RangeError(`route ${venue} needs at least one tier`);
  }
  return Object.freeze({
    venue,
    tiers: Object.freeze(route.tiers.map((tier) => normalizeTier(venue, tier))),
  });
}

function normalizeDeployment(input: BlastDeploymentInput): BlastDeployment {
  if (input.schemaVersion !== BLAST_DEPLOYMENT_SCHEMA_VERSION) {
    throw new RangeError(`unsupported schemaVersion ${input.schemaVersion}`);
  }
  if (
    input.environment !== "production" &&
    input.environment !== "non-production"
  ) {
    throw new RangeError(`unknown environment ${String(input.environment)}`);
  }
  const network = input.network as BlastNetwork;
  if (!BLAST_NETWORKS.includes(network)) {
    throw new RangeError(`unsupported Blast network: ${input.network}`);
  }
  const packages = normalizePackages(input.packages);
  const routes = Object.freeze((input.routes ?? []).map(normalizeRoute));
  if (routes.length > 0 && !packages.migrators) {
    throw new TypeError("routes require packages.migrators");
  }
  return Object.freeze({
    schemaVersion: BLAST_DEPLOYMENT_SCHEMA_VERSION,
    environment: input.environment,
    network,
    chainIdentifier: requireChainIdentifier(network, input.chainIdentifier),
    explorer: Object.freeze({ baseUrl: requireUrl(input.explorer?.baseUrl) }),
    packages,
    sharedObjects: normalizeSharedObjects(input.sharedObjects, packages),
    routes,
    source: Object.freeze({
      contractsCommit: requirePattern(
        "source.contractsCommit",
        input.source?.contractsCommit,
        COMMIT,
      ),
      abi: Object.freeze({
        launchpad: requirePattern(
          "source.abi.launchpad",
          input.source?.abi?.launchpad,
          SHA256,
        ),
        blastSui: requirePattern(
          "source.abi.blastSui",
          input.source?.abi?.blastSui,
          SHA256,
        ),
      }),
    }),
    release: Object.freeze({
      transactions: normalizeReleaseTransactions(input.release?.transactions),
    }),
    sdk: Object.freeze({
      version: requirePattern("sdk.version", input.sdk?.version, SEMVER),
      commit: requirePattern("sdk.commit", input.sdk?.commit, COMMIT),
    }),
    evidence: Object.freeze((input.evidence ?? []).map(normalizeEvidence)),
  });
}

function normalizePackages(
  packages: BlastDeploymentInput["packages"],
): BlastPackages {
  for (const name of REQUIRED_PACKAGES) {
    if (!packages?.[name]) throw new TypeError(`packages.${name} is required`);
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(packages).map(([name, reference]) => [
        name,
        Object.freeze(
          normalizeSuiPackageReference(`packages.${name}`, reference),
        ),
      ]),
    ),
  ) as BlastPackages;
}

/**
 * Normalizes every recorded group. The launchpad and ACL groups are always
 * required; a package's group is required exactly when the manifest records
 * that package, and a venue's whole set is required when any part of it is
 * recorded. Within a group every key is required, so no call can read a
 * half-recorded owner.
 */
function normalizeSharedObjects(
  objects: BlastDeploymentInput["sharedObjects"],
  packages: BlastPackages,
): BlastSharedObjects {
  const groups: SharedObjectGroup[] = [...CORE_GROUPS];
  for (const group of PACKAGE_GROUPS) {
    if (packages[group]) groups.push(group);
  }
  requireCompleteVenueSets(packages, objects);
  for (const venue of MIGRATOR_VENUES) {
    if (objects?.[venue]) groups.push(venue);
  }
  for (const group of groups) {
    if (!objects?.[group]) {
      throw new TypeError(`sharedObjects.${group} is required`);
    }
  }
  const unknown = Object.keys(objects ?? {}).filter(
    (group) => !groups.includes(group as SharedObjectGroup),
  );
  if (unknown.length > 0) {
    throw new TypeError(
      `sharedObjects records no package for ${unknown.join(", ")}`,
    );
  }
  return Object.freeze(
    Object.fromEntries(
      groups.map((group) => [
        group,
        Object.freeze(
          Object.fromEntries(
            SHARED_OBJECT_KEYS[group].map((name) => {
              const label = `sharedObjects.${group}.${name}`;
              return [
                name,
                Object.freeze(
                  normalizeSharedObjectIdentity(
                    label,
                    required<SharedObjectIdentity>(
                      objects[group] ?? {},
                      `sharedObjects.${group}`,
                      name,
                    ),
                  ),
                ),
              ];
            }),
          ),
        ),
      ]),
    ),
  ) as BlastSharedObjects;
}

/**
 * A venue's set is all or nothing: any recorded part requires every package
 * and its whole shared-object group, so each venue object is always
 * type-checked against the package lineage that defines it. A partial set is
 * an invalid manifest.
 */
function requireCompleteVenueSets(
  packages: BlastPackages,
  objects: BlastDeploymentInput["sharedObjects"],
): void {
  for (const [venue, set] of Object.entries(VENUE_IDENTITY_SETS)) {
    const group = objects?.[venue];
    const paths = [
      ...set.packages.map((name) => ({
        path: `packages.${name}`,
        present: Boolean(packages[name as keyof BlastPackages]),
      })),
      ...Object.keys(set.sharedObjects).map((name) => ({
        path: `sharedObjects.${venue}.${name}`,
        present: Boolean(group?.[name]),
      })),
    ];
    const missing = paths.find(({ present }) => !present);
    if (missing && paths.some(({ present }) => present)) {
      throw new TypeError(
        `${missing.path} is required: the ${venue} venue set is partial`,
      );
    }
  }
}

function normalizeTier(
  venue: MigratorVenue,
  tier: { tickSpacing: number; feeRate: string | number | bigint },
) {
  const tickSpacing = tier.tickSpacing;
  if (
    !Number.isInteger(tickSpacing) ||
    tickSpacing < 1 ||
    tickSpacing > 0xffff_ffff
  ) {
    throw new RangeError(`${venue} tickSpacing must be a positive u32`);
  }
  const feeRate = requirePositiveU64(`${venue} feeRate`, BigInt(tier.feeRate));
  // Bluefin's own pool bounds; Cetus derives its fee rate from the tick spacing.
  if (venue === "bluefin" && (tickSpacing > 400 || feeRate > 20_000n)) {
    throw new RangeError(
      "bluefin tiers are tick spacing 1-400 and fee rate 1-20,000",
    );
  }
  return Object.freeze({ tickSpacing, feeRate: feeRate.toString() });
}

function normalizeReleaseTransactions(
  transactions: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (!transactions?.launchpad) {
    throw new TypeError("release.transactions.launchpad is required");
  }
  for (const [step, digest] of Object.entries(transactions)) {
    if (!isValidTransactionDigest(digest)) {
      throw new TypeError(
        `release.transactions.${step} must be a transaction digest`,
      );
    }
  }
  return Object.freeze({ ...transactions });
}

function normalizeEvidence(
  evidence: BlastDeploymentInput["evidence"][number],
): PostDeployEvidence {
  if (
    evidence.transactionDigest !== null &&
    !isValidTransactionDigest(evidence.transactionDigest)
  ) {
    throw new TypeError(
      "evidence.transactionDigest must be a transaction digest",
    );
  }
  return Object.freeze({
    check: requireText("evidence.check", evidence.check),
    transactionDigest: evidence.transactionDigest,
    checkpoint: requireU64(
      "evidence.checkpoint",
      BigInt(evidence.checkpoint),
    ).toString(),
    verifiedAtMs: requirePositiveU64(
      "evidence.verifiedAtMs",
      BigInt(evidence.verifiedAtMs),
    ).toString(),
  });
}

/** Binds the chain to the network label: mainnet carries its genesis digest. */
function requireChainIdentifier(network: BlastNetwork, value: unknown): string {
  const chain = requireText("chainIdentifier", value);
  if (!isValidTransactionDigest(chain)) {
    throw new TypeError(
      "chainIdentifier must be the genesis checkpoint digest the Core API reports",
    );
  }
  if (chain !== SUI_CHAIN_IDENTIFIERS[network]) {
    throw new RangeError(`chainIdentifier ${chain} is not Sui ${network}`);
  }
  return chain;
}

function requireText(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requirePattern(name: string, value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${name} is malformed`);
  }
  return value;
}

function requireUrl(value: unknown): string {
  const text = requireText("explorer.baseUrl", value);
  // `URL` is not among the SDK's runtime globals (`types/runtime.d.ts`).
  if (!/^https?:\/\/[^\s/?#]+/i.test(text)) {
    throw new TypeError("explorer.baseUrl must be an http(s) URL");
  }
  return text.replace(/\/+$/, "");
}

function requireGroup<Value>(value: Value | undefined, path: string): Value {
  if (value === undefined) throw new TypeError(`${path} is required`);
  return value;
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
