/**
 * Sui mainnet packages. Both are immutable, so these IDs are also their original IDs and
 * never change. See `deployments/sui/mainnet/2026-09-24-otc-and-vesting.json`.
 */
export const mainnet = {
  otc: {
    packageId:
      "0x40e0c95f73af329e7a6a8eafee9d152a1f3090736d35052842288232f7eb5968",
  },
  vesting: {
    packageId:
      "0x85fdb7e3d28162b99e0df758069a3d23cff874c400b2160fc0d4618aefd3ec5c",
  },
} as const;
