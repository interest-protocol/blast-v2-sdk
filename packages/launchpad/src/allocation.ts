import { apportionBps, bpsBcs } from "@interest-protocol/blast-core/bps";
import {
  BASIS_POINTS_DENOMINATOR,
  requireBasisPoints,
} from "@interest-protocol/blast-core/integers";
import type { Recipient } from "@interest-protocol/blast-core/payout";
import { recipientBcs } from "@interest-protocol/blast-core/payout";
import { bcs } from "@mysten/sui/bcs";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

/** `constants::max_recipients`: most recipients one plan names; Blast's shares are separate. */
export const MAX_ALLOCATION_RECIPIENTS = 16;

/**
 * Mirrors `blast_fun::allocation::RecipientShare`: one core `Recipient`, paid
 * outright or vested at migration, with its shares of the Meme supply and of
 * the final Quote reserve.
 */
export type RecipientShare = {
  recipient: Recipient;
  memeBps: bigint;
  quoteBps: bigint;
};

/**
 * The creator's plan, the arguments of `allocation::plan`: Blast's shares are
 * not part of it.
 */
export type CreatorAllocationPlan = {
  curveMemeBps: bigint;
  lpMemeBps: bigint;
  lpQuoteBps: bigint;
  recipients: RecipientShare[];
};

/**
 * Mirrors `blast_fun::allocation::ProtocolAllocation`: Blast's one-time Meme
 * and Quote shares, snapshotted from `LaunchConfig` at finalization and accrued
 * as protocol fees in the launch ledger at migration.
 */
export type ProtocolAllocation = { memeBps: bigint; quoteBps: bigint };

/**
 * Mirrors `blast_fun::allocation::AllocationPlan`. `allocation::plan` stores
 * zero protocol shares; `launch::finalize` stores Blast's (see
 * `addProtocolAllocation`), so a launch object's plan carries them.
 */
export type AllocationPlan = CreatorAllocationPlan & {
  protocolMemeBps: bigint;
  protocolQuoteBps: bigint;
};

/** Exact Meme amounts of one apportioned supply. */
export type AllocationMemeAmounts = {
  curve: bigint;
  lp: bigint;
  /** Blast's one-time Meme fee; rounds up. */
  protocol: bigint;
  /** Aligned with `plan.recipients`. */
  recipients: bigint[];
};

/** Exact Quote amounts of one apportioned final reserve. */
export type AllocationQuoteAmounts = {
  lp: bigint;
  /** Blast's one-time Quote fee; rounds up. */
  protocol: bigint;
  /** Aligned with `plan.recipients`. */
  recipients: bigint[];
};

/** BCS layout of `blast_fun::allocation::RecipientShare`. */
export const recipientShareBcs = bcs.struct("RecipientShare", {
  recipient: recipientBcs,
  memeBps: bpsBcs,
  quoteBps: bpsBcs,
});
/** BCS layout of `blast_fun::allocation::AllocationPlan`. */
export const allocationPlanBcs = bcs.struct("AllocationPlan", {
  curveMemeBps: bpsBcs,
  lpMemeBps: bpsBcs,
  lpQuoteBps: bpsBcs,
  protocolMemeBps: bpsBcs,
  protocolQuoteBps: bpsBcs,
  recipients: bcs.vector(recipientShareBcs),
});
/** BCS layout of `blast_fun::allocation::ProtocolAllocation`. */
export const protocolAllocationBcs = bcs.struct("ProtocolAllocation", {
  memeBps: bpsBcs,
  quoteBps: bpsBcs,
});

/**
 * Checks a creator plan as `allocation::plan` and `payout::recipient` do:
 * positive curve and pool shares, nonzero destinations, recipient order kept,
 * and at most sixteen recipients (`add_protocol` at finalization). The sums
 * are checked once Blast's allocation is added (`addProtocolAllocation`).
 */
export function normalizeAllocationPlan(
  plan: CreatorAllocationPlan,
): CreatorAllocationPlan {
  const normalized = normalizeCreatorShares(plan);
  if (
    normalized.curveMemeBps === 0n ||
    normalized.lpMemeBps === 0n ||
    normalized.lpQuoteBps === 0n
  ) {
    throw new RangeError(
      "the curve and the pool need positive Meme shares and the pool needs positive Quote",
    );
  }
  if (normalized.recipients.length > MAX_ALLOCATION_RECIPIENTS) {
    throw new RangeError("an allocation plan names at most sixteen recipients");
  }
  return normalized;
}

