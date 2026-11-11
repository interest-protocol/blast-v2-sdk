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
  FIXTURE_POOL_0,
  FIXTURE_POOL_2,
  FIXTURE_RECEIPT_ID,
  FIXTURE_VAULT_ID,
  FUN_TREASURY_CAP_GOLDEN_BYTES,
} from "./blast-sui-golden.ts";

const originalPackageId = "0x123";
const vaultId = FIXTURE_VAULT_ID;
const receiptId = FIXTURE_RECEIPT_ID;
const receiptOwner = "0xbeef";
const funTreasuryCapId = "0xf1";
const blastTreasuryCapId = "0xb1";
const funCoinType = `${normalizeSuiAddress(originalPackageId)}::fun_sui::FUN_SUI`;
const blastCoinType = `${normalizeSuiAddress(originalPackageId)}::blast_sui::BLAST_SUI`;
const goldenVault = () => blastSuiVaultBcs.parse(BLAST_SUI_VAULT_GOLDEN_BYTES);
type ParsedVault = ReturnType<typeof goldenVault>;

function vaultBytes(update: (vault: ParsedVault) => ParsedVault): Uint8Array {
  return blastSuiVaultBcs.serialize(update(goldenVault())).toBytes();
}

function treasuryCapObjects(
  overrides: Partial<{
    funObjectId: string;
    funOwner: SuiClientTypes.ObjectOwner;
    funType: string;
    funContent: Uint8Array;
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
      objectId: blastTreasuryCapId,
      owner: treasuryCapOwner(blastCoinType),
      type: `0x2::coin::TreasuryCap<${blastCoinType}>`,
      content: BLAST_TREASURY_CAP_GOLDEN_BYTES,
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

function decodeVault(content: Uint8Array) {
  return decodeBlastSuiVaultObject(
    vaultObject({ content }),
    treasuryCapObjects(),
    originalPackageId,
  );
}

function receiptObject(
  overrides: Partial<{
    owner: SuiClientTypes.ObjectOwner;
    type: string;
    content: Uint8Array;
  }> = {},
) {
  return {
    objectId: receiptId,
    owner: addressOwner(),
    type: `${originalPackageId}::deposit_receipt::BlastSuiDepositReceipt`,
    content: BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
    ...overrides,
  };
}

function addressOwner(address = receiptOwner): SuiClientTypes.ObjectOwner {
  return { $kind: "AddressOwner", AddressOwner: address };
}

test("decodes the Move-printed vault: list, admissions, rates, custody and fee", () => {
  const vault = decodeBlastSuiVaultObject(
    vaultObject(),
    treasuryCapObjects(),
    originalPackageId,
  );

  assert.deepEqual(vault, {
    objectId: vaultId,
    initialSharedVersion: "7",
    mutable: true,
    originalPackageId: normalizeSuiAddress(originalPackageId),
    pools: [FIXTURE_POOL_0],
    validatorDelayMs: 0n,
    pendingValidatorDelay: { delay_ms: 172_800_000n, ready_at_ms: 1_000n },
    pendingValidators: {
      [FIXTURE_POOL_2]: { delay_ms: 0n, ready_at_ms: 1_000n },
    },
    poolRates: {
      [FIXTURE_POOL_0]: {
        epoch: 3n,
        suiAmount: 1_333_600_113_000_000_000n,
        poolTokenAmount: 113_000_000_000n,
      },
    },
    funSupply: 1_000_000_000n,
    blastSupply: 11_608_695_652n,
    funCustody: {
      liquidSui: 100_000_000n,
      positions: {
        [FIXTURE_POOL_0]: {
          pendingStakes: [
            {
              objectId:
                "0x3452df74783079d84e1ef8aa28642780481fe22f7ce5119edf2e1164ef0d619b",
              activationEpoch: 4n,
              principalSui: 1_010_063_923n,
            },
          ],
          activeStake: null,
          activeSui: 0n,
        },
      },
      assets: 1_110_063_923n,
    },
    blastCustody: {
      liquidSui: 0n,
      positions: {
        [FIXTURE_POOL_0]: {
          pendingStakes: [
            {
              objectId:
                "0x42568fe4464ad65562a3e7905754a3ef522b7d52c1e92dc942a341c56f084dd7",
              activationEpoch: 4n,
              principalSui: 45_097_586_039_384_697n,
            },
          ],
          activeStake: {
            objectId:
              "0x3d47c5715023c4a683948bc92a60a33c833d60ad28f366cfd6919b2a68b17648",
            poolTokens: 11_666_167_218n,
          },
          activeSui: 137_681_432_922_138_899n,
        },
      },
      assets: 45_097_586_039_384_697n + 137_681_432_922_138_899n,
    },
    redeemFeeBps: 2n,
    redeemFeeDelayMs: 172_800_000n,
    pendingRedeemFee: {
      value: 7n,
      delay_ms: 172_800_000n,
      ready_at_ms: 172_801_000n,
    },
    // The validator delay is still zero and pool 2's admission is pending.
    unpauseAllowed: false,
  });
  // The SDK layout re-encodes the Move bytes exactly.
  assert.deepEqual(
    blastSuiVaultBcs.serialize(goldenVault()).toBytes(),
    BLAST_SUI_VAULT_GOLDEN_BYTES,
  );
});

test("allows unpause only while both delays are guarded and no admission is pending", () => {
  const guarded = (vault: ParsedVault): ParsedVault => ({
    ...vault,
    validators: {
      ...vault.validators,
      delay_ms: 172_800_000n,
      admissions: [],
      pending_delay: null,
    },
  });
  assert.equal(decodeVault(vaultBytes(guarded)).unpauseAllowed, true);

  const unguarded: Array<(vault: ParsedVault) => ParsedVault> = [
    // The fixture's pending admission.
    (vault) => ({
      ...guarded(vault),
      validators: {
        ...guarded(vault).validators,
        admissions: vault.validators.admissions,
      },
    }),
    // A zero validator delay.
    (vault) => ({
      ...guarded(vault),
      validators: { ...guarded(vault).validators, delay_ms: 0n },
    }),
    // A pending validator delay of zero.
    (vault) => ({
      ...guarded(vault),
      validators: {
        ...guarded(vault).validators,
        pending_delay: { delay_ms: 0n, ready_at_ms: 1n },
      },
    }),
    // A zero fee delay.
    (vault) => ({
      ...guarded(vault),
      redeem_fee: { ...vault.redeem_fee, delay_ms: 0n },
    }),
    // A pending fee that would set the fee delay to zero.
    (vault) => ({
      ...guarded(vault),
      redeem_fee: {
        ...vault.redeem_fee,
        pending: { value: 7n, delay_ms: 0n, ready_at_ms: 1n },
      },
    }),
  ];
  for (const update of unguarded) {
    assert.equal(decodeVault(vaultBytes(update)).unpauseAllowed, false);
  }

  const noPendingFee = decodeVault(
    vaultBytes((vault) => ({
      ...vault,
      redeem_fee: { ...vault.redeem_fee, pending: null },
    })),
  );
  assert.equal(noPendingFee.pendingRedeemFee, null);
});

test("rejects a vault whose delayed values name another parent", () => {
  const other = normalizeSuiAddress("0x99");
  for (const update of [
    (vault: ParsedVault): ParsedVault => ({
      ...vault,
      validators: { ...vault.validators, parent: other },
    }),
    (vault: ParsedVault): ParsedVault => ({
      ...vault,
      redeem_fee: { ...vault.redeem_fee, parent: other },
    }),
  ]) {
    assert.throws(
      () => decodeVault(vaultBytes(update)),
      (error: unknown) =>
        error instanceof TypeError && /mismatched parent/.test(error.message),
    );
  }
});

test("rejects a fee outside basis points and a custody total over u64", () => {
  assert.throws(
    () =>
      decodeVault(
        vaultBytes((vault) => ({
          ...vault,
          redeem_fee: { ...vault.redeem_fee, value: 10_001n },
        })),
      ),
    /redeemFeeBps/,
  );
  assert.throws(
    () =>
      decodeVault(
        vaultBytes((vault) => ({
          ...vault,
          redeem_fee: {
            ...vault.redeem_fee,
            pending: { value: 10_001n, delay_ms: 1n, ready_at_ms: 1n },
          },
        })),
      ),
    /pendingRedeemFee/,
  );
  assert.throws(
    () =>
      decodeVault(
        vaultBytes((vault) => ({
          ...vault,
          fun_custody: {
            ...vault.fun_custody,
            liquid_sui: { value: ((1n << 64n) - 1n).toString() },
          },
        })),
      ),
    /funCustody.assets must be a u64/,
  );
});

test("decodes custody with several positions and an empty ledger", () => {
  const pool = normalizeSuiAddress("0x55");
  const vault = decodeVault(
    vaultBytes((parsed) => {
      const [entry] = parsed.blast_custody.positions.contents;
      assert.ok(entry);
      return {
        ...parsed,
        fun_custody: {
          liquid_sui: { value: "5" },
          positions: { contents: [] },
        },
        blast_custody: {
          ...parsed.blast_custody,
          positions: {
            contents: [
              entry,
              {
                key: pool,
                value: {
                  pending_stakes: [],
                  active_stake: null,
                  active_sui: "9",
                },
              },
            ],
          },
        },
      };
    }),
  );
  assert.deepEqual(vault.funCustody, {
    liquidSui: 5n,
    positions: {},
    assets: 5n,
  });
  assert.deepEqual(Object.keys(vault.blastCustody.positions), [
    FIXTURE_POOL_0,
    pool,
  ]);
  assert.equal(
    vault.blastCustody.assets,
    45_097_586_039_384_697n + 137_681_432_922_138_899n + 9n,
  );
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
      decodeVault(
        vaultBytes((vault) => ({
          ...vault,
          id: { id: { bytes: normalizeSuiAddress("0x99") } },
        })),
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
            .serialize({
              id: { id: { bytes: "0x88" } },
              total_supply: { value: 1n },
            })
            .toBytes(),
        }),
        originalPackageId,
      ),
    /mismatched UID/,
  );
});

