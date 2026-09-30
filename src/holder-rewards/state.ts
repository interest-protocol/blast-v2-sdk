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

/** BCS layout of `blast_fun_migrators::blast_holder_rewards::Round<Meme, Quote>`. */
export const rewardRoundBcs = bcs.struct("Round", {
  id: suiUidBcs,
  vault: suiIdBcs,
  number: bcs.u64(),
  root: bcs.vector(bcs.u8()),
  leaf_count: bcs.u64(),
  claimed: bcs.vector(bcs.u256()),
  meme: suiBalanceBcs,
  quote: suiBalanceBcs,
});

export type RewardRoundObject = SharedObjectReference<true> & {
  type: string;
  content: Uint8Array;
};

/** Decodes one shared holder-reward round published from an LP vault. */
export function decodeRewardRound(
  object: RewardRoundObject,
  migratorsOriginalPackageId: string,
) {
  const tag = parseStructTag(object.type);
  if (
    normalizeSuiAddress(tag.address) !==
      rewardAddress(migratorsOriginalPackageId) ||
    tag.module !== "blast_holder_rewards" ||
    tag.name !== "Round" ||
    tag.typeParams.length !== 2 ||
    object.mutable !== true
  ) {
    throw new Error("invalid holder-reward round type");
  }
  const decoded = rewardRoundBcs.parse(object.content);
  if (rewardAddress(object.objectId) !== rewardAddress(decoded.id.id.bytes)) {
    throw new Error("object UID mismatch");
  }
  const leafCount = Number(decoded.leaf_count);
  if (
    !Number.isInteger(leafCount) ||
    leafCount < 1 ||
    leafCount > MAX_REWARD_LEAVES ||
    decoded.claimed.length !== Math.ceil(leafCount / 256) ||
    decoded.root.length !== 32
  ) {
    throw new Error("invalid round bounds");
  }
  return {
    ...object,
    memeType: normalizeStructTag(tag.typeParams[0]!),
    quoteType: normalizeStructTag(tag.typeParams[1]!),
    vaultId: rewardAddress(decoded.vault.bytes),
    number: BigInt(decoded.number),
    root: toHex(Uint8Array.from(decoded.root)),
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

export async function getRewardRound(
  client: ClientWithCoreApi,
  objectId: string,
  migratorsOriginalPackageId: string,
): Promise<RewardRoundState> {
  const { object } = await client.core.getObject({
    objectId: rewardAddress(objectId),
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared")
    throw new Error("holder-reward round must be shared");
  return decodeRewardRound(
    {
      objectId: object.objectId,
      type: object.type,
      content: object.content,
      mutable: true,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
    },
    migratorsOriginalPackageId,
  );
}
