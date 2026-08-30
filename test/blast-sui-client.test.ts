import assert from "node:assert/strict";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";

import { BlastSuiClient, blastSui } from "../src/blast-sui/client.ts";
import {
  blastSuiDepositReceiptBcs,
  blastSuiVaultBcs,
} from "../src/blast-sui/state.ts";
import {
  BlastSuiCalls,
  BlastSuiTransactions,
} from "../src/blast-sui/transactions.ts";
import type { BlastSuiDeployment } from "../src/blast-sui/types.ts";

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
  const receipt = await client.getDepositReceipt("0xa");
  assert.equal(vault.objectId.endsWith("44"), true);
  assert.equal(receipt.objectId.endsWith("0a"), true);
  assert.deepEqual(requests, [
    {
      objectId: client.call.deployment.vault.objectId,
      include: { content: true },
    },
    { objectId: "0xa", include: { content: true } },
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
    content: blastSuiVaultBcs
      .serialize({
        id: uid("0x44"),
        fun_cap: treasury("0xf1"),
        blast_cap: treasury("0xb1"),
        pool_id: id("0x55"),
        fun_custody: custody(),
        blast_custody: custody(),
        rate_epoch: 1n,
        rate_sui: 1n,
        rate_pool_tokens: 1n,
        redeem_fee_bps: 0n,
        unwind_only: false,
      })
      .toBytes(),
  };
}

function receiptObject(objectId: string) {
  return {
    objectId,
    owner: { $kind: "AddressOwner" as const, AddressOwner: "0xbeef" },
    type: "0x122::deposit_receipt::BlastSuiDepositReceipt",
    content: blastSuiDepositReceiptBcs
      .serialize({
        id: uid(objectId),
        vault_id: id("0x44"),
        staked_sui: {
          id: uid("0xa3"),
          pool_id: id("0x55"),
          stake_activation_epoch: 2n,
          principal: { value: 3n },
        },
      })
      .toBytes(),
  };
}

function uid(value: string) {
  return { id: id(value) };
}

function id(value: string) {
  return { bytes: value };
}

function treasury(objectId: string) {
  return { id: uid(objectId), total_supply: { value: 0n } };
}

function custody() {
  return {
    liquid_sui: { value: 0n },
    pending_stakes: [],
    active_stake: null,
    active_sui: 0n,
  };
}
