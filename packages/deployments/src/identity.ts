import { packageVersionBcs } from "@interest-protocol/blast-admin-sdk/state";
import type {
  SharedObjectIdentity,
  SuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  BLAST_DEPLOYMENTS,
  DeploymentManifestError,
  defineBlastDeployment,
} from "./registry.ts";
import type { SdkRelease } from "./release.ts";
import { FROZEN_ABI, SDK_RELEASE } from "./release.ts";
import type {
  BlastDeployment,
  BlastDeploymentInput,
  BlastDeploymentRegistry,
  BlastSharedObjects,
  DeploymentEnvironment,
  Venue,
  VenueObjectType,
} from "./types.ts";
import {
  ARTIFACT_KEYS,
  SHARED_OBJECT_GROUPS,
  VENUE_IDENTITY_SETS,
  VENUES,
} from "./types.ts";

export * from "./release.ts";

export type DeploymentRejectionCode =
  | "invalid-manifest"
  | "environment-mismatch"
  | "fixture-identity-in-production"
  | "unreleased-deployment"
  | "foreign-lineage"
  | "abi-mismatch"
  | "unsupported-route"
  | "sdk-unreleased"
  | "sdk-mismatch"
  | "missing-evidence"
  | "runtime-unverified"
  | "runtime-mismatch"
  | "venue-unrecorded"
  | "venue-not-routed";

export type DeploymentRejection = Readonly<{
  code: DeploymentRejectionCode;
  message: string;
}>;

/** Whether actions on one venue may be signed, and why not. */
export type VenueAvailability =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; reasons: readonly DeploymentRejection[] }>;

/** The packages whose `PackageVersion<OTW>` carries a pause mask. */
export const PAUSABLE_PACKAGES = [
  "vault",
  "launchpad",
  "presale",
  "migrators",
] as const;

export type PausablePackage = (typeof PAUSABLE_PACKAGES)[number];

/**
 * Each package's observed `PackageVersion.paused` mask. An operation whose
 * bit is set aborts on chain, so consumers must not sign it:
 * `LAUNCHPAD_PAUSE_BITS` (Create, Trading, Migrate), `PRESALE_PAUSE_BITS`
 * (Create, Commit, Migrate) and `VAULT_PAUSE_BITS` (Admin, which gates admin
 * actions only). The migrators define no bits, so theirs is always zero.
 */
export type PausedMasks = Readonly<Record<PausablePackage, number>>;

/**
 * Whether protocol actions may be signed against a deployment. Consumers must
 * not build or sign protocol transactions unless `signing` is `"enabled"`,
 * nor an operation whose pause bit `paused` reports set. An action on a venue
 * (creating, migrating, or trading a sale on it) also requires
 * `venues[venue].available`; while signing is disabled, every venue is
 * unavailable and carries the core reasons.
 */
export type ProtocolAccess =
  | Readonly<{
      signing: "enabled";
      deployment: BlastDeployment;
      fingerprint: string;
      paused: PausedMasks;
      venues: Readonly<Record<Venue, VenueAvailability>>;
    }>
  | Readonly<{
      signing: "disabled";
      deployment: BlastDeployment | null;
      fingerprint: string | null;
      reasons: readonly DeploymentRejection[];
      venues: Readonly<Record<Venue, VenueAvailability>>;
    }>;

/**
 * What a node reports for the deployment's chain and shared objects, keyed by
 * each object's owner-qualified path (`launchpad.launchConfig`,
 * `cetus.pools`), the same path `BlastSharedObjects` records it at. Each
 * pausable package's `packageVersion` also reports its `paused` mask.
 */
export type DeploymentRuntimeObservation = {
  chainIdentifier: string;
  sharedObjects: Record<
    string,
    {
      objectId: string;
      type: string;
      initialSharedVersion: string;
      paused?: number;
    }
  >;
};

