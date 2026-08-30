import assert from "node:assert/strict";
import test from "node:test";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";

import {
  blastSuiDepositReceiptBcs,
  blastSuiVaultBcs,
  decodeBlastSuiDepositReceiptObject,
  decodeBlastSuiVaultObject,
  getBlastSuiDepositReceipt,
  getBlastSuiVault,
} from "../src/blast-sui/state.ts";
import {
  BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
  BLAST_SUI_VAULT_GOLDEN_BYTES,
} from "./blast-sui-golden.ts";

const originalPackageId = "0x123";
const vaultId = "0x44";
const poolId = "0x55";
const receiptId = "0x77";
const receiptOwner = "0xbeef";
const uid = (id: string) => ({ id: { bytes: id } });
const id = (value: string) => ({ bytes: value });
const balance = (value: bigint) => ({ value });

const custody = {
  liquid_sui: balance(11n),
  pending_stakes: [
    {
      id: uid("0xa1"),
      pool_id: id(poolId),
      stake_activation_epoch: 9n,
      principal: balance(13n),
    },
  ],
  active_stake: {
    id: uid("0xa2"),
    pool_id: id(poolId),
    value: 17n,
  },
  active_sui: 19n,
};

function serializeVaultWithUid(objectId: string): Uint8Array {
  return blastSuiVaultBcs
    .serialize({
      id: uid(objectId),
      fun_cap: {
        id: uid("0xf1"),
        total_supply: { value: 100n },
      },
      blast_cap: {
        id: uid("0xb1"),
        total_supply: { value: 200n },
      },
      pool_id: id(poolId),
      fun_custody: custody,
      blast_custody: custody,
      rate_epoch: 10n,
      rate_sui: 1_020n,
      rate_pool_tokens: 1_000n,
      redeem_fee_bps: 101n,
      unwind_only: true,
    })
    .toBytes();
}

function serializeReceiptWithUid(objectId: string): Uint8Array {
  return blastSuiDepositReceiptBcs
    .serialize({
      id: uid(objectId),
      vault_id: id(vaultId),
      staked_sui: {
        id: uid("0xa3"),
        pool_id: id(poolId),
        stake_activation_epoch: 12n,
        principal: balance(23n),
      },
    })
    .toBytes();
}

function vaultObject(
  overrides: Partial<{
    objectId: string;
    initialSharedVersion: string;
    mutable: boolean;
    type: string;
    content: Uint8Array;
  }> = {},
) {
  return {
    objectId: vaultId,
    initialSharedVersion: "7",
    mutable: true,
    type: `${originalPackageId}::vault::Vault`,
    content: BLAST_SUI_VAULT_GOLDEN_BYTES,
    ...overrides,
  };
}

function addressOwner(address = receiptOwner): SuiClientTypes.ObjectOwner {
  return { $kind: "AddressOwner", AddressOwner: address };
}

test("decodes the complete blast Sui vault and derives custody assets", () => {
  const vault = decodeBlastSuiVaultObject(vaultObject(), originalPackageId);

  assert.equal(vault.objectId.endsWith("44"), true);
  assert.equal(vault.originalPackageId.endsWith("0123"), true);
  assert.equal(vault.poolId.endsWith("55"), true);
  assert.equal(vault.funSupply, 100n);
  assert.equal(vault.blastSupply, 200n);
  assert.equal(vault.funCustody.assets, 43n);
  const pendingStake = vault.funCustody.pendingStakes[0];
  assert.ok(pendingStake);
  assert.deepEqual(vault.funCustody.pendingStakes, [
    {
      objectId: assertNormalizedSuffix(pendingStake.objectId, "a1"),
      poolId: assertNormalizedSuffix(pendingStake.poolId, "55"),
      activationEpoch: 9n,
      principalSui: 13n,
    },
  ]);
  const activeStake = vault.funCustody.activeStake;
  assert.ok(activeStake);
  assert.deepEqual(vault.funCustody.activeStake, {
    objectId: assertNormalizedSuffix(activeStake.objectId, "a2"),
    poolId: assertNormalizedSuffix(activeStake.poolId, "55"),
    poolTokens: 17n,
  });
  assert.deepEqual(vault.exchangeRate, {
    epoch: 10n,
    suiAmount: 1_020n,
    poolTokenAmount: 1_000n,
  });
  assert.equal(vault.redeemFeeBps, 101n);
  assert.equal(vault.unwindOnly, true);
});

test("rejects invalid vault identity, type, package, and mutability", () => {
  for (const type of [
    `${originalPackageId}::wrong::Vault`,
    `${originalPackageId}::vault::Wrong`,
  ]) {
    assert.throws(
      () => decodeBlastSuiVaultObject(vaultObject({ type }), originalPackageId),
      /not a blast Sui vault/,
    );
  }
  assert.throws(
    () => decodeBlastSuiVaultObject(vaultObject(), "0x999"),
    /unexpected package/,
  );
  assert.throws(
    () =>
      decodeBlastSuiVaultObject(
        vaultObject({ content: serializeVaultWithUid("0x99") }),
        originalPackageId,
      ),
    /mismatched UID/,
  );
  assert.throws(
    () =>
      decodeBlastSuiVaultObject(
        vaultObject({ mutable: false }),
        originalPackageId,
      ),
    /must be mutable/,
  );
});

test("rejects a custody asset total that exceeds u64", () => {
  const content = blastSuiVaultBcs
    .serialize({
      ...blastSuiVaultBcs.parse(BLAST_SUI_VAULT_GOLDEN_BYTES),
      fun_custody: {
        ...custody,
        liquid_sui: balance((1n << 64n) - 1n),
      },
    })
    .toBytes();

  assert.throws(
    () =>
      decodeBlastSuiVaultObject(vaultObject({ content }), originalPackageId),
    /assets must be a u64/,
  );
});

