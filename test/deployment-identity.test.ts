import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { packageVersionBcs } from "@interest-protocol/blast-admin-sdk/state";
import type {
  DeploymentRuntimeObservation,
  SdkRelease,
} from "@interest-protocol/blast-deployments-sdk";
import {
  ARTIFACT_KEYS,
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
      "core.treasury",
      "vault.registry",
      "vault.packageVersion",
      "vault.packageAdmin",
      "launchpad.packageVersion",
      "launchpad.packageAdmin",
      "launchpad.launchConfig",
      "launchpad.runtimeConfig",
      "launchpad.launchRegistry",
      "presale.packageVersion",
      "presale.packageAdmin",
      "presale.creationPolicy",
      "presale.feePolicy",
      "presale.presaleRegistry",
      "migrators.packageVersion",
      "migrators.packageAdmin",
      "migrators.venueConfig",
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

test("types each PackageVersion and PackageAdmin by its package's OTW", () => {
  const runtime = runtimeFor(manifest);
  const admin = normalizeSuiObjectId(pkg("admin"));
  assert.equal(
    runtime.sharedObjects["migrators.packageVersion"]?.type,
    `${admin}::package_version::PackageVersion<${normalizeSuiObjectId(pkg("migrators"))}::blast_migrators::BLAST_MIGRATORS>`,
  );
  // Another package's OTW is a different object, even under the same admin package.
  const swapped = structuredClone(runtime);
  swapped.sharedObjects["vault.packageVersion"]!.type =
    runtime.sharedObjects["launchpad.packageVersion"]!.type;
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest,
        mode: "non-production",
        runtime: swapped,
      }),
    ),
    ["runtime-mismatch"],
  );
  const foreignAdmin = structuredClone(runtime);
  foreignAdmin.sharedObjects["presale.packageAdmin"]!.type =
    `${normalizeSuiObjectId("0xbad")}::package_admin::PackageAdmin<${normalizeSuiObjectId(pkg("presale"))}::blast_presale_package::BLAST_PRESALE_PACKAGE>`;
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest,
        mode: "non-production",
        runtime: foreignAdmin,
      }),
    ),
    ["foreign-lineage"],
  );
});

