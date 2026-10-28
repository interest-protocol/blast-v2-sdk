import type { AdminDeployment } from "@interest-protocol/blast-admin-sdk/transactions";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { LaunchpadDeployment } from "@interest-protocol/blast-launchpad-sdk/transactions";
import type { MigratorsDeployment } from "@interest-protocol/blast-migrators-sdk/transactions";
import type { PartnersDeployment } from "@interest-protocol/blast-partners-sdk/transactions";
import type { PresaleDeployment } from "@interest-protocol/blast-presale-sdk/transactions";
import type { ClientWithCoreApi } from "@mysten/sui/client";

/** Canonical publication source; package custody was verified on mainnet on 2026-10-28. */
export const CANONICAL_MAINNET_SOURCE =
  "52effbcee5f12b727484ba0bb14f96aa5e2b4786";

/** Native package versions reviewed for this SDK; an unversioned name can advance before activation. */
export const CANONICAL_MAINNET_MVR_NAMES = Object.freeze({
  admin: "@blastpackages/admin/1",
  partners: "@blastpackages/partners/1",
  launchpad: "@blastpackages/launchpad/1",
  migrators: "@blastpackages/migrators/1",
  presale: "@blastpackages/presale/1",
});

/** Published code identities. These bindings do not enable production signing or venue routes. */
export const CANONICAL_MAINNET_PACKAGES = Object.freeze({
  admin: Object.freeze(
    normalizeSuiPackageReference("admin", {
      packageId:
        "0x4a27d816998b2ff015cf897a249c069c34859a09e789e56ad3a38992cf00d7ac",
      originalPackageId:
        "0x4a27d816998b2ff015cf897a249c069c34859a09e789e56ad3a38992cf00d7ac",
    }),
  ),
  partners: Object.freeze(
    normalizeSuiPackageReference("partners", {
      packageId:
        "0x163a96aa9b88afe77e51febc195a9e0fa8534a6122bc09c6bd46d176c91a99f9",
      originalPackageId:
        "0x163a96aa9b88afe77e51febc195a9e0fa8534a6122bc09c6bd46d176c91a99f9",
    }),
  ),
  launchpad: Object.freeze(
    normalizeSuiPackageReference("launchpad", {
      packageId:
        "0x079a1b44c551613cbc63cc0406f8ff8d717407378dd6f17d43d9e1b3fd63a573",
      originalPackageId:
        "0x079a1b44c551613cbc63cc0406f8ff8d717407378dd6f17d43d9e1b3fd63a573",
    }),
  ),
  migrators: Object.freeze(
    normalizeSuiPackageReference("migrators", {
      packageId:
        "0x4a5d11d8443e965d62abb3ff032e9b020d10aeaf4dfbc3bc59775b44a8af1f53",
      originalPackageId:
        "0x4a5d11d8443e965d62abb3ff032e9b020d10aeaf4dfbc3bc59775b44a8af1f53",
    }),
  ),
  presale: Object.freeze(
    normalizeSuiPackageReference("presale", {
      packageId:
        "0xb0279fbe54bfd1d920e985a4dba0916b2b73a5218514edeecb7b9dd30cf2863b",
      originalPackageId:
        "0xb0279fbe54bfd1d920e985a4dba0916b2b73a5218514edeecb7b9dd30cf2863b",
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
          "0xbda4af615d93435145012eaaeb540bad2fe09ec0cbe6cb99fb0dae7637643a1d",
        initialSharedVersion: "1",
      }),
    ),
  }),
  launchpad: Object.freeze({
    packageVersion: Object.freeze(
      normalizeSharedObjectIdentity("launchpad.packageVersion", {
        objectId:
          "0xe63adb5817a9a74a883062ac3790d21a6433dfbd35a9403d18261de3a8836f93",
        initialSharedVersion: "2",
      }),
    ),
    runtimeConfig: Object.freeze(
      normalizeSharedObjectIdentity("launchpad.runtimeConfig", {
        objectId:
          "0x6d0c08363ebc1e2a77f16fed290dd0cd5f52791285744d758a3b0942073b6785",
        initialSharedVersion: "1",
      }),
    ),
    launchConfig: Object.freeze(
      normalizeSharedObjectIdentity("launchpad.launchConfig", {
        objectId:
          "0xb1c860103a7c89c7def5ec92bc0585f26bf927ac6b3df48c985e1154e4765391",
        initialSharedVersion: "1",
      }),
    ),
  }),
  migrators: Object.freeze({
    packageVersion: Object.freeze(
      normalizeSharedObjectIdentity("migrators.packageVersion", {
        objectId:
          "0x63c5f99c1ddcdf390585a9926861ac558274fa6434d2b581aa67d13fe8a95706",
        initialSharedVersion: "1",
      }),
    ),
    lpFeePolicy: Object.freeze(
      normalizeSharedObjectIdentity("migrators.lpFeePolicy", {
        objectId:
          "0x6f4791d8f80c2192c66df947057560c5088040d872f16828c4f9d0a780d161b1",
        initialSharedVersion: "1",
      }),
    ),
    venueConfig: Object.freeze(
      normalizeSharedObjectIdentity("migrators.venueConfig", {
        objectId:
          "0xa9e38d9b9630bddbe47589f9d7815a3863d1e854270d122ab7108fa96c5489f8",
        initialSharedVersion: "1",
      }),
    ),
  }),
  presale: Object.freeze({
    packageVersion: Object.freeze(
      normalizeSharedObjectIdentity("presale.packageVersion", {
        objectId:
          "0xbf285882f2c2e0eec1afd3dc869e6d25fad70bccd30059ec1a7b7ceb95c3b42f",
        initialSharedVersion: "2",
      }),
    ),
    feePolicy: Object.freeze(
      normalizeSharedObjectIdentity("presale.feePolicy", {
        objectId:
          "0x7eee3154e7235f172a3f19c0c7fc3c0721008f22a4cbcd61dc8a4ab0614ef9e0",
        initialSharedVersion: "1",
      }),
    ),
    creationPolicy: Object.freeze(
      normalizeSharedObjectIdentity("presale.creationPolicy", {
        objectId:
          "0xac28eb90fea57e13a8c4807f37746811c046508cf46e390fd2ec07a6d7925b31",
        initialSharedVersion: "1",
      }),
    ),
    venueConfig: Object.freeze(
      normalizeSharedObjectIdentity("presale.venueConfig", {
        objectId:
          "0xaa4c53cfc143a4548f8ce0b9f6c9e6e2a30be000d496efc53d8763b1bf577eef",
        initialSharedVersion: "1",
      }),
    ),
  }),
});

