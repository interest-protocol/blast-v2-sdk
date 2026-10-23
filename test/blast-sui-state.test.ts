import assert from "node:assert/strict";
import test from "node:test";
import {
  blastSuiDepositReceiptBcs,
  blastSuiTreasuryCapBcs,
  blastSuiVaultBcs,
  decodeBlastSuiDepositReceiptObject,
  decodeBlastSuiVaultObject,
  getBlastSuiDepositReceipt,
  getBlastSuiVault,
} from "@interest-protocol/blast-sui-sdk/state";
import { TypeTagSerializer } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { deriveDynamicFieldID, normalizeSuiAddress } from "@mysten/sui/utils";
import {
  BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
  BLAST_SUI_VAULT_GOLDEN_BYTES,
  BLAST_TREASURY_CAP_GOLDEN_BYTES,
  FUN_TREASURY_CAP_GOLDEN_BYTES,
} from "./blast-sui-golden.ts";

const originalPackageId = "0x123";
const vaultId = "0x44";
const poolId = "0x55";
const receiptId = "0x77";
const receiptOwner = "0xbeef";
const funTreasuryCapId = "0xf1";
const blastTreasuryCapId = "0xb1";
const funCoinType = `${normalizeSuiAddress(originalPackageId)}::fun_sui::FUN_SUI`;
const blastCoinType = `${normalizeSuiAddress(originalPackageId)}::blast_sui::BLAST_SUI`;
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

function treasuryCapObjects(
  overrides: Partial<{
    funObjectId: string;
    funOwner: SuiClientTypes.ObjectOwner;
    funType: string;
    funContent: Uint8Array;
    blastObjectId: string;
    blastOwner: SuiClientTypes.ObjectOwner;
    blastType: string;
    blastContent: Uint8Array;
  }> = {},
) {
  return {
    fun: {
      objectId: overrides.funObjectId ?? funTreasuryCapId,
      owner: overrides.funOwner ?? treasuryCapOwner(funCoinType),
      type: overrides.funType ?? `0x2::coin::TreasuryCap<${funCoinType}>`,
      content: overrides.funContent ?? FUN_TREASURY_CAP_GOLDEN_BYTES,
    },
    blast: {
      objectId: overrides.blastObjectId ?? blastTreasuryCapId,
      owner: overrides.blastOwner ?? treasuryCapOwner(blastCoinType),
      type: overrides.blastType ?? `0x2::coin::TreasuryCap<${blastCoinType}>`,
      content: overrides.blastContent ?? BLAST_TREASURY_CAP_GOLDEN_BYTES,
    },
  };
}

function treasuryCapOwner(coinType: string): SuiClientTypes.ObjectOwner {
  const keyType = `${normalizeSuiAddress(originalPackageId)}::vault::TreasuryKey<${coinType}>`;
  const wrapperType = TypeTagSerializer.parseFromStr(
    `0x2::dynamic_object_field::Wrapper<${keyType}>`,
  );
  return {
    $kind: "ObjectOwner",
    ObjectOwner: deriveDynamicFieldID(
      vaultId,
      wrapperType,
      new Uint8Array([0]),
    ),
  };
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
  const vault = decodeBlastSuiVaultObject(
    vaultObject(),
    treasuryCapObjects(),
    originalPackageId,
  );

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
      () =>
        decodeBlastSuiVaultObject(
          vaultObject({ type }),
          treasuryCapObjects(),
          originalPackageId,
        ),
      /not a blast Sui vault/,
    );
  }
  assert.throws(
    () =>
      decodeBlastSuiVaultObject(vaultObject(), treasuryCapObjects(), "0x999"),
    /unexpected package/,
  );
  assert.throws(
    () =>
      decodeBlastSuiVaultObject(
        vaultObject({ content: serializeVaultWithUid("0x99") }),
        treasuryCapObjects(),
        originalPackageId,
      ),
    /mismatched UID/,
  );
  assert.throws(
    () =>
      decodeBlastSuiVaultObject(
        vaultObject({ mutable: false }),
        treasuryCapObjects(),
        originalPackageId,
      ),
    /must be mutable/,
  );
});

test("rejects a treasury cap with the wrong type, parent, or identity", () => {
  assert.throws(
    () =>
      decodeBlastSuiVaultObject(
        vaultObject(),
        treasuryCapObjects({ funType: `0x2::coin::TreasuryCap<u64>` }),
        originalPackageId,
      ),
    /is not the .*FUN_SUI TreasuryCap/,
  );
  assert.throws(
    () =>
      decodeBlastSuiVaultObject(
        vaultObject(),
        treasuryCapObjects({ funOwner: addressOwner() }),
        originalPackageId,
      ),
    /must be a child object/,
  );
  assert.throws(
    () =>
      decodeBlastSuiVaultObject(
        vaultObject(),
        treasuryCapObjects({
          funOwner: { $kind: "ObjectOwner", ObjectOwner: "0x999" },
        }),
        originalPackageId,
      ),
    /belongs to another parent/,
  );
  assert.throws(
    () =>
      decodeBlastSuiVaultObject(
        vaultObject(),
        treasuryCapObjects({
          funContent: blastSuiTreasuryCapBcs
            .serialize({ id: uid("0x88"), total_supply: { value: 100n } })
            .toBytes(),
        }),
        originalPackageId,
      ),
    /mismatched UID/,
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
      decodeBlastSuiVaultObject(
        vaultObject({ content }),
        treasuryCapObjects(),
        originalPackageId,
      ),
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
  assert.throws(
    // @ts-expect-error Original package identity is a required trust input.
    () => decodeBlastSuiVaultObject(vaultObject(), treasuryCapObjects()),
    TypeError,
  );
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
      getDynamicObjectField: async (options: { name: { type: string } }) => {
        requests.push(options);
        return {
          object: options.name.type.includes("fun_sui::FUN_SUI")
            ? treasuryCapObjects().fun
            : treasuryCapObjects().blast,
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
    {
      parentId: normalizeSuiAddress(vaultId),
      name: {
        type: `${normalizeSuiAddress(originalPackageId)}::vault::TreasuryKey<${funCoinType}>`,
        bcs: new Uint8Array([0]),
      },
      include: { content: true },
    },
    {
      parentId: normalizeSuiAddress(vaultId),
      name: {
        type: `${normalizeSuiAddress(originalPackageId)}::vault::TreasuryKey<${blastCoinType}>`,
        bcs: new Uint8Array([0]),
      },
      include: { content: true },
    },
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
      getDynamicObjectField: async (options: { name: { type: string } }) => ({
        object: options.name.type.includes("fun_sui::FUN_SUI")
          ? treasuryCapObjects().fun
          : treasuryCapObjects().blast,
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
