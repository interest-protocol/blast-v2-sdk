import type { RewardManifest } from "./allocations.ts";
import { validateRewardManifest } from "./allocations.ts";
import type { RewardRoundState } from "./state.ts";
import { rewardIsClaimed } from "./state.ts";

type RoundCommitment = Pick<
  RewardRoundState,
  "vaultId" | "number" | "root" | "leafCount"
>;

/**
 * A relayer must compare the public artifact with authoritative chain state
 * before paying. The root commits every leaf; the round object keeps no
 * checkpoints or manifest digest (its `RoundPublished` event does).
 */
export function assertRewardRoundMatchesManifest(
  round: RoundCommitment,
  manifest: RewardManifest,
): void {
  validateRewardManifest(manifest);
  if (
    round.vaultId !== manifest.vaultId ||
    round.number !== BigInt(manifest.number) ||
    round.root !== manifest.root ||
    round.leafCount !== manifest.allocations.length
  )
    throw new Error("manifest does not match funded round");
}

/** On-chain claimed bits own retry state; local transaction success logs do not. */
export function pendingRewardAllocations(
  round: RoundCommitment & Pick<RewardRoundState, "claimed">,
  manifest: RewardManifest,
) {
  assertRewardRoundMatchesManifest(round, manifest);
  return manifest.allocations.filter(
    (allocation) => !rewardIsClaimed(round, Number(allocation.index)),
  );
}
