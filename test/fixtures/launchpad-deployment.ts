import type { LaunchpadDeployment } from "@interest-protocol/blast-launchpad-sdk/transactions";

const shared = (objectId: string, initialSharedVersion: string) => ({
  objectId,
  initialSharedVersion,
});

const admin = { packageId: "0xad", acl: shared("0x5", "13") };
const core = {
  packageId: "0xc0",
  originalPackageId: "0xc0",
  treasury: shared("0x7ea5", "14"),
};
const vault = {
  packageId: "0xfa",
  originalPackageId: "0xfa",
  registry: shared("0xfa1", "15"),
  packageVersion: shared("0xfa2", "16"),
  packageAdmin: shared("0xfa3", "17"),
  core,
  admin,
};

/** A non-production launchpad deployment with distinct IDs for every object. */
export const LAUNCHPAD_DEPLOYMENT: LaunchpadDeployment = {
  packageId: "0x123",
  originalPackageId: "0x123",
  packageVersion: shared("0x2", "10"),
  packageAdmin: shared("0x8", "18"),
  launchConfig: shared("0x3", "11"),
  runtimeConfig: shared("0x4", "12"),
  launchRegistry: shared("0x7", "19"),
  core,
  admin,
  partners: { packageId: "0xae", admin },
  vault,
  migrators: {
    packageId: "0xb0",
    originalPackageId: "0xb0",
    packageVersion: shared("0xb01", "20"),
    packageAdmin: shared("0xb02", "21"),
    venueConfig: shared("0xb03", "22"),
    vault,
  },
  vestingPackageId: "0xf4",
};
