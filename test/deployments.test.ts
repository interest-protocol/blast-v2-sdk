import assert from "node:assert/strict";
import test from "node:test";

import {
  BLAST_DEPLOYMENTS,
  defineBlastDeployment,
  getBlastDeployment,
  launchpadDeployment,
} from "../src/deployments/index.ts";

const deployment = defineBlastDeployment({
  network: "testnet",
  chainIdentifier: " 4c78adac ",
  packages: {
    launchpad: {
      packageId: "0x123",
      originalPackageId: "0x122",
    },
    linearVesting: {
      packageId: "0x223",
      originalPackageId: "0x222",
    },
  },
  sharedObjects: {
    packageVersion: { objectId: "0x2", initialSharedVersion: "10" },
    launchConfig: { objectId: "0x3", initialSharedVersion: "11" },
    runtimeConfig: { objectId: "0x4", initialSharedVersion: "12" },
    protocolAuthority: { objectId: "0x5", initialSharedVersion: "13" },
    packageAdmin: { objectId: "0x6", initialSharedVersion: "14" },
  },
});

test("normalizes and freezes one complete deployment manifest", () => {
  assert.equal(deployment.chainIdentifier, "4c78adac");
  assert.equal(deployment.packages.launchpad.packageId.endsWith("0123"), true);
  assert.equal(
    deployment.sharedObjects.packageAdmin?.initialSharedVersion,
    "14",
  );
  assert.equal(Object.isFrozen(deployment), true);
  assert.equal(Object.isFrozen(deployment.packages), true);
  assert.equal(Object.isFrozen(deployment.packages.launchpad), true);
  assert.equal(Object.isFrozen(deployment.sharedObjects.packageVersion), true);
});

test("derives call-specific launchpad shared references", () => {
  assert.deepEqual(launchpadDeployment(deployment), {
    packageId:
      "0x0000000000000000000000000000000000000000000000000000000000000123",
    originalPackageId:
      "0x0000000000000000000000000000000000000000000000000000000000000122",
    packageVersion: {
      objectId:
        "0x0000000000000000000000000000000000000000000000000000000000000002",
      initialSharedVersion: "10",
      mutable: false,
    },
    launchConfig: {
      objectId:
        "0x0000000000000000000000000000000000000000000000000000000000000003",
      initialSharedVersion: "11",
      mutable: false,
    },
    runtimeConfig: {
      objectId:
        "0x0000000000000000000000000000000000000000000000000000000000000004",
      initialSharedVersion: "12",
      mutable: false,
    },
    protocolAuthority: {
      objectId:
        "0x0000000000000000000000000000000000000000000000000000000000000005",
      initialSharedVersion: "13",
      mutable: false,
    },
  });
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
        ...deployment,
        packages: {
          ...deployment.packages,
          launchpad: {
            packageId: "0x0",
            originalPackageId: "0x122",
          },
        },
      }),
    /packages\.launchpad\.packageId must not be the zero address/,
  );
});
