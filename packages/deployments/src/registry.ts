import type { AdminDeployment } from "@interest-protocol/blast-admin-sdk/transactions";
import type { CoreDeployment } from "@interest-protocol/blast-core/deployment";
import {
  requirePositiveU64,
  requireU64,
} from "@interest-protocol/blast-core/integers";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { LaunchpadDeployment } from "@interest-protocol/blast-launchpad-sdk/transactions";
import type { MigratorsDeployment } from "@interest-protocol/blast-migrators-sdk/transactions";
import type { PartnersDeployment } from "@interest-protocol/blast-partners-sdk/transactions";
import type { PresaleDeployment } from "@interest-protocol/blast-presale-sdk/transactions";
import type { BlastSuiDeployment } from "@interest-protocol/blast-sui-sdk/types";
import type { VaultDeployment } from "@interest-protocol/blast-vault-sdk/transactions";
import { isValidTransactionDigest } from "@mysten/sui/utils";
import type {
  BlastDeployment,
  BlastDeploymentInput,
  BlastDeploymentRegistry,
  BlastNetwork,
  BlastPackages,
  BlastSharedObjects,
  MigrationRoute,
  PostDeployEvidence,
  SharedObjectGroup,
  Venue,
} from "./types.ts";
import {
  ARTIFACT_KEYS,
  BLAST_DEPLOYMENT_SCHEMA_VERSION,
  BLAST_NETWORKS,
  VENUE_IDENTITY_SETS,
  VENUES,
} from "./types.ts";

/** The packages every manifest records, whatever else it carries. */
const REQUIRED_PACKAGES = [
  "admin",
  "partners",
  "core",
  "vesting",
  "vault",
  "launchpad",
  "presale",
  "migrators",
] as const satisfies readonly (keyof BlastPackages)[];

/** The fresh-stack publications every release records a transaction for. */
const PUBLISHED_PACKAGES = [
  "admin",
  "partners",
  "core",
  "vault",
  "launchpad",
  "presale",
  "migrators",
] as const;

/** Each shared-object group's complete key set, in canonical order. */
const SHARED_OBJECT_KEYS = {
  admin: ["acl"],
  core: ["treasury"],
  vault: ["registry", "packageVersion", "packageAdmin"],
  launchpad: [
    "packageVersion",
    "packageAdmin",
    "launchConfig",
    "runtimeConfig",
    "launchRegistry",
  ],
  presale: [
    "packageVersion",
    "packageAdmin",
    "creationPolicy",
    "feePolicy",
    "presaleRegistry",
  ],
  migrators: ["packageVersion", "packageAdmin", "venueConfig"],
  blastSui: ["packageVersion", "vault"],
  cetus: ["config", "pools", "burnManager"],
  bluefin: ["config"],
  aftermath: ["poolRegistry", "daoFeeVersion"],
} as const satisfies Record<SharedObjectGroup, readonly string[]>;

/** Groups every manifest records: the launch stack's singletons. */
const STACK_GROUPS = [
  "admin",
  "core",
  "vault",
  "launchpad",
  "presale",
  "migrators",
] as const;

/**
 * Groups a manifest records exactly when it records the package that owns
 * them. A venue's group follows `VENUE_IDENTITY_SETS` instead.
 */
const PACKAGE_GROUPS = ["blastSui"] as const;

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

/** Why a manifest is not a valid deployment identity, or why none exists. */
export class DeploymentManifestError extends Error {
  readonly code: "invalid-manifest" | "unsupported-route" | "unpublished";

  constructor(code: DeploymentManifestError["code"], message: string) {
    super(message);
    this.name = "DeploymentManifestError";
    this.code = code;
  }
}

/**
 * Released deployments, the only production identities. The fresh launch
 * stack (contracts ADR 0137) is unpublished: its publish script writes the
 * mainnet entry.
 */
export const BLAST_DEPLOYMENTS: BlastDeploymentRegistry = Object.freeze({});

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

