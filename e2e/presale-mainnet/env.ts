import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AdminTransactions, getAcl } from "@interest-protocol/blast-admin-sdk";
import { PresaleClient } from "@interest-protocol/blast-presale-sdk";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import {
  assertFinalizeTicketAbi,
  parseConfig,
  targetFingerprint,
} from "./target.ts";

const path = process.env.E2E_DEPLOYMENT;
if (!path)
  throw new Error(
    "Set E2E_DEPLOYMENT to an explicit final deployment configuration; there is no default target.",
  );
export const CONFIG = parseConfig(JSON.parse(readFileSync(path, "utf8")));
export const FINGERPRINT = targetFingerprint(CONFIG);
export const DEPLOYMENT = CONFIG.deployment;
export const ADMIN_DEPLOYMENT = DEPLOYMENT.admin;
export const SUPER_ADMIN_CAP = CONFIG.superAdminCap;
export const TESTKIT = CONFIG.testkit;
export const COIN_REGISTRY = "0xc";
export const SUI = normalizeStructTag("0x2::sui::SUI");
export const AFTERMATH = {
  poolRegistry:
    "0xfcc774493db2c45c79f688f88d28023a3e7d98e4ee9f48bbf5c7990f651577ae",
  daoFeeVersion:
    "0xb4bfb0f917f12ad2a772bea9b4f22431f6f5f9653162c3ae6fae5b99b21392b7",
};
export const client = new SuiGrpcClient({
  baseUrl: process.env.SUI_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443",
  network: "mainnet",
});
export const presale = new PresaleClient(client, DEPLOYMENT);
export const acl = new AdminTransactions(ADMIN_DEPLOYMENT);
export async function assertTarget(): Promise<void> {
  const info = await client.ledgerService.getServiceInfo({}).response;
  if (info.chainId !== "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S")
    throw new Error("RPC is not Sui mainnet");
  const [create, finalize] = await Promise.all([
    client.core.getMoveFunction({
      packageId: DEPLOYMENT.packageId,
      moduleName: "aftermath",
      name: "new",
    }),
    client.core.getMoveFunction({
      packageId: DEPLOYMENT.packageId,
      moduleName: "aftermath",
      name: "finalize",
    }),
  ]);
  assertFinalizeTicketAbi(
    DEPLOYMENT.originalPackageId,
    create.function,
    finalize.function,
  );
  const publication = await client.core.getTransaction({
    digest: CONFIG.publicationDigest,
    include: { effects: true },
  });
  if (
    publication.$kind !== "Transaction" ||
    !publication.Transaction.effects.changedObjects.some(
      (change) =>
        change.objectId === DEPLOYMENT.packageId &&
        change.outputState === "PackageWrite" &&
        change.idOperation === "Created",
    )
  )
    throw new Error(
      "Publication receipt does not create the configured final package",
    );
  const aclState = await getAcl(
    client,
    ADMIN_DEPLOYMENT.acl.objectId,
    ADMIN_DEPLOYMENT.packageId,
  );
  if (aclState.superAdminCapId !== SUPER_ADMIN_CAP)
    throw new Error("Configured root does not control this ACL");
  for (const [module, name, identity] of [
    ["blast_presale_package", "PackageVersion", DEPLOYMENT.packageVersion],
    ["venue_config", "VenueConfig", DEPLOYMENT.venueConfig],
    ["creation_policy", "CreationPolicy", DEPLOYMENT.creationPolicy],
    ["fee_policy", "FeePolicy", DEPLOYMENT.feePolicy],
  ] as const) {
    const { object } = await client.core.getObject({
      objectId: identity.objectId,
    });
    if (
      object.owner.$kind !== "Shared" ||
      String(object.owner.Shared.initialSharedVersion) !==
        String(identity.initialSharedVersion) ||
      normalizeStructTag(object.type) !==
        normalizeStructTag(
          `${DEPLOYMENT.originalPackageId}::${module}::${name}`,
        )
    )
      throw new Error(`Wrong final deployment object: ${name}`);
  }
  const { object: root } = await client.core.getObject({
    objectId: SUPER_ADMIN_CAP,
  });
  if (
    root.owner.$kind !== "AddressOwner" ||
    root.owner.AddressOwner !== CONFIG.operators.administrator ||
    normalizeStructTag(root.type) !==
      normalizeStructTag(
        `${ADMIN_DEPLOYMENT.packageId}::blast_acl::SuperAdminCap`,
      )
  )
    throw new Error("Administrator does not own the configured ACL root");
}
export function deployer(): Ed25519Keypair {
  return signer("DEPLOYER", CONFIG.operators.deployer);
}
export function administrator(): Ed25519Keypair {
  return signer("ADMINISTRATOR", CONFIG.operators.administrator);
}
function signer(name: string, defaultAddress: string): Ed25519Keypair {
  const address = normalizeSuiAddress(defaultAddress);
  const secret = process.env[`${name}_KEY`]?.trim();
  if (secret) {
    const keypair = Ed25519Keypair.fromSecretKey(secret);
    if (keypair.toSuiAddress() !== address) {
      throw new Error(`${name}_KEY is not the key of ${address}`);
    }
    return keypair;
  }
  const keystore = JSON.parse(
    readFileSync(join(homedir(), ".sui", "sui_config", "sui.keystore"), "utf8"),
  ) as string[];
  for (const entry of keystore) {
    const bytes = Buffer.from(entry, "base64");
    if (bytes[0] !== 0) continue;
    const keypair = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
    if (keypair.toSuiAddress() === address) return keypair;
  }
  throw new Error(
    `no Ed25519 key for ${address}: set ${name}_KEY or add it to the Sui keystore`,
  );
}
