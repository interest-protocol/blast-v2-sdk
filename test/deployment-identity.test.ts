import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeSuiObjectId } from "@mysten/sui/utils";

import type {
  DeploymentRuntimeObservation,
  SdkRelease,
} from "../src/deployments/index.ts";
import {
  BLAST_DEPLOYMENTS,
  defineBlastDeployment,
  deploymentFingerprint,
  evaluateProtocolAccess,
  FROZEN_ABI,
  observeDeploymentRuntime,
  SDK_RELEASE,
} from "../src/deployments/index.ts";
import type { BlastDeploymentInput } from "../src/deployments/types.ts";
import { NON_PRODUCTION_MANIFEST } from "./fixtures/non-production-deployment.ts";

const manifest = NON_PRODUCTION_MANIFEST;
const deployment = defineBlastDeployment(manifest);
const pkg = (name: keyof typeof manifest.packages) =>
  manifest.packages[name].originalPackageId;

/** What a node returns for the fixture's shared objects and chain. */
function runtimeFor(input: BlastDeploymentInput): DeploymentRuntimeObservation {
  const original = (name: string) => {
    const reference = input.packages[name];
    assert.ok(reference, name);
    return reference.originalPackageId;
  };
  const launchpad = original("launchpad");
  const migrators = original("migrators");
  const types: Record<string, string> = {
    packageVersion: `${launchpad}::package_version::PackageVersion`,
    launchConfig: `${launchpad}::launch_config::LaunchConfig`,
    runtimeConfig: `${launchpad}::runtime_config::RuntimeConfig`,
    acl: `${original("admin")}::blast_acl::ACL`,
    migratorsPackageVersion: `${migrators}::package_version::PackageVersion`,
    lpFeePolicy: `${migrators}::lp_fee_policy::LpFeePolicy`,
    venueConfig: `${migrators}::venue_config::VenueConfig`,
  };
  return {
    chainIdentifier: input.chainIdentifier,
    sharedObjects: Object.fromEntries(
      Object.entries(input.sharedObjects).map(([name, identity]) => [
        name,
        {
          objectId: identity.objectId,
          type: types[name] ?? "0x2::object::UID",
          initialSharedVersion: String(identity.initialSharedVersion),
        },
      ]),
    ),
  };
}

const codes = (access: ReturnType<typeof evaluateProtocolAccess>) =>
  access.signing === "disabled" ? access.reasons.map(({ code }) => code) : [];

test("normalizes, freezes, and fingerprints the non-production manifest", () => {
  assert.equal(deployment.environment, "non-production");
  assert.equal(
    deployment.packages.launchpad.packageId,
    normalizeSuiObjectId(pkg("launchpad")),
  );
  assert.deepEqual(deployment.routes, [
    {
      venue: "bluefin",
      tiers: [
        { tickSpacing: 60, feeRate: "3000" },
        { tickSpacing: 200, feeRate: "10000" },
      ],
    },
  ]);
  assert.equal(Object.isFrozen(deployment), true);
  assert.equal(Object.isFrozen(deployment.routes[0]?.tiers), true);

  const fingerprint = deploymentFingerprint(deployment);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    deploymentFingerprint(defineBlastDeployment(manifest)),
    fingerprint,
  );
  // Evidence and explorer describe a release; they are not its identity.
  assert.equal(
    deploymentFingerprint(
      defineBlastDeployment({
        ...manifest,
        evidence: [],
        explorer: { baseUrl: "http://localhost:9002" },
      }),
    ),
    fingerprint,
  );
  assert.notEqual(
    deploymentFingerprint(
      defineBlastDeployment({
        ...manifest,
        sharedObjects: {
          ...manifest.sharedObjects,
          launchConfig: {
            ...manifest.sharedObjects.launchConfig,
            initialSharedVersion: "4",
          },
        },
      }),
    ),
    fingerprint,
  );
});

test("enables signing only for a runtime-verified non-production manifest", () => {
  const access = evaluateProtocolAccess({
    manifest,
    mode: "non-production",
    runtime: runtimeFor(manifest),
  });
  assert.equal(access.signing, "enabled");
  assert.equal(access.fingerprint, deploymentFingerprint(deployment));

  assert.deepEqual(
    codes(evaluateProtocolAccess({ manifest, mode: "non-production" })),
    ["runtime-unverified"],
  );
});

