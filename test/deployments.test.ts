import assert from "node:assert/strict";
import test from "node:test";

import {
  BLAST_DEPLOYMENTS,
  blastSuiDeployment,
  defineBlastDeployment,
  getBlastDeployment,
  launchpadDeployment,
  migratorsDeployment,
} from "../src/deployments/index.ts";

const deployment = defineBlastDeployment({
  network: "testnet",
  chainIdentifier: " 4c78adac ",
  packages: {
    launchpad: {
      packageId: "0x123",
      originalPackageId: "0x122",
    },
    admin: {
      packageId: "0x111",
      originalPackageId: "0x111",
    },
    partners: {
      packageId: "0x112",
      originalPackageId: "0x112",
    },
    timelock: {
      packageId: "0x113",
      originalPackageId: "0x113",
    },
    blastSui: {
      packageId: "0x423",
      originalPackageId: "0x422",
    },
    migrators: {
      packageId: "0x323",
      originalPackageId: "0x322",
    },
  },
  sharedObjects: {
    packageVersion: { objectId: "0x2", initialSharedVersion: "10" },
    launchConfig: { objectId: "0x3", initialSharedVersion: "11" },
    runtimeConfig: { objectId: "0x4", initialSharedVersion: "12" },
    lpFeePolicy: { objectId: "0x40", initialSharedVersion: "18" },
    acl: { objectId: "0x5", initialSharedVersion: "13" },
    blastSuiPackageVersion: { objectId: "0x8", initialSharedVersion: "16" },
    blastSuiVault: { objectId: "0x9", initialSharedVersion: "17" },
    packageAdmin: { objectId: "0x6", initialSharedVersion: "14" },
    migratorsPackageVersion: { objectId: "0xa", initialSharedVersion: "19" },
    venueConfig: { objectId: "0x7", initialSharedVersion: "15" },
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
    partnersPackageId:
      "0x0000000000000000000000000000000000000000000000000000000000000112",
    timelockPackageId:
      "0x0000000000000000000000000000000000000000000000000000000000000113",
    packageVersion: {
      objectId:
        "0x0000000000000000000000000000000000000000000000000000000000000002",
      initialSharedVersion: "10",
    },
    launchConfig: {
      objectId:
        "0x0000000000000000000000000000000000000000000000000000000000000003",
      initialSharedVersion: "11",
    },
    runtimeConfig: {
      objectId:
        "0x0000000000000000000000000000000000000000000000000000000000000004",
      initialSharedVersion: "12",
    },
    admin: {
      packageId:
        "0x0000000000000000000000000000000000000000000000000000000000000111",
      acl: {
        objectId:
          "0x0000000000000000000000000000000000000000000000000000000000000005",
        initialSharedVersion: "13",
      },
    },
  });
});

test("derives current-package blast Sui call references", () => {
  assert.deepEqual(blastSuiDeployment(deployment), {
    packageId:
      "0x0000000000000000000000000000000000000000000000000000000000000423",
    originalPackageId:
      "0x0000000000000000000000000000000000000000000000000000000000000422",
    packageVersion: {
      objectId:
        "0x0000000000000000000000000000000000000000000000000000000000000008",
      initialSharedVersion: "16",
    },
    vault: {
      objectId:
        "0x0000000000000000000000000000000000000000000000000000000000000009",
      initialSharedVersion: "17",
    },
    admin: {
      packageId:
        "0x0000000000000000000000000000000000000000000000000000000000000111",
      acl: {
        objectId:
          "0x0000000000000000000000000000000000000000000000000000000000000005",
        initialSharedVersion: "13",
      },
    },
  });
});

test("requires the packages every generated Meme links", () => {
  for (const name of ["admin", "partners", "timelock"] as const) {
    const { [name]: _removed, ...without } = deployment.packages;
    assert.throws(
      () =>
        defineBlastDeployment({
          ...deployment,
          packages: without as typeof deployment.packages,
        }),
      new RegExp(`packages\\.${name} is required`),
    );
  }
});

