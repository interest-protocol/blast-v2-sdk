import type {
  SharedObjectIdentity,
  SuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { MigratorVenue } from "@interest-protocol/blast-migrators-sdk/state";
import { MIGRATOR_VENUES } from "@interest-protocol/blast-migrators-sdk/state";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
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
import type {
  BlastDeployment,
  BlastDeploymentInput,
  BlastDeploymentRegistry,
  BlastSharedObjects,
  DeploymentEnvironment,
  VenueObjectType,
} from "./types.ts";
import { SHARED_OBJECT_GROUPS, VENUE_IDENTITY_SETS } from "./types.ts";

/**
 * The ABI this SDK is frozen to: the reviewed contracts commit and the sha256
 * of each committed parity artifact. A manifest built from anything else is an
 * ABI mismatch.
 */
export const FROZEN_ABI = Object.freeze({
  contractsCommit: "01d7659617abcd552cece6d05b9db409ec4ff2c0",
  artifacts: Object.freeze({
    launchpad:
      "4c6cef053ed514f974ee9ced7a19cd09466389937bb51989192acc592a5edc03",
    blastSui:
      "943236915134897494c1a1eb7f18d2a0ea8a012e6e657321abc5fc274ee3587f",
  }),
});

/** This SDK build's release identity. */
export type SdkRelease = Readonly<{
  name: string;
  /** package.json `version`. */
  version: string;
  /** False until this SDK version is released to npm. */
  published: boolean;
  /** The released source commit; null for a working copy. */
  commit: string | null;
}>;

/**
 * The shipped SDK state: private, unversioned, and without a release commit.
 * Production signing requires a published, versioned SDK with a commit, so it
 * stays disabled for this build.
 */
export const SDK_RELEASE: SdkRelease = Object.freeze({
  name: "@interest-protocol/blast-sdk",
  version: "0.0.0",
  published: false,
  commit: null,
});

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

/**
 * Whether protocol actions may be signed against a deployment. Consumers must
 * not build or sign protocol transactions unless `signing` is `"enabled"`.
 * `signing` covers the core actions (curve trades, opening rounds,
 * publication, and creation's core checks). An action on a venue (creating,
 * migrating, or trading a launch on it) also requires
 * `venues[venue].available`; while signing is disabled, every venue is
 * unavailable and carries the core reasons.
 */
export type ProtocolAccess =
  | Readonly<{
      signing: "enabled";
      deployment: BlastDeployment;
      fingerprint: string;
      venues: Readonly<Record<MigratorVenue, VenueAvailability>>;
    }>
  | Readonly<{
      signing: "disabled";
      deployment: BlastDeployment | null;
      fingerprint: string | null;
      reasons: readonly DeploymentRejection[];
      venues: Readonly<Record<MigratorVenue, VenueAvailability>>;
    }>;

/**
 * What a node reports for the deployment's chain and shared objects, keyed by
 * each object's owner-qualified path (`launchpad.launchConfig`,
 * `cetus.pools`), the same path `BlastSharedObjects` records it at.
 */
export type DeploymentRuntimeObservation = {
  chainIdentifier: string;
  sharedObjects: Record<
    string,
    { objectId: string; type: string; initialSharedVersion: string }
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
      error instanceof DeploymentManifestError
        ? error.code
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
        venues: venueAvailability(deployment, [], runtime.venues),
      })
    : disabled(deployment, unique, fingerprint, runtime.venues);
}