/**
 * Every recorded shared object as `<owner group>.<name>` paired with its
 * identity, in canonical group order. The identity checks walk this flat view
 * of the grouped manifest, so one path names both the owner and the object.
 *
 * This is the key format of `DeploymentRuntimeObservation.sharedObjects`, so
 * anything that builds an observation (a test node, a fixture chain) should
 * key it from here rather than spelling the paths out.
 */
export function sharedObjectEntries(
  objects: BlastSharedObjects,
): [string, SharedObjectIdentity][] {
  return SHARED_OBJECT_GROUPS.flatMap((group) => {
    const recorded = objects[group];
    if (!recorded) return [];
    return Object.entries(recorded).map(
      ([name, identity]) =>
        [`${group}.${name}`, identity] as [string, SharedObjectIdentity],
    );
  });
}

/**
 * sha256 hex over the canonical JSON of the identity-bearing fields: schema,
 * environment, network, chain, packages, shared objects, routes, and source.
 * Explorer links, release digests, SDK stamp, and evidence describe the
 * release and do not change it.
 */
export function deploymentFingerprint(deployment: BlastDeployment): string {
  const identity = {
    schemaVersion: deployment.schemaVersion,
    environment: deployment.environment,
    network: deployment.network,
    chainIdentifier: deployment.chainIdentifier,
    packages: deployment.packages,
    sharedObjects: deployment.sharedObjects,
    routes: deployment.routes,
    source: deployment.source,
  };
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(identity))));
}

/**
 * The one fail-closed identity check every consumer runs before signing. It
 * never throws for an identity problem: every failure is a reason.
 *
 * Core reasons (manifest, environment, registry, release, SDK, ABI, chain,
 * packages, and any shared object's ID or initial version) disable all
 * signing, and every venue with it. A partial venue set is an invalid
 * manifest, so it is core too. Venue reasons disable only that venue: no
 * recorded set for it (`venue-unrecorded`), a set without a route
 * (`venue-not-routed`), or a recorded venue object the runtime did not
 * observe or observed with another type or lineage.
 */
export function evaluateProtocolAccess(options: {
  manifest: BlastDeploymentInput | BlastDeployment;
  mode: DeploymentEnvironment;
  runtime?: DeploymentRuntimeObservation;
  sdk?: SdkRelease;
  registry?: BlastDeploymentRegistry;
}): ProtocolAccess {
  let deployment: BlastDeployment;
  try {
    deployment = defineBlastDeployment(
      options.manifest as BlastDeploymentInput,
    );
  } catch (error) {
    const code =
      error instanceof DeploymentManifestError &&
      error.code === "unsupported-route"
        ? "unsupported-route"
        : "invalid-manifest";
    return disabled(null, [reason(code, errorMessage(error))]);
  }
  const runtime = observedRuntimeReasons(deployment, options.runtime);
  const reasons = [
    ...environmentReasons(deployment, options.mode),
    ...registryReasons(
      deployment,
      options.mode,
      options.registry ?? BLAST_DEPLOYMENTS,
    ),
    ...sourceReasons(deployment),
    ...sdkReasons(deployment, options.mode, options.sdk ?? SDK_RELEASE),
    ...runtime.core,
  ];
  const unique = uniqueByCode(reasons);
  const fingerprint = deploymentFingerprint(deployment);
  return unique.length === 0
    ? Object.freeze({
        signing: "enabled",
        deployment,
        fingerprint,
        paused: Object.freeze(
          runtime.paused as Record<PausablePackage, number>,
        ),
        venues: venueAvailability(deployment, [], runtime.venues),
      })
    : disabled(deployment, unique, fingerprint, runtime.venues);
}

/** Each venue's availability: the core reasons first, then its own. */
function venueAvailability(
  deployment: BlastDeployment | null,
  core: readonly DeploymentRejection[],
  observed: Readonly<Partial<Record<Venue, DeploymentRejection[]>>>,
): Readonly<Record<Venue, VenueAvailability>> {
  const entries = VENUES.map((venue) => {
    const reasons = uniqueByCode([
      ...core,
      ...(deployment ? venueRecordReasons(deployment, venue) : []),
      ...(observed[venue] ?? []),
    ]);
    const availability: VenueAvailability =
      reasons.length === 0
        ? Object.freeze({ available: true })
        : Object.freeze({ available: false, reasons: Object.freeze(reasons) });
    return [venue, availability] as const;
  });
  return Object.freeze(
    Object.fromEntries(entries) as Record<Venue, VenueAvailability>,
  );
}

