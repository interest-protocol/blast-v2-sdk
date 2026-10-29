import type { AdminDeployment } from "@interest-protocol/blast-admin-sdk/transactions";
import { normalizeAdminDeployment } from "@interest-protocol/blast-admin-sdk/transactions";
import {
  requirePositiveU64,
  requireU64,
} from "@interest-protocol/blast-core/integers";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { MigratorVenue } from "@interest-protocol/blast-migrators-sdk/state";
import { MIGRATOR_VENUES } from "@interest-protocol/blast-migrators-sdk/state";
import type { PartnersDeployment } from "@interest-protocol/blast-partners-sdk/transactions";
import { defineAftermathPresaleDeployment } from "@interest-protocol/blast-presale-sdk/aftermath";
import type { PresaleDeployment } from "@interest-protocol/blast-presale-sdk/transactions";
import { isValidTransactionDigest } from "@mysten/sui/utils";
import {
  CANONICAL_MAINNET_PACKAGES,
  CANONICAL_MAINNET_SHARED_OBJECTS,
  MAINNET_PRESALE_DEPLOYMENT,
} from "./mainnet.ts";
import { FROZEN_ABI, SDK_RELEASE } from "./release.ts";
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
  presale: ["packageVersion", "venueConfig", "creationPolicy", "feePolicy"],
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

/** When the canonical stack's publish and custody were verified on mainnet. */
const CANONICAL_MAINNET_VERIFIED_AT_MS = "1793192079762";

/**
 * Publish and seal transactions of the canonical stack, with their
 * checkpoints. Source: contracts
 * `deployments/sui/mainnet/2026-10-28-canonical-mvr-launch-stack.json`.
 */
const CANONICAL_MAINNET_TRANSACTIONS = {
  admin: ["9QPC85nBDcKvM3NsWc24qMYGQ9LSMP54eJVWgkAwArBh", "339055856"],
  partners: ["76Z3rwhNrZxTz5th9Knu8QgCqveCAxMzWGrmeWGBLbYY", "339055930"],
  launchpad: ["3Qqc2DnEDucks229oFvRWBzkxD6DhDw44ZbToqZKHQHo", "339055980"],
  launchpadSeal: ["DAnSTzxqR3B79NfdrWrfh5V3ATPewpEh7XsbzKgmDWMD", "339056167"],
  migrators: ["4UXZoF2hwvhz5WxA8tC6nMqYYD8RaPsBdqVsnsRLRqsw", "339056212"],
  migratorsSeal: ["6hMFmSSYT4T8JKwe9gvxqdAHCRzF7H8mS21NskCjTTuN", "339056352"],
  presale: ["FdT1SiwhaXHzscenaYzmhNwr7GDRGmGrCXFsUfmx2T2P", "339056472"],
  presaleSeal: ["HrWaVvBh2ukHj3foiwXbreMCNwkFc8LCueTMXzqTRPfE", "339056547"],
} as const;

/**
 * Canonical released deployments, the only production identities. Mainnet is
 * the 2026-10-28 canonical stack, with the Cetus and Bluefin revisions its
 * migrators package links against. Routes are the pool tiers creators may
 * pick; the launchpad's `LaunchConfig` admits both venues' witnesses.
 */
