import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSuiObjectId } from "@mysten/sui/utils";

import { AdminCalls } from "../src/admin/transactions.ts";
import { BlastSuiCalls } from "../src/blast-sui/transactions.ts";
import type { BlastDeploymentInput } from "../src/deployments/index.ts";
import {
  adminDeployment,
  BLAST_DEPLOYMENTS,
  BLAST_PRESALE_DEPLOYMENTS,
  blastSuiDeployment,
  defineBlastDeployment,
  definePresaleDeployment,
  getBlastDeployment,
  getPresaleDeployment,
  launchpadDeployment,
  migratorsDeployment,
  partnersDeployment,
  presaleDeployment,
} from "../src/deployments/index.ts";
import { LaunchpadCalls } from "../src/launchpad/transactions.ts";
import { MigratorCalls } from "../src/migrators/transactions.ts";
import { PartnersCalls } from "../src/partners/transactions.ts";
import { PresaleCalls } from "../src/presale/transactions.ts";
import { NON_PRODUCTION_MANIFEST } from "./fixtures/non-production-deployment.ts";

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

/** The core every manifest records, for the "only when requested" cases. */
const corePackages = {
  launchpad: packages.launchpad,
  admin: packages.admin,
  partners: packages.partners,
  timelock: packages.timelock,
};
const coreObjects = {
  admin: sharedObjects.admin,
  launchpad: sharedObjects.launchpad,
};

test("normalizes, trims and freezes one complete deployment manifest", () => {
  assert.equal(
    deployment.chainIdentifier,
    "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  );
  assert.equal(deployment.network, "mainnet");
  assert.equal(deployment.environment, "non-production");
  assert.equal(
    packages.launchpad.packageId,
    NON_PRODUCTION_MANIFEST.packages.launchpad.packageId,
  );
  assert.equal(sharedObjects.blastSui?.vault.objectId, id("0x9"));
  assert.equal(Object.isFrozen(deployment), true);
  assert.equal(Object.isFrozen(packages), true);
  assert.equal(Object.isFrozen(packages.launchpad), true);
  assert.equal(Object.isFrozen(sharedObjects), true);
  assert.equal(Object.isFrozen(sharedObjects.launchpad), true);
  assert.equal(Object.isFrozen(sharedObjects.launchpad.packageVersion), true);
  assert.equal(Object.isFrozen(sharedObjects.presale), true);
});

test("derives every package's call-ready deployment", () => {
  const admin = {
    packageId: packages.admin.packageId,
    acl: sharedObjects.admin.acl,
  };
  assert.deepEqual(adminDeployment(deployment), admin);
  assert.deepEqual(partnersDeployment(deployment), {
    packageId: packages.partners.packageId,
    admin,
  });
  const launchpad = {
    packageId: packages.launchpad.packageId,
    originalPackageId: packages.launchpad.originalPackageId,
    admin,
    partnersPackageId: packages.partners.packageId,
    timelockPackageId: packages.timelock.packageId,
    packageVersion: sharedObjects.launchpad.packageVersion,
    launchConfig: sharedObjects.launchpad.launchConfig,
    runtimeConfig: sharedObjects.launchpad.runtimeConfig,
  };
  assert.deepEqual(launchpadDeployment(deployment), launchpad);
  assert.deepEqual(migratorsDeployment(deployment), {
    packageId: packages.migrators?.packageId,
    originalPackageId: packages.migrators?.originalPackageId,
    launchpad,
    migratorsVersion: sharedObjects.migrators?.packageVersion,
    lpFeePolicy: sharedObjects.migrators?.lpFeePolicy,
    venueConfig: sharedObjects.migrators?.venueConfig,
  });
  assert.deepEqual(presaleDeployment(deployment), {
    ...packages.presale,
    ...sharedObjects.presale,
    admin,
  });
  assert.deepEqual(blastSuiDeployment(deployment), {
    packageId: id("0x423"),
    originalPackageId: id("0x422"),
    packageVersion: { objectId: id("0x8"), initialSharedVersion: "16" },
    vault: { objectId: id("0x9"), initialSharedVersion: "17" },
    admin,
  });
  // Each product accepts its derived deployment as is.
  new AdminCalls(adminDeployment(deployment));
  new PartnersCalls(partnersDeployment(deployment));
  new LaunchpadCalls(launchpadDeployment(deployment));
  new MigratorCalls(migratorsDeployment(deployment));
  new PresaleCalls(presaleDeployment(deployment));
  new BlastSuiCalls(blastSuiDeployment(deployment));
});

test("requires the core packages every manifest records", () => {
  for (const name of ["launchpad", "admin", "partners", "timelock"] as const) {
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

test("requires every shared object a recorded group owns", () => {
  const { venueConfig: _removed, ...migrators } = input.sharedObjects.migrators;
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        sharedObjects: { ...input.sharedObjects, migrators },
      }),
    /sharedObjects\.migrators\.venueConfig is required/,
  );
  const { feePolicy: _dropped, ...presale } = input.sharedObjects.presale;
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        sharedObjects: { ...input.sharedObjects, presale },
      }),
    /sharedObjects\.presale\.feePolicy is required/,
  );
});