function venueRecordReasons(
  deployment: BlastDeployment,
  venue: Venue,
): DeploymentRejection[] {
  // A set is complete or absent, so the recorded group means the whole set.
  if (!deployment.sharedObjects[VENUE_IDENTITY_SETS[venue].group]) {
    return [
      reason(
        "venue-unrecorded",
        `the manifest records no ${venue} packages and objects`,
      ),
    ];
  }
  return deployment.routes.some((route) => route.venue === venue)
    ? []
    : [reason("venue-not-routed", `the manifest admits no ${venue} route`)];
}

/** The venue whose group records the shared object at `path`, if any. */
function venueOf(path: string): { venue: Venue; type: VenueObjectType } | null {
  const [group, name] = path.split(".");
  const venue = VENUES.find(
    (candidate) => VENUE_IDENTITY_SETS[candidate].group === group,
  );
  if (!venue || name === undefined) return null;
  const type = (
    VENUE_IDENTITY_SETS[venue].sharedObjects as Record<string, VenueObjectType>
  )[name];
  return type ? { venue, type } : null;
}

function uniqueByCode(
  reasons: readonly DeploymentRejection[],
): DeploymentRejection[] {
  return reasons.filter(
    (entry, index) =>
      reasons.findIndex((other) => other.code === entry.code) === index,
  );
}

/**
 * Reads the chain identifier, every shared object's type and initial
 * version, and each pausable package's pause mask: the observation
 * `evaluateProtocolAccess` compares.
 */
export async function observeDeploymentRuntime(
  client: ClientWithCoreApi,
  deployment: BlastDeployment,
): Promise<DeploymentRuntimeObservation> {
  const getChainIdentifier = (
    client.core as {
      getChainIdentifier?: () => Promise<{ chainIdentifier: string }>;
    }
  ).getChainIdentifier;
  if (!getChainIdentifier) {
    throw new TypeError("the client cannot report its chain identifier");
  }
  const { chainIdentifier } = await getChainIdentifier.call(client.core);
  const entries = sharedObjectEntries(deployment.sharedObjects);
  const { objects } = await client.core.getObjects({
    objectIds: entries.map(([, identity]) => identity.objectId),
    include: { content: true },
  });
  const sharedObjects: DeploymentRuntimeObservation["sharedObjects"] = {};
  for (const [index, [name]] of entries.entries()) {
    const object = objects[index];
    if (!object || object instanceof Error) continue;
    if (object.owner.$kind !== "Shared") continue;
    const paused = PAUSABLE_PACKAGES.some(
      (group) => name === `${group}.packageVersion`,
    )
      ? pausedMask(object.content)
      : undefined;
    sharedObjects[name] = {
      objectId: object.objectId,
      type: object.type,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      ...(paused === undefined ? {} : { paused }),
    };
  }
  return { chainIdentifier, sharedObjects };
}

/** A `PackageVersion<OTW>`'s pause mask; undefined when its contents do not decode. */
function pausedMask(content: Uint8Array): number | undefined {
  try {
    return packageVersionBcs.parse(content).paused;
  } catch {
    return undefined;
  }
}

/** A shared object's expected type: package, module, name and type arguments. */
type ExpectedType = {
  packageId: string;
  module: string;
  name: string;
  typeParams?: readonly string[];
};