test("disables signing on a runtime identity mismatch or foreign lineage", () => {
  const runtime = runtimeFor(manifest);
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest,
        mode: "non-production",
        runtime: { ...runtime, chainIdentifier: "other-chain" },
      }),
    ),
    ["runtime-mismatch"],
  );
  const moved = structuredClone(runtime);
  moved.sharedObjects.launchConfig!.initialSharedVersion = "99";
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest,
        mode: "non-production",
        runtime: moved,
      }),
    ),
    ["runtime-mismatch"],
  );
  const foreign = structuredClone(runtime);
  foreign.sharedObjects.launchConfig!.type =
    `${normalizeSuiObjectId("0xbad")}::launch_config::LaunchConfig`;
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest,
        mode: "non-production",
        runtime: foreign,
      }),
    ),
    ["foreign-lineage"],
  );
  const missing = structuredClone(runtime);
  delete missing.sharedObjects.acl;
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest,
        mode: "non-production",
        runtime: missing,
      }),
    ),
    ["runtime-unverified"],
  );
});

test("disables signing on an ABI mismatch or an unsupported route", () => {
  const runtime = runtimeFor(manifest);
  const otherCommit = {
    ...manifest,
    source: {
      ...manifest.source,
      contractsCommit: "9e8d871842139dbccee90c0bb9ecc8ca2a8a590d",
    },
  };
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest: otherCommit,
        mode: "non-production",
        runtime,
      }),
    ),
    ["abi-mismatch"],
  );
  const otherAbi = {
    ...manifest,
    source: {
      ...manifest.source,
      abi: { ...manifest.source.abi, launchpad: "0".repeat(64) },
    },
  };
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest: otherAbi,
        mode: "non-production",
        runtime,
      }),
    ),
    ["abi-mismatch"],
  );
  for (const venue of ["turbos", "cetus"]) {
    const route = {
      ...manifest,
      routes: [{ venue, tiers: [{ tickSpacing: 60, feeRate: "2500" }] }],
    };
    assert.deepEqual(
      codes(
        evaluateProtocolAccess({
          manifest: route,
          mode: "non-production",
          runtime,
        }),
      ),
      ["unsupported-route"],
      venue,
    );
  }
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest: {
          ...manifest,
          packages: {
            ...manifest.packages,
            launchpad: { packageId: "nope", originalPackageId: "nope" },
          },
        },
        mode: "non-production",
        runtime,
      }),
    ),
    ["invalid-manifest"],
  );
});

test("never lets a non-production or fixture identity sign in production", () => {
  const nonProduction = codes(
    evaluateProtocolAccess({
      manifest,
      mode: "production",
      runtime: runtimeFor(manifest),
    }),
  );
  assert.ok(nonProduction.includes("environment-mismatch"));
  assert.ok(nonProduction.includes("unreleased-deployment"));
  assert.ok(nonProduction.includes("sdk-unreleased"));

  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest: { ...manifest, network: "mainnet" },
        mode: "non-production",
        runtime: runtimeFor(manifest),
      }),
    ),
    ["invalid-manifest"],
  );

  const relabeled = {
    ...manifest,
    environment: "production",
    network: "mainnet",
    packages: {
      ...manifest.packages,
      launchpad: { packageId: "0x123", originalPackageId: "0x123" },
    },
  } as const;
  assert.ok(
    codes(
      evaluateProtocolAccess({
        manifest: relabeled,
        mode: "production",
        runtime: runtimeFor(relabeled),
      }),
    ).includes("fixture-identity-in-production"),
  );
});

