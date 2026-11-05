import type { CoreAbortName } from "@interest-protocol/blast-core/aborts";
import { itemAt } from "@interest-protocol/blast-core/arrays";
import {
  apportionBps,
  MAX_VESTING_DURATION_MS,
} from "@interest-protocol/blast-core/bps";
import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import { normalizeFeeSplit } from "@interest-protocol/blast-core/fee-split";
import {
  BASIS_POINTS_DENOMINATOR,
  U64_MAX,
} from "@interest-protocol/blast-core/integers";
import {
  isSeedablePrice,
  sqrtPriceX64,
} from "@interest-protocol/blast-core/migration-math";
import type { VestingTerms } from "@interest-protocol/blast-core/payout";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { PresaleAbortName } from "./aborts.ts";
import type {
  EligibilityPolicy,
  HardCap,
  PresaleCommitment,
  PresaleState,
  ProtocolFees,
  RecipientPayout,
  RecipientShare,
  UncappedPhase,
} from "./state.ts";

// Every amount here is atomic units (`u64`) of the named asset, every share is
// BPS of 10,000, and every time is Unix milliseconds. Each function mirrors the
// cited Move function, including its rounding and the order of its aborts, and
// throws `PresaleAbortError` carrying the Move error name: a `blast_presale`
// name, or a `blast_core` one for the core constructors a creation calls.

const BPS = BASIS_POINTS_DENOMINATOR;
/** `constants::max_participants`: dynamic commitment records per presale. */
export const MAX_PARTICIPANTS = 65_536n;
/** `constants::max_recipients`: token and raise recipients, each. */
export const MAX_RECIPIENTS = 64;
/**
 * `constants::min_liquidity_window_duration_ms`: seven days, the shortest time
 * after the window before anyone may cancel an unmigrated funded sale.
 */
export const MIN_LIQUIDITY_WINDOW_DURATION_MS = 7n * 24n * 60n * 60n * 1_000n;

/** A `blast_presale` error, or a `blast_core` one a creation constructor raises. */
export type PresaleAbortCode = PresaleAbortName | CoreAbortName;

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

/**
 * Mirrors `blast_presale::valid_shares`: at most `max` shares, each taking
 * positive BPS and naming a distinct destination.
 */
function validShares(shares: readonly RecipientShare[], max: number): boolean {
  const destinations = shares.map((share) =>
    normalizeSuiAddress(share.recipient.destination),
  );
  return (
    shares.length <= max &&
    shares.every((share) => share.bps > 0n) &&
    new Set(destinations).size === destinations.length
  );
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

// === Constructors ===

/** Mirrors `bps::new` (`blast_core`), which every rate reaches the sale through. */
function bps(value: bigint): bigint {
  check(
    value >= 0n && value <= BPS,
    "EInvalidBps",
    "a basis-points rate must be at most 10,000",
  );
  return value;
}

/** Mirrors `payout::vesting_terms` (`blast_core`). */
function vestingTerms(terms: VestingTerms): void {
  const { cliffDelayMs, periodDurationMs, periods } = terms;
  check(
    isU64(cliffDelayMs) &&
      isU64(periodDurationMs) &&
      isU64(periods) &&
      periodDurationMs > 0n &&
      periods > 0n &&
      periodDurationMs <= MAX_VESTING_DURATION_MS / periods &&
      cliffDelayMs <= periodDurationMs * periods,
    "EInvalidVestingTerms",
    "vesting needs a positive period and period count, a cliff within its duration, and a duration of at most 2^63 milliseconds",
  );
}

/** Mirrors `payout::recipient` then `bps::new`, the constructors of one `recipient_share`. */
function recipientShare(share: RecipientShare): void {
  const terms = share.recipient.vestingTerms;
  if (terms) vestingTerms(terms);
  check(
    BigInt(normalizeSuiAddress(share.recipient.destination)) !== 0n,
    "EInvalidRecipient",
    "a recipient cannot be the zero address",
  );
  bps(share.bps);
}

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
      maxParticipants <= MAX_PARTICIPANTS,
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
      leafCount <= MAX_PARTICIPANTS,
    "EInvalidEligibilityPolicy",
    "allowlist needs a 32-byte root and 1..=65,536 leaves",
  );
  return { kind: "allowlisted", root, leafCount };
}