/** The package and type each launch-stack shared object must have. */
function expectedObjectTypes(
  deployment: BlastDeployment,
): Record<string, ExpectedType> {
  const original = (name: keyof BlastDeployment["packages"]) =>
    deployment.packages[name]?.originalPackageId ?? "";
  const admin = original("admin");
  const type = (
    packageId: string,
    module: string,
    name: string,
  ): ExpectedType => ({ packageId, module, name });
  const types: Record<string, ExpectedType> = {
    "admin.acl": type(admin, "blast_acl", "ACL"),
    "core.treasury": type(original("core"), "blast_treasury", "Treasury"),
    "vault.registry": type(
      original("vault"),
      "blast_vault_package",
      "VaultRegistry",
    ),
    "launchpad.launchConfig": type(
      original("launchpad"),
      "launch_config",
      "LaunchConfig",
    ),
    "launchpad.runtimeConfig": type(
      original("launchpad"),
      "runtime_config",
      "RuntimeConfig",
    ),
    "launchpad.launchRegistry": type(
      original("launchpad"),
      "launch",
      "LaunchRegistry",
    ),
    "presale.creationPolicy": type(
      original("presale"),
      "creation_policy",
      "CreationPolicy",
    ),
    "presale.feePolicy": type(original("presale"), "fee_policy", "FeePolicy"),
    "presale.presaleRegistry": type(
      original("presale"),
      "blast_presale",
      "PresaleRegistry",
    ),
    "migrators.venueConfig": type(
      original("migrators"),
      "venue_config",
      "VenueConfig",
    ),
  };
  // Each upgradeable package's `PackageVersion<OTW>` and `PackageAdmin<OTW>`.
  const otws = {
    vault: ["blast_vault_package", "BLAST_VAULT_PACKAGE"],
    launchpad: ["blast_fun", "BLAST_FUN"],
    presale: ["blast_presale_package", "BLAST_PRESALE_PACKAGE"],
    migrators: ["blast_migrators", "BLAST_MIGRATORS"],
  } as const;
  for (const [group, [module, name]] of Object.entries(otws)) {
    const otw = normalizeStructTag(
      `${original(group as keyof typeof otws)}::${module}::${name}`,
    );
    types[`${group}.packageVersion`] = {
      ...type(admin, "package_version", "PackageVersion"),
      typeParams: [otw],
    };
    types[`${group}.packageAdmin`] = {
      ...type(admin, "package_admin", "PackageAdmin"),
      typeParams: [otw],
    };
  }
  return types;
}

function environmentReasons(
  deployment: BlastDeployment,
  mode: DeploymentEnvironment,
): DeploymentRejection[] {
  const reasons: DeploymentRejection[] = [];
  if (deployment.environment !== mode) {
    reasons.push(
      reason(
        "environment-mismatch",
        `a ${deployment.environment} manifest cannot sign in ${mode}`,
      ),
    );
  }
  if (mode === "production" && fixtureIdentities(deployment).length > 0) {
    reasons.push(
      reason(
        "fixture-identity-in-production",
        `fixture identities ${fixtureIdentities(deployment).join(", ")} cannot be production`,
      ),
    );
  }
  return reasons;
}

function registryReasons(
  deployment: BlastDeployment,
  mode: DeploymentEnvironment,
  registry: BlastDeploymentRegistry,
): DeploymentRejection[] {
  if (mode !== "production") return [];
  const released = registry[deployment.network];
  if (!released) {
    return [
      reason(
        "unreleased-deployment",
        `no released Blast V2 deployment exists on ${deployment.network}`,
      ),
    ];
  }
  const manifestPackages = deployment.packages as Readonly<
    Record<string, SuiPackageReference | undefined>
  >;
  const foreign = Object.entries(released.packages).filter(
    ([name, reference]) =>
      manifestPackages[name]?.originalPackageId !==
      (reference as SuiPackageReference).originalPackageId,
  );
  if (foreign.length > 0) {
    return [
      reason(
        "foreign-lineage",
        `packages ${foreign.map(([name]) => name).join(", ")} do not descend from the released lineage`,
      ),
    ];
  }
  return deploymentFingerprint(released) === deploymentFingerprint(deployment)
    ? []
    : [
        reason(
          "unreleased-deployment",
          "the manifest is not the released deployment identity",
        ),
      ];
}