test("reports each pausable package's observed pause mask", () => {
  const access = evaluateProtocolAccess({
    manifest,
    mode: "non-production",
    runtime: runtimeFor(manifest, { vault: 1, launchpad: 7, presale: 2 }),
  });
  assert.equal(access.signing, "enabled");
  assert.deepEqual(access.signing === "enabled" && access.paused, {
    vault: 1,
    launchpad: 7,
    presale: 2,
    migrators: 0,
  });
  const unobserved = runtimeFor(manifest);
  delete unobserved.sharedObjects["presale.packageVersion"]!.paused;
  assert.deepEqual(
    codes(
      evaluateProtocolAccess({
        manifest,
        mode: "non-production",
        runtime: unobserved,
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
        manifest: {
          ...manifest,
          source: {
            ...manifest.source,
            abi: { ...manifest.source.abi, vault: "1".repeat(64) },
          },
        },
        mode: "non-production",
        runtime,
      }),
    ),
    ["abi-mismatch"],
  );
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
  // Every venue the SDK builds is a supported route.
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
  // A different canonical lineage is registered.
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

test("the fresh ABI requires a coordinated SDK release and matching runtime", () => {
  assert.equal(BLAST_DEPLOYMENTS.mainnet?.environment, "production");
  assert.equal(SDK_RELEASE.name, "@interest-protocol/blast-sdk");
  assert.equal(SDK_RELEASE.version, "0.2.1");
  assert.equal(SDK_RELEASE.published, true);
  assert.match(SDK_RELEASE.commit ?? "", /^[a-f0-9]{40}$/);
  assert.deepEqual(BLAST_DEPLOYMENTS.mainnet?.sdk, {
    version: SDK_RELEASE.version,
    commit: SDK_RELEASE.commit,
  });
  const packageJson = JSON.parse(
    readFileSync(
      new URL("../packages/blast-sdk/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(SDK_RELEASE.name, packageJson.name);
  assert.equal(SDK_RELEASE.version, packageJson.version);
  assert.equal(packageJson.version, "0.2.1");

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

test("pins the frozen ABI to the contracts baseline and every artifact key", () => {
  assert.equal(
    FROZEN_ABI.contractsCommit,
    "86ee8cf9df8e9b2ec920f9564e2fda8afbf82106",
  );
  assert.deepEqual(Object.keys(FROZEN_ABI.artifacts), [...ARTIFACT_KEYS]);
  for (const [key, digest] of Object.entries(FROZEN_ABI.artifacts)) {
    const file = `production-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-v1.json`;
    const artifact = readFileSync(new URL(`../abi/${file}`, import.meta.url));
    assert.equal(
      digest,
      createHash("sha256").update(artifact).digest("hex"),
      `FROZEN_ABI.artifacts.${key} is the sha256 of abi/${file}`,
    );
    // blast-sui and boosts stay frozen at their own earlier baseline.
    if (key !== "blastSui" && key !== "boosts") {
      assert.equal(
        JSON.parse(artifact.toString("utf8")).baseline.contractsCommit,
        FROZEN_ABI.contractsCommit,
        file,
      );
    }
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
            // A `PackageVersion<OTW>` with its pause mask; other objects need no contents.
            content:
              entry.paused === undefined
                ? new Uint8Array()
                : packageVersionBcs
                    .serialize({
                      id: { id: { bytes: objectId } },
                      valid_pause_bits: 7,
                      paused: entry.paused,
                      package_witness: "0x1::m::W",
                      version: 1n,
                    })
                    .toBytes(),
          };
        }),
      }),
    },
  } as unknown as ClientWithCoreApi;

  const observed = await observeDeploymentRuntime(client, deployment);
  assert.deepEqual(observed, expected);
  assert.equal(
    evaluateProtocolAccess({
      manifest,
      mode: "non-production",
      runtime: observed,
    }).signing,
    "enabled",
  );
});

test("canonical mainnet routes pass the SDK gate while pause masks remain in force", () => {
  const mainnet = BLAST_DEPLOYMENTS.mainnet;
  assert.ok(mainnet);
  const access = evaluateProtocolAccess({
    manifest: mainnet,
    mode: "production",
    runtime: runtimeFor(mainnet, { vault: 1, launchpad: 7, presale: 7 }),
  });
  assert.equal(access.signing, "enabled");
  assert.deepEqual(access.paused, {
    vault: 1,
    launchpad: 7,
    presale: 7,
    migrators: 0,
  });
  for (const venue of ["cetus", "bluefin"] as const) {
    assert.equal(access.venues[venue].available, true);
  }
  assert.deepEqual(
    mainnet.routes.find((route) => route.venue === "cetus")?.tiers,
    [{ tickSpacing: 200, feeRate: "10000" }],
  );
  assert.deepEqual(
    mainnet.routes
      .find((route) => route.venue === "bluefin")
      ?.tiers.map(({ tickSpacing, feeRate }) => [tickSpacing, feeRate]),
    [
      [2, "100"],
      [4, "200"],
      [6, "300"],
      [8, "400"],
      [10, "500"],
      [20, "1000"],
      [30, "1500"],
      [40, "2000"],
      [60, "2500"],
      [80, "3000"],
      [100, "4000"],
      [120, "6000"],
      [160, "8000"],
      [200, "10000"],
      [220, "20000"],
    ],
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
    packages: Object.fromEntries(
      Object.keys(manifest.packages).map((name) => [name, reference(name)]),
    ),
    sharedObjects: Object.fromEntries(
      Object.entries(manifest.sharedObjects).map(([group, objects]) => [
        group,
        Object.fromEntries(
          Object.keys(objects).map((name) => [
            name,
            object(`${group}.${name}`),
          ]),
        ),
      ]),
    ),
    sdk: {
      version: "1.0.0",
      commit: "1111111111111111111111111111111111111111",
    },
  } satisfies BlastDeploymentInput;
}