/** Mirrors `blast_presale::uncapped_for_eligible`. */
export function uncappedForEligible(startsAfterMs: bigint): UncappedPhase {
  return { startsAfterMs, access: { kind: "eligible" } };
}

/** Mirrors `blast_presale::uncapped_for_anyone`. */
export function uncappedForAnyone(
  startsAfterMs: bigint,
  maxParticipants: bigint,
  minCommitment: bigint,
): UncappedPhase {
  check(
    isU64(minCommitment) &&
      minCommitment > 0n &&
      maxParticipants > 0n &&
      maxParticipants <= MAX_PARTICIPANTS,
    "EInvalidUncappedPhase",
    "an open-to-anyone phase needs a positive minimum and 1..=65,536 participants",
  );
  return {
    startsAfterMs,
    access: { kind: "anyone", maxParticipants, minCommitment },
  };
}

// === Apportionment ===

export type SupplyApportionment = {
  /** Participant (presale) token allocation. */
  tokenAllocation: bigint;
  /** LP-token allocation seeded at migration. */
  liquidityTokenAllocation: bigint;
  /** Blast's token share, moved into the fee ledger on migration. */
  protocolTokenAllocation: bigint;
  recipientPayouts: RecipientPayout[];
};

/**
 * Mirrors `blast_presale::apportion_supply`: `[presale, LP, Blast,
 * ...recipients]` apportioned over `tokenSupply` by core `bps::apportion`
 * (largest remainder, no rounded-up part). Requires validated allocations
 * (`validateTokenAllocations`). The presale, the LP, and every recipient must
 * get positive atoms; Blast's share may be zero.
 */
export function apportionSupply(
  tokenSupply: bigint,
  tokenAllocationBps: bigint,
  liquidityTokenAllocationBps: bigint,
  protocolTokenBps: bigint,
  recipientAllocations: readonly RecipientShare[],
): SupplyApportionment {
  const amounts = apportionBps(
    [
      tokenAllocationBps,
      liquidityTokenAllocationBps,
      protocolTokenBps,
      ...recipientAllocations.map((allocation) => allocation.bps),
    ],
    tokenSupply,
    null,
  );
  const [
    tokenAllocation = 0n,
    liquidityTokenAllocation = 0n,
    protocolTokenAllocation = 0n,
  ] = amounts;
  const recipientPayouts = payouts(recipientAllocations, amounts.slice(3));
  check(
    tokenAllocation > 0n &&
      liquidityTokenAllocation > 0n &&
      recipientPayouts.every((payout) => payout.amount > 0n),
    "EInvalidTokenAllocation",
    "the presale, LP, and every recipient allocation must apportion to positive atoms",
  );
  return {
    tokenAllocation,
    liquidityTokenAllocation,
    protocolTokenAllocation,
    recipientPayouts,
  };
}

/**
 * Mirrors `blast_presale::apportion_raise`: raise recipients in order, then
 * Blast's `protocolRaiseBps`, then the LP's `10,000 - sum(bps) - Blast's`
 * last, apportioned over `raiseTarget`. Every recipient amount and the LP's
 * must be positive; Blast's may be zero. `liquidityQuote` seeds the pool.
 */