test("pairs each shared-object group with the package that owns it", () => {
  const { migrators: _removed, ...withoutMigrators } = input.sharedObjects;
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        sharedObjects:
          withoutMigrators as BlastDeploymentInput["sharedObjects"],
      }),
    /sharedObjects\.migrators is required/,
  );
  const { blastSui: _dropped, ...withoutBlastSuiPackage } = input.packages;
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        packages: withoutBlastSuiPackage as BlastDeploymentInput["packages"],
      }),
    /sharedObjects records no package for blastSui/,
  );
});

test("derives each optional package's constants only when recorded", () => {
  const core = {
    ...input,
    routes: [],
    packages: corePackages,
    sharedObjects: coreObjects,
  } satisfies BlastDeploymentInput;
  const bare = defineBlastDeployment(core);
  assert.equal(bare.sharedObjects.migrators, undefined);
  assert.throws(
    () => blastSuiDeployment(bare),
    /packages\.blastSui is required/,
  );
  assert.throws(
    () => migratorsDeployment(bare),
    /packages\.migrators is required/,
  );
  assert.throws(() => presaleDeployment(bare), /packages\.presale is required/);
});

test("routes need the migrators package", () => {
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        packages: corePackages,
        sharedObjects: coreObjects,
      }),
    /routes require packages\.migrators/,
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

test("does not invent constants before a canonical release", () => {
  assert.deepEqual(BLAST_DEPLOYMENTS, {});
  assert.throws(
    () => getBlastDeployment("mainnet"),
    /Blast V2 is not deployed on Sui mainnet/,
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

test("registers the 2026-10-11 mainnet presale, administered through the ACL", () => {
  const presale = getPresaleDeployment("mainnet");
  assert.equal(presale, BLAST_PRESALE_DEPLOYMENTS.mainnet);
  assert.equal(
    presale.originalPackageId,
    "0xf9c404c0368cf014b44cac79dc5037da2aa34e16952673433d1c87ae3d2f8ca4",
  );
  assert.equal(
    presale.packageId,
    "0xf9c404c0368cf014b44cac79dc5037da2aa34e16952673433d1c87ae3d2f8ca4",
  );
  assert.equal(
    presale.admin.acl.objectId,
    "0xc9fbcfc4eda38626d7daad17902cc145b4008beb20470135438298aa7a005a6d",
  );
  assert.equal(Object.isFrozen(presale.admin), true);
  new PresaleCalls(presale);
});

test("normalizes a standalone presale manifest and requires every singleton", () => {
  const manifest = presaleDeployment(deployment);
  const presale = definePresaleDeployment(manifest);
  assert.deepEqual(presale, manifest);
  assert.equal(Object.isFrozen(presale), true);
  assert.equal(Object.isFrozen(presale.feePolicy), true);
  assert.equal(Object.isFrozen(presale.admin), true);
  new PresaleCalls(presale);
  for (const name of [
    "venueConfig",
    "creationPolicy",
    "feePolicy",
    "admin",
  ] as const) {
    const { [name]: _removed, ...rest } = manifest;
    assert.throws(
      () => definePresaleDeployment(rest as typeof manifest),
      new RegExp(`presale\\.${name} is required`),
    );
  }
  assert.throws(
    () => definePresaleDeployment({ ...manifest, packageId: "0x0" }),
    /presale\.packageId must not be the zero address/,
  );
});
