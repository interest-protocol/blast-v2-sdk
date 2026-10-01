import { bcs } from "@mysten/sui/bcs";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

import {
  BASIS_POINTS_DENOMINATOR,
  mulDivUp,
  requireBasisPoints,
  requireU64,
} from "../lib/integers.ts";

/** Most project recipients one allocation plan may name; Blast's fee has its own fields. */
export const MAX_ALLOCATION_RECIPIENTS = 16;
/** Most direct recipients one LP-fee split may name. */
export const MAX_FEE_SPLIT_RECIPIENTS = 16;

/**
 * Mirrors `blast_fun::allocation::Recipient`: one address paid at migration,
 * with its shares of the Meme supply and of the final Quote reserve.
 */
export type AllocationRecipient = {
  destination: string;
  memeBps: bigint;
  quoteBps: bigint;
};

/**
 * Mirrors `blast_fun::allocation::AllocationPlan`. `allocation::plan` leaves
 * Blast's shares at zero; `launch::finalize` sets them from the `LaunchConfig`
 * protocol allocation (see `addProtocolAllocation`). Blast's shares accrue as
 * its one-time migration fee in the launch's fee ledger (contracts ADR 0098).
 */
export type AllocationPlan = {
  curveMemeBps: bigint;
  lpMemeBps: bigint;
  lpQuoteBps: bigint;
  protocolMemeBps: bigint;
  protocolQuoteBps: bigint;
  recipients: AllocationRecipient[];
};

/** The creator's plan: `allocation::plan` input, before Blast's shares are added. */
export type CreatorAllocationPlan = Omit<
  AllocationPlan,
  "protocolMemeBps" | "protocolQuoteBps"
>;

/** Mirrors `blast_fun::allocation::ProtocolAllocation`, Blast's one-time migration fee. */
export type ProtocolAllocation = { memeBps: bigint; quoteBps: bigint };

/** Exact Meme amounts of one apportioned supply. */
export type AllocationMemeAmounts = {
  curve: bigint;
  lp: bigint;
  /** Blast's migration fee, rounded up. */
  protocol: bigint;
  /** Aligned with `plan.recipients`. */
  recipients: bigint[];
};

/** Exact Quote amounts of one apportioned final reserve. */
export type AllocationQuoteAmounts = {
  lp: bigint;
  /** Blast's migration fee, rounded up. */
  protocol: bigint;
  /** Aligned with `plan.recipients`. */
  recipients: bigint[];
};

export type FeeSplitRecipient = { destination: string; bps: bigint };

/**
 * Mirrors `blast_fun::allocation::FeeSplit`: the creator's split of every
 * LP-fee collection after Blast's share, recipients in the order given. The
 * burn part's Meme is burned at collection; its Quote waits in the vault for a
 * buyback admin to swap it for Meme to burn.
 */
export type FeeSplit = {
  creatorBps: bigint;
  autoLpBps: bigint;
  rewardsBps: bigint;
  burnBps: bigint;
  recipients: FeeSplitRecipient[];
};

/** Exact per-part amounts of one apportioned fee-split total. */
export type FeeSplitAmounts = {
  creator: bigint;
  autoLp: bigint;
  rewards: bigint;
  burn: bigint;
  recipients: bigint[];
};

const u64Bcs = bcs.u64().transform({
  input: (value: bigint) => value,
  output: (value) => BigInt(value),
});
/** BCS layout of `blast_fun::bps::Bps`. */
export const bpsBcs = bcs.struct("Bps", { value: u64Bcs }).transform({
  input: (value: bigint) => ({ value }),
  output: (value) => value.value,
});
const addressBcs = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});
const recipientBcs = bcs.struct("Recipient", {
  destination: addressBcs,
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
  recipients: bcs.vector(recipientBcs),
});
/** BCS layout of `blast_fun::allocation::ProtocolAllocation`. */
export const protocolAllocationBcs = bcs.struct("ProtocolAllocation", {
  memeBps: bpsBcs,
  quoteBps: bpsBcs,
});
const routeBcs = bcs.struct("Route", {
  destination: addressBcs,
  bps: bpsBcs,
});
/** BCS layout of `blast_fun::allocation::FeeSplit`. */
export const feeSplitBcs = bcs.struct("FeeSplit", {
  creatorBps: bpsBcs,
  autoLpBps: bpsBcs,
  rewardsBps: bpsBcs,
  burnBps: bpsBcs,
  recipients: bcs.vector(routeBcs),
});

/**
 * Checks a creator plan exactly as `allocation::plan` and
 * `allocation::recipient` do: positive curve and pool Meme shares, nonzero
 * destinations, recipient order kept, plus `add_protocol`'s sixteen-recipient
 * cap. The sums are checked once Blast's shares are added
 * (`addProtocolAllocation`); finalization then requires a positive pool Quote
 * amount at the graduation target.
 */
