import assert from "node:assert/strict";
import test from "node:test";
import { AdminCalls } from "@interest-protocol/blast-admin-sdk/transactions";
import type { BlastDeploymentInput } from "@interest-protocol/blast-deployments-sdk";
import {
  ARTIFACT_KEYS,
  adminDeployment,
  BLAST_DEPLOYMENT_SCHEMA_VERSION,
  BLAST_DEPLOYMENTS,
  blastSuiDeployment,
  coreDeployment,
  DeploymentManifestError,
  defineBlastDeployment,
  FROZEN_ABI,
  getBlastDeployment,
  launchpadDeployment,
  migratorsDeployment,
  partnersDeployment,
  presaleDeployment,
  vaultDeployment,
} from "@interest-protocol/blast-deployments-sdk";
import { MigratorCalls } from "@interest-protocol/blast-migrators-sdk/transactions";
import { PartnersCalls } from "@interest-protocol/blast-partners-sdk/transactions";
import { BlastSuiCalls } from "@interest-protocol/blast-sui-sdk/transactions";
import { VaultCalls } from "@interest-protocol/blast-vault-sdk/transactions";
import { normalizeSuiObjectId } from "@mysten/sui/utils";
import { NON_PRODUCTION_MANIFEST } from "./fixtures/non-production-deployment.ts";
import { manifestWithVenues } from "./fixtures/venue-deployment.ts";

const id = (value: string) => normalizeSuiObjectId(value);
const object = (objectId: string, initialSharedVersion: string) => ({
  objectId,
  initialSharedVersion,
});
const blastSuiPackage = {
  packageId: "0x423",
  originalPackageId: "0x422",
};
const blastSuiObjects = {
  packageVersion: object("0x8", "16"),
  vault: object("0x9", "17"),
};

/** The non-production manifest with blast Sui, so every accessor has a group. */
const input = {
  ...NON_PRODUCTION_MANIFEST,
  chainIdentifier: " 4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S ",
  packages: {
    ...NON_PRODUCTION_MANIFEST.packages,
    blastSui: blastSuiPackage,
  },
  sharedObjects: {
    ...NON_PRODUCTION_MANIFEST.sharedObjects,
    blastSui: blastSuiObjects,
  },
} satisfies BlastDeploymentInput;
const deployment = defineBlastDeployment(input);
const { packages, sharedObjects } = deployment;