/** The released deployment on `network`; throws while none is published. */
export function getBlastDeployment(network: BlastNetwork): BlastDeployment {
  const deployment = BLAST_DEPLOYMENTS[network];
  if (!deployment) {
    throw new DeploymentManifestError(
      "unpublished",
      `Blast is not yet published on Sui ${network}`,
    );
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

export function coreDeployment(deployment: BlastDeployment): CoreDeployment {
  return {
    ...deployment.packages.core,
    treasury: deployment.sharedObjects.core.treasury,
  };
}

export function vaultDeployment(deployment: BlastDeployment): VaultDeployment {
  return {
    ...deployment.packages.vault,
    ...deployment.sharedObjects.vault,
    core: coreDeployment(deployment),
    admin: adminDeployment(deployment),
  };
}

export function migratorsDeployment(
  deployment: BlastDeployment,
): MigratorsDeployment {
  return {
    ...deployment.packages.migrators,
    ...deployment.sharedObjects.migrators,
    vault: vaultDeployment(deployment),
  };
}

export function launchpadDeployment(
  deployment: BlastDeployment,
): LaunchpadDeployment {
  return {
    ...deployment.packages.launchpad,
    ...deployment.sharedObjects.launchpad,
    core: coreDeployment(deployment),
    admin: adminDeployment(deployment),
    partners: partnersDeployment(deployment),
    vault: vaultDeployment(deployment),
    migrators: migratorsDeployment(deployment),
    vestingPackageId: deployment.packages.vesting.packageId,
  };
}

/**
 * The presale's call-ready identities. `aftermathDaoPresale` is present
 * exactly when the manifest records the vendor venue's whole set.
 */
export function presaleDeployment(
  deployment: BlastDeployment,
): PresaleDeployment {
  const { aftermathDaoPresale } = deployment.packages;
  const aftermath = deployment.sharedObjects.aftermath;
  return {
    ...deployment.packages.presale,
    ...deployment.sharedObjects.presale,
    core: coreDeployment(deployment),
    admin: adminDeployment(deployment),
    partners: partnersDeployment(deployment),
    vault: vaultDeployment(deployment),
    migrators: migratorsDeployment(deployment),
    ...(aftermathDaoPresale && aftermath
      ? { aftermathDaoPresale: { ...aftermathDaoPresale, aftermath } }
      : {}),
  };
}

/** Returns the call-ready blast Sui identities from a deployment. */
export function blastSuiDeployment(
  deployment: BlastDeployment,
): BlastSuiDeployment {
  const packageReference = requireGroup(
    deployment.packages.blastSui,
    "packages.blastSui",
  );
  const objects = requireGroup(
    deployment.sharedObjects.blastSui,
    "sharedObjects.blastSui",
  );
  return {
    ...packageReference,
    ...objects,
    admin: adminDeployment(deployment),
  };
}

/**
 * Checks one route in its venue's native units: a migrators venue names at
 * least one pool tier; the vendor's `aftermathDao` names none.
 */
export function normalizeRoute(route: {
  venue: string;
  tiers: readonly { tickSpacing: number; feeRate: string | number | bigint }[];
}): MigrationRoute {
  if (!(VENUES as readonly string[]).includes(route.venue)) {
    throw new DeploymentManifestError(
      "unsupported-route",
      `unsupported route ${String(route.venue)}`,
    );
  }
  const venue = route.venue as Venue;
  if (!Array.isArray(route.tiers)) {
    throw new TypeError(`route ${venue} needs a tier list`);
  }
  if (venue === "aftermathDao") {
    if (route.tiers.length > 0) {
      throw new RangeError("the aftermathDao route has no tiers");
    }
    return Object.freeze({ venue, tiers: Object.freeze([]) });
  }
  if (route.tiers.length === 0) {
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
      abi: Object.freeze(
        Object.fromEntries(
          ARTIFACT_KEYS.map((key) => [
            key,
            requirePattern(
              `source.abi.${key}`,
              input.source?.abi?.[key],
              SHA256,
            ),
          ]),
        ) as Record<(typeof ARTIFACT_KEYS)[number], string>,
      ),
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
 * Normalizes every recorded group. The launch stack's groups are always
 * required; a package's group is required exactly when the manifest records
 * that package, and a venue's whole set is required when any part of it is
 * recorded. Within a group every key is required, so no call can read a
 * half-recorded owner.
 */
function normalizeSharedObjects(
  objects: BlastDeploymentInput["sharedObjects"],
  packages: BlastPackages,
): BlastSharedObjects {
  const groups: SharedObjectGroup[] = [...STACK_GROUPS];
  for (const group of PACKAGE_GROUPS) {
    if (packages[group]) groups.push(group);
  }
  requireCompleteVenueSets(packages, objects);
  for (const { group } of Object.values(VENUE_IDENTITY_SETS)) {
    if (objects?.[group]) groups.push(group);
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
    const group = objects?.[set.group];
    const paths = [
      ...set.packages.map((name) => ({
        path: `packages.${name}`,
        present: Boolean(packages[name as keyof BlastPackages]),
      })),
      ...Object.keys(set.sharedObjects).map((name) => ({
        path: `sharedObjects.${set.group}.${name}`,
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
  venue: Venue,
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
  for (const name of PUBLISHED_PACKAGES) {
    if (!transactions?.[name]) {
      throw new TypeError(`release.transactions.${name} is required`);
    }
  }
  for (const [step, digest] of Object.entries(transactions ?? {})) {
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
