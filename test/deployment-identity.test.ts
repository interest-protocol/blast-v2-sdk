import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  DeploymentRuntimeObservation,
  SdkRelease,
  VenueAvailability,
} from "@interest-protocol/blast-deployments-sdk";
import {
  BLAST_DEPLOYMENTS,
  defineBlastDeployment,
  deploymentFingerprint,
  evaluateProtocolAccess,
  FROZEN_ABI,
  observeDeploymentRuntime,
  SDK_RELEASE,
  sharedObjectEntries,
} from "@interest-protocol/blast-deployments-sdk";
import type { BlastDeploymentInput } from "@interest-protocol/blast-deployments-sdk/types";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeSuiObjectId } from "@mysten/sui/utils";
import { NON_PRODUCTION_MANIFEST } from "./fixtures/non-production-deployment.ts";
import { manifestWithVenues, runtimeFor } from "./fixtures/venue-deployment.ts";

const manifest = NON_PRODUCTION_MANIFEST;
const deployment = defineBlastDeployment(manifest);
const pkg = (name: keyof typeof manifest.packages) =>
  manifest.packages[name].originalPackageId;

/** The manifest with the complete Cetus set and its route (contracts 442116a snapshot). */
const CETUS_MANIFEST = manifestWithVenues(["cetus"]);

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
          launchpad: {
            ...manifest.sharedObjects.launchpad,
            launchConfig: {
              ...manifest.sharedObjects.launchpad.launchConfig,
              initialSharedVersion: "4",
            },
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

test("names every recorded shared object by its owner-qualified path", () => {
  assert.deepEqual(
    sharedObjectEntries(deployment.sharedObjects).map(([path]) => path),
    [
      "admin.acl",
      "launchpad.packageVersion",
      "launchpad.launchConfig",
      "launchpad.runtimeConfig",
      "migrators.packageVersion",
      "migrators.lpFeePolicy",
      "migrators.venueConfig",
      "presale.packageVersion",
      "presale.venueConfig",
      "presale.creationPolicy",
      "presale.feePolicy",
    ],
  );
  // The observation an SDK consumer builds uses exactly those keys.
  assert.deepEqual(Object.keys(runtimeFor(manifest)).sort(), [
    "chainIdentifier",
    "sharedObjects",
  ]);
  assert.deepEqual(
    Object.keys(runtimeFor(manifest).sharedObjects).sort(),
    sharedObjectEntries(deployment.sharedObjects)
      .map(([path]) => path)
      .sort(),
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
  moved.sharedObjects["launchpad.launchConfig"]!.initialSharedVersion = "99";
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
  foreign.sharedObjects["launchpad.launchConfig"]!.type =
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
  delete missing.sharedObjects["admin.acl"];
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

test("checks a recorded Cetus config against the recorded Cetus lineage, for Cetus only", () => {
  const runtime = runtimeFor(CETUS_MANIFEST);
  const access = evaluateProtocolAccess({
    manifest: CETUS_MANIFEST,
    mode: "non-production",
    runtime,
  });
  assert.equal(access.signing, "enabled");
  assert.deepEqual(access.venues.cetus, { available: true });
  const foreign = structuredClone(runtime);
  foreign.sharedObjects["cetus.config"]!.type =
    `${normalizeSuiObjectId("0xbad")}::config::GlobalConfig`;
  const mismatched = evaluateProtocolAccess({
    manifest: CETUS_MANIFEST,
    mode: "non-production",
    runtime: foreign,
  });
  assert.equal(mismatched.signing, "enabled");
  assert.deepEqual(
    !mismatched.venues.cetus.available &&
      mismatched.venues.cetus.reasons.map(({ code }) => code),
    ["foreign-lineage"],
  );
});

test("rejects a half-recorded Cetus lineage as an invalid manifest", () => {
  const { cetusClmm, ...packages } = CETUS_MANIFEST.packages;
  const { cetus, ...sharedObjects } = CETUS_MANIFEST.sharedObjects;
  assert.ok(cetusClmm && cetus);
  const withoutConfig = { ...CETUS_MANIFEST, sharedObjects };
  const withoutPackage = { ...CETUS_MANIFEST, packages };
  assert.throws(() => defineBlastDeployment(withoutConfig), {
    name: "DeploymentManifestError",
    code: "invalid-manifest",
    message: /sharedObjects\.cetus\.config is required/,
  });
  assert.throws(() => defineBlastDeployment(withoutPackage), {
    name: "DeploymentManifestError",
    code: "invalid-manifest",
    message: /packages\.cetusClmm is required/,
  });
  for (const half of [withoutConfig, withoutPackage]) {
    assert.deepEqual(
      codes(
        evaluateProtocolAccess({
          manifest: half,
          mode: "non-production",
          runtime: runtimeFor(CETUS_MANIFEST),
        }),
      ),
      ["invalid-manifest"],
    );
  }
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
  const withRoute = (venue: string) => ({
    ...manifest,
    routes: [{ venue, tiers: [{ tickSpacing: 60, feeRate: "2500" }] }],
  });
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest: withRoute("turbos"),
        mode: "non-production",
        runtime,
      }),
    ),
    ["unsupported-route"],
  );
  // The SDK's generic Cetus builders match the frozen ADR 0100 routes.
  assert.equal(
    evaluateProtocolAccess({
      manifest: withRoute("cetus"),
      mode: "non-production",
      runtime,
    }).signing,
    "enabled",
  );
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

/** Genesis checkpoint digests, as contracts 442116a records them. */
const MAINNET_CHAIN = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
/** Sui testnet's genesis digest: a chain the SDK must never accept. */
const FOREIGN_CHAIN = "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD";

test("refuses every network but mainnet, whatever chain it names", () => {
  for (const network of ["testnet", "devnet", "localnet"]) {
    for (const chainIdentifier of [MAINNET_CHAIN, FOREIGN_CHAIN]) {
      const other = { ...manifest, network, chainIdentifier };
      assert.deepEqual(
        codes(
          evaluateProtocolAccess({
            manifest: other,
            mode: "non-production",
            runtime: runtimeFor(other),
          }),
        ),
        ["invalid-manifest"],
        `${network} ${chainIdentifier}`,
      );
    }
  }
});

test("binds the chain identifier to Sui mainnet's genesis digest", () => {
  const invalid = (chainIdentifier: string) =>
    assert.throws(
      () => defineBlastDeployment({ ...manifest, chainIdentifier }),
      { name: "DeploymentManifestError", code: "invalid-manifest" },
      chainIdentifier,
    );
  invalid(FOREIGN_CHAIN);
  // Only the genesis digest the Core API reports; not JSON-RPC's short form.
  invalid("35834a8a");
  invalid("4c78adac");
  invalid("");
  assert.throws(
    () =>
      defineBlastDeployment({
        ...productionManifest(),
        chainIdentifier: FOREIGN_CHAIN,
      }),
    { code: "invalid-manifest" },
  );
  // A non-production manifest names mainnet too; `environment` keeps it out.
  assert.equal(deployment.network, "mainnet");
  assert.equal(deployment.chainIdentifier, MAINNET_CHAIN);
});

test("rejects the review probe: a foreign network label on mainnet's chain", () => {
  // R-001 B-001: observed on a mainnet node, with and without a foreign lineage.
  const probe = {
    ...manifest,
    network: "testnet",
    chainIdentifier: MAINNET_CHAIN,
  };
  const foreign = {
    ...probe,
    packages: {
      ...probe.packages,
      launchpad: {
        packageId: `0x${"ee".repeat(32)}`,
        originalPackageId: `0x${"ee".repeat(32)}`,
      },
    },
  };
  for (const candidate of [probe, foreign]) {
    assert.deepEqual(
      codes(
        evaluateProtocolAccess({
          manifest: candidate,
          mode: "non-production",
          runtime: runtimeFor(candidate),
        }),
      ),
      ["invalid-manifest"],
    );
  }
});

test("reports a malformed runtime observation instead of throwing", () => {
  const runtime = runtimeFor(manifest);
  const malformed = [
    { chainIdentifier: runtime.chainIdentifier },
    {
      ...runtime,
      sharedObjects: {
        ...runtime.sharedObjects,
        "admin.acl": { type: runtime.sharedObjects["admin.acl"]?.type },
      },
    },
  ] as unknown as DeploymentRuntimeObservation[];
  for (const observation of malformed) {
    assert.deepEqual(
      codes(
        evaluateProtocolAccess({
          manifest,
          mode: "non-production",
          runtime: observation,
        }),
      ),
      ["runtime-unverified"],
    );
  }
});

test("flags the SDK's own non-production fixture identities in production", () => {
  // Every other production check passes, so only the fixture IDs remain.
  const relabeled = {
    ...manifest,
    environment: "production",
    network: "mainnet",
    chainIdentifier: MAINNET_CHAIN,
    sdk: { ...manifest.sdk, version: "1.0.0" },
  };
  const access = evaluateProtocolAccess({
    manifest: relabeled,
    mode: "production",
    runtime: runtimeFor(relabeled),
    registry: { mainnet: defineBlastDeployment(relabeled) },
    sdk: {
      name: SDK_RELEASE.name,
      version: "1.0.0",
      published: true,
      commit: relabeled.sdk.commit,
    },
  });
  assert.deepEqual(codes(access), ["fixture-identity-in-production"]);
  const message =
    access.signing === "disabled" ? access.reasons[0]?.message : "";
  for (const id of [
    ...Object.values(manifest.packages).map(({ packageId }) => packageId),
    ...Object.values(manifest.sharedObjects).flatMap((group) =>
      Object.values(group).map(({ objectId }) => objectId),
    ),
  ]) {
    assert.ok(message?.includes(id), id);
  }
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
  assert.ok(nonProduction.includes("foreign-lineage"));
  assert.equal(nonProduction.includes("sdk-unreleased"), false);

  const relabeled = {
    ...manifest,
    environment: "production",
    network: "mainnet",
    chainIdentifier: MAINNET_CHAIN,
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

test("the published MVR SDK still requires a released deployment and matching runtime", () => {
  assert.ok(BLAST_DEPLOYMENTS.mainnet);
  assert.equal(SDK_RELEASE.name, "@interest-protocol/blast-sdk");
  assert.equal(SDK_RELEASE.version, "0.1.4");
  assert.equal(SDK_RELEASE.published, true);
  assert.ok(SDK_RELEASE.commit);
  assert.match(SDK_RELEASE.commit, /^[0-9a-f]{40}$/);
  const packageJson = JSON.parse(
    readFileSync(
      new URL("../packages/blast-sdk/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(SDK_RELEASE.name, packageJson.name);
  assert.equal(SDK_RELEASE.version, packageJson.version);
  assert.equal(packageJson.version, "0.1.4");

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
  // Publication alone cannot sign for an unregistered deployment or another SDK identity.
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest: production,
        mode: "production",
        runtime,
      }),
    ),
    ["foreign-lineage", "sdk-mismatch"],
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
    "9255e78751b70b22d8f33cc6577df126a3434424",
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
    "production-presale-v1.json",
    "production-admin-v1.json",
    "production-partners-v1.json",
  ]) {
    assert.equal(
      JSON.parse(artifact(name).toString("utf8")).baseline.contractsCommit,
      FROZEN_ABI.contractsCommit,
    );
  }
  for (const name of [
    "production-blast-sui-v1.json",
    "production-aftermath-dao-presale-v1.json",
    "production-boosts-v1.json",
  ]) {
    assert.equal(
      JSON.parse(artifact(name).toString("utf8")).baseline.contractsCommit,
      "01d7659617abcd552cece6d05b9db409ec4ff2c0",
    );
  }
  assert.equal("unresolvedRoutes" in FROZEN_ABI, false);
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
      admin: { acl: object("acl") },
      launchpad: {
        packageVersion: object("packageVersion"),
        launchConfig: object("launchConfig"),
        runtimeConfig: object("runtimeConfig"),
      },
      migrators: {
        packageVersion: object("migratorsPackageVersion"),
        lpFeePolicy: object("lpFeePolicy"),
        venueConfig: object("venueConfig"),
      },
    },
    sdk: {
      version: "1.0.0",
      commit: "1111111111111111111111111111111111111111",
    },
  } as const satisfies BlastDeploymentInput;
}

test("the registered canonical mainnet stack signs against a matching runtime", () => {
  const released = BLAST_DEPLOYMENTS.mainnet;
  assert.ok(released);
  const access = evaluateProtocolAccess({
    manifest: released,
    mode: "production",
    runtime: runtimeFor(released as unknown as BlastDeploymentInput),
  });
  assert.equal(access.signing, "enabled");
  for (const venue of ["cetus", "bluefin"] as const) {
    const availability: VenueAvailability = access.venues[venue];
    assert.deepEqual(availability, { available: true });
  }
  assert.notEqual(
    codes(
      evaluateProtocolAccess({
        manifest: released,
        mode: "production",
        runtime: {
          ...runtimeFor(released as unknown as BlastDeploymentInput),
          chainIdentifier: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD",
        },
      }),
    ).length,
    0,
  );
});
