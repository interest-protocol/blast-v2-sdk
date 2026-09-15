import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
  toHex,
} from "@mysten/sui/utils";
import { suiBalanceBcs, suiIdBcs, suiUidBcs } from "../lib/bcs.ts";
import type { SharedObjectReference } from "../lib/sui.ts";
import { MAX_REWARD_LEAVES, rewardAddress } from "./allocations.ts";

export const distributorVersionBcs = bcs.struct("Version", {
  id: suiUidBcs,
  version: bcs.u64(),
  paused: bcs.bool(),
});

export const distributorBcs = bcs.struct("Distributor", {
  id: suiUidBcs,
  launch: suiIdBcs,
  meme: suiBalanceBcs,
  quote: suiBalanceBcs,
  next_round: bcs.u64(),
  last_checkpoint: bcs.option(bcs.u64()),
});
export const rewardRoundBcs = bcs.struct("Round", {
  id: suiUidBcs,
  distributor: suiIdBcs,
  number: bcs.u64(),
  start_checkpoint: bcs.u64(),
  end_checkpoint: bcs.u64(),
  root: bcs.vector(bcs.u8()),
  manifest_digest: bcs.vector(bcs.u8()),
  leaf_count: bcs.u64(),
  claimed: bcs.vector(bcs.u256()),
  meme: suiBalanceBcs,
  quote: suiBalanceBcs,
});
export type DistributorObject = SharedObjectReference<true> & {
  type: string;
  content: Uint8Array;
};

/** Operational control is shared across all distributors and rounds in this lineage. */
export function decodeDistributorVersion(
  object: DistributorObject,
  originalPackageId: string,
) {
  const expected = normalizeStructTag(
    `${rewardAddress(originalPackageId)}::distributor::Version`,
  );
  if (normalizeStructTag(object.type) !== expected || object.mutable !== true)
    throw new Error("invalid distributor version type");
  const decoded = distributorVersionBcs.parse(object.content);
  assertUid(object.objectId, decoded.id.id.bytes);
  return {
    ...object,
    version: BigInt(decoded.version),
    paused: decoded.paused,
  };
}

export async function getDistributorVersion(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
) {
  return decodeDistributorVersion(
    await readShared(client, objectId),
    originalPackageId,
  );
}

/** Reads canonical custody and funding facts; never treats the mere existence of a label as enrollment. */
export function decodeDistributor(
  object: DistributorObject,
  originalPackageId: string,
) {
  const pair = assertObjectType(object, originalPackageId, "Distributor");
  const decoded = distributorBcs.parse(object.content);
  assertUid(object.objectId, decoded.id.id.bytes);
  return {
    ...object,
    ...pair,
    launchId: decoded.launch.bytes,
    memeAmount: BigInt(decoded.meme.value),
    quoteAmount: BigInt(decoded.quote.value),
    nextRound: BigInt(decoded.next_round),
    lastCheckpoint:
      decoded.last_checkpoint === null ? null : BigInt(decoded.last_checkpoint),
  };
}
export type DistributorState = ReturnType<typeof decodeDistributor>;

export function decodeRewardRound(
  object: DistributorObject,
  originalPackageId: string,
) {
  const pair = assertObjectType(object, originalPackageId, "Round");
  const decoded = rewardRoundBcs.parse(object.content);
  assertUid(object.objectId, decoded.id.id.bytes);
  const leafCount = Number(decoded.leaf_count);
  if (
    !Number.isInteger(leafCount) ||
    leafCount < 1 ||
    leafCount > MAX_REWARD_LEAVES ||
    decoded.claimed.length !== Math.ceil(leafCount / 256) ||
    decoded.root.length !== 32 ||
    decoded.manifest_digest.length !== 32
  )
    throw new Error("invalid round bounds");
  return {
    ...object,
    ...pair,
    distributorId: decoded.distributor.bytes,
    number: BigInt(decoded.number),
    startCheckpoint: BigInt(decoded.start_checkpoint),
    endCheckpoint: BigInt(decoded.end_checkpoint),
    root: toHex(Uint8Array.from(decoded.root)),
    manifestDigest: toHex(Uint8Array.from(decoded.manifest_digest)),
    leafCount,
    claimed: decoded.claimed.map(BigInt),
    memeAmount: BigInt(decoded.meme.value),
    quoteAmount: BigInt(decoded.quote.value),
  };
}
export type RewardRoundState = ReturnType<typeof decodeRewardRound>;

export function rewardIsClaimed(
  round: Pick<RewardRoundState, "leafCount" | "claimed">,
  index: number,
): boolean {
  if (!Number.isSafeInteger(index) || index < 0 || index >= round.leafCount)
    throw new RangeError("claim index out of bounds");
  return (
    (round.claimed[Math.floor(index / 256)]! & (1n << BigInt(index % 256))) !==
    0n
  );
}

export async function getDistributor(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<DistributorState> {
  return decodeDistributor(
    await readShared(client, objectId),
    originalPackageId,
  );
}
export async function getRewardRound(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<RewardRoundState> {
  return decodeRewardRound(
    await readShared(client, objectId),
    originalPackageId,
  );
}

/** Resolves the actual child object through the framework's dynamic-object-field API. */
export async function getDistributorCreatorCap(
  client: ClientWithCoreApi,
  distributorId: string,
  originalPackageId: string,
  launchpadOriginalPackageId: string,
) {
  const distributor = await getDistributor(
    client,
    distributorId,
    originalPackageId,
  );
  const { object } = await client.core.getDynamicObjectField({
    parentId: distributor.objectId,
    name: {
      type: `${rewardAddress(originalPackageId)}::distributor::CreatorCapKey`,
      // Move unit structs serialize their dummy_field: bool.
      bcs: Uint8Array.of(0),
    },
  });
  const expected = normalizeStructTag(
    `${rewardAddress(launchpadOriginalPackageId)}::creator_authority::CreatorCap<${distributor.memeType}>`,
  );
  if (normalizeStructTag(object.type) !== expected)
    throw new Error("unexpected creator capability type");
  return object;
}

async function readShared(
  client: ClientWithCoreApi,
  objectId: string,
): Promise<DistributorObject> {
  const { object } = await client.core.getObject({
    objectId: rewardAddress(objectId),
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared")
    throw new Error("distributor state must be shared");
  return {
    objectId: object.objectId,
    type: object.type,
    content: object.content,
    mutable: true,
    initialSharedVersion: object.owner.Shared.initialSharedVersion,
  };
}
function assertObjectType(
  object: DistributorObject,
  packageId: string,
  name: string,
) {
  const tag = parseStructTag(object.type);
  if (normalizeSuiAddress(tag.address) !== rewardAddress(packageId))
    throw new Error("unexpected distributor package");
  if (
    tag.module !== "distributor" ||
    tag.name !== name ||
    tag.typeParams.length !== 2 ||
    object.mutable !== true
  )
    throw new Error("invalid distributor object type");
  return {
    memeType: normalizeStructTag(tag.typeParams[0]!),
    quoteType: normalizeStructTag(tag.typeParams[1]!),
  };
}
function assertUid(expected: string, actual: string) {
  if (rewardAddress(expected) !== rewardAddress(actual))
    throw new Error("object UID mismatch");
}
