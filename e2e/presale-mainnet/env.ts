import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { normalizeStructTag } from "@mysten/sui/utils";

import { getPresaleDeployment } from "../../src/deployments/index.ts";
import { PresaleClient } from "../../src/presale/index.ts";

/** Mainnet genesis checkpoint digest prefix every run checks before signing. */
export const MAINNET_CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";

export const DEPLOYMENT = getPresaleDeployment("mainnet");

/** The deployer's live administrator caps (deployment record 2026-10-04). */
export const ADMIN_CAP =
  "0x7a9174aa9f7658ed29a91b4b732a965c19ef4683d5b47d30cc0320315d82e9be";
export const SUPER_ADMIN_CAP =
  "0x6958f7c0f3d2f05364d4274e6d0aed3e8d457e544673d7c37077559543d6c3cc";

/** `sui/presale_testkit`, published 2026-10-04 (tx 7Kczhy9i…gbf). */
export const TESTKIT =
  "0x5650d58030f361f60f81913b54bf026e93e957bfbf506234f8f2e83bd3bfbd85";
export const TEST_SUI = normalizeStructTag(`${TESTKIT}::test_sui::TEST_SUI`);
export const SUI = normalizeStructTag("0x2::sui::SUI");
export const FAUCET = {
  objectId:
    "0x4e304866ee5bc21eddc89fd9bf6eaf650324a2fd75335e464fca3c02b8739073",
  initialSharedVersion: "1034583373",
};
export const TEST_SUI_CURRENCY = {
  objectId:
    "0x9efb1fd81fa8d22120954bf04a8d4db52493c9daeb8c7ba88d0ec8d86b527a21",
  initialSharedVersion: "1034583373",
};
export const COIN_REGISTRY = "0xc";
/** SUI's Coin Registry `Currency`, derived from the registry. */
export const SUI_CURRENCY = {
  objectId:
    "0xf256d3fb6a50eaa748d94335b34f2982fbc3b63ceec78cafaa29ebc9ebaf2bbc",
  initialSharedVersion: "646801005",
};

/** Venue shared objects, each checked on chain on 2026-10-04. */
export const CETUS = {
  packageId:
    "0x260693ec785a6e6c9d81d58c7d2ff72f1288ae0fa6a9725abe05a6478b11f084",
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
};
export const BLUEFIN = {
  packageId:
    "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c",
  config: {
    objectId:
      "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352",
    initialSharedVersion: "406496849",
  },
};

export const client = new SuiGrpcClient({
  baseUrl: process.env.SUI_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443",
  network: "mainnet",
});

export const presale = new PresaleClient(client, DEPLOYMENT);

/** Refuses to run against anything but mainnet. */
export async function assertMainnet(): Promise<void> {
  const info = await client.ledgerService.getServiceInfo({}).response;
  if (info.chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`RPC chain ${info.chainId} is not Sui mainnet`);
  }
}

/** The deployer key from the local Sui keystore, matched by address. */
export function deployer(): Ed25519Keypair {
  const address =
    process.env.DEPLOYER_ADDRESS ??
    "0x1dd93b4bb9a733c30da8a3c4a49177ab3ab4ab4a602a89a72b24f63b68e53534";
  const keystore = JSON.parse(
    readFileSync(join(homedir(), ".sui", "sui_config", "sui.keystore"), "utf8"),
  ) as string[];
  for (const entry of keystore) {
    const bytes = Buffer.from(entry, "base64");
    if (bytes[0] !== 0) continue;
    const keypair = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
    if (keypair.toSuiAddress() === address) return keypair;
  }
  throw new Error(`no Ed25519 key for ${address} in the Sui keystore`);
}

/** Named run wallets, generated once and kept out of git. */
export const WALLET_NAMES = [
  "fees",
  "creator",
  "relayer",
  "p1",
  "p2",
  "p3",
  "p4",
  "p5",
  "p6",
  "r1",
  "r2",
  "r3",
] as const;
export type WalletName = (typeof WALLET_NAMES)[number];

const WALLETS_PATH = new URL(".wallets.json", import.meta.url);

export function wallets(): Record<WalletName, Ed25519Keypair> {
  const stored: Partial<Record<WalletName, string>> = existsSync(WALLETS_PATH)
    ? JSON.parse(readFileSync(WALLETS_PATH, "utf8"))
    : {};
  let changed = false;
  const keys = Object.fromEntries(
    WALLET_NAMES.map((name) => {
      let secret = stored[name];
      if (!secret) {
        secret = new Ed25519Keypair().getSecretKey();
        stored[name] = secret;
        changed = true;
      }
      return [name, Ed25519Keypair.fromSecretKey(secret)];
    }),
  ) as Record<WalletName, Ed25519Keypair>;
  if (changed) {
    writeFileSync(WALLETS_PATH, `${JSON.stringify(stored, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return keys;
}
