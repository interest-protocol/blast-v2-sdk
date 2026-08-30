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
  migrationQuoteTarget: bigint;
  quoteFeeBps: bigint;
  memeFeeBps: bigint;
};

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

  if (state.realQuoteReserve >= state.migrationQuoteTarget) {
    throw new RangeError(
      "buy preview requires Quote below the migration target",
    );
  }

  const quoteRemaining = state.migrationQuoteTarget - state.realQuoteReserve;
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
    crossedThreshold: realQuoteReserveAfter >= state.migrationQuoteTarget,
  };
}

/**
 * Mirrors `launch::sell` for one live launch.
 *
 * Inputs and outputs use atomic units. Fees and pending burn round up to their
 * recipients. Progress, the burn-rate ramp, and Quote output round down.
 */
export function previewSell(
  state: CurveState,
  memeInGross: bigint,
  maxBurnBps: bigint,
): SellPreview {
  validateCurveState(state);
  requirePositiveU64("memeInGross", memeInGross);
  requireBasisPoints("maxBurnBps", maxBurnBps);

  const memeFee = applyBpsUp(memeInGross, state.memeFeeBps);
  const memeInAfterFee = memeInGross - memeFee;
  requirePositiveOutput("memeInAfterFee", memeInAfterFee);

  const progressBps =
    state.realQuoteReserve >= state.migrationQuoteTarget
      ? BASIS_POINTS_DENOMINATOR
      : mulDivDown(
          state.realQuoteReserve,
          BASIS_POINTS_DENOMINATOR,
          state.migrationQuoteTarget,
        );
  const burnBps = mulDivDown(progressBps, maxBurnBps, BASIS_POINTS_DENOMINATOR);
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

function validateCurveState(state: CurveState): void {
  requirePositiveU64("memeReserve", state.memeReserve);
  requireU64("realQuoteReserve", state.realQuoteReserve);
  requirePositiveU64("virtualQuote", state.virtualQuote);
  requirePositiveU64("migrationQuoteTarget", state.migrationQuoteTarget);
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