test("requires blast Sui deployment constants only when requested", () => {
  const {
    blastSuiPackageVersion: _blastSuiPackageVersion,
    ...withoutBlastSuiPackageVersion
  } = deployment.sharedObjects;
  const { blastSuiVault: _blastSuiVault, ...withoutBlastSuiVault } =
    deployment.sharedObjects;
  assert.doesNotThrow(() =>
    defineBlastDeployment({
      ...deployment,
      packages: {
        launchpad: deployment.packages.launchpad,
        admin: deployment.packages.admin,
        partners: deployment.packages.partners,
        timelock: deployment.packages.timelock,
      },
      sharedObjects: {
        packageVersion: deployment.sharedObjects.packageVersion,
        launchConfig: deployment.sharedObjects.launchConfig,
        runtimeConfig: deployment.sharedObjects.runtimeConfig,
        acl: deployment.sharedObjects.acl,
      },
    }),
  );
  assert.throws(
    () =>
      blastSuiDeployment({
        ...deployment,
        packages: {
          launchpad: deployment.packages.launchpad,
          admin: deployment.packages.admin,
          partners: deployment.packages.partners,
          timelock: deployment.packages.timelock,
        },
      }),
    /packages\.blastSui is required/,
  );
  assert.throws(
    () =>
      blastSuiDeployment({
        ...deployment,
        sharedObjects: {
          ...withoutBlastSuiPackageVersion,
        },
      }),
    /sharedObjects\.blastSuiPackageVersion is required/,
  );
  assert.throws(
    () =>
      blastSuiDeployment({
        ...deployment,
        sharedObjects: {
          ...withoutBlastSuiVault,
        },
      }),
    /sharedObjects\.blastSuiVault is required/,
  );
});

test("derives migrator package and shared-object references", () => {
  assert.deepEqual(migratorsDeployment(deployment), {
    packageId:
      "0x0000000000000000000000000000000000000000000000000000000000000323",
    originalPackageId:
      "0x0000000000000000000000000000000000000000000000000000000000000322",
    launchpad: launchpadDeployment(deployment),
    migratorsVersion: {
      objectId:
        "0x000000000000000000000000000000000000000000000000000000000000000a",
      initialSharedVersion: "19",
    },
    lpFeePolicy: {
      objectId:
        "0x0000000000000000000000000000000000000000000000000000000000000040",
      initialSharedVersion: "18",
    },
    venueConfig: {
      objectId:
        "0x0000000000000000000000000000000000000000000000000000000000000007",
      initialSharedVersion: "15",
    },
  });
});

test("requires migrator deployment constants only when requested", () => {
  const { lpFeePolicy, migratorsPackageVersion, venueConfig } =
    deployment.sharedObjects;
  assert.ok(lpFeePolicy && migratorsPackageVersion && venueConfig);
  const launchpadObjects = {
    packageVersion: deployment.sharedObjects.packageVersion,
    launchConfig: deployment.sharedObjects.launchConfig,
    runtimeConfig: deployment.sharedObjects.runtimeConfig,
    acl: deployment.sharedObjects.acl,
  };
  assert.throws(
    () =>
      migratorsDeployment({
        ...deployment,
        packages: {
          launchpad: deployment.packages.launchpad,
          admin: deployment.packages.admin,
          partners: deployment.packages.partners,
          timelock: deployment.packages.timelock,
        },
      }),
    /packages\.migrators is required/,
  );
  assert.throws(
    () =>
      migratorsDeployment({
        ...deployment,
        sharedObjects: { ...launchpadObjects, lpFeePolicy, venueConfig },
      }),
    /sharedObjects\.migratorsPackageVersion is required/,
  );
  assert.throws(
    () =>
      migratorsDeployment({
        ...deployment,
        sharedObjects: {
          ...launchpadObjects,
          migratorsPackageVersion,
          venueConfig,
        },
      }),
    /sharedObjects\.lpFeePolicy is required/,
  );
  assert.throws(
    () =>
      migratorsDeployment({
        ...deployment,
        sharedObjects: {
          ...launchpadObjects,
          lpFeePolicy,
          migratorsPackageVersion,
        },
      }),
    /sharedObjects\.venueConfig is required/,
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