function sourceReasons(deployment: BlastDeployment): DeploymentRejection[] {
  const reasons: DeploymentRejection[] = [];
  const { contractsCommit, abi } = deployment.source;
  if (
    contractsCommit !== FROZEN_ABI.contractsCommit ||
    ARTIFACT_KEYS.some((key) => abi[key] !== FROZEN_ABI.artifacts[key])
  ) {
    reasons.push(
      reason(
        "abi-mismatch",
        `the manifest was built from ${contractsCommit}, not the SDK's frozen ABI ${FROZEN_ABI.contractsCommit}`,
      ),
    );
  }
  const unsupported = deployment.routes.filter(
    ({ venue }) => !VENUES.includes(venue),
  );
  if (unsupported.length > 0) {
    reasons.push(
      reason(
        "unsupported-route",
        `the SDK cannot build routes ${unsupported.map(({ venue }) => venue).join(", ")} at the frozen ABI`,
      ),
    );
  }
  return reasons;
}

function sdkReasons(
  deployment: BlastDeployment,
  mode: DeploymentEnvironment,
  sdk: SdkRelease,
): DeploymentRejection[] {
  const reasons: DeploymentRejection[] = [];
  if (mode === "production") {
    if (!sdk.published || sdk.version === "0.0.0" || sdk.commit === null) {
      reasons.push(
        reason(
          "sdk-unreleased",
          "production signing needs a published, versioned SDK with a release commit",
        ),
      );
    }
    if (deployment.evidence.length === 0) {
      reasons.push(
        reason(
          "missing-evidence",
          "a production manifest needs post-deploy evidence",
        ),
      );
    }
  }
  if (
    deployment.sdk.version !== sdk.version ||
    (sdk.commit !== null && deployment.sdk.commit !== sdk.commit)
  ) {
    reasons.push(
      reason(
        "sdk-mismatch",
        `the manifest was validated with SDK ${deployment.sdk.version}, not ${sdk.version}`,
      ),
    );
  }
  return reasons;
}

type RuntimeReasons = {
  core: DeploymentRejection[];
  venues: Partial<Record<Venue, DeploymentRejection[]>>;
  paused: Partial<Record<PausablePackage, number>>;
};

/** A structurally invalid observation is unverified, never an exception. */
function observedRuntimeReasons(
  deployment: BlastDeployment,
  runtime: DeploymentRuntimeObservation | undefined,
): RuntimeReasons {
  try {
    return runtimeReasons(deployment, runtime);
  } catch (error) {
    return {
      core: [
        reason(
          "runtime-unverified",
          `malformed runtime observation: ${errorMessage(error)}`,
        ),
      ],
      venues: {},
      paused: {},
    };
  }
}

/**
 * Compares the observation with the manifest. A chain, ID, or initial-version
 * difference is core; a venue object's absence or type is its venue's.
 */
function runtimeReasons(
  deployment: BlastDeployment,
  runtime: DeploymentRuntimeObservation | undefined,
): RuntimeReasons {
  const result: RuntimeReasons = { core: [], venues: {}, paused: {} };
  if (!runtime) {
    result.core.push(
      reason(
        "runtime-unverified",
        "no runtime observation of the chain and shared objects",
      ),
    );
    return result;
  }
  if (runtime.chainIdentifier !== deployment.chainIdentifier) {
    result.core.push(
      reason(
        "runtime-mismatch",
        `the node reports chain ${runtime.chainIdentifier}, not ${deployment.chainIdentifier}`,
      ),
    );
  }
  const expected = expectedObjectTypes(deployment);
  for (const [name, identity] of sharedObjectEntries(
    deployment.sharedObjects,
  )) {
    const venue = venueOf(name);
    const own = venue ? venueList(result, venue.venue) : result.core;
    const observed = runtime.sharedObjects[name];
    if (!observed) {
      own.push(reason("runtime-unverified", `${name} was not observed`));
      continue;
    }
    if (
      normalizeSuiObjectId(observed.objectId) !== identity.objectId ||
      String(observed.initialSharedVersion) !==
        String(identity.initialSharedVersion)
    ) {
      result.core.push(
        reason("runtime-mismatch", `${name} differs from the manifest`),
      );
    }
    const type = venue
      ? {
          ...venue.type,
          packageId:
            (
              deployment.packages as Readonly<
                Record<string, SuiPackageReference | undefined>
              >
            )[venue.type.package]?.originalPackageId ?? "",
        }
      : expected[name];
    if (type) own.push(...typeReasons(name, observed.type, type));
  }
  observePausedMasks(runtime, result);
  return result;
}