test("fails closed while the production registry or SDK release identity is absent", () => {
  assert.deepEqual(BLAST_DEPLOYMENTS, {});
  assert.deepEqual(SDK_RELEASE, {
    name: "@interest-protocol/blast-sdk",
    version: "0.0.0",
    published: false,
    commit: null,
  });
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(SDK_RELEASE.name, packageJson.name);
  assert.equal(SDK_RELEASE.version, packageJson.version);
  assert.equal(SDK_RELEASE.published, packageJson.private !== true);

  const production = productionManifest();
  const runtime = runtimeFor(production);
  const registry = { mainnet: defineBlastDeployment(production) };
  const released: SdkRelease = {
    name: SDK_RELEASE.name,
    version: "1.0.0",
    published: true,
    commit: production.sdk.commit,
  };
  assert.equal(
    evaluateProtocolAccess({
      manifest: production,
      mode: "production",
      runtime,
      registry,
      sdk: released,
    }).signing,
    "enabled",
  );
  // The shipped registry is empty and the shipped SDK is private and unversioned.
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest: production,
        mode: "production",
        runtime,
      }),
    ),
    ["unreleased-deployment", "sdk-unreleased", "sdk-mismatch"],
  );
  for (const sdk of [
    { ...released, published: false },
    { ...released, version: "0.0.0" },
    { ...released, commit: null },
  ]) {
    assert.ok(
      codes(
        evaluateProtocolAccess({
          manifest: production,
          mode: "production",
          runtime,
          registry,
          sdk,
        }),
      ).includes("sdk-unreleased"),
    );
  }
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest: { ...production, evidence: [] },
        mode: "production",
        runtime,
        registry: {
          mainnet: defineBlastDeployment({ ...production, evidence: [] }),
        },
        sdk: released,
      }),
    ),
    ["missing-evidence"],
  );
  const foreign = {
    ...production,
    packages: {
      ...production.packages,
      launchpad: {
        packageId: `0x${"ab".repeat(32)}`,
        originalPackageId: `0x${"ab".repeat(32)}`,
      },
    },
  };
  assert.ok(
    codes(
      evaluateProtocolAccess({
        manifest: foreign,
        mode: "production",
        runtime: runtimeFor(foreign),
        registry,
        sdk: released,
      }),
    ).includes("foreign-lineage"),
  );
});

test("pins the frozen ABI identity to the committed artifacts", () => {
  const artifact = (name: string) =>
    readFileSync(new URL(`../abi/${name}`, import.meta.url));
  const sha = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    FROZEN_ABI.contractsCommit,
    "a2a1db25f72a44e3b650bebe0ef806de4c70abbc",
  );
  assert.equal(
    FROZEN_ABI.artifacts.launchpad,
    sha(artifact("production-launchpad-v1.json")),
  );
  assert.equal(
    FROZEN_ABI.artifacts.blastSui,
    sha(artifact("production-blast-sui-v1.json")),
  );
  for (const name of [
    "production-launchpad-v1.json",
    "production-blast-sui-v1.json",
  ]) {
    assert.equal(
      JSON.parse(artifact(name).toString("utf8")).baseline.contractsCommit,
      FROZEN_ABI.contractsCommit,
    );
  }
  assert.deepEqual(FROZEN_ABI.unresolvedRoutes, ["cetus"]);
});

test("observes the chain and shared-object identities through the Core API", async () => {
  const expected = runtimeFor(manifest);
  const client = {
    core: {
      getChainIdentifier: async () => ({
        chainIdentifier: manifest.chainIdentifier,
      }),
      getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
        objects: objectIds.map((objectId) => {
          const entry = Object.values(expected.sharedObjects).find(
            (object) => normalizeSuiObjectId(object.objectId) === objectId,
          );
          assert.ok(entry);
          return {
            objectId,
            type: entry.type,
            owner: {
              $kind: "Shared",
              Shared: { initialSharedVersion: entry.initialSharedVersion },
            },
          };
        }),
      }),
    },
  } as unknown as ClientWithCoreApi;

  const observed = await observeDeploymentRuntime(client, deployment);
  assert.equal(
    evaluateProtocolAccess({
      manifest,
      mode: "non-production",
      runtime: observed,
    }).signing,
    "enabled",
  );
});

function productionManifest() {
  const id = (seed: string) =>
    `0x${createHash("sha256").update(`blast-sdk-production-test-${seed}`).digest("hex")}`;
  const reference = (seed: string) => ({
    packageId: id(seed),
    originalPackageId: id(seed),
  });
  const object = (seed: string) => ({
    objectId: id(seed),
    initialSharedVersion: "100",
  });
  return {
    ...manifest,
    environment: "production",
    network: "mainnet",
    chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
    explorer: { baseUrl: "https://suiscan.xyz/mainnet" },
    packages: {
      launchpad: reference("launchpad"),
      admin: reference("admin"),
      partners: reference("partners"),
      timelock: reference("timelock"),
      migrators: reference("migrators"),
    },
    sharedObjects: {
      packageVersion: object("packageVersion"),
      launchConfig: object("launchConfig"),
      runtimeConfig: object("runtimeConfig"),
      acl: object("acl"),
      migratorsPackageVersion: object("migratorsPackageVersion"),
      lpFeePolicy: object("lpFeePolicy"),
      venueConfig: object("venueConfig"),
    },
    sdk: {
      version: "1.0.0",
      commit: "1111111111111111111111111111111111111111",
    },
  } as const satisfies BlastDeploymentInput;
}