test("normalizes, trims and freezes one complete schema-2 manifest", () => {
  assert.equal(BLAST_DEPLOYMENT_SCHEMA_VERSION, 2);
  assert.equal(
    deployment.chainIdentifier,
    "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  );
  assert.equal(deployment.network, "mainnet");
  assert.equal(deployment.environment, "non-production");
  assert.equal(sharedObjects.blastSui?.vault.objectId, id("0x9"));
  assert.deepEqual(deployment.source.abi, FROZEN_ABI.artifacts);
  for (const value of [
    deployment,
    packages,
    packages.vault,
    sharedObjects,
    sharedObjects.core,
    sharedObjects.vault,
    sharedObjects.launchpad.launchRegistry,
    sharedObjects.presale.presaleRegistry,
    sharedObjects.migrators.packageAdmin,
    deployment.source.abi,
  ])
    assert.equal(Object.isFrozen(value), true);
});

test("refuses a schema-1 manifest", () => {
  assert.throws(
    () => defineBlastDeployment({ ...input, schemaVersion: 1 }),
    /unsupported schemaVersion 1/,
  );
});

test("derives every package's call-ready deployment", () => {
  const admin = {
    packageId: packages.admin.packageId,
    acl: sharedObjects.admin.acl,
  };
  const core = { ...packages.core, treasury: sharedObjects.core.treasury };
  const vault = { ...packages.vault, ...sharedObjects.vault, core, admin };
  const migrators = {
    ...packages.migrators,
    ...sharedObjects.migrators,
    vault,
  };
  const partners = { packageId: packages.partners.packageId, admin };
  assert.deepEqual(adminDeployment(deployment), admin);
  assert.deepEqual(partnersDeployment(deployment), partners);
  assert.deepEqual(coreDeployment(deployment), core);
  assert.deepEqual(vaultDeployment(deployment), vault);
  assert.deepEqual(migratorsDeployment(deployment), migrators);
  const stack = { core, admin, partners, vault, migrators };
  assert.deepEqual(launchpadDeployment(deployment), {
    ...packages.launchpad,
    ...sharedObjects.launchpad,
    ...stack,
    vestingPackageId: packages.vesting.packageId,
  });
  assert.deepEqual(presaleDeployment(deployment), {
    ...packages.presale,
    ...sharedObjects.presale,
    ...stack,
  });
  assert.deepEqual(blastSuiDeployment(deployment), {
    packageId: id("0x423"),
    originalPackageId: id("0x422"),
    packageVersion: { objectId: id("0x8"), initialSharedVersion: "16" },
    vault: { objectId: id("0x9"), initialSharedVersion: "17" },
    admin,
  });
  // Each package's calls accept its derived deployment as is.
  new AdminCalls(adminDeployment(deployment));
  new PartnersCalls(partnersDeployment(deployment));
  new VaultCalls(vaultDeployment(deployment));
  new MigratorCalls(migratorsDeployment(deployment));
  new BlastSuiCalls(blastSuiDeployment(deployment));
});

test("the presale carries the vendor venue exactly when its set is recorded", () => {
  const vendor = defineBlastDeployment(manifestWithVenues(["aftermathDao"]));
  assert.deepEqual(presaleDeployment(vendor).aftermathDaoPresale, {
    ...vendor.packages.aftermathDaoPresale,
    aftermath: vendor.sharedObjects.aftermath,
  });
  assert.equal("aftermathDaoPresale" in presaleDeployment(deployment), false);
});

test("requires the launch stack's eight packages", () => {
  for (const name of [
    "admin",
    "partners",
    "core",
    "vesting",
    "vault",
    "launchpad",
    "presale",
    "migrators",
  ] as const) {
    const { [name]: _removed, ...rest } = input.packages;
    assert.throws(
      () =>
        defineBlastDeployment({
          ...input,
          packages: rest as BlastDeploymentInput["packages"],
        }),
      new RegExp(`packages\\.${name} is required`),
    );
  }
});

test("requires every launch-stack group and every object it owns", () => {
  for (const group of [
    "admin",
    "core",
    "vault",
    "launchpad",
    "presale",
    "migrators",
  ] as const) {
    const { [group]: _removed, ...rest } = input.sharedObjects;
    assert.throws(
      () =>
        defineBlastDeployment({
          ...input,
          sharedObjects: rest as BlastDeploymentInput["sharedObjects"],
        }),
      new RegExp(`sharedObjects\\.${group} is required`),
    );
  }
  for (const [group, name] of [
    ["core", "treasury"],
    ["vault", "registry"],
    ["vault", "packageAdmin"],
    ["launchpad", "launchRegistry"],
    ["presale", "presaleRegistry"],
    ["migrators", "packageAdmin"],
  ] as const) {
    const objects: Record<string, unknown> = {
      ...input.sharedObjects[group],
    };
    delete objects[name];
    assert.throws(
      () =>
        defineBlastDeployment({
          ...input,
          sharedObjects: {
            ...input.sharedObjects,
            [group]: objects,
          } as BlastDeploymentInput["sharedObjects"],
        }),
      new RegExp(`sharedObjects\\.${group}\\.${name} is required`),
    );
  }
});

test("pairs each optional group with the package that owns it", () => {
  const { blastSui: _dropped, ...withoutBlastSuiPackage } = input.packages;
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        packages: withoutBlastSuiPackage as BlastDeploymentInput["packages"],
      }),
    /sharedObjects records no package for blastSui/,
  );
  const bare = defineBlastDeployment(NON_PRODUCTION_MANIFEST);
  assert.throws(
    () => blastSuiDeployment(bare),
    /packages\.blastSui is required/,
  );
});

test("records every frozen ABI artifact digest and each publication", () => {
  for (const key of ARTIFACT_KEYS) {
    const abi: Record<string, string> = { ...input.source.abi };
    delete abi[key];
    assert.throws(
      () =>
        defineBlastDeployment({ ...input, source: { ...input.source, abi } }),
      new RegExp(`source\\.abi\\.${key} is malformed`),
    );
  }
  for (const step of ["core", "vault", "migrators"]) {
    const transactions: Record<string, string> = {
      ...input.release.transactions,
    };
    delete transactions[step];
    assert.throws(
      () => defineBlastDeployment({ ...input, release: { transactions } }),
      new RegExp(`release\\.transactions\\.${step} is required`),
    );
  }
});

test("the vendor route has no tiers; a migrators route needs one", () => {
  const vendor = defineBlastDeployment(manifestWithVenues(["aftermathDao"]));
  assert.deepEqual(
    vendor.routes.find(({ venue }) => venue === "aftermathDao"),
    { venue: "aftermathDao", tiers: [] },
  );
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        routes: [
          {
            venue: "aftermathDao",
            tiers: [{ tickSpacing: 60, feeRate: "3000" }],
          },
        ],
      }),
    /aftermathDao route has no tiers/,
  );
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        routes: [{ venue: "cetus", tiers: [] }],
      }),
    /route cetus needs at least one tier/,
  );
});

test("accepts only mainnet, bound to its genesis digest", () => {
  for (const network of ["testnet", "devnet", "localnet"]) {
    assert.throws(
      () => defineBlastDeployment({ ...input, network }),
      /unsupported Blast network/,
    );
  }
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        chainIdentifier: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD",
      }),
    /is not Sui mainnet/,
  );
});

test("no deployment is registered until the fresh stack is published", () => {
  assert.deepEqual(BLAST_DEPLOYMENTS, {});
  assert.throws(
    () => getBlastDeployment("mainnet"),
    (error: unknown) =>
      error instanceof DeploymentManifestError && error.code === "unpublished",
  );
});

test("rejects placeholder package IDs", () => {
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        packages: {
          ...input.packages,
          launchpad: { packageId: "0x0", originalPackageId: "0x122" },
        },
      }),
    /packages\.launchpad\.packageId must not be the zero address/,
  );
});
