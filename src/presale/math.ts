import { normalizeSuiAddress } from "@mysten/sui/utils";
import { itemAt } from "../lib/arrays.ts";
import { BASIS_POINTS_DENOMINATOR, U64_MAX } from "../lib/integers.ts";
import { sqrtPriceX64 } from "../migrators/migration-math.ts";
import type {
  BpsShare,
  EligibilityPolicy,
  PresaleCommitment,
  PresaleState,
  ProtocolFees,
  RecipientPayout,
  UncappedPhase,
} from "./state.ts";

// Every amount here is atomic units (`u64`) of the named asset, every share is
// BPS of 10,000, and every time is Unix milliseconds. Each function mirrors the
// cited `blast_presale` Move function, including its rounding and the order of
// its aborts, and throws `PresaleAbortError` carrying the Move error name.

const BPS = BASIS_POINTS_DENOMINATOR;
/** `blast_presale::MAX_PARTICIPANTS`: dynamic commitment records per presale. */
export const MAX_PRESALE_PARTICIPANTS = 65_536n;
/** `blast_presale::MAX_RECIPIENTS`: token and raise recipients, each. */
export const MAX_PRESALE_RECIPIENTS = 64;
/** `blast_presale::MAX_FEE_RECIPIENTS`. */
export const MAX_PRESALE_FEE_RECIPIENTS = 16;
/** `bluefin::MAX_TICK_SPACING`, `MAX_FEE_RATE`, `MAX_MEME_SYMBOL_LENGTH`. */
export const BLUEFIN_PRESALE_MAX_TICK_SPACING = 400;
export const BLUEFIN_PRESALE_MAX_FEE_RATE = 20_000n;
export const BLUEFIN_PRESALE_MAX_SYMBOL_BYTES = 32;
/** `migration_math` sqrt-price bounds shared by Cetus v15 and Bluefin v17. */
export const PRESALE_MIN_SQRT_PRICE_X64 = 4_295_048_016n;
export const PRESALE_MAX_SQRT_PRICE_X64 =
  79_226_673_515_401_279_992_447_579_055n;

export type PresaleAbortCode =
  | "EInvalidRaiseTarget"
  | "EInvalidTokenAllocation"
  | "EInvalidWindow"
  | "EInvalidEligibilityPolicy"
  | "EInvalidLifecycle"
  | "EPresaleEnded"
  | "EZeroCommitment"
  | "EWalletCapExceeded"
  | "EParticipantCapacityReached"
  | "EInvalidEligibilityProof"
  | "EWrongEligibilityPolicy"
  | "ETotalCommitmentOverflow"
  | "EInvalidFeeSplit"
  | "EBelowMinimumCommitment"
  | "EUnreachableRaise"
  | "EUnseedablePrice"
  | "EInvalidUncappedPhase"
  | "EUncappedPhaseNotOpen"
  | "EPresaleFilled"
  | "EInvalidRaiseAllocation"
  | "EInvalidTier"
  | "ESymbolTooLong";

/** A preview found the abort the contract would raise. */
export class PresaleAbortError extends RangeError {
  readonly abort: PresaleAbortCode;

  constructor(abort: PresaleAbortCode, message: string) {
    super(`${abort}: ${message}`);
    this.abort = abort;
  }
}

function check(
  condition: boolean,
  abort: PresaleAbortCode,
  message: string,
): void {
  if (!condition) throw new PresaleAbortError(abort, message);
}

function isU64(value: bigint): boolean {
  return value >= 0n && value <= U64_MAX;
}

function distinct(shares: readonly BpsShare[]): boolean {
  const recipients = shares.map((share) =>
    normalizeSuiAddress(share.recipient),
  );
  return new Set(recipients).size === recipients.length;
}