test("decodes an address-owned blast Sui deposit receipt", () => {
  const receipt = decodeBlastSuiDepositReceiptObject(
    {
      objectId: receiptId,
      owner: addressOwner(),
      type: `${originalPackageId}::deposit_receipt::BlastSuiDepositReceipt`,
      content: BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
    },
    originalPackageId,
  );

  assert.equal(receipt.objectId.endsWith("77"), true);
  assert.equal(receipt.owner.endsWith("beef"), true);
  assert.equal(receipt.originalPackageId.endsWith("0123"), true);
  assert.equal(receipt.vaultId.endsWith("44"), true);
  assert.equal(receipt.poolId.endsWith("55"), true);
  assert.equal(receipt.principalSui, 23n);
  assert.equal(receipt.activationEpoch, 12n);
});

test("rejects invalid receipt type, package, ownership, and identity", () => {
  assert.throws(
    () =>
      decodeBlastSuiDepositReceiptObject(
        {
          objectId: receiptId,
          owner: addressOwner(),
          type: `${originalPackageId}::wrong::BlastSuiDepositReceipt`,
          content: BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
        },
        originalPackageId,
      ),
    /not a blast Sui deposit receipt/,
  );
  assert.throws(
    () =>
      decodeBlastSuiDepositReceiptObject(
        {
          objectId: receiptId,
          owner: addressOwner(),
          type: `${originalPackageId}::deposit_receipt::BlastSuiDepositReceipt`,
          content: BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
        },
        "0x999",
      ),
    /unexpected package/,
  );
  assert.throws(
    () =>
      decodeBlastSuiDepositReceiptObject(
        {
          objectId: receiptId,
          owner: {
            $kind: "Shared",
            Shared: { initialSharedVersion: "1" },
          },
          type: `${originalPackageId}::deposit_receipt::BlastSuiDepositReceipt`,
          content: BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
        },
        originalPackageId,
      ),
    /must be address-owned/,
  );
  assert.throws(
    () =>
      decodeBlastSuiDepositReceiptObject(
        {
          objectId: receiptId,
          owner: addressOwner(),
          type: `${originalPackageId}::deposit_receipt::BlastSuiDepositReceipt`,
          content: serializeReceiptWithUid("0x88"),
        },
        originalPackageId,
      ),
    /mismatched UID/,
  );
});

test("requires original package identity at every exported object boundary", async () => {
  const receiptObject = {
    objectId: receiptId,
    owner: addressOwner(),
    type: `${originalPackageId}::deposit_receipt::BlastSuiDepositReceipt`,
    content: BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
  };
  // @ts-expect-error Original package identity is a required trust input.
  assert.throws(() => decodeBlastSuiVaultObject(vaultObject()), TypeError);
  assert.throws(
    // @ts-expect-error Original package identity is a required trust input.
    () => decodeBlastSuiDepositReceiptObject(receiptObject),
    TypeError,
  );

  const client = {
    core: {
      getObject: async ({ objectId }: { objectId: string }) => ({
        object:
          objectId === vaultId
            ? {
                objectId: vaultId,
                owner: {
                  $kind: "Shared" as const,
                  Shared: { initialSharedVersion: "7" },
                },
                type: `${originalPackageId}::vault::Vault`,
                content: BLAST_SUI_VAULT_GOLDEN_BYTES,
              }
            : receiptObject,
      }),
    },
  } as unknown as ClientWithCoreApi;
  // @ts-expect-error Original package identity is a required trust input.
  await assert.rejects(getBlastSuiVault(client, vaultId), TypeError);
  // @ts-expect-error Original package identity is a required trust input.
  await assert.rejects(getBlastSuiDepositReceipt(client, receiptId), TypeError);
});

test("reads vault and receipt state through the transport-neutral Core API", async () => {
  const requests: unknown[] = [];
  const client = {
    core: {
      getObject: async (options: { objectId: string }) => {
        requests.push(options);
        if (options.objectId === vaultId) {
          return {
            object: {
              objectId: vaultId,
              owner: {
                $kind: "Shared",
                Shared: { initialSharedVersion: "7" },
              },
              type: `${originalPackageId}::vault::Vault`,
              content: BLAST_SUI_VAULT_GOLDEN_BYTES,
            },
          };
        }
        return {
          object: {
            objectId: receiptId,
            owner: addressOwner(),
            type: `${originalPackageId}::deposit_receipt::BlastSuiDepositReceipt`,
            content: BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
          },
        };
      },
    },
  } as unknown as ClientWithCoreApi;

  const vault = await getBlastSuiVault(client, vaultId, originalPackageId);
  const receipt = await getBlastSuiDepositReceipt(
    client,
    receiptId,
    originalPackageId,
  );

  assert.equal(vault.initialSharedVersion, "7");
  assert.equal(receipt.owner.endsWith("beef"), true);
  assert.deepEqual(requests, [
    { objectId: vaultId, include: { content: true } },
    { objectId: receiptId, include: { content: true } },
  ]);
});

test("rejects a non-shared vault read", async () => {
  const client = {
    core: {
      getObject: async () => ({
        object: {
          objectId: vaultId,
          owner: addressOwner(),
          type: `${originalPackageId}::vault::Vault`,
          content: BLAST_SUI_VAULT_GOLDEN_BYTES,
        },
      }),
    },
  } as unknown as ClientWithCoreApi;

  await assert.rejects(
    getBlastSuiVault(client, vaultId, originalPackageId),
    /not a shared object/,
  );
});

function assertNormalizedSuffix(value: string, suffix: string): string {
  assert.equal(value.endsWith(suffix), true);
  return value;
}