export function normalizeAllocationPlan(
  plan: CreatorAllocationPlan,
): CreatorAllocationPlan {
  const normalized = {
    curveMemeBps: requireBasisPoints("curveMemeBps", plan.curveMemeBps),
    lpMemeBps: requireBasisPoints("lpMemeBps", plan.lpMemeBps),
    lpQuoteBps: requireBasisPoints("lpQuoteBps", plan.lpQuoteBps),
    recipients: plan.recipients.map(normalizeRecipient),
  };
  if (normalized.curveMemeBps === 0n || normalized.lpMemeBps === 0n) {
    throw new RangeError("the curve and the pool need positive Meme shares");
  }
  if (normalized.recipients.length > MAX_ALLOCATION_RECIPIENTS) {
    throw new RangeError("allocation plan exceeds sixteen recipients");
  }
  return normalized;
}

/**
 * Mirrors `allocation::add_protocol`, which `launch::finalize` runs with the
 * `LaunchConfig` protocol allocation: Blast's shares fill their own fields,
 * and each asset must then sum to 10,000 basis points.
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
 * Checks a plan with Blast's shares set, such as `LaunchState.allocationPlan`:
 * at most sixteen recipients, and each asset summing to 10,000 basis points.
 */
export function requireCompletePlan(plan: AllocationPlan): AllocationPlan {
  const normalized = {
    ...normalizeAllocationPlan(plan),
    protocolMemeBps: requireBasisPoints(
      "protocolMemeBps",
      plan.protocolMemeBps,
    ),
    protocolQuoteBps: requireBasisPoints(
      "protocolQuoteBps",
      plan.protocolQuoteBps,
    ),
  };
  const meme = normalized.recipients.reduce(
    (sum, recipient) => sum + recipient.memeBps,
    normalized.curveMemeBps + normalized.lpMemeBps + normalized.protocolMemeBps,
  );
  const quote = normalized.recipients.reduce(
    (sum, recipient) => sum + recipient.quoteBps,
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
 * Checks a split exactly as `allocation::fee_split` and `allocation::route` do:
 * at most sixteen distinct nonzero destinations in the order given, and every
 * part summing to 10,000 basis points. Zero shares are allowed.
 */
export function normalizeFeeSplit(split: FeeSplit): FeeSplit {
  const creatorBps = requireBasisPoints("creatorBps", split.creatorBps);
  const autoLpBps = requireBasisPoints("autoLpBps", split.autoLpBps);
  const rewardsBps = requireBasisPoints("rewardsBps", split.rewardsBps);
  const burnBps = requireBasisPoints("burnBps", split.burnBps);
  const recipients = split.recipients.map((recipient) => ({
    destination: requireDestination("recipient", recipient.destination),
    bps: requireBasisPoints("recipient bps", recipient.bps),
  }));
  if (recipients.length > MAX_FEE_SPLIT_RECIPIENTS) {
    throw new RangeError("fee split exceeds sixteen recipients");
  }
  if (
    new Set(recipients.map(({ destination }) => destination)).size !==
    recipients.length
  ) {
    throw new RangeError("fee split recipients must be distinct");
  }
  const total = recipients.reduce(
    (sum, recipient) => sum + recipient.bps,
    creatorBps + autoLpBps + rewardsBps + burnBps,
  );
  if (total !== BASIS_POINTS_DENOMINATOR) {
    throw new RangeError("fee split must sum to 10,000 basis points");
  }
  return { creatorBps, autoLpBps, rewardsBps, burnBps, recipients };
}

/**
 * Mirrors `allocation::apportion_meme` on a complete plan: the curve's, the
 * pool's, Blast's, and each recipient's share of `supply`. Blast takes its
 * ceiling; the rest go by largest remainder.
 */
export function apportionMeme(
  plan: AllocationPlan,
  supply: bigint,
): AllocationMemeAmounts {
  const [curve = 0n, lp = 0n, protocol = 0n, ...recipients] = apportion(
    [
      plan.curveMemeBps,
      plan.lpMemeBps,
      plan.protocolMemeBps,
      ...plan.recipients.map((recipient) => recipient.memeBps),
    ],
    supply,
    2,
  );
  return { curve, lp, protocol, recipients };
}

/**
 * Mirrors `allocation::apportion_quote` on a complete plan: the pool's,
 * Blast's, and each recipient's share of the final Quote `reserve`. Blast
 * takes its ceiling; the rest go by largest remainder.
 */
export function apportionQuote(
  plan: AllocationPlan,
  reserve: bigint,
): AllocationQuoteAmounts {
  const [lp = 0n, protocol = 0n, ...recipients] = apportion(
    [
      plan.lpQuoteBps,
      plan.protocolQuoteBps,
      ...plan.recipients.map((recipient) => recipient.quoteBps),
    ],
    reserve,
    1,
  );
  return { lp, protocol, recipients };
}

/**
 * Mirrors `allocation::apportion_fee_split`: by largest remainder with no
 * rounded-up part, ties in creator, auto-LP, rewards, burn, then recipient
 * order.
 * Conserves `total` exactly.
 */
export function apportionFeeSplit(
  split: FeeSplit,
  total: bigint,
): FeeSplitAmounts {
  const [creator = 0n, autoLp = 0n, rewards = 0n, burn = 0n, ...recipients] =
    apportion(
      [
        split.creatorBps,
        split.autoLpBps,
        split.rewardsBps,
        split.burnBps,
        ...split.recipients.map((recipient) => recipient.bps),
      ],
      total,
      null,
    );
  return { creator, autoLp, rewards, burn, recipients };
}

export type FeeCollectionPreview = {
  protocolMeme: bigint;
  protocolQuote: bigint;
  meme: FeeSplitAmounts;
  quote: FeeSplitAmounts;
};

/**
 * Mirrors `vault::split_fees` for one collection in atomic units. Blast's share
 * of each asset rounds up to the protocol (`bps::apply_up`); the rest follows
 * `apportionFeeSplit`.
 */
export function previewFeeCollection(input: {
  grossMeme: bigint;
  grossQuote: bigint;
  memeShareBps: bigint;
  quoteShareBps: bigint;
  feeSplit: FeeSplit;
}): FeeCollectionPreview {
  const grossMeme = requireU64("grossMeme", input.grossMeme);
  const grossQuote = requireU64("grossQuote", input.grossQuote);
  const protocolMeme = mulDivUp(
    grossMeme,
    requireBasisPoints("memeShareBps", input.memeShareBps),
    BASIS_POINTS_DENOMINATOR,
  );
  const protocolQuote = mulDivUp(
    grossQuote,
    requireBasisPoints("quoteShareBps", input.quoteShareBps),
    BASIS_POINTS_DENOMINATOR,
  );
  return {
    protocolMeme,
    protocolQuote,
    meme: apportionFeeSplit(input.feeSplit, grossMeme - protocolMeme),
    quote: apportionFeeSplit(input.feeSplit, grossQuote - protocolQuote),
  };
}

/**
 * Largest-remainder apportionment of `total` over shares summing to 10,000:
 * the `roundedUp` part takes its ceiling, every other part its floor, then one
 * atom each goes to the largest remaining remainders, earlier parts first.
 */
function apportion(
  shares: readonly bigint[],
  total: bigint,
  roundedUp: number | null,
): bigint[] {
  requireU64("total", total);
  if (
    shares.reduce((sum, share) => sum + share, 0n) !== BASIS_POINTS_DENOMINATOR
  ) {
    throw new RangeError("shares must sum to 10,000 basis points");
  }
  const products = shares.map((share) => total * share);
  const amounts = products.map((product, index) =>
    index === roundedUp
      ? mulDivUp(product, 1n, BASIS_POINTS_DENOMINATOR)
      : product / BASIS_POINTS_DENOMINATOR,
  );
  const remainder = (index: number) =>
    (products[index] ?? 0n) % BASIS_POINTS_DENOMINATOR;
  const order = shares
    .map((_, index) => index)
    .filter((index) => index !== roundedUp)
    .sort((left, right) => {
      const difference = remainder(right) - remainder(left);
      if (difference !== 0n) return difference > 0n ? 1 : -1;
      return left - right;
    });
  const leftover = total - amounts.reduce((sum, amount) => sum + amount, 0n);
  for (let index = 0; index < Number(leftover); index++) {
    const target = order[index] as number;
    amounts[target] = (amounts[target] ?? 0n) + 1n;
  }
  return amounts;
}

function normalizeRecipient(
  recipient: AllocationRecipient,
): AllocationRecipient {
  return {
    destination: requireDestination("recipient", recipient.destination),
    memeBps: requireBasisPoints("recipient memeBps", recipient.memeBps),
    quoteBps: requireBasisPoints("recipient quoteBps", recipient.quoteBps),
  };
}

function requireDestination(name: string, value: string): string {
  const address = normalizeSuiAddress(value);
  if (!isValidSuiAddress(address) || BigInt(address) === 0n) {
    throw new RangeError(`${name} must be a nonzero Sui address`);
  }
  return address;
}
