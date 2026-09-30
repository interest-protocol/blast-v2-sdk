import {
  BASIS_POINTS_DENOMINATOR,
  checkedAddU64,
  mulDivDown,
  mulDivUp,
  requireBasisPoints,
  requirePositiveU64,
  requireU64,
} from "../lib/integers.ts";

export type CurveState = {
  memeReserve: bigint;
  realQuoteReserve: bigint;
  virtualQuote: bigint;
  graduationTarget: bigint;
  quoteFeeBps: bigint;
  memeFeeBps: bigint;
};

export const MAX_SELL_BURN_BPS = 5_000n;

export type BuyPreview = {
  quoteSupplied: bigint;
  quoteInGross: bigint;
  quoteRefund: bigint;
  quoteFee: bigint;
  quoteInNet: bigint;
  memeOutGross: bigint;
  memeFee: bigint;
  memeOutNet: bigint;
  memeReserveAfter: bigint;
  realQuoteReserveAfter: bigint;
  crossedThreshold: boolean;
};

export type SellPreview = {
  memeInGross: bigint;
  memeFee: bigint;
  memeInAfterFee: bigint;
  progressBps: bigint;
  burnBps: bigint;
  pendingBurnDelta: bigint;
  memeInEffective: bigint;
  quoteOutGross: bigint;
  quoteFee: bigint;
  quoteOutNet: bigint;
  memeReserveAfter: bigint;
  realQuoteReserveAfter: bigint;
};

/**
 * Mirrors `launch::buy`, including its exact-target cap.
 *
 * Inputs and outputs use atomic units. Fees round up to their fee recipient;
 * curve output rounds down, leaving the integer remainder in the curve.
 */
export function previewBuy(
  state: CurveState,
  quoteSupplied: bigint,
): BuyPreview {
  validateCurveState(state);
  requirePositiveU64("quoteSupplied", quoteSupplied);

  if (state.realQuoteReserve >= state.graduationTarget) {
    throw new RangeError(
      "buy preview requires Quote below the graduation target",
    );
  }

  const quoteRemaining = state.graduationTarget - state.realQuoteReserve;
  const suppliedFee = applyBpsUp(quoteSupplied, state.quoteFeeBps);
  const suppliedNet = quoteSupplied - suppliedFee;
  let quoteInGross = quoteSupplied;

  if (suppliedNet > quoteRemaining) {
    const feeComplement = BASIS_POINTS_DENOMINATOR - state.quoteFeeBps;
    if (feeComplement === 0n) {
      throw new RangeError("quoteFeeBps leaves no net Quote input");
    }
    quoteInGross = mulDivUp(
      quoteRemaining,
      BASIS_POINTS_DENOMINATOR,
      feeComplement,
    );
  }

  const quoteRefund = quoteSupplied - quoteInGross;
  const quoteFee = applyBpsUp(quoteInGross, state.quoteFeeBps);
  const quoteInNet = quoteInGross - quoteFee;
  requirePositiveOutput("quoteInNet", quoteInNet);

  const effectiveQuoteAfter =
    state.virtualQuote + state.realQuoteReserve + quoteInNet;
  const memeOutGross = (state.memeReserve * quoteInNet) / effectiveQuoteAfter;
  requirePositiveOutput("memeOutGross", memeOutGross);

  const memeFee = applyBpsUp(memeOutGross, state.memeFeeBps);
  const memeOutNet = memeOutGross - memeFee;
  requirePositiveOutput("memeOutNet", memeOutNet);

  const realQuoteReserveAfter = checkedAddU64(
    "realQuoteReserveAfter",
    state.realQuoteReserve,
    quoteInNet,
  );

  return {
    quoteSupplied,
    quoteInGross,
    quoteRefund,
    quoteFee,
    quoteInNet,
    memeOutGross,
    memeFee,
    memeOutNet,
    memeReserveAfter: state.memeReserve - memeOutGross,
    realQuoteReserveAfter,
    crossedThreshold: realQuoteReserveAfter >= state.graduationTarget,
  };
}

