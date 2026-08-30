import assert from "node:assert/strict";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";

import { BlastSuiClient, blastSui } from "../src/blast-sui/client.ts";
import {
  BlastSuiCalls,
  BlastSuiTransactions,
} from "../src/blast-sui/transactions.ts";
import type { BlastSuiDeployment } from "../src/blast-sui/types.ts";
import {
  BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
  BLAST_SUI_VAULT_GOLDEN_BYTES,
} from "./blast-sui-golden.ts";

const deployment: BlastSuiDeployment = {
  packageId: "0x123",
  originalPackageId: "0x122",
  packageVersion: {
    objectId: "0x10",
    initialSharedVersion: "8",
    mutable: false,
  },
  vault: { objectId: "0x44", initialSharedVersion: "9", mutable: true },
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

function receiptObject(objectId: string) {
  return {
    objectId,
    owner: { $kind: "AddressOwner" as const, AddressOwner: "0xbeef" },
    type: "0x122::deposit_receipt::BlastSuiDepositReceipt",
    content: BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
  };
}