/** Each pausable package's observed mask; an unobserved one is unverified. */
function observePausedMasks(
  runtime: DeploymentRuntimeObservation,
  result: RuntimeReasons,
): void {
  for (const group of PAUSABLE_PACKAGES) {
    const paused = runtime.sharedObjects[`${group}.packageVersion`]?.paused;
    if (paused === undefined || !Number.isInteger(paused)) {
      result.core.push(
        reason(
          "runtime-unverified",
          `${group}.packageVersion's pause mask was not observed`,
        ),
      );
      continue;
    }
    result.paused[group] = paused;
  }
}

function venueList(
  result: RuntimeReasons,
  venue: Venue,
): DeploymentRejection[] {
  const list = result.venues[venue] ?? [];
  result.venues[venue] = list;
  return list;
}

function typeReasons(
  name: string,
  observedType: string,
  expected: ExpectedType,
): DeploymentRejection[] {
  let tag: ReturnType<typeof parseStructTag>;
  try {
    tag = parseStructTag(observedType);
  } catch {
    return [reason("runtime-mismatch", `${name} has an unreadable type`)];
  }
  if (tag.address !== normalizeSuiAddress(expected.packageId)) {
    return [
      reason(
        "foreign-lineage",
        `${name} belongs to ${tag.address}, not ${expected.packageId}`,
      ),
    ];
  }
  const typeParams = tag.typeParams.map((param) =>
    normalizeStructTag(param as string),
  );
  return tag.module === expected.module &&
    tag.name === expected.name &&
    typeParams.length === (expected.typeParams ?? []).length &&
    typeParams.every((param, index) => param === expected.typeParams?.[index])
    ? []
    : [
        reason(
          "runtime-mismatch",
          `${name} is a ${normalizeStructTag(observedType)}`,
        ),
      ];
}

/**
 * The IDs of this repository's non-production test manifest
 * (`test/fixtures/non-production-deployment.ts`): sha256("blast-sdk-nonprod-<n>")
 * for n below 32.
 */
const SDK_FIXTURE_IDS: ReadonlySet<string> = new Set(
  Array.from(
    { length: 32 },
    (_, n) => `0x${bytesToHex(sha256(utf8ToBytes(`blast-sdk-nonprod-${n}`)))}`,
  ),
);

/**
 * Hash-derived Sui IDs never fit in 64 bits; an ID that does is a hand-written
 * test or placeholder value. The SDK's own test manifest IDs are fixtures too.
 * Any other hash-derived test ID is caught only by the registry match.
 */
function fixtureIdentities(deployment: BlastDeployment): string[] {
  const ids = [
    ...Object.values(deployment.packages).flatMap((reference) => [
      reference.packageId,
      reference.originalPackageId,
    ]),
    ...sharedObjectEntries(deployment.sharedObjects).map(
      ([, { objectId }]) => objectId,
    ),
  ];
  return [
    ...new Set(
      ids.filter((id) => BigInt(id) < 1n << 64n || SDK_FIXTURE_IDS.has(id)),
    ),
  ];
}

function disabled(
  deployment: BlastDeployment | null,
  reasons: DeploymentRejection[],
  fingerprint: string | null = null,
  venues: RuntimeReasons["venues"] = {},
): ProtocolAccess {
  return Object.freeze({
    signing: "disabled",
    deployment,
    fingerprint,
    reasons: Object.freeze(reasons),
    venues: venueAvailability(deployment, reasons, venues),
  });
}

function reason(
  code: DeploymentRejectionCode,
  message: string,
): DeploymentRejection {
  return Object.freeze({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