/**
 * Mirrors `launch::sell` for one live launch.
 *
 * Inputs and outputs use atomic units. Fees and pending burn round up to their
 * recipients. The creator-selected burn is applied after the Meme fee; Quote
 * output and progress telemetry round down.
 */
export function previewSell(
  state: CurveState,
  memeInGross: bigint,
  sellBurnBps: bigint,
): SellPreview {
  validateCurveState(state);
  requirePositiveU64("memeInGross", memeInGross);
  requireBasisPoints("sellBurnBps", sellBurnBps);
  if (sellBurnBps > MAX_SELL_BURN_BPS) {
    throw new RangeError("sellBurnBps exceeds 5,000");
  }

  const memeFee = applyBpsUp(memeInGross, state.memeFeeBps);
  const memeInAfterFee = memeInGross - memeFee;
  requirePositiveOutput("memeInAfterFee", memeInAfterFee);

  const progressBps =
    state.realQuoteReserve >= state.graduationTarget
      ? BASIS_POINTS_DENOMINATOR
      : mulDivDown(
          state.realQuoteReserve,
          BASIS_POINTS_DENOMINATOR,
          state.graduationTarget,
        );
  const burnBps = sellBurnBps;
  const pendingBurnDelta = applyBpsUp(memeInAfterFee, burnBps);
  const memeInEffective = memeInAfterFee - pendingBurnDelta;
  requirePositiveOutput("memeInEffective", memeInEffective);

  const memeReserveAfter = checkedAddU64(
    "memeReserveAfter",
    state.memeReserve,
    memeInEffective,
  );
  const effectiveQuote = state.virtualQuote + state.realQuoteReserve;
  const quoteOutGross = (effectiveQuote * memeInEffective) / memeReserveAfter;
  requirePositiveOutput("quoteOutGross", quoteOutGross);

  if (quoteOutGross > state.realQuoteReserve) {
    throw new RangeError("sell preview exceeds the real Quote reserve");
  }

  const quoteFee = applyBpsUp(quoteOutGross, state.quoteFeeBps);
  const quoteOutNet = quoteOutGross - quoteFee;
  requirePositiveOutput("quoteOutNet", quoteOutNet);

  return {
    memeInGross,
    memeFee,
    memeInAfterFee,
    progressBps,
    burnBps,
    pendingBurnDelta,
    memeInEffective,
    quoteOutGross,
    quoteFee,
    quoteOutNet,
    memeReserveAfter,
    realQuoteReserveAfter: state.realQuoteReserve - quoteOutGross,
  };
}

/**
 * Mirrors `launch::deliver_opening_round`: a bidder's share of the Meme and
 * refunded Quote the settled round holds, each `held * bid / bids` rounded
 * down. The last undelivered bid (`bid === openingRoundBids`) takes the
 * remainder, so rounding dust stays with the later deliveries.
 */
export function previewOpeningRoundDelivery(
  round: {
    openingRoundBids: bigint;
    openingRoundMeme: bigint;
    openingRoundQuote: bigint;
  },
  bid: bigint,
): { meme: bigint; quote: bigint } {
  requirePositiveU64("bid", bid);
  if (bid > round.openingRoundBids) {
    throw new RangeError("bid exceeds the undelivered opening-round bids");
  }
  return {
    meme: mulDivDown(round.openingRoundMeme, bid, round.openingRoundBids),
    quote: mulDivDown(round.openingRoundQuote, bid, round.openingRoundBids),
  };
}

function validateCurveState(state: CurveState): void {
  requirePositiveU64("memeReserve", state.memeReserve);
  requireU64("realQuoteReserve", state.realQuoteReserve);
  requirePositiveU64("virtualQuote", state.virtualQuote);
  requirePositiveU64("graduationTarget", state.graduationTarget);
  requireBasisPoints("quoteFeeBps", state.quoteFeeBps);
  requireBasisPoints("memeFeeBps", state.memeFeeBps);
}

function applyBpsUp(amount: bigint, bps: bigint): bigint {
  return mulDivUp(amount, bps, BASIS_POINTS_DENOMINATOR);
}

function requirePositiveOutput(name: string, value: bigint): void {
  if (value <= 0n) {
    throw new RangeError(`${name} rounds to zero`);
  }
}
