import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSuiObjectId } from "@mysten/sui/utils";

import { AdminCalls } from "../src/admin/transactions.ts";
import { BlastSuiCalls } from "../src/blast-sui/transactions.ts";
import type { BlastDeployment } from "../src/deployments/index.ts";
import {
  adminDeployment,
  BLAST_DEPLOYMENTS,
  blastSuiDeployment,
  defineBlastDeployment,
  getBlastDeployment,
  launchpadDeployment,
  migratorsDeployment,
  partnersDeployment,
  presaleDeployment,
} from "../src/deployments/index.ts";
import { LaunchpadCalls } from "../src/launchpad/transactions.ts";
import { MigratorCalls } from "../src/migrators/transactions.ts";
import { PartnersCalls } from "../src/partners/transactions.ts";
import { PresaleCalls } from "../src/presale/transactions.ts";

const id = (value: string) => normalizeSuiObjectId(value);
const pkg = (packageId: string, originalPackageId = packageId) => ({
  packageId,
  originalPackageId,
});
const object = (objectId: string, initialSharedVersion: string) => ({
  objectId,
  initialSharedVersion,
});
const input: BlastDeployment = {
  network: "testnet",
  chainIdentifier: " 4c78adac ",
  packages: {
    timelock: pkg("0x113"),
    admin: pkg("0x111"),
    partners: pkg("0x112"),
    launchpad: pkg("0x123", "0x122"),
    migrators: pkg("0x323", "0x322"),
    presale: pkg("0x523", "0x522"),
    blastSui: pkg("0x423", "0x422"),
  },
  sharedObjects: {
    admin: { acl: object("0x5", "13") },
    launchpad: {
      packageVersion: object("0x2", "10"),
      launchConfig: object("0x3", "11"),
      runtimeConfig: object("0x4", "12"),
    },
    migrators: {
      packageVersion: object("0xa", "19"),
      lpFeePolicy: object("0x40", "18"),
      venueConfig: object("0x7", "15"),
    },
    presale: {
      venueConfig: object("0x57", "21"),
      feePolicy: object("0x58", "21"),
    },
    blastSui: {
      packageVersion: object("0x8", "16"),
      vault: object("0x9", "17"),
    },
  },
};
const deployment = defineBlastDeployment(input);

test("normalizes and freezes one complete deployment manifest", () => {
  assert.equal(deployment.chainIdentifier, "4c78adac");
  assert.equal(deployment.packages.launchpad.packageId, id("0x123"));
  assert.equal(
    deployment.sharedObjects.presale.venueConfig.objectId,
    id("0x57"),
  );
  assert.equal(Object.isFrozen(deployment), true);
  assert.equal(Object.isFrozen(deployment.packages.launchpad), true);
  assert.equal(Object.isFrozen(deployment.sharedObjects.migrators), true);
  assert.equal(Object.isFrozen(deployment.sharedObjects.blastSui.vault), true);
});

test("derives every package's call-ready deployment", () => {
  const admin = {
    packageId: id("0x111"),
    acl: { objectId: id("0x5"), initialSharedVersion: "13" },
  };
  assert.deepEqual(adminDeployment(deployment), admin);
  assert.deepEqual(partnersDeployment(deployment), {
    packageId: id("0x112"),
    admin,
  });
  const launchpad = {
    packageId: id("0x123"),
    originalPackageId: id("0x122"),
    admin,
    partnersPackageId: id("0x112"),
    timelockPackageId: id("0x113"),
    packageVersion: { objectId: id("0x2"), initialSharedVersion: "10" },
    launchConfig: { objectId: id("0x3"), initialSharedVersion: "11" },
    runtimeConfig: { objectId: id("0x4"), initialSharedVersion: "12" },
  };
  assert.deepEqual(launchpadDeployment(deployment), launchpad);
  assert.deepEqual(migratorsDeployment(deployment), {
    packageId: id("0x323"),
    originalPackageId: id("0x322"),
    launchpad,
    migratorsVersion: { objectId: id("0xa"), initialSharedVersion: "19" },
    lpFeePolicy: { objectId: id("0x40"), initialSharedVersion: "18" },
    venueConfig: { objectId: id("0x7"), initialSharedVersion: "15" },
  });
  assert.deepEqual(presaleDeployment(deployment), {
    packageId: id("0x523"),
    originalPackageId: id("0x522"),
    venueConfig: { objectId: id("0x57"), initialSharedVersion: "21" },
    feePolicy: { objectId: id("0x58"), initialSharedVersion: "21" },
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

test("requires every package and shared object", () => {
  for (const name of Object.keys(input.packages)) {
    const { [name as "admin"]: _removed, ...packages } = input.packages;
    assert.throws(
      () =>
        defineBlastDeployment({
          ...input,
          packages: packages as BlastDeployment["packages"],
        }),
      new RegExp(`packages\\.${name} is required`),
    );
  }
  const { venueConfig: _removed, ...migrators } = input.sharedObjects.migrators;
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        sharedObjects: {
          ...input.sharedObjects,
          migrators: migrators as BlastDeployment["sharedObjects"]["migrators"],
        },
      }),
    /sharedObjects\.migrators\.venueConfig is required/,
  );
});

test("does not invent constants before a canonical release", () => {
  assert.deepEqual(BLAST_DEPLOYMENTS, {});
  assert.throws(
    () => getBlastDeployment("testnet"),
    /Blast V2 is not deployed on Sui testnet/,
  );
});

test("rejects placeholder package IDs", () => {
  assert.throws(
    () =>
      defineBlastDeployment({
        ...input,
        packages: { ...input.packages, launchpad: pkg("0x0", "0x122") },
      }),
    /packages\.launchpad\.packageId must not be the zero address/,
  );
});
