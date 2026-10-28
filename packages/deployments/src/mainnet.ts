import type { AdminDeployment } from "@interest-protocol/blast-admin-sdk/transactions";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { LaunchpadDeployment } from "@interest-protocol/blast-launchpad-sdk/transactions";
import type { MigratorsDeployment } from "@interest-protocol/blast-migrators-sdk/transactions";
import type { PartnersDeployment } from "@interest-protocol/blast-partners-sdk/transactions";
import type { PresaleDeployment } from "@interest-protocol/blast-presale-sdk/transactions";

/** Canonical publication source; package custody was verified on mainnet on 2026-10-28. */
export const CANONICAL_MAINNET_SOURCE =
  "9255e78751b70b22d8f33cc6577df126a3434424";

/** Published code identities. These bindings do not enable production signing or venue routes. */
export const CANONICAL_MAINNET_PACKAGES = Object.freeze({
  admin: Object.freeze(
    normalizeSuiPackageReference("admin", {
      packageId:
        "0x2136ba8efa373b04d237c4eb5154d240f526e65f27a06164e88e9513d28f50df",
      originalPackageId:
        "0x2136ba8efa373b04d237c4eb5154d240f526e65f27a06164e88e9513d28f50df",
    }),
  ),
  partners: Object.freeze(
    normalizeSuiPackageReference("partners", {
      packageId:
        "0x1ac5602bea673a59f693020e57ece4819e1bcb1c421c40494e9b225aeb949a85",
      originalPackageId:
        "0x1ac5602bea673a59f693020e57ece4819e1bcb1c421c40494e9b225aeb949a85",
    }),
  ),
  launchpad: Object.freeze(
    normalizeSuiPackageReference("launchpad", {
      packageId:
        "0x827e04933699da94c23d9ea529f184656738cacdb7962f03be791fd715b76743",
      originalPackageId:
        "0x827e04933699da94c23d9ea529f184656738cacdb7962f03be791fd715b76743",
    }),
  ),
  migrators: Object.freeze(
    normalizeSuiPackageReference("migrators", {
      packageId:
        "0x7e009c69fcaab269617359fc9ea2b3a308e71c82165af30f3b91ffc445800416",
      originalPackageId:
        "0x7e009c69fcaab269617359fc9ea2b3a308e71c82165af30f3b91ffc445800416",
    }),
  ),
  presale: Object.freeze(
    normalizeSuiPackageReference("presale", {
      packageId:
        "0xedb6ddae546132a66f5ae5a1c3561ef07bf892620bd78d90659aba962f7be0af",
      originalPackageId:
        "0xedb6ddae546132a66f5ae5a1c3561ef07bf892620bd78d90659aba962f7be0af",
    }),
  ),
  timelock: Object.freeze(
    normalizeSuiPackageReference("timelock", {
      packageId:
        "0x1749b76a3ae065dedfe847578b07826fa83d1e18ff485d9e4f9647f3698e104d",
      originalPackageId:
        "0x1749b76a3ae065dedfe847578b07826fa83d1e18ff485d9e4f9647f3698e104d",
    }),
  ),
});