/** Each venue's availability: the core reasons first, then its own. */
function venueAvailability(
  deployment: BlastDeployment | null,
  core: readonly DeploymentRejection[],
  observed: Readonly<Partial<Record<MigratorVenue, DeploymentRejection[]>>>,
): Readonly<Record<MigratorVenue, VenueAvailability>> {
  const entries = MIGRATOR_VENUES.map((venue) => {
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
    Object.fromEntries(entries) as Record<MigratorVenue, VenueAvailability>,
  );
}

function venueRecordReasons(
  deployment: BlastDeployment,
  venue: MigratorVenue,
): DeploymentRejection[] {
  // A set is complete or absent, so the recorded group means the whole set.
  if (!deployment.sharedObjects[venue]) {
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
function venueOf(
  path: string,
): { venue: MigratorVenue; type: VenueObjectType } | null {
  const [group, name] = path.split(".");
  const venue = MIGRATOR_VENUES.find((candidate) => candidate === group);
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
 * Reads the chain identifier and every shared object's type and initial
 * version, the observation `evaluateProtocolAccess` compares.
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
  });
  const sharedObjects: DeploymentRuntimeObservation["sharedObjects"] = {};
  for (const [index, [name]] of entries.entries()) {
    const object = objects[index];
    if (!object || object instanceof Error) continue;
    if (object.owner.$kind !== "Shared") continue;
    sharedObjects[name] = {
      objectId: object.objectId,
      type: object.type,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
    };
  }
  return { chainIdentifier, sharedObjects };
}

/** The package and type each named shared object must have. */
function expectedObjectTypes(
  deployment: BlastDeployment,
): Record<string, { packageId: string; module: string; name: string }> {
  const launchpad = deployment.packages.launchpad.originalPackageId;
  const admin = deployment.packages.admin.originalPackageId;
  const migrators = deployment.packages.migrators?.originalPackageId;
  const presale = deployment.packages.presale?.originalPackageId;
  const types: Record<
    string,
    { packageId: string; module: string; name: string }
  > = {
    "launchpad.packageVersion": {
      packageId: launchpad,
      module: "package_version",
      name: "PackageVersion",
    },
    "launchpad.launchConfig": {
      packageId: launchpad,
      module: "launch_config",
      name: "LaunchConfig",
    },
    "launchpad.runtimeConfig": {
      packageId: launchpad,
      module: "runtime_config",
      name: "RuntimeConfig",
    },
    "admin.acl": { packageId: admin, module: "blast_acl", name: "ACL" },
  };
  if (migrators) {
    types["migrators.packageVersion"] = {
      packageId: migrators,
      module: "package_version",
      name: "PackageVersion",
    };
    types["migrators.lpFeePolicy"] = {
      packageId: migrators,
      module: "lp_fee_policy",
      name: "LpFeePolicy",
    };
    types["migrators.venueConfig"] = {
      packageId: migrators,
      module: "venue_config",
      name: "VenueConfig",
    };
  }
  if (presale) {
    types["presale.packageVersion"] = {
      packageId: presale,
      module: "blast_presale_package",
      name: "PackageVersion",
    };
    types["presale.venueConfig"] = {
      packageId: presale,
      module: "venue_config",
      name: "VenueConfig",
    };
    types["presale.creationPolicy"] = {
      packageId: presale,
      module: "creation_policy",
      name: "CreationPolicy",
    };
    types["presale.feePolicy"] = {
      packageId: presale,
      module: "fee_policy",
      name: "FeePolicy",
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
    abi.launchpad !== FROZEN_ABI.artifacts.launchpad ||
    abi.blastSui !== FROZEN_ABI.artifacts.blastSui
  ) {
    reasons.push(
      reason(
        "abi-mismatch",
        `the manifest was built from ${contractsCommit}, not the SDK's frozen ABI ${FROZEN_ABI.contractsCommit}`,
      ),
    );
  }
  const unsupported = deployment.routes.filter(
    ({ venue }) => !MIGRATOR_VENUES.includes(venue),
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
  venues: Partial<Record<MigratorVenue, DeploymentRejection[]>>;
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
  const result: RuntimeReasons = { core: [], venues: {} };
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
  return result;
}

function venueList(
  result: RuntimeReasons,
  venue: MigratorVenue,
): DeploymentRejection[] {
  const list = result.venues[venue] ?? [];
  result.venues[venue] = list;
  return list;
}

function typeReasons(
  name: string,
  observedType: string,
  expected: { packageId: string; module: string; name: string },
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
  return tag.module === expected.module && tag.name === expected.name
    ? []
    : [reason("runtime-mismatch", `${name} is a ${tag.module}::${tag.name}`)];
}

/**
 * The IDs of this repository's non-production test manifest
 * (`test/fixtures/non-production-deployment.ts`): sha256("blast-sdk-nonprod-<n>")
 * for n below 18.
 */
const SDK_FIXTURE_IDS: ReadonlySet<string> = new Set(
  Array.from(
    { length: 18 },
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