export function apportionRaise(
  raiseAllocations: readonly RecipientShare[],
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
  const amounts = apportionBps(
    [...shares, protocolRaiseBps, BPS - allocated],
    raiseTarget,
    null,
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

function payouts(
  allocations: readonly RecipientShare[],
  amounts: readonly bigint[],
): RecipientPayout[] {
  return allocations.map((allocation, index) => ({
    recipient: {
      destination: normalizeSuiAddress(allocation.recipient.destination),
      vestingTerms: allocation.recipient.vestingTerms,
    },
    amount: itemAt(amounts, index),
  }));
}

// === Creation validation ===

/** Mirrors `blast_presale::assert_raise_allocations`. */
export function validateRaiseAllocations(
  raiseAllocations: readonly RecipientShare[],
  protocolRaiseBps: bigint,
): void {
  check(
    validShares(raiseAllocations, MAX_RECIPIENTS) &&
      sum(raiseAllocations.map((allocation) => allocation.bps)) +
        protocolRaiseBps <
        BPS,
    "EInvalidRaiseAllocation",
    "raise allocations must be at most 64 distinct recipients leaving the LP a share after Blast's",
  );
}

/** Mirrors `blast_presale::assert_token_allocations`. */
export function validateTokenAllocations(
  tokenSupply: bigint,
  tokenAllocationBps: bigint,
  liquidityTokenAllocationBps: bigint,
  protocolTokenBps: bigint,
  recipientAllocations: readonly RecipientShare[],
): void {
  check(
    tokenSupply > 0n &&
      isU64(tokenSupply) &&
      tokenAllocationBps > 0n &&
      liquidityTokenAllocationBps > 0n &&
      validShares(recipientAllocations, MAX_RECIPIENTS) &&
      tokenAllocationBps +
        liquidityTokenAllocationBps +
        protocolTokenBps +
        sum(recipientAllocations.map((allocation) => allocation.bps)) ===
        BPS,
    "EInvalidTokenAllocation",
    "presale, LP, and distinct recipient BPS must be positive and total exactly 10,000 with Blast's share",
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
  // `slots_at_minimum`: every slot under an open policy; under an allowlist only
  // the slots beyond its leaves, whose wallets may commit any positive amount.
  const slotsAtMinimum =
    eligibility.kind === "open"
      ? phase.access.maxParticipants
      : phase.access.maxParticipants - eligibility.leafCount;
  check(
    phase.access.minCommitment * slotsAtMinimum >= raiseTarget,
    "EUnreachableRaise",
    "the phase's minimum times the slots held to it must reach the raise",
  );
}

/** Mirrors `finalize`'s hard-cap bound: the hard cap starts inside the window. */
export function validateHardCap(hardCap: HardCap, durationMs: bigint): void {
  check(
    hardCap.startsAfterMs < durationMs,
    "EInvalidHardCap",
    "a hard cap must start inside the commitment window",
  );
}

export type PresaleCreationConfig = {
  tokenSupply: bigint;
  tokenAllocationBps: bigint;
  liquidityTokenAllocationBps: bigint;
  recipientAllocations: readonly RecipientShare[];
  /** Terms each claim locks a participant's tokens under; null pays them out. */
  participantVesting: VestingTerms | null;
  raiseTarget: bigint;
  raiseAllocations: readonly RecipientShare[];
  durationMs: bigint;
  liquidityWindowMs: bigint;
  eligibility: EligibilityPolicy;
  uncapped: UncappedPhase | null;
  /** The sale's hard cap; null overflows for the whole window. */
  hardCap: HardCap | null;
  /** The LP-fee split the sale's vault starts with. */
  feeSplit: FeeSplit;
  /** The `FeePolicy` rates now, which `blast_presale::new` snapshots. */
  protocolFees: ProtocolFees;
};

export type PresaleCreationPreview = SupplyApportionment & {
  raisePayouts: RecipientPayout[];
  /** Blast's share of the raise, moved into the fee ledger on migration. */
  protocolQuote: bigint;
  /** Quote that seeds the pool: the raise less Blast's and the recipients' payouts. */
  liquidityQuote: bigint;
  /** floor(sqrt(quote / LP tokens) * 2^64), the sale token as coin A. */
  seedSqrtPriceX64: bigint;
};

/**
 * Mirrors the checks of `blast_presale::finalize` in its abort order, after the
 * constructors `PresaleCalls` runs first in setter order (`bps::new` for the
 * token rates, `payout::vesting_terms`, `payout::recipient` and `bps::new`
 * for each token recipient, `vesting_terms` for participant vesting, the raise
 * recipients, `open_eligibility` / `allowlisted_eligibility`,
 * `uncapped_for_anyone`, then `fee_split::new`), and returns the exact amounts
 * it apportions. Does not check what only the chain knows: the
 * `CreationPolicy`, the venue, distinct coin types, or a zero-supply
 * `TreasuryCap`.
 */
export function previewPresaleCreation(
  config: PresaleCreationConfig,
): PresaleCreationPreview {
  bps(config.tokenAllocationBps);
  bps(config.liquidityTokenAllocationBps);
  config.recipientAllocations.forEach(recipientShare);
  const { participantVesting, eligibility, uncapped, hardCap } = config;
  if (participantVesting) vestingTerms(participantVesting);
  config.raiseAllocations.forEach(recipientShare);
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
    );
  }
  for (const { destination, bps: rate } of config.feeSplit.routes) {
    check(
      destination.kind !== "Address" ||
        BigInt(normalizeSuiAddress(destination.address)) !== 0n,
      "EInvalidRoute",
      "a fee-split route cannot pay the zero address",
    );
    check(bps(rate) > 0n, "EInvalidRoute", "a route needs a positive share");
  }
  try {
    normalizeFeeSplit(config.feeSplit);
  } catch (error) {
    throw new PresaleAbortError(
      "EInvalidFeeSplit",
      error instanceof Error ? error.message : String(error),
    );
  }

  check(
    config.raiseTarget > 0n && isU64(config.raiseTarget),
    "EInvalidRaiseTarget",
    "the raise target must be a positive u64",
  );
  validateRaiseAllocations(
    config.raiseAllocations,
    config.protocolFees.raiseBps,
  );
  validateTokenAllocations(
    config.tokenSupply,
    config.tokenAllocationBps,
    config.liquidityTokenAllocationBps,
    config.protocolFees.tokenBps,
    config.recipientAllocations,
  );
  check(
    config.durationMs > 0n &&
      config.liquidityWindowMs >= MIN_LIQUIDITY_WINDOW_DURATION_MS,
    "EInvalidWindow",
    "the commitment window must be positive and the liquidity window at least seven days",
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
  if (hardCap) validateHardCap(hardCap, config.durationMs);

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
    isSeedablePrice(seedSqrtPriceX64),
    "EUnseedablePrice",
    "the raise and LP-token allocation give a seed price the venues cannot pool",
  );
  return { ...supply, ...raise, seedSqrtPriceX64 };
}

/**
 * Mirrors `blast_presale::share`: the windows fixed from `startMs`, the later
 * of the requested start and the share's clock time. Without an uncapped phase
 * `uncappedFromMs` is `endMs`; without a hard cap `hardCapFromMs` is null.
 * After an early close, pass the stored `durationMs`, the time the sale ran.
 */
export function presaleWindows(
  startMs: bigint,
  durationMs: bigint,
  liquidityWindowMs: bigint,
  uncapped: Pick<UncappedPhase, "startsAfterMs"> | null,
  hardCap: Pick<HardCap, "startsAfterMs"> | null = null,
): {
  endMs: bigint;
  liquidityDeadlineMs: bigint;
  uncappedFromMs: bigint;
  hardCapFromMs: bigint | null;
} {
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
    hardCapFromMs: hardCap ? startMs + hardCap.startsAfterMs : null,
  };
}