const mainnet = createMainnetDeployments(CANONICAL_MAINNET_PACKAGES);

export const MAINNET_ADMIN_DEPLOYMENT = mainnet.admin;
export const MAINNET_PARTNERS_DEPLOYMENT = mainnet.partners;
export const MAINNET_LAUNCHPAD_DEPLOYMENT = mainnet.launchpad;
export const MAINNET_MIGRATORS_DEPLOYMENT = mainnet.migrators;
export const MAINNET_PRESALE_DEPLOYMENT = mainnet.presale;

/**
 * Resolves the reviewed release through the client's cached MVR API. Shared
 * objects and original type identities remain bound to the verified release.
 * Resolution errors or another package identity fail without a static fallback.
 */
export async function resolveMainnetDeployments(client: ClientWithCoreApi) {
  if (client.network !== "mainnet") {
    throw new RangeError("canonical Blast deployments require Sui mainnet");
  }
  const resolved = await client.core.mvr.resolve({
    packages: Object.values(CANONICAL_MAINNET_MVR_NAMES),
  });
  const packages = { ...CANONICAL_MAINNET_PACKAGES };
  const names = Object.keys(
    CANONICAL_MAINNET_MVR_NAMES,
  ) as (keyof typeof CANONICAL_MAINNET_MVR_NAMES)[];
  for (const name of names) {
    const mvrName = CANONICAL_MAINNET_MVR_NAMES[name];
    const packageId = resolved.packages[mvrName]?.package;
    if (!packageId) {
      throw new Error(`MVR did not resolve ${mvrName}`);
    }
    const reference = normalizeSuiPackageReference(name, {
      packageId,
      originalPackageId: CANONICAL_MAINNET_PACKAGES[name].originalPackageId,
    });
    if (reference.packageId !== CANONICAL_MAINNET_PACKAGES[name].packageId) {
      throw new Error(
        `MVR ${mvrName} does not match the reviewed Blast release`,
      );
    }
    packages[name] = Object.freeze(reference);
  }
  return createMainnetDeployments(packages);
}

function createMainnetDeployments(packages: typeof CANONICAL_MAINNET_PACKAGES) {
  const admin: AdminDeployment = Object.freeze({
    packageId: packages.admin.packageId,
    ...CANONICAL_MAINNET_SHARED_OBJECTS.admin,
  });
  const partners: PartnersDeployment = Object.freeze({
    packageId: packages.partners.packageId,
    admin,
  });
  const launchpad: LaunchpadDeployment = Object.freeze({
    ...packages.launchpad,
    ...CANONICAL_MAINNET_SHARED_OBJECTS.launchpad,
    admin,
    partnersPackageId: packages.partners.packageId,
    timelockPackageId: packages.timelock.packageId,
  });
  const migrators: MigratorsDeployment = Object.freeze({
    ...packages.migrators,
    launchpad,
    migratorsVersion: CANONICAL_MAINNET_SHARED_OBJECTS.migrators.packageVersion,
    lpFeePolicy: CANONICAL_MAINNET_SHARED_OBJECTS.migrators.lpFeePolicy,
    venueConfig: CANONICAL_MAINNET_SHARED_OBJECTS.migrators.venueConfig,
  });
  const presale: PresaleDeployment = Object.freeze({
    ...packages.presale,
    ...CANONICAL_MAINNET_SHARED_OBJECTS.presale,
    admin,
  });
  return Object.freeze({ admin, partners, launchpad, migrators, presale });
}
