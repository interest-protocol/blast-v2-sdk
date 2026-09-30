import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { MigratorVenue } from "../migrators/state.ts";
import { MIGRATOR_VENUES } from "../migrators/state.ts";
import {
  BLAST_DEPLOYMENTS,
  DeploymentManifestError,
  defineBlastDeployment,
} from "./registry.ts";
import type {
  BlastDeployment,
  BlastDeploymentInput,
  BlastDeploymentRegistry,
  DeploymentEnvironment,
} from "./types.ts";

/**
 * The ABI this SDK is frozen to: the reviewed contracts commit and the sha256
 * of each committed parity artifact. A manifest built from anything else is an
 * ABI mismatch.
 */
export const FROZEN_ABI = Object.freeze({
  contractsCommit: "a2a1db25f72a44e3b650bebe0ef806de4c70abbc",
  artifacts: Object.freeze({
    launchpad:
      "d08ee60a12a3223d1f9e9f4c009a0aaf3adec1b783e0025f453e2c79b7474288",
    blastSui:
      "f3a1e1c12c8bac0a1d8a3de38fa7c2e3eab13fa648fface320eecf658e66e22d",
  }),
  /**
   * Routes whose SDK call shape does not match the frozen commit. The SDK
   * builds the contracts ADR 0100 generic Cetus routes, which a2a1db2 does not
   * have (it has `*_meme_a` and `*_meme_b`), so Cetus stays disabled until the
   * two agree. `npm run check:abi` fails on the same conflict.
   */
  unresolvedRoutes: Object.freeze(["cetus"] as MigratorVenue[]),
});

/** This SDK build's release identity. */
export type SdkRelease = Readonly<{
  name: string;
  /** package.json `version`. */
  version: string;
  /** False while package.json is `private`. */
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
  | "runtime-mismatch";

export type DeploymentRejection = Readonly<{
  code: DeploymentRejectionCode;
  message: string;
}>;

/**
 * Whether protocol actions may be signed against a deployment. Consumers must
 * not build or sign protocol transactions unless `signing` is `"enabled"`.
 */
export type ProtocolAccess =
  | Readonly<{
      signing: "enabled";
      deployment: BlastDeployment;
      fingerprint: string;
    }>
  | Readonly<{
      signing: "disabled";
      deployment: BlastDeployment | null;
      fingerprint: string | null;
      reasons: readonly DeploymentRejection[];
    }>;

/** What a node reports for the deployment's chain and shared objects. */
export type DeploymentRuntimeObservation = {
  chainIdentifier: string;
  sharedObjects: Record<
    string,
    { objectId: string; type: string; initialSharedVersion: string }
  >;
};

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
 * never throws for an identity problem: every failure is a reason, and any
 * reason disables signing.
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
  const reasons = [
    ...environmentReasons(deployment, options.mode),
    ...registryReasons(
      deployment,
      options.mode,
      options.registry ?? BLAST_DEPLOYMENTS,
    ),
    ...sourceReasons(deployment),
    ...sdkReasons(deployment, options.mode, options.sdk ?? SDK_RELEASE),
    ...runtimeReasons(deployment, options.runtime),
  ];
  const unique = reasons.filter(
    (entry, index) =>
      reasons.findIndex((other) => other.code === entry.code) === index,
  );
  const fingerprint = deploymentFingerprint(deployment);
  return unique.length === 0
    ? Object.freeze({ signing: "enabled", deployment, fingerprint })
    : disabled(deployment, unique, fingerprint);
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
  const entries = Object.entries(deployment.sharedObjects);
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
  const types: Record<
    string,
    { packageId: string; module: string; name: string }
  > = {
    packageVersion: {
      packageId: launchpad,
      module: "package_version",
      name: "PackageVersion",
    },
    launchConfig: {
      packageId: launchpad,
      module: "launch_config",
      name: "LaunchConfig",
    },
    runtimeConfig: {
      packageId: launchpad,
      module: "runtime_config",
      name: "RuntimeConfig",
    },
    acl: { packageId: admin, module: "blast_acl", name: "ACL" },
  };
  if (migrators) {
    types.migratorsPackageVersion = {
      packageId: migrators,
      module: "package_version",
      name: "PackageVersion",
    };
    types.lpFeePolicy = {
      packageId: migrators,
      module: "lp_fee_policy",
      name: "LpFeePolicy",
    };
    types.venueConfig = {
      packageId: migrators,
      module: "venue_config",
      name: "VenueConfig",
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
  const foreign = Object.entries(released.packages).filter(
    ([name, reference]) =>
      deployment.packages[name]?.originalPackageId !==
      reference.originalPackageId,
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
    ({ venue }) =>
      !MIGRATOR_VENUES.includes(venue) ||
      FROZEN_ABI.unresolvedRoutes.includes(venue),
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

function runtimeReasons(
  deployment: BlastDeployment,
  runtime: DeploymentRuntimeObservation | undefined,
): DeploymentRejection[] {
  if (!runtime) {
    return [
      reason(
        "runtime-unverified",
        "no runtime observation of the chain and shared objects",
      ),
    ];
  }
  const reasons: DeploymentRejection[] = [];
  if (runtime.chainIdentifier !== deployment.chainIdentifier) {
    reasons.push(
      reason(
        "runtime-mismatch",
        `the node reports chain ${runtime.chainIdentifier}, not ${deployment.chainIdentifier}`,
      ),
    );
  }
  const expected = expectedObjectTypes(deployment);
  for (const [name, identity] of Object.entries(deployment.sharedObjects)) {
    const observed = runtime.sharedObjects[name];
    if (!observed) {
      reasons.push(reason("runtime-unverified", `${name} was not observed`));
      continue;
    }
    if (
      normalizeSuiObjectId(observed.objectId) !== identity.objectId ||
      String(observed.initialSharedVersion) !==
        String(identity.initialSharedVersion)
    ) {
      reasons.push(
        reason("runtime-mismatch", `${name} differs from the manifest`),
      );
    }
    const type = expected[name];
    if (type) reasons.push(...typeReasons(name, observed.type, type));
  }
  return reasons;
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
 * Hash-derived Sui IDs never fit in 64 bits; an ID that does is a hand-written
 * test or placeholder value.
 */
function fixtureIdentities(deployment: BlastDeployment): string[] {
  const ids = [
    ...Object.values(deployment.packages).flatMap((reference) => [
      reference.packageId,
      reference.originalPackageId,
    ]),
    ...Object.values(deployment.sharedObjects).map(({ objectId }) => objectId),
  ];
  return [...new Set(ids.filter((id) => BigInt(id) < 1n << 64n))];
}

function disabled(
  deployment: BlastDeployment | null,
  reasons: DeploymentRejection[],
  fingerprint: string | null = null,
): ProtocolAccess {
  return Object.freeze({
    signing: "disabled",
    deployment,
    fingerprint,
    reasons: Object.freeze(reasons),
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
