import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
  toHex,
} from "@mysten/sui/utils";
import { itemAt } from "../arrays.ts";
import {
  addressBcs,
  suiBalanceBcs,
  suiIdBcs,
  suiUidBcs,
  u64Bcs,
} from "../bcs.ts";
import type { SharedObjectReference } from "../sui.ts";
import { MAX_REWARD_LEAVES, rewardAddress } from "./allocations.ts";

const hexBytesBcs = bcs.byteVector().transform({
  input: (hex: string) => fromHex(hex),
  output: (bytes) => toHex(bytes),
});

/**
 * `RoundTerms` of both `blast_fun_migrators::vault` and
 * `blast_presale::presale_vault`: a scheduled holder-reward round, waiting in
 * its vault's `round_publication`. `claim_window_duration_ms` starts at
 * publication. Digests decode to lowercase hex without a prefix.
 */
export const rewardRoundTermsBcs = bcs.struct("RoundTerms", {
  number: u64Bcs,
  start_checkpoint: u64Bcs,
  end_checkpoint: u64Bcs,
  root: hexBytesBcs,
  manifest_digest: hexBytesBcs,
  leaf_count: u64Bcs,
  meme_amount: u64Bcs,
  quote_amount: u64Bcs,
  gas_reserve_amount: u64Bcs,
  claim_window_duration_ms: u64Bcs,
  expected_treasury: addressBcs,
});

export type RewardRoundTerms = ReturnType<typeof rewardRoundTermsBcs.parse>;

/** BCS layout of `blast_fun_migrators::blast_holder_rewards::Round<Meme, Quote>`. */
export const rewardRoundBcs = bcs.struct("Round", {
  id: suiUidBcs,
  vault: suiIdBcs,
  number: bcs.u64(),
  claim_deadline_at_ms: bcs.u64(),
  root: bcs.vector(bcs.u8()),
  leaf_count: bcs.u64(),
  claimed: bcs.vector(bcs.u256()),
  meme: suiBalanceBcs,
  quote: suiBalanceBcs,
  treasury: bcs.Address,
  gas_reserve: bcs.option(suiBalanceBcs),
});

export type RewardRoundObject = SharedObjectReference<true> & {
  type: string;
  content: Uint8Array;
};

/**
 * Decodes one shared holder-reward round published from an LP vault. Its
 * checkpoints and manifest digest are in its `RoundPublished` event.
 */
export function decodeRewardRound(
  object: RewardRoundObject,
  migratorsOriginalPackageId: string,
) {
  const tag = parseStructTag(object.type);
  const [memeType, quoteType, ...extra] = tag.typeParams;
  if (
    normalizeSuiAddress(tag.address) !==
      rewardAddress(migratorsOriginalPackageId) ||
    tag.module !== "blast_holder_rewards" ||
    tag.name !== "Round" ||
    memeType === undefined ||
    quoteType === undefined ||
    extra.length > 0 ||
    object.mutable !== true
  ) {
    throw new Error("invalid holder-reward round type");
  }
  const decoded = rewardRoundBcs.parse(object.content);
  if (
    rewardRoundBcs.serialize(decoded).toBytes().length !== object.content.length
  ) {
    throw new Error("invalid holder-reward round BCS length");
  }
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
    memeType: normalizeStructTag(memeType),
    quoteType: normalizeStructTag(quoteType),
    vaultId: rewardAddress(decoded.vault.bytes),
    number: BigInt(decoded.number),
    claimDeadlineMs: BigInt(decoded.claim_deadline_at_ms),
    treasury: rewardAddress(decoded.treasury),
    gasReserveRemaining:
      decoded.gas_reserve === null ? null : BigInt(decoded.gas_reserve.value),
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
  const word = itemAt(round.claimed, Math.floor(index / 256));
  return (word & (1n << BigInt(index % 256))) !== 0n;
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
