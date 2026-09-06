import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";
import type { DexPositionEconomics } from "../dex/math.ts";
import { previewDexDeposit, previewDexPositionFees } from "../dex/math.ts";
import type { DexPoolState, DexSharedObject } from "../dex/state.ts";
import {
  assertDexObjectType,
  assertDexUid,
  decodeDexPosition,
  readDexSharedObject,
} from "../dex/state.ts";
import { suiBalanceBcs, suiIdBcs, suiUidBcs } from "../lib/bcs.ts";
import { normalizePositiveU64, requireU64 } from "../lib/integers.ts";

export const autoLpControlBcs = bcs.struct("Control", {
  id: suiUidBcs,
  version: bcs.u64(),
});
export const autoLpVaultBcs = bcs.struct("Vault", {
  id: suiUidBcs,
  pool_id: suiIdBcs,
  executor: bcs.Address,
  meme: suiBalanceBcs,
  quote: suiBalanceBcs,
});
export function decodeAutoLpControl(
  object: DexSharedObject,
  originalPackageId: string,
) {
  assertDexObjectType(object, originalPackageId, "vault", "Control", 0);
  const value = autoLpControlBcs.parse(object.content);
  assertDexUid(object.objectId, value.id.id.bytes);
  return {
    objectId: normalizeSuiObjectId(object.objectId),
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    version: BigInt(value.version),
  };
}
export function decodeAutoLpVault(
  object: DexSharedObject,
  originalPackageId: string,
) {
  const pair = assertDexObjectType(
    object,
    originalPackageId,
    "vault",
    "Vault",
    2,
  );
  const value = autoLpVaultBcs.parse(object.content);
  assertDexUid(object.objectId, value.id.id.bytes);
  if (BigInt(value.executor) === 0n)
    throw new TypeError("invalid zero executor");
  return {
    objectId: normalizeSuiObjectId(object.objectId),
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    ...pair,
    poolId: normalizeSuiObjectId(value.pool_id.bytes),
    executor: normalizeSuiAddress(value.executor),
    memeAmount: BigInt(value.meme.value),
    quoteAmount: BigInt(value.quote.value),
  };
}
export type AutoLpVaultState = ReturnType<typeof decodeAutoLpVault>;
export async function getAutoLpVault(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
) {
  return decodeAutoLpVault(
    await readDexSharedObject(client, objectId),
    originalPackageId,
  );
}
export async function getAutoLpControl(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
) {
  return decodeAutoLpControl(
    await readDexSharedObject(client, objectId),
    originalPackageId,
  );
}
export async function getAutoLpPosition(
  client: ClientWithCoreApi,
  vaultId: string,
  originalPackageId: string,
  dexOriginalPackageId: string,
) {
  const vault = await getAutoLpVault(client, vaultId, originalPackageId);
  const { object } = await client.core.getDynamicObjectField({
    parentId: vault.objectId,
    name: {
      type: `${normalizeSuiAddress(originalPackageId)}::vault::PositionKey`,
      bcs: Uint8Array.of(0),
    },
    include: { content: true },
  });
  const position = decodeDexPosition(object, dexOriginalPackageId);
  if (
    position.poolId !== vault.poolId ||
    position.memeType !== vault.memeType ||
    position.quoteType !== vault.quoteType
  )
    throw new TypeError("AutoLP position pool or pair mismatch");
  return { ...position, owner: object.owner };
}
export async function getAutoLpCreatorCap(
  client: ClientWithCoreApi,
  vaultId: string,
  originalPackageId: string,
  launchpadOriginalPackageId: string,
) {
  const vault = await getAutoLpVault(client, vaultId, originalPackageId);
  const { object } = await client.core.getDynamicObjectField({
    parentId: vault.objectId,
    name: {
      type: `${normalizeSuiAddress(originalPackageId)}::vault::CreatorCapKey`,
      bcs: Uint8Array.of(0),
    },
    include: { content: true },
  });
  const expected = normalizeStructTag(
    `${normalizeSuiAddress(launchpadOriginalPackageId)}::creator_authority::CreatorCap<${vault.memeType}>`,
  );
  if (normalizeStructTag(object.type) !== expected)
    throw new TypeError("unexpected AutoLP creator capability type");
  assertDexUid(object.objectId, suiUidBcs.parse(object.content).id.bytes);
  return object;
}
/** Snapshot preview only: pending atoms plus own LP fees, ceil contributions and retained refunds.
 * The executor must independently approve timing and limits; this is not an oracle or authorization. */
export function previewAutoLpCompound(
  vault: AutoLpVaultState,
  pool: DexPoolState,
  position: DexPositionEconomics & { poolId: string },
) {
  if (
    normalizeSuiObjectId(vault.poolId) !== pool.objectId ||
    normalizeSuiObjectId(position.poolId) !== pool.objectId ||
    vault.memeType !== pool.memeType ||
    vault.quoteType !== pool.quoteType
  )
    throw new TypeError("AutoLP pool or pair mismatch");
  const ownQuoteFees = previewDexPositionFees(pool, position).quote;
  const quote = requireU64(
    "pending Quote plus fees",
    vault.quoteAmount + ownQuoteFees,
  );
  const result = previewDexDeposit(pool, vault.memeAmount, quote);
  return { ...result, ownQuoteFees, willSkip: result.shares === 0n };
}
