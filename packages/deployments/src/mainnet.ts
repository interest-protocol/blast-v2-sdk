import { FROZEN_ABI, SDK_RELEASE } from "./release.ts";
import type { BlastDeploymentInput } from "./types.ts";

/**
 * Canonical November 6 publication, verified from the contracts deployment
 * record and live shared-object owners. sdk.commit pins the same reviewed
 * implementation as the coordinated npm release.
 * Route evidence is documented in docs/mainnet-route-evidence.md.
 * The vault and both products were paused at verification.
 */
export const CANONICAL_MAINNET_MANIFEST: BlastDeploymentInput = {
  schemaVersion: 2,
  environment: "production",
  network: "mainnet",
  chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  explorer: {
    baseUrl: "https://suiscan.xyz/mainnet",
  },
  packages: {
    admin: {
      packageId:
        "0xb4c52669d7a07ce26d8fc91ba577b0a05f1f3d0cb9b1ba230c6419fb7ddd55fd",
      originalPackageId:
        "0xb4c52669d7a07ce26d8fc91ba577b0a05f1f3d0cb9b1ba230c6419fb7ddd55fd",
    },
    partners: {
      packageId:
        "0x2998c10c91e46082548b2f3205f84f09377bbbedf2b0f617f70575a09ec69a54",
      originalPackageId:
        "0x2998c10c91e46082548b2f3205f84f09377bbbedf2b0f617f70575a09ec69a54",
    },
    core: {
      packageId:
        "0xd70a8d11582fd1997380bc59bfd56a2f9028ebe11da74514ea3d386258d932fc",
      originalPackageId:
        "0xd70a8d11582fd1997380bc59bfd56a2f9028ebe11da74514ea3d386258d932fc",
    },
    vault: {
      packageId:
        "0xe99278bb86aa754d9a0496b2842d0fb9ac14a7ddec075d472baa069671efdecd",
      originalPackageId:
        "0xe99278bb86aa754d9a0496b2842d0fb9ac14a7ddec075d472baa069671efdecd",
    },
    launchpad: {
      packageId:
        "0x9c2cef371c0e80648136f7ae65378ac9476e3fdb860538d00290e6e4f975b192",
      originalPackageId:
        "0x9c2cef371c0e80648136f7ae65378ac9476e3fdb860538d00290e6e4f975b192",
    },
    presale: {
      packageId:
        "0x1f44a8e9fab4380228fe9c1bcc27d99b7f6ea76a8e18b5c178ca18cd46fb33c4",
      originalPackageId:
        "0x1f44a8e9fab4380228fe9c1bcc27d99b7f6ea76a8e18b5c178ca18cd46fb33c4",
    },
    migrators: {
      packageId:
        "0xb8146388d5098524e767a8708354e5390d69ebb2840835d4426cd180df898df4",
      originalPackageId:
        "0xb8146388d5098524e767a8708354e5390d69ebb2840835d4426cd180df898df4",
    },
    vesting: {
      packageId:
        "0x85fdb7e3d28162b99e0df758069a3d23cff874c400b2160fc0d4618aefd3ec5c",
      originalPackageId:
        "0x85fdb7e3d28162b99e0df758069a3d23cff874c400b2160fc0d4618aefd3ec5c",
    },
    cetusClmm: {
      packageId:
        "0x260693ec785a6e6c9d81d58c7d2ff72f1288ae0fa6a9725abe05a6478b11f084",
      originalPackageId:
        "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
    },
    cetusLpBurn: {
      packageId:
        "0xc4aabc874f5060d3147d8f74c14e3a8a1f9f8d92edea138a51635395ed167cd9",
      originalPackageId:
        "0x12d73de9a6bc3cb658ec9dc0fe7de2662be1cea5c76c092fcc3606048cdbac27",
    },
    bluefinSpot: {
      packageId:
        "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c",
      originalPackageId:
        "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267",
    },
  },
  sharedObjects: {
    admin: {
      acl: {
        objectId:
          "0xec294e9b3ce0a0ffb123ab1a90dfedd2a368f20744e95c368726283c81e62f52",
        initialSharedVersion: "1",
      },
    },
    core: {
      treasury: {
        objectId:
          "0x11f54f5cabdf5f1add9b05d54229dee53a16f698e08016aae8a6068b9f281b7e",
        initialSharedVersion: "1",
      },
    },
    vault: {
      registry: {
        objectId:
          "0x5e97870db07ea12e1c9c5bafdf0a578c0e7df7867f5800eeeaa6cce87f770c73",
        initialSharedVersion: "1",
      },
      packageVersion: {
        objectId:
          "0xb9856c7ab88ea4940201c6b429eb7fc42f67d62142286472e378527ee4890b16",
        initialSharedVersion: "2",
      },
      packageAdmin: {
        objectId:
          "0xc8fe804fb63ad60f0755110bfa297dd3535ac1a983a2748f3626faed60ed7c90",
        initialSharedVersion: "2",
      },
    },
    launchpad: {
      launchConfig: {
        objectId:
          "0x2313c26286ab4809593b4216135cff085ade5882f2e58b44621baf33bcd79e9c",
        initialSharedVersion: "1",
      },
      runtimeConfig: {
        objectId:
          "0xc0b25b6adc2186c116d5bfa6442194c6cdb09eecc6c6907e98c737662b2c97f1",
        initialSharedVersion: "1",
      },
      launchRegistry: {
        objectId:
          "0xfd17081d0992842070b4d59ee8eae94a088959a8e6692f06aebe71f39ddf6cc1",
        initialSharedVersion: "1",
      },
      packageVersion: {
        objectId:
          "0x25b905a97e1c4e66be7b332e0d4e4b37a423f7cfb1dbdbe6e088e561df7d0ee3",
        initialSharedVersion: "2",
      },
      packageAdmin: {
        objectId:
          "0xc67edfa7f9d00b5a672bad958bbc04973677216b99e3a498ce26791ef95990ff",
        initialSharedVersion: "2",
      },
    },
    presale: {
      creationPolicy: {
        objectId:
          "0x5e61581b1bb526dbe914e972d32c5253e8bff0ebec6acf3570ab228d7f6841af",
        initialSharedVersion: "1",
      },
      feePolicy: {
        objectId:
          "0xada8e6835fb4aab775aedd76d4de7ecef87044d4403fb76028615396622f233b",
        initialSharedVersion: "1",
      },
      presaleRegistry: {
        objectId:
          "0x2e6a741d72a33f1fb97f734c450f4f8713e5f403959cab0e435d7e41b55c65bc",
        initialSharedVersion: "1",
      },
      packageVersion: {
        objectId:
          "0xd9523cb850fac1d2ac84a31dbc1335e412e1b778d409b091c5eefec3f6133ba7",
        initialSharedVersion: "2",
      },
      packageAdmin: {
        objectId:
          "0x315c0fe20ddde9c2f3b75385beb93c440b246c072bc98c28482690a10df56b15",
        initialSharedVersion: "2",
      },
    },
    migrators: {
      venueConfig: {
        objectId:
          "0x7ee32ce175c6aec6bb0c30c1d72a8bea02ea50701a67780b53b6ba84d0dbbf64",
        initialSharedVersion: "1",
      },
      packageVersion: {
        objectId:
          "0x05057043d181d3c31f2e1990b6b7ac17c6814feb3069332b47eb8a6cd5d6b6b6",
        initialSharedVersion: "2",
      },
      packageAdmin: {
        objectId:
          "0x87ce206a4cd4cd334337229368ca03a67f8d00a0d0b40d4c130ac8b0df32cedd",
        initialSharedVersion: "2",
      },
    },
    cetus: {
      config: {
        objectId:
          "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f",
        initialSharedVersion: "1574190",
      },
      pools: {
        objectId:
          "0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0",
        initialSharedVersion: "1574190",
      },
      burnManager: {
        objectId:
          "0x1d94aa32518d0cb00f9de6ed60d450c9a2090761f326752ffad06b2e9404f845",
        initialSharedVersion: "327723159",
      },
    },
    bluefin: {
      config: {
        objectId:
          "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352",
        initialSharedVersion: "406496849",
      },
    },
  },
  routes: [
    { venue: "cetus", tiers: [{ tickSpacing: 200, feeRate: "10000" }] },
    {
      venue: "bluefin",
      tiers: [
        { tickSpacing: 2, feeRate: "100" },
        { tickSpacing: 4, feeRate: "200" },
        { tickSpacing: 6, feeRate: "300" },
        { tickSpacing: 8, feeRate: "400" },
        { tickSpacing: 10, feeRate: "500" },
        { tickSpacing: 20, feeRate: "1000" },
        { tickSpacing: 30, feeRate: "1500" },
        { tickSpacing: 40, feeRate: "2000" },
        { tickSpacing: 60, feeRate: "2500" },
        { tickSpacing: 80, feeRate: "3000" },
        { tickSpacing: 100, feeRate: "4000" },
        { tickSpacing: 120, feeRate: "6000" },
        { tickSpacing: 160, feeRate: "8000" },
        { tickSpacing: 200, feeRate: "10000" },
        { tickSpacing: 220, feeRate: "20000" },
      ],
    },
  ],
  source: {
    contractsCommit: FROZEN_ABI.contractsCommit,
    abi: FROZEN_ABI.artifacts,
  },
  release: {
    transactions: {
      admin: "Ek986kysryZNcZ8ikFfPMaJSgfAkd7UN41yk7DkcAQ29",
      partners: "CrcoEd6KBzL1fcP1AV1nJvBLow1mPUX7WqH1SmcWFpU1",
      core: "DB1L4Uw83hm9bhZLMER8e2NSvUpHZQZzaPocxtnnF2eN",
      vault: "362R9mM89oFkQKPqes1Y1Zm7yi5AiFxkAszw8cAQK3Aj",
      launchpad: "DwfkEATbTFxxKubdfbni44rV6XFKxfaNY6jhzfcBKb2C",
      presale: "3CpYQbvXwqJvVCWVZhWymwe5R3qpfxbFxe55EaH4ouPs",
      migrators: "FK6c3KY1TkfXRkqG5sqmvMpzmf7Ha3UqZMo1Cis1SzVp",
    },
  },
  sdk: {
    version: SDK_RELEASE.version,
    commit: "8d88037ac836c0f0e14d52a03151340294e8041e",
  },
  evidence: [
    {
      check: "Canonical venue and quote admission",
      transactionDigest: "7HHZeepG6z5MJDjcnJ517cjN7uAuLdqt5HCpQxmTQZw9",
      checkpoint: "342367197",
      verifiedAtMs: "1794109714329",
    },
    {
      check: "Bluefin launchpad migration on rehearsal packages",
      transactionDigest: "HgjC76qSBPApYYNM6GernvR3NpgdfpEXZCyPqi2B5sZt",
      checkpoint: "343256659",
      verifiedAtMs: "1794203060880",
    },
    {
      check: "Bluefin presale migration on rehearsal packages",
      transactionDigest: "5iT1hSmrJX26n5qFWMFkKZdo4MrqqrH26vjSm2MB13mZ",
      checkpoint: "343256751",
      verifiedAtMs: "1794203060880",
    },
    {
      check: "Cetus launchpad migration on rehearsal packages",
      transactionDigest: "HgjC76qSBPApYYNM6GernvR3NpgdfpEXZCyPqi2B5sZt",
      checkpoint: "343256659",
      verifiedAtMs: "1794203060880",
    },
    {
      check: "Cetus presale migration on rehearsal packages",
      transactionDigest: "5iT1hSmrJX26n5qFWMFkKZdo4MrqqrH26vjSm2MB13mZ",
      checkpoint: "343256751",
      verifiedAtMs: "1794203060880",
    },
  ],
};
