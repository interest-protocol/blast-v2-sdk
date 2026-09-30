import type { BlastDeploymentInput } from "../../src/deployments/types.ts";

/**
 * One valid non-production (localnet) manifest. Every identity is a test
 * value: sha256("blast-sdk-nonprod-<n>") object IDs and sha256-derived base58
 * digests. It is never a production identity.
 */
export const NON_PRODUCTION_MANIFEST = {
  schemaVersion: 1,
  environment: "non-production",
  network: "localnet",
  chainIdentifier: "J7V8G2zmJUEXtEJgvP2iCzxwV259RFuSWbeD68PYUghP",
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
  },
  sharedObjects: {
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
    acl: {
      objectId:
        "0x434c11834928f93c0e96cda16baeb5e1c9219438fb3eddf59be3dc6d096c839f",
      initialSharedVersion: "2",
    },
    migratorsPackageVersion: {
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
  routes: [
    {
      venue: "bluefin",
      tiers: [
        { tickSpacing: 60, feeRate: "3000" },
        { tickSpacing: 200, feeRate: "10000" },
      ],
    },
  ],
  source: {
    contractsCommit: "442116a0a1b82c6b4a64dc55fa0de430322f4bb7",
    abi: {
      launchpad:
        "90da633139dd28069572dc84c8a0d700f8f4535fcc98770734ef42c380632cf3",
      blastSui:
        "0fdaeaa1dbed9d5ac4d80ad49db9aa5b7c438a5daa3a4fff68702968a8dcd1ed",
    },
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
