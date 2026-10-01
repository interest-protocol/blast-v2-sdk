import { isValidTransactionDigest } from "@mysten/sui/utils";

import { requirePositiveU64, requireU64 } from "../lib/integers.ts";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
  sharedObjectReference,
} from "../lib/sui.ts";
import type { MigratorVenue } from "../migrators/state.ts";
import { MIGRATOR_VENUES } from "../migrators/state.ts";
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
} from "./types.ts";
import {
  BLAST_DEPLOYMENT_SCHEMA_VERSION,
  BLAST_NETWORKS,
  VENUE_IDENTITY_SETS,
} from "./types.ts";

const REQUIRED_PACKAGES = ["launchpad", "admin", "partners", "timelock"];
const REQUIRED_SHARED_OBJECTS = [
  "packageVersion",
  "launchConfig",
  "runtimeConfig",
  "acl",
];
const MIGRATOR_SHARED_OBJECTS = [
  "migratorsPackageVersion",
  "lpFeePolicy",
  "venueConfig",
];
/**
 * Genesis checkpoint digests of the public Sui chains, in the form every Core
 * API transport of `@mysten/sui` reports from `getChainIdentifier`. Source:
 * contracts 442116a, `sui/migrators/scripts/check_mainnet_abi.mjs` (mainnet)
 * and `deployments/sui/lineage-search-2026-09-22.md` (testnet). Their first
 * four bytes are JSON-RPC's `sui_getChainIdentifier` values `35834a8a` and
 * `4c78adac`, which that record also lists.
 */
const SUI_CHAIN_IDENTIFIERS: Readonly<Partial<Record<BlastNetwork, string>>> = {
  mainnet: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  testnet: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD",
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

/**
 * Validates, normalizes, and freezes one manifest into the runtime identity
 * schema. Shape only: `evaluateProtocolAccess` decides whether it may sign.
 * A production manifest must name mainnet; a non-production one never may.
 * The chain identifier must be the named network's genesis digest.
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

export function launchpadDeployment(
  deployment: BlastDeployment,
): LaunchpadDeploymentConstants {
  const packages = deployment.packages;
  const objects = deployment.sharedObjects;
  return {
    packageId: packages.launchpad.packageId,
    originalPackageId: packages.launchpad.originalPackageId,
    adminPackageId: packages.admin.packageId,
    partnersPackageId: packages.partners.packageId,
    timelockPackageId: packages.timelock.packageId,
    packageVersion: sharedObjectReference(objects.packageVersion, false),
    launchConfig: sharedObjectReference(objects.launchConfig, false),
    runtimeConfig: sharedObjectReference(objects.runtimeConfig, false),
    acl: sharedObjectReference(objects.acl, false),
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
  if ((input.environment === "production") !== (network === "mainnet")) {
    throw new RangeError(
      "a production manifest names mainnet, and a non-production manifest never does",
    );
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
  return freezeRecord(
    "packages",
    packages,
    normalizeSuiPackageReference,
  ) as BlastPackages;
}

function normalizeSharedObjects(
  objects: BlastDeploymentInput["sharedObjects"],
  packages: BlastPackages,
): BlastSharedObjects {
  const required = packages.migrators
    ? [...REQUIRED_SHARED_OBJECTS, ...MIGRATOR_SHARED_OBJECTS]
    : REQUIRED_SHARED_OBJECTS;
  for (const name of required) {
    if (!objects?.[name]) {
      throw new TypeError(`sharedObjects.${name} is required`);
    }
  }
  requireCompleteVenueSets(packages, objects);
  return freezeRecord(
    "sharedObjects",
    objects,
    normalizeSharedObjectIdentity,
  ) as BlastSharedObjects;
}

/**
 * A venue's set is all or nothing: any recorded key requires every key, so
 * each venue object is always type-checked against the package lineage that
 * defines it. A partial set is an invalid manifest.
 */
function requireCompleteVenueSets(
  packages: BlastPackages,
  objects: BlastDeploymentInput["sharedObjects"],
): void {
  for (const [venue, set] of Object.entries(VENUE_IDENTITY_SETS)) {
    const paths = [
      ...set.packages.map((name) => ({
        path: `packages.${name}`,
        present: Boolean(packages[name]),
      })),
      ...Object.keys(set.sharedObjects).map((name) => ({
        path: `sharedObjects.${name}`,
        present: Boolean(objects[name]),
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

/**
 * Binds the chain to the network label: mainnet and testnet must carry their
 * own genesis digest, and no other network may carry either one.
 */
function requireChainIdentifier(network: BlastNetwork, value: unknown): string {
  const chain = requireText("chainIdentifier", value);
  if (!isValidTransactionDigest(chain)) {
    throw new TypeError(
      "chainIdentifier must be the genesis checkpoint digest the Core API reports",
    );
  }
  const expected = SUI_CHAIN_IDENTIFIERS[network];
  const known = Object.values(SUI_CHAIN_IDENTIFIERS).includes(chain);
  if (expected === undefined ? known : chain !== expected) {
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
  const url = new URL(text);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("explorer.baseUrl must be an http(s) URL");
  }
  return text.replace(/\/+$/, "");
}

function freezeRecord<Value, Normalized>(
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