test("decodes the Move-printed deposit receipt", () => {
  const receipt = decodeBlastSuiDepositReceiptObject(
    receiptObject(),
    originalPackageId,
  );

  assert.deepEqual(receipt, {
    objectId: receiptId,
    owner: normalizeSuiAddress(receiptOwner),
    originalPackageId: normalizeSuiAddress(originalPackageId),
    vaultId,
    poolId: FIXTURE_POOL_0,
    principalSui: 3_000_000_000n,
    activationEpoch: 2n,
  });
  assert.deepEqual(
    blastSuiDepositReceiptBcs
      .serialize(
        blastSuiDepositReceiptBcs.parse(BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES),
      )
      .toBytes(),
    BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
  );
});

test("rejects invalid receipt type, package, ownership, and identity", () => {
  assert.throws(
    () =>
      decodeBlastSuiDepositReceiptObject(
        receiptObject({
          type: `${originalPackageId}::wrong::BlastSuiDepositReceipt`,
        }),
        originalPackageId,
      ),
    /not a blast Sui deposit receipt/,
  );
  assert.throws(
    () => decodeBlastSuiDepositReceiptObject(receiptObject(), "0x999"),
    /unexpected package/,
  );
  assert.throws(
    () =>
      decodeBlastSuiDepositReceiptObject(
        receiptObject({
          owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
        }),
        originalPackageId,
      ),
    /must be address-owned/,
  );
  const parsed = blastSuiDepositReceiptBcs.parse(
    BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES,
  );
  assert.throws(
    () =>
      decodeBlastSuiDepositReceiptObject(
        receiptObject({
          content: blastSuiDepositReceiptBcs
            .serialize({ ...parsed, id: { id: { bytes: "0x88" } } })
            .toBytes(),
        }),
        originalPackageId,
      ),
    /mismatched UID/,
  );
});

test("requires original package identity at every exported object boundary", async () => {
  assert.throws(
    // @ts-expect-error Original package identity is a required trust input.
    () => decodeBlastSuiVaultObject(vaultObject(), treasuryCapObjects()),
    TypeError,
  );
  assert.throws(
    // @ts-expect-error Original package identity is a required trust input.
    () => decodeBlastSuiDepositReceiptObject(receiptObject()),
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
            : receiptObject(),
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
        return { object: receiptObject() };
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
  assert.deepEqual(vault.pools, [FIXTURE_POOL_0]);
  assert.equal(receipt.owner, normalizeSuiAddress(receiptOwner));
  assert.deepEqual(requests, [
    { objectId: vaultId, include: { content: true } },
    {
      parentId: vaultId,
      name: {
        type: `${normalizeSuiAddress(originalPackageId)}::vault::TreasuryKey<${funCoinType}>`,
        bcs: new Uint8Array([0]),
      },
      include: { content: true },
    },
    {
      parentId: vaultId,
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