/**
 * Mirrors `allocation::add_protocol`, which `launch::finalize` runs with the
 * `LaunchConfig` protocol allocation: the plan stores Blast's shares, and each
 * asset must then sum to 10,000 basis points.
 */
export function addProtocolAllocation(
  plan: CreatorAllocationPlan,
  protocol: ProtocolAllocation,
): AllocationPlan {
  return requireCompletePlan({
    ...normalizeAllocationPlan(plan),
    protocolMemeBps: protocol.memeBps,
    protocolQuoteBps: protocol.quoteBps,
  });
}

/**
 * Checks a plan with Blast's shares stored, such as
 * `LaunchState.allocationPlan`: at most sixteen recipients, and each asset
 * summing to 10,000 basis points.
 */
export function requireCompletePlan(plan: AllocationPlan): AllocationPlan {
  const normalized: AllocationPlan = {
    ...normalizeCreatorShares(plan),
    protocolMemeBps: requireBasisPoints(
      "protocolMemeBps",
      plan.protocolMemeBps,
    ),
    protocolQuoteBps: requireBasisPoints(
      "protocolQuoteBps",
      plan.protocolQuoteBps,
    ),
  };
  if (normalized.recipients.length > MAX_ALLOCATION_RECIPIENTS) {
    throw new RangeError("allocation plan exceeds sixteen recipients");
  }
  const meme = normalized.recipients.reduce(
    (sum, share) => sum + share.memeBps,
    normalized.curveMemeBps + normalized.lpMemeBps + normalized.protocolMemeBps,
  );
  const quote = normalized.recipients.reduce(
    (sum, share) => sum + share.quoteBps,
    normalized.lpQuoteBps + normalized.protocolQuoteBps,
  );
  if (meme !== BASIS_POINTS_DENOMINATOR || quote !== BASIS_POINTS_DENOMINATOR) {
    throw new RangeError(
      "each allocation plan asset must sum to 10,000 basis points",
    );
  }
  return normalized;
}

/**
 * Mirrors `allocation::apportion_meme` on a complete plan: the curve's, the
 * pool's, Blast's, and each recipient's share of `supply`, through core
 * `apportionBps` with Blast's part rounded up.
 */
export function apportionMeme(
  plan: AllocationPlan,
  supply: bigint,
): AllocationMemeAmounts {
  const [curve = 0n, lp = 0n, protocol = 0n, ...recipients] = apportionBps(
    [
      plan.curveMemeBps,
      plan.lpMemeBps,
      plan.protocolMemeBps,
      ...plan.recipients.map((share) => share.memeBps),
    ],
    supply,
    2,
  );
  return { curve, lp, protocol, recipients };
}

/**
 * Mirrors `allocation::apportion_quote` on a complete plan: the pool's,
 * Blast's, and each recipient's share of the final Quote `reserve`, Blast's
 * part rounded up.
 */
export function apportionQuote(
  plan: AllocationPlan,
  reserve: bigint,
): AllocationQuoteAmounts {
  const [lp = 0n, protocol = 0n, ...recipients] = apportionBps(
    [
      plan.lpQuoteBps,
      plan.protocolQuoteBps,
      ...plan.recipients.map((share) => share.quoteBps),
    ],
    reserve,
    1,
  );
  return { lp, protocol, recipients };
}

function normalizeCreatorShares(
  plan: CreatorAllocationPlan,
): CreatorAllocationPlan {
  return {
    curveMemeBps: requireBasisPoints("curveMemeBps", plan.curveMemeBps),
    lpMemeBps: requireBasisPoints("lpMemeBps", plan.lpMemeBps),
    lpQuoteBps: requireBasisPoints("lpQuoteBps", plan.lpQuoteBps),
    recipients: plan.recipients.map(normalizeRecipientShare),
  };
}

function normalizeRecipientShare(share: RecipientShare): RecipientShare {
  const destination = normalizeSuiAddress(share.recipient.destination);
  if (!isValidSuiAddress(destination) || BigInt(destination) === 0n) {
    throw new RangeError("recipient must be a nonzero Sui address");
  }
  return {
    recipient: { destination, vestingTerms: share.recipient.vestingTerms },
    memeBps: requireBasisPoints("recipient memeBps", share.memeBps),
    quoteBps: requireBasisPoints("recipient quoteBps", share.quoteBps),
  };
}