function isValidShare(share: BpsShare): boolean {
  return (
    BigInt(normalizeSuiAddress(share.recipient)) !== 0n &&
    share.bps > 0n &&
    share.bps <= BPS
  );
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

// === Constructors ===

/** Mirrors `blast_presale::open_eligibility`. */
export function openEligibility(
  walletCap: bigint,
  maxParticipants: bigint,
  minCommitment: bigint,
): EligibilityPolicy {
  check(
    isU64(walletCap) &&
      minCommitment > 0n &&
      minCommitment <= walletCap &&
      maxParticipants > 0n &&
      maxParticipants <= MAX_PRESALE_PARTICIPANTS,
    "EInvalidEligibilityPolicy",
    "open policy needs 0 < minimum <= wallet cap and 1..=65,536 participants",
  );
  return { kind: "open", walletCap, maxParticipants, minCommitment };
}

/** Mirrors `blast_presale::allowlisted_eligibility`; `root` is 32 hex bytes. */
export function allowlistedEligibility(
  root: string,
  leafCount: bigint,
): EligibilityPolicy {
  check(
    /^[0-9a-f]{64}$/.test(root) &&
      leafCount > 0n &&
      leafCount <= MAX_PRESALE_PARTICIPANTS,
    "EInvalidEligibilityPolicy",
    "allowlist needs a 32-byte root and 1..=65,536 leaves",
  );
  return { kind: "allowlisted", root, leafCount };
}

/** Mirrors `blast_presale::uncapped_for_eligible`. */
export function uncappedForEligible(
  startsAfterMs: bigint,
  hardCap: boolean,
): UncappedPhase {
  return { startsAfterMs, access: { kind: "eligible" }, hardCap };
}

/** Mirrors `blast_presale::uncapped_for_anyone`. */
export function uncappedForAnyone(
  startsAfterMs: bigint,
  maxParticipants: bigint,
  minCommitment: bigint,
  hardCap: boolean,
): UncappedPhase {
  check(
    isU64(minCommitment) &&
      minCommitment > 0n &&
      maxParticipants > 0n &&
      maxParticipants <= MAX_PRESALE_PARTICIPANTS,
    "EInvalidUncappedPhase",
    "an open-to-anyone phase needs a positive minimum and 1..=65,536 participants",
  );
  return {
    startsAfterMs,
    access: { kind: "anyone", maxParticipants, minCommitment },
    hardCap,
  };
}

// === Apportionment ===

/**
 * Mirrors `blast_presale::apportion`: largest-remainder apportionment of
 * `total` atoms over BPS `shares` that sum to 10,000. Each share first gets
 * `floor(total * bps / 10,000)`; the leftover atoms (fewer than the share
 * count) go one each to the largest fractional remainders, earlier shares
 * first on ties. Every atom is assigned exactly once.
 */
export function apportion(shares: readonly bigint[], total: bigint): bigint[] {
  if (sum(shares) !== BPS) {
    throw new RangeError("apportioned shares must total 10,000 BPS");
  }
  const products = shares.map((share) => total * share);
  const amounts = products.map((product) => product / BPS);
  const order = products
    .map((product, index) => ({ index, remainder: product % BPS }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  const leftover = Number(total - sum(amounts));
  const bumped = new Set(order.slice(0, leftover).map(({ index }) => index));
  return amounts.map((amount, index) =>
    bumped.has(index) ? amount + 1n : amount,
  );
}

export type SupplyApportionment = {
  /** Participant (presale) token allocation. */
  tokenAllocation: bigint;
  /** LP-token allocation seeded at migration. */
  liquidityTokenAllocation: bigint;
  /** Blast's token share, paid on migration. */
  protocolTokenAllocation: bigint;
  recipientPayouts: RecipientPayout[];
};

/**
 * Mirrors `blast_presale::apportion_supply`: `[presale, LP, Blast,
 * ...recipients]` apportioned over `tokenSupply`. Requires validated
 * allocations (`validateTokenAllocations`). Blast's share may be zero atoms.
 */
export function apportionSupply(
  tokenSupply: bigint,
  tokenAllocationBps: bigint,
  liquidityTokenAllocationBps: bigint,
  protocolTokenBps: bigint,
  recipientAllocations: readonly BpsShare[],
): SupplyApportionment {
  const amounts = apportion(
    [
      tokenAllocationBps,
      liquidityTokenAllocationBps,
      protocolTokenBps,
      ...recipientAllocations.map((allocation) => allocation.bps),
    ],
    tokenSupply,
  );
  const [
    tokenAllocation = 0n,
    liquidityTokenAllocation = 0n,
    protocolTokenAllocation = 0n,
  ] = amounts;
  check(
    tokenAllocation > 0n && liquidityTokenAllocation > 0n,
    "EInvalidTokenAllocation",
    "the presale and LP allocations must apportion to positive atoms",
  );
  return {
    tokenAllocation,
    liquidityTokenAllocation,
    protocolTokenAllocation,
    recipientPayouts: payouts(recipientAllocations, amounts.slice(3)),
  };
}

/**
 * Mirrors `blast_presale::apportion_raise`: raise recipients in order, then
 * Blast's `protocolRaiseBps`, then the LP's `10,000 - sum(bps) - Blast's`
 * last, apportioned over `raiseTarget`. Every recipient amount and the LP's
 * must be positive; Blast's may be zero. `liquidityQuote` seeds the pool.
 */
export function apportionRaise(
  raiseAllocations: readonly BpsShare[],
  protocolRaiseBps: bigint,
  raiseTarget: bigint,
): {
  raisePayouts: RecipientPayout[];
  protocolQuote: bigint;
  liquidityQuote: bigint;
} {
  const shares = raiseAllocations.map((allocation) => allocation.bps);
  const allocated = sum(shares) + protocolRaiseBps;
  check(
    allocated < BPS,
    "EInvalidRaiseAllocation",
    "raise allocations and Blast's share must leave the LP a share",
  );
  const amounts = apportion(
    [...shares, protocolRaiseBps, BPS - allocated],
    raiseTarget,
  );
  const raisePayouts = payouts(raiseAllocations, amounts);
  const liquidityQuote = itemAt(amounts, -1);
  check(
    raisePayouts.every((payout) => payout.amount > 0n) && liquidityQuote > 0n,
    "EInvalidRaiseAllocation",
    "every raise share and the LP's must apportion to positive atoms",
  );
  return {
    raisePayouts,
    protocolQuote: itemAt(amounts, -2),
    liquidityQuote,
  };
}

/**
 * Mirrors `blast_presale::apportion_fee` as `presale_vault::fee_shares` uses
 * it: one collected fee amount split into each fee recipient's atoms and the
 * holder-reward share, largest remainder, recipients winning ties over holders.
 */
export function apportionFee(
  feeRecipients: readonly BpsShare[],
  rewardsFeeBps: bigint,
  amount: bigint,
): { recipients: bigint[]; rewards: bigint } {
  const amounts = apportion(
    [...feeRecipients.map((recipient) => recipient.bps), rewardsFeeBps],
    amount,
  );
  return { recipients: amounts.slice(0, -1), rewards: itemAt(amounts, -1) };
}

/**
 * Mirrors `presale_vault::split_fees` for one asset: Blast takes
 * `ceil(amount * protocolBps / 10,000)` first, then `apportionFee` splits the
 * rest between the fee recipients and the holder-reward share.
 */
export function splitCollectedFee(
  feeRecipients: readonly BpsShare[],
  rewardsFeeBps: bigint,
  protocolBps: bigint,
  amount: bigint,
): { protocol: bigint; recipients: bigint[]; rewards: bigint } {
  const protocol = (amount * protocolBps + BPS - 1n) / BPS;
  return {
    protocol,
    ...apportionFee(feeRecipients, rewardsFeeBps, amount - protocol),
  };
}

function payouts(
  allocations: readonly BpsShare[],
  amounts: readonly bigint[],
): RecipientPayout[] {
  return allocations.map((allocation, index) => ({
    recipient: normalizeSuiAddress(allocation.recipient),
    amount: itemAt(amounts, index),
  }));
}

// === Creation validation ===

/** Mirrors `blast_presale::recipient_allocation`. */
export function validateRecipientAllocation(allocation: BpsShare): BpsShare {
  check(
    isValidShare(allocation),
    "EInvalidTokenAllocation",
    "a recipient allocation needs a nonzero address and 1..=10,000 BPS",
  );
  return allocation;
}

/** Mirrors `blast_presale::fee_recipient`. */
export function validateFeeRecipient(recipient: BpsShare): BpsShare {
  check(
    isValidShare(recipient),
    "EInvalidFeeSplit",
    "a fee recipient needs a nonzero address and 1..=10,000 BPS",
  );
  return recipient;
}

/** Mirrors `blast_presale::assert_raise_allocations`. */
export function validateRaiseAllocations(
  raiseAllocations: readonly BpsShare[],
): void {
  check(
    raiseAllocations.length <= MAX_PRESALE_RECIPIENTS &&
      raiseAllocations.every(
        (allocation) => isValidShare(allocation) && allocation.bps < BPS,
      ) &&
      distinct(raiseAllocations) &&
      sum(raiseAllocations.map((allocation) => allocation.bps)) < BPS,
    "EInvalidRaiseAllocation",
    "raise allocations must be at most 64 distinct recipients leaving the LP a share",
  );
}

/** Mirrors `blast_presale::assert_token_allocations`. */
export function validateTokenAllocations(
  tokenSupply: bigint,
  tokenAllocationBps: bigint,
  liquidityTokenAllocationBps: bigint,
  protocolTokenBps: bigint,
  recipientAllocations: readonly BpsShare[],
): void {
  check(
    tokenSupply > 0n &&
      isU64(tokenSupply) &&
      tokenAllocationBps > 0n &&
      tokenAllocationBps <= BPS &&
      liquidityTokenAllocationBps > 0n &&
      liquidityTokenAllocationBps <= BPS &&
      recipientAllocations.length <= MAX_PRESALE_RECIPIENTS &&
      recipientAllocations.every(isValidShare) &&
      distinct(recipientAllocations) &&
      tokenAllocationBps +
        liquidityTokenAllocationBps +
        protocolTokenBps +
        sum(recipientAllocations.map((allocation) => allocation.bps)) ===
        BPS,
    "EInvalidTokenAllocation",
    "presale, LP, and distinct recipient BPS must be positive and total exactly 10,000 with Blast's share",
  );
}

/** Mirrors `blast_presale::assert_fee_split`. */
export function validateFeeSplit(
  feeRecipients: readonly BpsShare[],
  rewardsFeeBps: bigint,
): void {
  check(
    feeRecipients.length <= MAX_PRESALE_FEE_RECIPIENTS &&
      rewardsFeeBps >= 0n &&
      rewardsFeeBps <= BPS &&
      feeRecipients.every(isValidShare) &&
      distinct(feeRecipients) &&
      rewardsFeeBps + sum(feeRecipients.map((recipient) => recipient.bps)) ===
        BPS,
    "EInvalidFeeSplit",
    "at most 16 distinct fee recipients and the holder share must total 10,000 BPS",
  );
}

/**
 * Mirrors `EligibilityPolicy::can_reach`: filling every open slot at the
 * minimum funds the raise. Allowlist caps are off chain, so always true.
 */
export function canReachRaise(
  eligibility: EligibilityPolicy,
  raiseTarget: bigint,
): boolean {
  return (
    eligibility.kind === "allowlisted" ||
    eligibility.minCommitment * eligibility.maxParticipants >= raiseTarget
  );
}

/** Mirrors `blast_presale::assert_uncapped_phase`. */
export function validateUncappedPhase(
  phase: UncappedPhase,
  durationMs: bigint,
  eligibility: EligibilityPolicy,
  raiseTarget: bigint,
): void {
  check(
    phase.startsAfterMs < durationMs,
    "EInvalidUncappedPhase",
    "the uncapped phase must start inside the commitment window",
  );
  if (phase.access.kind === "eligible") return;
  const policyBound =
    eligibility.kind === "open"
      ? eligibility.maxParticipants
      : eligibility.leafCount;
  check(
    phase.access.maxParticipants >= policyBound,
    "EInvalidUncappedPhase",
    "an open-to-anyone phase must admit at least the policy's wallets",
  );
  check(
    phase.access.minCommitment * phase.access.maxParticipants >= raiseTarget,
    "EUnreachableRaise",
    "the phase's minimum times its participant bound must reach the raise",
  );
}

/**
 * Mirrors `migration_math::is_seedable`: the Q64.64 seed sqrt price sits a
 * factor of two inside the venues' bounds (`MAX / 2` rounds down).
 */
export function isSeedable(sqrtPrice: bigint): boolean {
  return (
    sqrtPrice >= PRESALE_MIN_SQRT_PRICE_X64 * 2n &&
    sqrtPrice <= PRESALE_MAX_SQRT_PRICE_X64 / 2n
  );
}

export type PresaleCreationConfig = {
  tokenSupply: bigint;
  tokenAllocationBps: bigint;
  liquidityTokenAllocationBps: bigint;
  recipientAllocations: readonly BpsShare[];
  raiseTarget: bigint;
  raiseAllocations: readonly BpsShare[];
  durationMs: bigint;
  liquidityWindowMs: bigint;
  eligibility: EligibilityPolicy;
  uncapped: UncappedPhase | null;
  feeRecipients: readonly BpsShare[];
  rewardsFeeBps: bigint;
  /** The `FeePolicy` rates now, which `blast_presale::new` snapshots. */
  protocolFees: ProtocolFees;
};

export type PresaleCreationPreview = SupplyApportionment & {
  raisePayouts: RecipientPayout[];
  /** Blast's share of the raise, paid on migration. */
  protocolQuote: bigint;
  /** Quote that seeds the pool: the raise less Blast's and the recipients' payouts. */
  liquidityQuote: bigint;
  /** floor(sqrt(quote / LP tokens) * 2^64), Meme as coin A. */
  seedSqrtPriceX64: bigint;
};

/**
 * Mirrors the checks of `blast_presale::new` in its abort order, after the
 * constructors `PresaleCalls` runs first in this order (`recipient_allocation`
 * for token then raise recipients, `open_eligibility` /
 * `allowlisted_eligibility`, `uncapped_for_anyone`, `fee_recipient`), and
 * returns the exact amounts it apportions. Does not check what only the chain
 * knows: distinct coin types, a zero-supply `TreasuryCap`, or a Cetus tier.
 */
export function previewPresaleCreation(
  config: PresaleCreationConfig,
): PresaleCreationPreview {
  config.recipientAllocations.forEach(validateRecipientAllocation);
  config.raiseAllocations.forEach(validateRecipientAllocation);
  const { eligibility, uncapped } = config;
  if (eligibility.kind === "open") {
    openEligibility(
      eligibility.walletCap,
      eligibility.maxParticipants,
      eligibility.minCommitment,
    );
  } else {
    allowlistedEligibility(eligibility.root, eligibility.leafCount);
  }
  if (uncapped?.access.kind === "anyone") {
    uncappedForAnyone(
      uncapped.startsAfterMs,
      uncapped.access.maxParticipants,
      uncapped.access.minCommitment,
      uncapped.hardCap,
    );
  }
  config.feeRecipients.forEach(validateFeeRecipient);

  check(
    config.raiseTarget > 0n && isU64(config.raiseTarget),
    "EInvalidRaiseTarget",
    "the raise target must be a positive u64",
  );
  validateRaiseAllocations(config.raiseAllocations);
  validateTokenAllocations(
    config.tokenSupply,
    config.tokenAllocationBps,
    config.liquidityTokenAllocationBps,
    config.protocolFees.tokenBps,
    config.recipientAllocations,
  );
  validateFeeSplit(config.feeRecipients, config.rewardsFeeBps);
  check(
    config.durationMs > 0n && config.liquidityWindowMs > 0n,
    "EInvalidWindow",
    "commitment and liquidity windows must be positive",
  );
  check(
    canReachRaise(eligibility, config.raiseTarget),
    "EUnreachableRaise",
    "an open sale's minimum times its participant bound must reach the raise",
  );
  if (uncapped) {
    validateUncappedPhase(
      uncapped,
      config.durationMs,
      eligibility,
      config.raiseTarget,
    );
  }

  const supply = apportionSupply(
    config.tokenSupply,
    config.tokenAllocationBps,
    config.liquidityTokenAllocationBps,
    config.protocolFees.tokenBps,
    config.recipientAllocations,
  );
  const raise = apportionRaise(
    config.raiseAllocations,
    config.protocolFees.raiseBps,
    config.raiseTarget,
  );
  const seedSqrtPriceX64 = sqrtPriceX64(
    supply.liquidityTokenAllocation,
    raise.liquidityQuote,
    true,
  );
  check(
    isSeedable(seedSqrtPriceX64),
    "EUnseedablePrice",
    "the raise and LP-token allocation give a seed price the venues cannot pool",
  );
  check(
    supply.recipientPayouts.every((payout) => payout.amount > 0n),
    "EInvalidTokenAllocation",
    "every recipient allocation must apportion to positive atoms",
  );
  return { ...supply, ...raise, seedSqrtPriceX64 };
}

/**
 * Mirrors the tier and symbol checks `bluefin::new` runs before
 * `blast_presale::new`: tick spacing 1..=400, fee rate 1..=20,000, and a Meme
 * symbol of at most 32 UTF-8 bytes.
 */
export function validateBluefinPresaleTier(
  tickSpacing: number,
  feeRate: bigint,
  memeSymbol: string,
): void {
  check(
    tickSpacing > 0 &&
      tickSpacing <= BLUEFIN_PRESALE_MAX_TICK_SPACING &&
      feeRate > 0n &&
      feeRate <= BLUEFIN_PRESALE_MAX_FEE_RATE,
    "EInvalidTier",
    "Bluefin tier needs tick spacing 1..=400 and fee rate 1..=20,000",
  );
  check(
    new TextEncoder().encode(memeSymbol).length <=
      BLUEFIN_PRESALE_MAX_SYMBOL_BYTES,
    "ESymbolTooLong",
    "the Meme symbol must be at most 32 bytes for Bluefin migration",
  );
}

/**
 * Mirrors `blast_presale::share`: the windows fixed when the presale is shared
 * at `startMs`. Without an uncapped phase `uncappedFromMs` is `endMs`.
 */
export function presaleWindows(
  startMs: bigint,
  durationMs: bigint,
  liquidityWindowMs: bigint,
  uncapped: Pick<UncappedPhase, "startsAfterMs"> | null,
): { endMs: bigint; liquidityDeadlineMs: bigint; uncappedFromMs: bigint } {
  const endMs = startMs + durationMs;
  const liquidityDeadlineMs = endMs + liquidityWindowMs;
  check(
    isU64(endMs) && isU64(liquidityDeadlineMs),
    "EInvalidWindow",
    "the windows must fit in u64 milliseconds",
  );
  return {
    endMs,
    liquidityDeadlineMs,
    uncappedFromMs: uncapped ? startMs + uncapped.startsAfterMs : endMs,
  };
}

// === Commitments ===

export type CommitRoute = "open" | "allowlisted" | "uncapped";

export type CommitPreviewInput = {
  presale: Pick<
    PresaleState,
    | "lifecycle"
    | "endMs"
    | "raiseTarget"
    | "eligibility"
    | "uncapped"
    | "uncappedFromMs"
    | "totalCommitments"
    | "participants"
  >;
  route: CommitRoute;
  /** Value of the `Coin<Quote>` supplied. */
  offered: bigint;
  /** Clock time the transaction will see. */
  nowMs: bigint;
  /** The sender's current record (`getPresaleCommitment`), null if none. */
  commitment: PresaleCommitment | null;
  /** The allowlist leaf's cap; required on the `allowlisted` route. */
  walletCap?: bigint;
};

export type CommitPreview = {
  /** Quote the presale keeps. */
  accepted: bigint;
  /** Quote the call returns: `offered - accepted`, nonzero only under a hard cap. */
  change: bigint;
  walletCommitment: bigint;
  totalCommitments: bigint;
  participants: bigint;
  /** Whether wallet caps no longer apply. */
  uncapped: boolean;
};

/**
 * Mirrors `commit_open`, `commit_allowlisted` (except the Merkle proof, see
 * `verifyAllowlistProof`), and `commit_uncapped` through `record_commitment`,
 * `participant_limits`, `accepted_quote`, and `add_within_cap`, in abort order.
 * Its values match the `Committed` event the call would emit.
 */
export function previewCommit(input: CommitPreviewInput): CommitPreview {
  const { presale, offered, nowMs } = input;
  check(
    presale.lifecycle === "Open",
    "EInvalidLifecycle",
    "the presale is not open",
  );
  check(nowMs < presale.endMs, "EPresaleEnded", "the window has ended");
  check(offered > 0n, "EZeroCommitment", "a commitment must be positive");

  const { walletCap, maxParticipants, minCommitment } = routeLimits(input);
  const uncapped = nowMs >= presale.uncappedFromMs;
  let limit = maxParticipants;
  let hardCap = false;
  if (uncapped && presale.uncapped) {
    hardCap = presale.uncapped.hardCap;
    if (presale.uncapped.access.kind === "anyone") {
      limit = presale.uncapped.access.maxParticipants;
    }
  }

  // accepted_quote
  let accepted = offered;
  if (hardCap) {
    check(
      presale.totalCommitments < presale.raiseTarget,
      "EPresaleFilled",
      "the hard-capped sale already reached its raise",
    );
    const left = presale.raiseTarget - presale.totalCommitments;
    accepted = offered < left ? offered : left;
  }
  const fillsRaise =
    hardCap && presale.totalCommitments + accepted === presale.raiseTarget;

  // add_within_cap
  const current = input.commitment ?? { quote: 0n, walletCap };
  check(
    uncapped || current.walletCap === walletCap,
    "EInvalidEligibilityProof",
    "the wallet cap differs from the wallet's recorded cap",
  );
  const walletCommitment = current.quote + accepted;
  check(
    isU64(walletCommitment) && (uncapped || walletCommitment <= walletCap),
    "EWalletCapExceeded",
    "the wallet commitment exceeds its cap",
  );
  check(
    walletCommitment >= minCommitment || fillsRaise,
    "EBelowMinimumCommitment",
    "the wallet's total is below the minimum commitment",
  );
  check(
    input.commitment !== null || presale.participants < limit,
    "EParticipantCapacityReached",
    "the presale has its maximum number of participants",
  );
  const totalCommitments = presale.totalCommitments + accepted;
  check(
    isU64(totalCommitments),
    "ETotalCommitmentOverflow",
    "the total commitment would overflow",
  );
  return {
    accepted,
    change: offered - accepted,
    walletCommitment,
    totalCommitments,
    participants: presale.participants + (input.commitment ? 0n : 1n),
    uncapped,
  };
}

function routeLimits(input: CommitPreviewInput): {
  walletCap: bigint;
  maxParticipants: bigint;
  minCommitment: bigint;
} {
  const { presale } = input;
  const policy = presale.eligibility;
  if (input.route === "open") {
    check(
      policy.kind === "open",
      "EWrongEligibilityPolicy",
      "commit_open needs an open policy",
    );
    return policy as Extract<EligibilityPolicy, { kind: "open" }>;
  }
  if (input.route === "allowlisted") {
    check(
      policy.kind === "allowlisted",
      "EWrongEligibilityPolicy",
      "commit_allowlisted needs an allowlist policy",
    );
    const walletCap = input.walletCap ?? 0n;
    check(
      walletCap > 0n,
      "EInvalidEligibilityProof",
      "an allowlist leaf needs a positive wallet cap",
    );
    const { leafCount } = policy as Extract<
      EligibilityPolicy,
      { kind: "allowlisted" }
    >;
    // Allowlisted wallets are few and named, so any positive commitment counts.
    return { walletCap, maxParticipants: leafCount, minCommitment: 1n };
  }
  const access = presale.uncapped?.access;
  check(
    input.nowMs >= presale.uncappedFromMs && access?.kind === "anyone",
    "EUncappedPhaseNotOpen",
    "no uncapped phase open to anyone has started",
  );
  const { maxParticipants, minCommitment } = access as Extract<
    typeof access,
    { kind: "anyone" }
  >;
  return { walletCap: U64_MAX, maxParticipants, minCommitment };
}

// === Settlement and claims ===

/**
 * Mirrors `blast_presale::settle`: after `endMs`, an underfunded sale cancels
 * and a funded one fixes the common fill rate `raise / commitments`.
 */
export function previewSettlement(
  presale: Pick<PresaleState, "totalCommitments" | "raiseTarget">,
):
  | { outcome: "Cancelled"; refundableQuote: bigint }
  | { outcome: "Funded"; acceptedQuote: bigint; refundableQuote: bigint } {
  return presale.totalCommitments < presale.raiseTarget
    ? { outcome: "Cancelled", refundableQuote: presale.totalCommitments }
    : {
        outcome: "Funded",
        acceptedQuote: presale.raiseTarget,
        refundableQuote: presale.totalCommitments - presale.raiseTarget,
      };
}

/**
 * Mirrors `blast_presale::claim_payout` for one commitment of `commitment`
 * Quote atoms. After migration: `tokens = floor(tokenAllocation * c / C)` and
 * `quoteRefund = floor((C - R) * c / C)`; after cancellation no tokens and
 * `floor(C * c / C) = c`. The last claim (`remaining == c`) takes every atom
 * left in custody instead, so the rounding remainder goes to it.
 */
export function previewClaim(
  presale: Pick<
    PresaleState,
    | "lifecycle"
    | "totalCommitments"
    | "remainingCommitments"
    | "raiseTarget"
    | "tokenAllocation"
    | "saleTokens"
    | "quote"
  >,
  commitment: bigint,
): { tokens: bigint; quoteRefund: bigint } {
  const migrated = presale.lifecycle === "Migrated";
  check(
    migrated || presale.lifecycle === "Cancelled",
    "EInvalidLifecycle",
    "claims open after migration or cancellation",
  );
  const total = presale.totalCommitments;
  const last = presale.remainingCommitments === commitment;
  const tokens = !migrated
    ? 0n
    : last
      ? presale.saleTokens
      : (presale.tokenAllocation * commitment) / total;
  const refundTotal = migrated ? total - presale.raiseTarget : total;
  const quoteRefund = last ? presale.quote : (refundTotal * commitment) / total;
  return { tokens, quoteRefund };
}
