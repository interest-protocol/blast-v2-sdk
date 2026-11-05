import type { MigratorsDeployment } from "@interest-protocol/blast-migrators-sdk/transactions";

/**
 * A non-production migrators deployment for builder and reader tests: every
 * ID is a placeholder whose last bytes name the object, so argument
 * descriptors (`shared:0x…`) say which object a call borrows.
 */
export const MIGRATORS: MigratorsDeployment = {
  packageId: "0x3001",
  originalPackageId: "0x3000",
  packageVersion: { objectId: "0x3010", initialSharedVersion: "11" },
  packageAdmin: { objectId: "0x3011", initialSharedVersion: "11" },
  venueConfig: { objectId: "0x3020", initialSharedVersion: "12" },
  vault: {
    packageId: "0x2001",
    originalPackageId: "0x2000",
    registry: { objectId: "0x2020", initialSharedVersion: "7" },
    packageVersion: { objectId: "0x2010", initialSharedVersion: "7" },
    packageAdmin: { objectId: "0x2011", initialSharedVersion: "7" },
    core: {
      packageId: "0x1001",
      originalPackageId: "0x1000",
      treasury: { objectId: "0x1030", initialSharedVersion: "5" },
    },
    admin: {
      packageId: "0xad",
      acl: { objectId: "0xac1", initialSharedVersion: "3" },
    },
  },
};

/** Cetus and Bluefin shared objects and a vault's own objects, by role. */
export const VENUE_OBJECTS = {
  cetusConfig: { objectId: "0xc0f", initialSharedVersion: "21" },
  cetusPools: { objectId: "0xc00", initialSharedVersion: "21" },
  burnManager: { objectId: "0xb0", initialSharedVersion: "22" },
  bluefinConfig: { objectId: "0xbf", initialSharedVersion: "23" },
  vault: { objectId: "0x7a", initialSharedVersion: "30" },
  pool: { objectId: "0x9001", initialSharedVersion: "30" },
  currency: { objectId: "0xcc", initialSharedVersion: "31" },
  quoteCurrency: { objectId: "0xcd", initialSharedVersion: "32" },
} as const;

/** `0xa::meme::MEME` sorts after SUI, so Cetus makes it coin A. */
export const MEME_A = "0xa::meme::MEME";
/** `0x1::meme::MEME` sorts before SUI, so Cetus makes it coin B. */
export const MEME_B = "0x1::meme::MEME";
export const SUI = "0x2::sui::SUI";
