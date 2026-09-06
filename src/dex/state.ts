import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";
import {
  moveTypeNameBcs,
  suiBalanceBcs,
  suiIdBcs,
  suiUidBcs,
} from "../lib/bcs.ts";
import { normalizePositiveU64 } from "../lib/integers.ts";
import type { SharedObjectIdentity } from "../lib/sui.ts";

export const dexPoolBcs = bcs.struct("Pool", {
  id: suiUidBcs,
  meme: suiBalanceBcs,
  quote: suiBalanceBcs,
  quote_fees: suiBalanceBcs,
  total_shares: bcs.u128(),
  fee_growth_x64: bcs.u128(),
  volume_x32: bcs.u128(),
  last_trade_seconds: bcs.u64(),
  volume_target: bcs.u64(),
  max_fee_bps: bcs.u64(),
  burn_bps: bcs.u64(),
});
export const dexPositionBcs = bcs.struct("Position", {
  id: suiUidBcs,
  pool_id: suiIdBcs,
  shares: bcs.u128(),
  fee_checkpoint_x64: bcs.u128(),
  fees_owed: bcs.u64(),
  fee_fraction_x64: bcs.u64(),
});
export const dexFactoryBcs = bcs.struct("Factory", {
  id: suiUidBcs,
  version: bcs.u64(),
  pools: bcs.struct("Table", { id: suiUidBcs, size: bcs.u64() }),
});
export const nativeLpVaultBcs = bcs.struct("LockedLpVault", {
  id: suiUidBcs,
  pool_id: suiIdBcs,
  fees: bcs.struct("FeeLedger", {
    protocol_meme: suiBalanceBcs,
    creator_meme: suiBalanceBcs,
    protocol_quote: suiBalanceBcs,
    creator_quote: suiBalanceBcs,
  }),
});
export type DexObject = { objectId: string; type: string; content: Uint8Array };
export type DexSharedObject = DexObject & SharedObjectIdentity;

/** Requires original type lineage; execution package IDs are deliberately separate. */
export function decodeDexPool(
  object: DexSharedObject,
  originalPackageId: string,
) {
  const pair = assertDexObjectType(
    object,
    originalPackageId,
    "pool",
    "Pool",
    2,
  );
  const value = dexPoolBcs.parse(object.content);
  assertDexUid(object.objectId, value.id.id.bytes);
  return {
    ...sharedMetadata(object),
    ...pair,
    originalPackageId: normalizeSuiAddress(originalPackageId),
    memeReserve: BigInt(value.meme.value),
    quoteReserve: BigInt(value.quote.value),
    quoteFees: BigInt(value.quote_fees.value),
    totalShares: BigInt(value.total_shares),
    feeGrowthX64: BigInt(value.fee_growth_x64),
    volumeX32: BigInt(value.volume_x32),
    lastTradeSeconds: BigInt(value.last_trade_seconds),
    volumeTarget: BigInt(value.volume_target),
    maxFeeBps: BigInt(value.max_fee_bps),
    burnBps: BigInt(value.burn_bps),
  };
}
export type DexPoolState = ReturnType<typeof decodeDexPool>;

export function decodeDexPosition(
  object: DexObject,
  originalPackageId: string,
) {
  const pair = assertDexObjectType(
    object,
    originalPackageId,
    "pool",
    "Position",
    2,
  );
  const value = dexPositionBcs.parse(object.content);
  assertDexUid(object.objectId, value.id.id.bytes);
  return {
    objectId: normalizeSuiObjectId(object.objectId),
    ...pair,
    poolId: normalizeSuiObjectId(value.pool_id.bytes),
    shares: BigInt(value.shares),
    feeCheckpointX64: BigInt(value.fee_checkpoint_x64),
    feesOwed: BigInt(value.fees_owed),
    feeFractionX64: BigInt(value.fee_fraction_x64),
  };
}
export type DexPositionState = ReturnType<typeof decodeDexPosition>;

export function decodeDexFactory(
  object: DexSharedObject,
  originalPackageId: string,
) {
  assertDexObjectType(object, originalPackageId, "pool", "Factory", 0);
  const value = dexFactoryBcs.parse(object.content);
  assertDexUid(object.objectId, value.id.id.bytes);
  return {
    ...sharedMetadata(object),
    version: BigInt(value.version),
    poolsTableId: normalizeSuiObjectId(value.pools.id.id.bytes),
    poolCount: BigInt(value.pools.size),
  };
}
export function decodeNativeLpVault(
  object: DexSharedObject,
  originalPackageId: string,
) {
  const pair = assertDexObjectType(
    object,
    originalPackageId,
    "migration",
    "LockedLpVault",
    2,
  );
  const value = nativeLpVaultBcs.parse(object.content);
  assertDexUid(object.objectId, value.id.id.bytes);
  return {
    ...sharedMetadata(object),
    ...pair,
    poolId: normalizeSuiObjectId(value.pool_id.bytes),
    protocolMemeFees: BigInt(value.fees.protocol_meme.value),
    creatorMemeFees: BigInt(value.fees.creator_meme.value),
    protocolQuoteFees: BigInt(value.fees.protocol_quote.value),
    creatorQuoteFees: BigInt(value.fees.creator_quote.value),
  };
}
export type NativeLpVaultState = ReturnType<typeof decodeNativeLpVault>;

