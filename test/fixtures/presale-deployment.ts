import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import type { PresaleDeployment } from "@interest-protocol/blast-presale-sdk/transactions";

const shared = (objectId: string): SharedObjectIdentity => ({
  objectId,
  initialSharedVersion: "3",
});
const admin = { packageId: "0xad", acl: shared("0xac1") };
const core = {
  packageId: "0xc1",
  originalPackageId: "0xc0",
  treasury: shared("0x7ea"),
};
const vault = {
  packageId: "0xb1",
  originalPackageId: "0xb0",
  registry: shared("0xb2"),
  packageVersion: shared("0xb3"),
  packageAdmin: shared("0xb4"),
  core,
  admin,
};

/** A non-production presale deployment with distinct IDs for every object. */
export const PRESALE_DEPLOYMENT: PresaleDeployment = {
  packageId: "0x5f",
  originalPackageId: "0x5e",
  packageVersion: shared("0x64"),
  packageAdmin: shared("0x65"),
  creationPolicy: shared("0x62"),
  feePolicy: shared("0x61"),
  presaleRegistry: shared("0x63"),
  core,
  admin,
  partners: { packageId: "0xa7", admin },
  vault,
  migrators: {
    packageId: "0xd1",
    originalPackageId: "0xd0",
    packageVersion: shared("0xd3"),
    packageAdmin: shared("0xd4"),
    venueConfig: shared("0xd5"),
    vault,
  },
  vestingPackageId: "0xf4",
  aftermathDaoPresale: {
    packageId: "0x7a",
    originalPackageId: "0x7a",
    aftermath: {
      poolRegistry: shared("0xaf1"),
      daoFeeVersion: shared("0xaf2"),
    },
  },
};
