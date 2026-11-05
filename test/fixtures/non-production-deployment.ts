import {
  FROZEN_ABI,
  SDK_RELEASE,
} from "@interest-protocol/blast-deployments-sdk/identity";
import type { BlastDeploymentInput } from "@interest-protocol/blast-deployments-sdk/types";

/**
 * One valid non-production manifest of the fresh launch stack (schema 2).
 * Blast runs on mainnet only, so it names mainnet and carries mainnet's
 * genesis digest; `environment` is what keeps it out of production, together
 * with its identities. Every identity is a test value:
 * sha256("blast-sdk-nonprod-<n>") object IDs and sha256-derived base58
 * digests, so `evaluateProtocolAccess` refuses it in production mode.
 */
export const NON_PRODUCTION_MANIFEST = {
  schemaVersion: 2,
  environment: "non-production",
  network: "mainnet",
  chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  explorer: { baseUrl: "http://127.0.0.1:9001" },
  packages: {
    admin: {
      packageId:
        "0x9e0fc676dfefb03ab0c77c329497e68025cf519ed400ba40b6240afe30ad1b24",
      originalPackageId:
        "0x9e0fc676dfefb03ab0c77c329497e68025cf519ed400ba40b6240afe30ad1b24",
    },
    partners: {
      packageId:
        "0x661519f5fffe732a38d23ab13fb8d6d3b4527d8b0ca821dd8df61db13441a2b5",
      originalPackageId:
        "0x661519f5fffe732a38d23ab13fb8d6d3b4527d8b0ca821dd8df61db13441a2b5",
    },
    core: {
      packageId:
        "0xc5b18999be90fb2a773a1806b83563346f316f7e7a4901a96408b9105b94a5e5",
      originalPackageId:
        "0xc5b18999be90fb2a773a1806b83563346f316f7e7a4901a96408b9105b94a5e5",
    },
    vesting: {
      packageId:
        "0xda45053f7e2b16e31acc37b81bb863fe674dcd3b9eb3effc00e47de3251cc537",
      originalPackageId:
        "0xda45053f7e2b16e31acc37b81bb863fe674dcd3b9eb3effc00e47de3251cc537",
    },
    vault: {
      packageId:
        "0x962b49ef38ccefb5ef690fb14a189792b5112d251efcb675da6a87b8d6671eb9",
      originalPackageId:
        "0x962b49ef38ccefb5ef690fb14a189792b5112d251efcb675da6a87b8d6671eb9",
    },
    launchpad: {
      packageId:
        "0x1d0a3368b0c69c8ad5a0e59e57f0306bcccb7c52c18fcfbbf4b700421649ab8c",
      originalPackageId:
        "0x1d0a3368b0c69c8ad5a0e59e57f0306bcccb7c52c18fcfbbf4b700421649ab8c",
    },
    presale: {
      packageId:
        "0xb71fdc32b87b5ef7026f7b86439d35965af6ebdb9ff1ca06a9354668e82a326a",
      originalPackageId:
        "0xb71fdc32b87b5ef7026f7b86439d35965af6ebdb9ff1ca06a9354668e82a326a",
    },
    migrators: {
      packageId:
        "0x3db89a4e81c0b952c952a91d26b8568945ece87ff52ff69a1c7b928f2a257ce6",
      originalPackageId:
        "0x3db89a4e81c0b952c952a91d26b8568945ece87ff52ff69a1c7b928f2a257ce6",
    },
  },
  sharedObjects: {
    admin: {
      acl: {
        objectId:
          "0x434c11834928f93c0e96cda16baeb5e1c9219438fb3eddf59be3dc6d096c839f",
        initialSharedVersion: "2",
      },
    },
    core: {
      treasury: {
        objectId:
          "0xda6cecfd52e07dd9f307fd9ee97c90daaeb42f458e656e1d075a037b35119872",
        initialSharedVersion: "3",
      },
    },
    vault: {
      registry: {
        objectId:
          "0xd99b24f0467ef7c9413ac54327322ef9f28865c2ca7fd6f79870ec839ab84b06",
        initialSharedVersion: "4",
      },
      packageVersion: {
        objectId:
          "0x4558340e1d3b8b66340b6aae089ac16963b1045539c485f243ab404d0bb03317",
        initialSharedVersion: "4",
      },
      packageAdmin: {
        objectId:
          "0xca90ea28519bbfa3dbb35e0250e98c0b682f9bca899ef55323f58ffaa7a114d4",
        initialSharedVersion: "4",
      },
    },
    launchpad: {
      packageVersion: {
        objectId:
          "0xdd979931bc39021dba25563616fa3fc517fc91aa0edb9181deae37b0b96550b6",
        initialSharedVersion: "5",
      },
      packageAdmin: {
        objectId:
          "0x9d496983e2c48ca402b5c6c9d8c351fcb0626d624433c87e247598b8c807843e",
        initialSharedVersion: "5",
      },
      launchConfig: {
        objectId:
          "0xd0d213ecd2638fe23065ed11ccd33fd1ab601d76d84e16fc88253d413d7614b0",
        initialSharedVersion: "5",
      },
      runtimeConfig: {
        objectId:
          "0xe47b5e9a47b360e6b7254146593b36aacfd0b825713fd0158c9360189ae8d16f",
        initialSharedVersion: "5",
      },
      launchRegistry: {
        objectId:
          "0x1ea895ea9eae75b515a910dba257d6bdf16c37436cacb6546f6c630789e58db2",
        initialSharedVersion: "5",
      },
    },
    presale: {
      packageVersion: {
        objectId:
          "0xd576a03b3d1edb7db3b5ad106a8b0986c9ee582089920a9fc37b0900fd9d0679",
        initialSharedVersion: "6",
      },
      packageAdmin: {
        objectId:
          "0x93965cb6679c618ca29f3977efb46fd90c7ab4038d8e17c09c847e79e722d958",
        initialSharedVersion: "6",
      },
      creationPolicy: {
        objectId:
          "0x7c36c02fe6492c6eeb8e1e086ace6f5d51128ae195dc43476d37c9318bfb5952",
        initialSharedVersion: "6",
      },
      feePolicy: {
        objectId:
          "0xbcc266bcf4d3c29ccb43076f193efeb5477d30045ae432a616bf09df53665662",
        initialSharedVersion: "6",
      },
      presaleRegistry: {
        objectId:
          "0x8702456af92cc66d1c2cf2ad90dfdd6a77294011b526fa7d470e0ab732d12f59",
        initialSharedVersion: "6",
      },
    },
    migrators: {
      packageVersion: {
        objectId:
          "0x75817ab000b656422e2399a5cffc22f70d36163c756fddad49ca4bcd66540571",
        initialSharedVersion: "7",
      },
      packageAdmin: {
        objectId:
          "0x9ac4549d010caba4141445ebd884768fb253ca80eb99f27db02deca0bc1abc21",
        initialSharedVersion: "7",
      },
      venueConfig: {
        objectId:
          "0xcab7f751cc9f209097c023fb9c7a228ed02cac0b6974cd02495f74fadd1b8d75",
        initialSharedVersion: "7",
      },
    },
  },
  routes: [
    {
      venue: "bluefin",
      tiers: [
        { tickSpacing: 60, feeRate: "3000" },
        { tickSpacing: 200, feeRate: "10000" },
      ],
    },
  ],
  // Built from the SDK's frozen ABI, so the fixture follows each refreeze.
  source: {
    contractsCommit: FROZEN_ABI.contractsCommit,
    abi: { ...FROZEN_ABI.artifacts },
  },
  release: {
    transactions: {
      admin: "HcgAauyuV1TCjtvWFXHE4LqKkja9aPR6wz1y1xCXdLcr",
      partners: "Am7GpsGz2cbd5znWQmkBaWdv6T1D959jiRwZoQE6wRU4",
      core: "HVfVRn5f7SH1EUKum8K9QvhSZx2hnPJUT3uKfr9WCVa9",
      vault: "CtqPnCwSbweUenwCD4zbqzNXQABxBKqqCCjia55DHWLg",
      launchpad: "AopiFViCrb2tvBTGyJzHxjtPhsuiWqrHkswNH5qrDobs",
      presale: "FkqxiSXpXbcJkrP4a9teNosVsKCLc9S9aYXHpGK7e3ud",
      migrators: "Ca3ZToV3SsaQreei3GibK9J4D2FiCZrHPdN9Xv2BHumJ",
    },
  },
  sdk: {
    version: SDK_RELEASE.version,
    commit: SDK_RELEASE.commit ?? "70bd985c812b9e304ab771a9335a26246c993d9f",
  },
  evidence: [
    {
      check: "launch-stack objects read back with their package types",
      transactionDigest: null,
      checkpoint: "12",
      verifiedAtMs: "1790000000000",
    },
    {
      check: "bluefin launch created, bought, and migrated",
      transactionDigest: "BMwg3HvPTPQaKr9Lnk5jjNkw1bseCftzVgdaGksass4W",
      checkpoint: "40",
      verifiedAtMs: "1790000060000",
    },
  ],
} as const satisfies BlastDeploymentInput;