export const BLAST_DEPLOYMENTS: BlastDeploymentRegistry = Object.freeze({
  mainnet: defineBlastDeployment({
    schemaVersion: BLAST_DEPLOYMENT_SCHEMA_VERSION,
    environment: "production",
    network: "mainnet",
    chainIdentifier: SUI_CHAIN_IDENTIFIERS.mainnet,
    explorer: { baseUrl: "https://suiscan.xyz/mainnet" },
    packages: {
      ...CANONICAL_MAINNET_PACKAGES,
      // Cetus CLMM revision 15, Cetus LP Burn revision 8, Bluefin Spot revision 17.
      cetusClmm: {
        packageId:
          "0x260693ec785a6e6c9d81d58c7d2ff72f1288ae0fa6a9725abe05a6478b11f084",
        originalPackageId:
          "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
      },
      cetusLpBurn: {
        packageId:
          "0xc4aabc874f5060d3147d8f74c14e3a8a1f9f8d92edea138a51635395ed167cd9",
        originalPackageId:
          "0x12d73de9a6bc3cb658ec9dc0fe7de2662be1cea5c76c092fcc3606048cdbac27",
      },
      bluefinSpot: {
        packageId:
          "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c",
        originalPackageId:
          "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267",
      },
    },
    sharedObjects: {
      ...CANONICAL_MAINNET_SHARED_OBJECTS,
      cetus: {
        config: {
          objectId:
            "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f",
          initialSharedVersion: "1574190",
        },
        pools: {
          objectId:
            "0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0",
          initialSharedVersion: "1574190",
        },
        burnManager: {
          objectId:
            "0x1d94aa32518d0cb00f9de6ed60d450c9a2090761f326752ffad06b2e9404f845",
          initialSharedVersion: "327723159",
        },
      },
      bluefin: {
        config: {
          objectId:
            "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352",
          initialSharedVersion: "406496849",
        },
      },
    },
    // Owner, 2026-10-28: every tier the DEXes support. Cetus: each tick spacing its mainnet
    // `GlobalConfig.fee_tiers` registers. Bluefin has no registry, so the same pairs within its
    // bounds (fee rate at most 20,000). Fee rates are parts per million.
    routes: [
      {
        venue: "cetus",
        tiers: [
          { tickSpacing: 2, feeRate: "100" },
          { tickSpacing: 4, feeRate: "200" },
          { tickSpacing: 6, feeRate: "300" },
          { tickSpacing: 8, feeRate: "400" },
          { tickSpacing: 10, feeRate: "500" },
          { tickSpacing: 20, feeRate: "1000" },
          { tickSpacing: 30, feeRate: "1500" },
          { tickSpacing: 40, feeRate: "2000" },
          { tickSpacing: 60, feeRate: "2500" },
          { tickSpacing: 80, feeRate: "3000" },
          { tickSpacing: 100, feeRate: "4000" },
          { tickSpacing: 120, feeRate: "6000" },
          { tickSpacing: 160, feeRate: "8000" },
          { tickSpacing: 200, feeRate: "10000" },
          { tickSpacing: 220, feeRate: "20000" },
          { tickSpacing: 260, feeRate: "40000" },
        ],
      },
      {
        venue: "bluefin",
        tiers: [
          { tickSpacing: 2, feeRate: "100" },
          { tickSpacing: 4, feeRate: "200" },
          { tickSpacing: 6, feeRate: "300" },
          { tickSpacing: 8, feeRate: "400" },
          { tickSpacing: 10, feeRate: "500" },
          { tickSpacing: 20, feeRate: "1000" },
          { tickSpacing: 30, feeRate: "1500" },
          { tickSpacing: 40, feeRate: "2000" },
          { tickSpacing: 60, feeRate: "2500" },
          { tickSpacing: 80, feeRate: "3000" },
          { tickSpacing: 100, feeRate: "4000" },
          { tickSpacing: 120, feeRate: "6000" },
          { tickSpacing: 160, feeRate: "8000" },
          { tickSpacing: 200, feeRate: "10000" },
          { tickSpacing: 220, feeRate: "20000" },
        ],
      },
    ],
    source: {
      contractsCommit: FROZEN_ABI.contractsCommit,
      abi: FROZEN_ABI.artifacts,
    },
    release: {
      transactions: Object.fromEntries(
        Object.entries(CANONICAL_MAINNET_TRANSACTIONS).map(
          ([step, [digest]]) => [step, digest],
        ),
      ),
    },
    sdk: { version: SDK_RELEASE.version, commit: SDK_RELEASE.commit ?? "" },
    evidence: Object.entries(CANONICAL_MAINNET_TRANSACTIONS).map(
      ([step, [transactionDigest, checkpoint]]) => ({
        check: `${step}-published`,
        transactionDigest,
        checkpoint,
        verifiedAtMs: CANONICAL_MAINNET_VERIFIED_AT_MS,
      }),
    ),
  }),
});

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
 * Canonical versioned presale, freshly published and activated on mainnet.
 * Venue admission and economics remain governed by the live policies.
 */
export const BLAST_PRESALE_DEPLOYMENTS: Readonly<
  Partial<Record<BlastNetwork, PresaleDeployment>>
> = Object.freeze({
  mainnet: definePresaleDeployment(MAINNET_PRESALE_DEPLOYMENT),
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
