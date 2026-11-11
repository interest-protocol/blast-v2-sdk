import assert from "node:assert/strict";
import test from "node:test";
import {
  BlastSuiClient,
  blastSui,
} from "@interest-protocol/blast-sui-sdk/client";
import {
  BlastSuiCalls,
  BlastSuiTransactions,
} from "@interest-protocol/blast-sui-sdk/transactions";
import type { BlastSuiDeployment } from "@interest-protocol/blast-sui-sdk/types";
import { TypeTagSerializer } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  deriveDynamicFieldID,
  normalizeStructTag,
  normalizeSuiAddress,
} from "@mysten/sui/utils";
import {
  BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
  BLAST_SUI_VAULT_GOLDEN_BYTES,
  BLAST_TREASURY_CAP_GOLDEN_BYTES,
  FIXTURE_POOL_0,
  FIXTURE_RECEIPT_ID,
  FIXTURE_VAULT_ID,
  FUN_TREASURY_CAP_GOLDEN_BYTES,
} from "./blast-sui-golden.ts";

const originalPackageId = "0x122";
const deployment: BlastSuiDeployment = {
  packageId: "0x123",
  originalPackageId,
  packageVersion: {
    objectId: "0x10",
    initialSharedVersion: "8",
  },
  packageAdmin: { objectId: "0x12", initialSharedVersion: "4" },
  vault: { objectId: FIXTURE_VAULT_ID, initialSharedVersion: "9" },
  admin: {
    packageId: "0xad",
    acl: { objectId: "0xac", initialSharedVersion: "3" },
  },
};

test("registers calls, transactions, and exact Core API state reads", async () => {
  const requests: unknown[] = [];
  const coreClient = {
    core: {
      getObject: async (options: { objectId: string }) => {
        requests.push(options);
        return options.objectId === FIXTURE_VAULT_ID
          ? { object: vaultObject() }
          : { object: receiptObject(options.objectId) };
      },
      getDynamicObjectField: async (options: { name: { type: string } }) => {
        requests.push(options);
        return {
          object: options.name.type.includes("fun_sui::FUN_SUI")
            ? treasuryCapObject("fun")
            : treasuryCapObject("blast"),
        };
      },
    },
  } as unknown as ClientWithCoreApi;

  const client = new BlastSuiClient(coreClient, deployment);
  assert.equal(client.call instanceof BlastSuiCalls, true);
  assert.equal(client.tx instanceof BlastSuiTransactions, true);

  const vault = await client.getVault();
  const receipt = await client.getDepositReceipt(FIXTURE_RECEIPT_ID);
  assert.equal(vault.objectId, FIXTURE_VAULT_ID);
  assert.equal(vault.initialSharedVersion, "9");
  assert.deepEqual(vault.pools, [FIXTURE_POOL_0]);
  assert.equal(vault.redeemFeeBps, 2n);
  assert.equal(receipt.objectId, FIXTURE_RECEIPT_ID);
  assert.equal(receipt.vaultId, FIXTURE_VAULT_ID);
  assert.equal(receipt.principalSui, 3_000_000_000n);
  assert.deepEqual(requests, [
    {
      objectId: client.call.deployment.vault.objectId,
      include: { content: true },
    },
    {
      parentId: client.call.deployment.vault.objectId,
      name: {
        type: treasuryKeyType("fun"),
        bcs: new Uint8Array([0]),
      },
      include: { content: true },
    },
    {
      parentId: client.call.deployment.vault.objectId,
      name: {
        type: treasuryKeyType("blast"),
        bcs: new Uint8Array([0]),
      },
      include: { content: true },
    },
    { objectId: FIXTURE_RECEIPT_ID, include: { content: true } },
  ]);

  const registration = blastSui(deployment);
  assert.equal(registration.name, "blastSui");
  const registered = registration.register(coreClient);
  assert.equal(registered instanceof BlastSuiClient, true);
  assert.deepEqual(registered.call.deployment, client.call.deployment);
  assert.equal(
    blastSui({ ...deployment, name: "liquidStaking" }).name,
    "liquidStaking",
  );
});

test("passes the SUI coin source option to its transaction builder", () => {
  const coreClient = { core: {} } as unknown as ClientWithCoreApi;
  const coinType = (client: BlastSuiClient) => {
    const command = client.tx
      .donateSui({ amount: 1n })
      .getData()
      .commands.find((candidate) => candidate.$kind === "$Intent");
    assert.ok(command?.$kind === "$Intent");
    return command.$Intent.data.type;
  };
  assert.equal(coinType(new BlastSuiClient(coreClient, deployment)), "gas");
  assert.equal(
    coinType(new BlastSuiClient(coreClient, deployment, { useGasCoin: false })),
    normalizeStructTag("0x2::sui::SUI"),
  );
});

function vaultObject() {
  return {
    objectId: FIXTURE_VAULT_ID,
    owner: {
      $kind: "Shared" as const,
      Shared: { initialSharedVersion: "9" },
    },
    type: "0x122::vault::Vault",
    content: BLAST_SUI_VAULT_GOLDEN_BYTES,
  };
}

function treasuryCapObject(kind: "fun" | "blast") {
  const coinType = treasuryCoinType(kind);
  const wrapperType = TypeTagSerializer.parseFromStr(
    `0x2::dynamic_object_field::Wrapper<${treasuryKeyType(kind)}>`,
  );
  const objectId = kind === "fun" ? "0xf1" : "0xb1";
  return {
    objectId,
    owner: {
      $kind: "ObjectOwner" as const,
      ObjectOwner: deriveDynamicFieldID(
        deployment.vault.objectId,
        wrapperType,
        new Uint8Array([0]),
      ),
    },
    type: `0x2::coin::TreasuryCap<${coinType}>`,
    content:
      kind === "fun"
        ? FUN_TREASURY_CAP_GOLDEN_BYTES
        : BLAST_TREASURY_CAP_GOLDEN_BYTES,
  };
}

function treasuryKeyType(kind: "fun" | "blast"): string {
  return `${normalizeSuiAddress(originalPackageId)}::vault::TreasuryKey<${treasuryCoinType(kind)}>`;
}

function treasuryCoinType(kind: "fun" | "blast"): string {
  const module = kind === "fun" ? "fun_sui::FUN_SUI" : "blast_sui::BLAST_SUI";
  return `${normalizeSuiAddress(originalPackageId)}::${module}`;
}

function receiptObject(objectId: string) {
  return {
    objectId,
    owner: { $kind: "AddressOwner" as const, AddressOwner: "0xbeef" },
    type: "0x122::deposit_receipt::BlastSuiDepositReceipt",
    content: BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
  };
}