export async function getDexPool(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
) {
  return decodeDexPool(
    await readDexSharedObject(client, objectId),
    originalPackageId,
  );
}
export async function getDexFactory(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
) {
  return decodeDexFactory(
    await readDexSharedObject(client, objectId),
    originalPackageId,
  );
}
export async function getNativeLpVault(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
) {
  return decodeNativeLpVault(
    await readDexSharedObject(client, objectId),
    originalPackageId,
  );
}
export async function getDexPosition(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
) {
  const { object } = await client.core.getObject({
    objectId: normalizeSuiObjectId(objectId),
    include: { content: true },
  });
  return {
    ...decodeDexPosition(object, originalPackageId),
    owner: object.owner,
  };
}
/** Reads the canonical registry using the original Meme type, then validates the returned pool pair. */
export async function getCanonicalDexPool(
  client: ClientWithCoreApi,
  factoryId: string,
  originalMemeType: string,
  originalPackageId: string,
) {
  const factory = await getDexFactory(client, factoryId, originalPackageId);
  const meme = normalizeStructTag(originalMemeType);
  const { dynamicField } = await client.core.getDynamicField({
    parentId: factory.poolsTableId,
    name: {
      type: "0x1::type_name::TypeName",
      bcs: moveTypeNameBcs
        .serialize(meme.replace(/0x([0-9a-f]{64})::/g, "$1::"))
        .toBytes(),
    },
  });
  if (
    normalizeStructTag(dynamicField.value.type) !==
    normalizeStructTag("0x2::object::ID")
  )
    throw new TypeError("canonical pool registry has unexpected value type");
  const pool = await getDexPool(
    client,
    suiIdBcs.parse(dynamicField.value.bcs).bytes,
    originalPackageId,
  );
  if (pool.memeType !== meme)
    throw new TypeError("canonical pool registry Meme mismatch");
  return pool;
}
export async function getNativeLpPosition(
  client: ClientWithCoreApi,
  vaultId: string,
  originalPackageId: string,
) {
  const vault = await getNativeLpVault(client, vaultId, originalPackageId);
  const { object } = await client.core.getDynamicObjectField({
    parentId: vault.objectId,
    name: {
      type: `${normalizeSuiAddress(originalPackageId)}::migration::PositionKey`,
      bcs: Uint8Array.of(0),
    },
    include: { content: true },
  });
  const position = decodeDexPosition(object, originalPackageId);
  if (
    position.poolId !== vault.poolId ||
    position.memeType !== vault.memeType ||
    position.quoteType !== vault.quoteType
  )
    throw new TypeError("locked position pool or pair mismatch");
  return { ...position, owner: object.owner };
}

/** Shared read helper reused by the dependent AutoLP adapter. */
export async function readDexSharedObject(
  client: ClientWithCoreApi,
  objectId: string,
): Promise<DexSharedObject> {
  const { object } = await client.core.getObject({
    objectId: normalizeSuiObjectId(objectId),
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared")
    throw new TypeError("expected shared object custody");
  return {
    objectId: object.objectId,
    type: object.type,
    content: object.content,
    initialSharedVersion: object.owner.Shared.initialSharedVersion,
  };
}
export function assertDexObjectType(
  object: DexObject,
  originalPackageId: string,
  module: string,
  name: string,
  parameters: 0 | 2,
) {
  const tag = parseStructTag(object.type);
  if (
    normalizeSuiAddress(tag.address) !== normalizeSuiAddress(originalPackageId)
  )
    throw new TypeError("unexpected object package");
  if (
    tag.module !== module ||
    tag.name !== name ||
    tag.typeParams.length !== parameters
  )
    throw new TypeError("unexpected object type");
  const types = tag.typeParams.map((type) => {
    if (typeof type === "string")
      throw new TypeError("coin type must be a struct");
    return normalizeStructTag(type);
  });
  if (parameters === 2 && types[0] === types[1])
    throw new TypeError("coin types must differ");
  return { memeType: types[0] ?? "", quoteType: types[1] ?? "" };
}
export function assertDexUid(expected: string, actual: string) {
  if (normalizeSuiObjectId(expected) !== normalizeSuiObjectId(actual))
    throw new TypeError("object UID mismatch");
}
function sharedMetadata(object: DexSharedObject) {
  return {
    objectId: normalizeSuiObjectId(object.objectId),
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
  };
}
