import { FROZEN_ABI } from "../../src/deployments/identity.ts";
import type { BlastDeploymentInput } from "../../src/deployments/types.ts";

/**
 * One valid non-production manifest. Blast runs on mainnet only, so it names
 * mainnet and carries mainnet's genesis digest; `environment` is what keeps it
 * out of production, together with its identities. Every identity is a test
 * value: sha256("blast-sdk-nonprod-<n>") object IDs and sha256-derived base58
 * digests, so `evaluateProtocolAccess` refuses it in production mode.
 */
export const NON_PRODUCTION_MANIFEST = {
  schemaVersion: 1,
  environment: "non-production",
  network: "mainnet",
  chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  explorer: { baseUrl: "http://127.0.0.1:9001" },
  packages: {
    launchpad: {
      packageId:
        "0x1d0a3368b0c69c8ad5a0e59e57f0306bcccb7c52c18fcfbbf4b700421649ab8c",
      originalPackageId:
        "0x1d0a3368b0c69c8ad5a0e59e57f0306bcccb7c52c18fcfbbf4b700421649ab8c",
    },
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
    timelock: {
      packageId:
        "0x4646dcce24368888cc0baf3092e5009777e3b61263bce622c97d7673c8b54070",
      originalPackageId:
        "0x4646dcce24368888cc0baf3092e5009777e3b61263bce622c97d7673c8b54070",
    },
    migrators: {
      packageId:
        "0x3db89a4e81c0b952c952a91d26b8568945ece87ff52ff69a1c7b928f2a257ce6",
      originalPackageId:
        "0x3db89a4e81c0b952c952a91d26b8568945ece87ff52ff69a1c7b928f2a257ce6",
    },
    presale: {
      packageId:
        "0xb71fdc32b87b5ef7026f7b86439d35965af6ebdb9ff1ca06a9354668e82a326a",
      originalPackageId:
        "0xb71fdc32b87b5ef7026f7b86439d35965af6ebdb9ff1ca06a9354668e82a326a",
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
    launchpad: {
      packageVersion: {
        objectId:
          "0xdd979931bc39021dba25563616fa3fc517fc91aa0edb9181deae37b0b96550b6",
        initialSharedVersion: "3",
      },
      launchConfig: {
        objectId:
          "0xd0d213ecd2638fe23065ed11ccd33fd1ab601d76d84e16fc88253d413d7614b0",
        initialSharedVersion: "3",
      },
      runtimeConfig: {
        objectId:
          "0xe47b5e9a47b360e6b7254146593b36aacfd0b825713fd0158c9360189ae8d16f",
        initialSharedVersion: "3",
      },
    },
    migrators: {
      packageVersion: {
        objectId:
          "0x75817ab000b656422e2399a5cffc22f70d36163c756fddad49ca4bcd66540571",
        initialSharedVersion: "5",
      },
      lpFeePolicy: {
        objectId:
          "0x9ac4549d010caba4141445ebd884768fb253ca80eb99f27db02deca0bc1abc21",
        initialSharedVersion: "5",
      },
      venueConfig: {
        objectId:
          "0xcab7f751cc9f209097c023fb9c7a228ed02cac0b6974cd02495f74fadd1b8d75",
        initialSharedVersion: "5",
      },
    },
    presale: {
      venueConfig: {
        objectId:
          "0xfb235af5bc5d6d766809e4e976848637de6eee126454cf52b75402ad461eaa46",
        initialSharedVersion: "9",
      },
      creationPolicy: {
        objectId:
          "0x7c36c02fe6492c6eeb8e1e086ace6f5d51128ae195dc43476d37c9318bfb5952",
        initialSharedVersion: "9",
      },
      feePolicy: {
        objectId:
          "0xbcc266bcf4d3c29ccb43076f193efeb5477d30045ae432a616bf09df53665662",
        initialSharedVersion: "9",
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
      timelock: "FEiQZR1XWhnTCeYdb2f8nZ1Uo49FE13NfJdvkbeJLDvg",
      admin: "HcgAauyuV1TCjtvWFXHE4LqKkja9aPR6wz1y1xCXdLcr",
      partners: "Am7GpsGz2cbd5znWQmkBaWdv6T1D959jiRwZoQE6wRU4",
      launchpad: "AopiFViCrb2tvBTGyJzHxjtPhsuiWqrHkswNH5qrDobs",
      migrators: "Ca3ZToV3SsaQreei3GibK9J4D2FiCZrHPdN9Xv2BHumJ",
    },
  },
  sdk: {
    version: "0.0.0",
    commit: "70bd985c812b9e304ab771a9335a26246c993d9f",
  },
  evidence: [
    {
      check: "launchpad objects read back with their package types",
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
