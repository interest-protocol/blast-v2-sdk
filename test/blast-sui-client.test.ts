import assert from "node:assert/strict";
import test from "node:test";

import { TypeTagSerializer } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { deriveDynamicFieldID, normalizeSuiAddress } from "@mysten/sui/utils";

import { BlastSuiClient, blastSui } from "../src/blast-sui/client.ts";
import {
  BlastSuiCalls,
  BlastSuiTransactions,
} from "../src/blast-sui/transactions.ts";
import type { BlastSuiDeployment } from "../src/blast-sui/types.ts";
import {
  BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
  BLAST_SUI_VAULT_GOLDEN_BYTES,
  BLAST_TREASURY_CAP_GOLDEN_BYTES,
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
  vault: { objectId: "0x44", initialSharedVersion: "9" },
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
        return options.objectId.endsWith("44")
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
  const receipt = await client.getDepositReceipt("0x77");
  assert.equal(vault.objectId.endsWith("44"), true);
  assert.equal(receipt.objectId.endsWith("77"), true);
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
    { objectId: "0x77", include: { content: true } },
  ]);

  const registration = blastSui(deployment);
  assert.equal(registration.name, "blastSui");
  assert.equal(
    registration.register(coreClient) instanceof BlastSuiClient,
    true,
  );
});

function vaultObject() {
  return {
    objectId: "0x44",
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