// === Commitments ===

export type CommitRoute = "open" | "allowlisted" | "uncapped";

export type CommitPreviewInput = {
  presale: Pick<
    PresaleState,
    | "lifecycle"
    | "startMs"
    | "endMs"
    | "raiseTarget"
    | "eligibility"
    | "uncapped"
    | "uncappedFromMs"
    | "hardCapFromMs"
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
 * `participant_limit`, `acceptable_quote`, and `add_within_cap`, in abort order.
 * Its values match the `Committed` event the call would emit.
 */
export function previewCommit(input: CommitPreviewInput): CommitPreview {
  const { presale, offered, nowMs } = input;
  check(
    presale.lifecycle === "Open",
    "EInvalidLifecycle",
    "the presale is not open",
  );
  check(
    nowMs >= presale.startMs,
    "EPresaleNotStarted",
    "the window has not started",
  );
  check(nowMs < presale.endMs, "EPresaleEnded", "the window has ended");
  check(offered > 0n, "EZeroCommitment", "a commitment must be positive");

  const { walletCap, maxParticipants, minCommitment } = routeLimits(input);
  const uncapped = nowMs >= presale.uncappedFromMs;
  const hardCapped =
    presale.hardCapFromMs !== null && nowMs >= presale.hardCapFromMs;
  const limit =
    uncapped && presale.uncapped?.access.kind === "anyone"
      ? presale.uncapped.access.maxParticipants
      : maxParticipants;

  // acceptable_quote
  let accepted = offered;
  if (hardCapped) {
    check(
      presale.totalCommitments < presale.raiseTarget,
      "EPresaleFilled",
      "the sale already reached its raise under its hard cap",
    );
    const left = presale.raiseTarget - presale.totalCommitments;
    accepted = offered < left ? offered : left;
  }
  const fillsRaise =
    hardCapped && presale.totalCommitments + accepted === presale.raiseTarget;

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
 * Mirrors `blast_presale::can_close_early`: the raise is full under a hard cap
 * that closes the sale when filled, so it can take no more Quote.
 */
export function canClosePresaleEarly(
  presale: Pick<
    PresaleState,
    "hardCap" | "hardCapFromMs" | "totalCommitments" | "raiseTarget"
  >,
  nowMs: bigint,
): boolean {
  return (
    presale.hardCap?.closesWhenFilled === true &&
    presale.hardCapFromMs !== null &&
    nowMs >= presale.hardCapFromMs &&
    presale.totalCommitments >= presale.raiseTarget
  );
}

/**
 * Mirrors `blast_presale::settle` at clock time `nowMs`, in abort order: from
 * `endMs`, or earlier once the sale can close early, an underfunded sale
 * cancels and a funded one fixes the common fill rate `raise / commitments`.
 * An early close ends the window at `nowMs`, so `endMs` and the LP deadline
 * it returns count from the close, matching `PresaleFunded`.
 */
export function previewSettlement(
  presale: Pick<
    PresaleState,
    | "lifecycle"
    | "startMs"
    | "endMs"
    | "liquidityWindowMs"
    | "hardCap"
    | "hardCapFromMs"
    | "totalCommitments"
    | "raiseTarget"
  >,
  nowMs: bigint,
):
  | { outcome: "Cancelled"; refundableQuote: bigint }
  | {
      outcome: "Funded";
      acceptedQuote: bigint;
      refundableQuote: bigint;
      endMs: bigint;
      liquidityDeadlineMs: bigint;
    } {
  check(
    presale.lifecycle === "Open",
    "EInvalidLifecycle",
    "only an open presale settles",
  );
  check(
    nowMs >= presale.endMs || canClosePresaleEarly(presale, nowMs),
    "EPresaleNotEnded",
    "the window has not ended and the sale cannot close early",
  );
  if (presale.totalCommitments < presale.raiseTarget) {
    return { outcome: "Cancelled", refundableQuote: presale.totalCommitments };
  }
  const endMs = nowMs < presale.endMs ? nowMs : presale.endMs;
  return {
    outcome: "Funded",
    acceptedQuote: presale.raiseTarget,
    refundableQuote: presale.totalCommitments - presale.raiseTarget,
    endMs,
    liquidityDeadlineMs: endMs + presale.liquidityWindowMs,
  };
}

/**
 * Mirrors `blast_presale::claim` for one commitment of `commitment` Quote
 * atoms. After migration: `tokens = floor(tokenAllocation * c / C)` and
 * `quoteRefund = floor((C - R) * c / C)`; after cancellation no tokens and
 * `floor(C * c / C) = c`. The last claim, from the one wallet still holding a
 * commitment (`participants == 1`), takes every atom left in custody instead,
 * so the rounding remainder goes to it. `vesting` is
 * the terms of the schedule the claim locks `tokens` in, starting at the claim;
 * null when they are paid out, including when there are none to lock.
 */
export function previewClaim(
  presale: Pick<
    PresaleState,
    | "lifecycle"
    | "totalCommitments"
    | "participants"
    | "raiseTarget"
    | "tokenAllocation"
    | "participantVesting"
    | "saleTokens"
    | "quote"
  >,
  commitment: bigint,
): { tokens: bigint; quoteRefund: bigint; vesting: VestingTerms | null } {
  const migrated = presale.lifecycle === "Migrated";
  check(
    migrated || presale.lifecycle === "Cancelled",
    "EInvalidLifecycle",
    "claims open after migration or cancellation",
  );
  const total = presale.totalCommitments;
  const last = presale.participants === 1n;
  const tokens = !migrated
    ? 0n
    : last
      ? presale.saleTokens
      : (presale.tokenAllocation * commitment) / total;
  const refundTotal = migrated ? total - presale.raiseTarget : total;
  const quoteRefund = last ? presale.quote : (refundTotal * commitment) / total;
  const vesting = tokens > 0n ? presale.participantVesting : null;
  return { tokens, quoteRefund, vesting };
}