/** Shared singletons with their initial sharing versions, including activated PackageVersion objects. */
export const CANONICAL_MAINNET_SHARED_OBJECTS = Object.freeze({
  admin: Object.freeze({
    acl: Object.freeze(
      normalizeSharedObjectIdentity("admin.acl", {
        objectId:
          "0xf326d951bd8d05cead62bffde480e3d7aca4a94837fc0caf522297497b410244",
        initialSharedVersion: "1",
      }),
    ),
  }),
  launchpad: Object.freeze({
    packageVersion: Object.freeze(
      normalizeSharedObjectIdentity("launchpad.packageVersion", {
        objectId:
          "0xf5c3dc0dff4c3b46681a4869613259069709b18e3ca337011eb0de8c90e825ae",
        initialSharedVersion: "2",
      }),
    ),
    runtimeConfig: Object.freeze(
      normalizeSharedObjectIdentity("launchpad.runtimeConfig", {
        objectId:
          "0x93887f806260f9a473ea12c00fcc9fb450ba57e92dbcad959b41c44478535092",
        initialSharedVersion: "1",
      }),
    ),
    launchConfig: Object.freeze(
      normalizeSharedObjectIdentity("launchpad.launchConfig", {
        objectId:
          "0xf562d83d9d71d8e9c7a1487cc4b0ef97401451813b2c01fb36e0f35be0614cca",
        initialSharedVersion: "1",
      }),
    ),
  }),
  migrators: Object.freeze({
    packageVersion: Object.freeze(
      normalizeSharedObjectIdentity("migrators.packageVersion", {
        objectId:
          "0xa2400c287ab0ccc13619d468f9257edd1857550e2bee8a706ed4748f68ecfd4d",
        initialSharedVersion: "1",
      }),
    ),
    lpFeePolicy: Object.freeze(
      normalizeSharedObjectIdentity("migrators.lpFeePolicy", {
        objectId:
          "0x240dc9305b26297b444daf686e649085d3977f003a23b9829ce8d6af263f7646",
        initialSharedVersion: "1",
      }),
    ),
    venueConfig: Object.freeze(
      normalizeSharedObjectIdentity("migrators.venueConfig", {
        objectId:
          "0x6f76ba819d1ef1a273a0b176422a0026a4c714b3cecbab222bb4841432c28e5d",
        initialSharedVersion: "1",
      }),
    ),
  }),
  presale: Object.freeze({
    packageVersion: Object.freeze(
      normalizeSharedObjectIdentity("presale.packageVersion", {
        objectId:
          "0x4b52b856959ad5c7b2cdb9507888f891cdda77b37497dcbf62bba2c779198ce6",
        initialSharedVersion: "2",
      }),
    ),
    feePolicy: Object.freeze(
      normalizeSharedObjectIdentity("presale.feePolicy", {
        objectId:
          "0x1225f690d2b877da3d0b08da6ee8a064439d52f8f1df6e50e7584bc74b7e287d",
        initialSharedVersion: "1",
      }),
    ),
    creationPolicy: Object.freeze(
      normalizeSharedObjectIdentity("presale.creationPolicy", {
        objectId:
          "0x319676c10bd896eaf6ef751def9f4ea8ea5e687fa11c88d8d02a0f7f8ff06d69",
        initialSharedVersion: "1",
      }),
    ),
    venueConfig: Object.freeze(
      normalizeSharedObjectIdentity("presale.venueConfig", {
        objectId:
          "0x788f60f5a19c312e9b3060cb8180d50ca17a6ed033169e33d6fb54525ff39bc9",
        initialSharedVersion: "1",
      }),
    ),
  }),
});

export const MAINNET_ADMIN_DEPLOYMENT: AdminDeployment = Object.freeze({
  packageId: CANONICAL_MAINNET_PACKAGES.admin.packageId,
  ...CANONICAL_MAINNET_SHARED_OBJECTS.admin,
});

export const MAINNET_PARTNERS_DEPLOYMENT: PartnersDeployment = Object.freeze({
  packageId: CANONICAL_MAINNET_PACKAGES.partners.packageId,
  admin: MAINNET_ADMIN_DEPLOYMENT,
});

export const MAINNET_LAUNCHPAD_DEPLOYMENT: LaunchpadDeployment = Object.freeze({
  ...CANONICAL_MAINNET_PACKAGES.launchpad,
  ...CANONICAL_MAINNET_SHARED_OBJECTS.launchpad,
  admin: MAINNET_ADMIN_DEPLOYMENT,
  partnersPackageId: CANONICAL_MAINNET_PACKAGES.partners.packageId,
  timelockPackageId: CANONICAL_MAINNET_PACKAGES.timelock.packageId,
});

export const MAINNET_MIGRATORS_DEPLOYMENT: MigratorsDeployment = Object.freeze({
  ...CANONICAL_MAINNET_PACKAGES.migrators,
  launchpad: MAINNET_LAUNCHPAD_DEPLOYMENT,
  migratorsVersion: CANONICAL_MAINNET_SHARED_OBJECTS.migrators.packageVersion,
  lpFeePolicy: CANONICAL_MAINNET_SHARED_OBJECTS.migrators.lpFeePolicy,
  venueConfig: CANONICAL_MAINNET_SHARED_OBJECTS.migrators.venueConfig,
});

export const MAINNET_PRESALE_DEPLOYMENT: PresaleDeployment = Object.freeze({
  ...CANONICAL_MAINNET_PACKAGES.presale,
  ...CANONICAL_MAINNET_SHARED_OBJECTS.presale,
  admin: MAINNET_ADMIN_DEPLOYMENT,
});
