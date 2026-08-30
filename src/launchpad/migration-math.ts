import {
  BASIS_POINTS_DENOMINATOR,
  mulDivUp,
  requireBasisPoints,
  requirePositiveU64,
  requireU128,
  requireU64,
} from "../lib/integers.ts";

/** Mirrors `migration_math::sqrt_price_x64` over atomic Meme/Quote units. */
export function sqrtPriceX64(
  memeAmount: bigint,
  quoteAmount: bigint,
  memeIsCoinA: boolean,
): bigint {
  return integerSqrt(ratioQ128(memeAmount, quoteAmount, memeIsCoinA));
}

/** Mirrors the adopted-pool price guard in `migration_math`. */
export function assertPriceWithinBps(
  memeAmount: bigint,
  quoteAmount: bigint,
  memeIsCoinA: boolean,
  actualSqrtPriceX64: bigint,
  maxDeviationBps: bigint,
): void {
  requireBasisPoints("maxDeviationBps", maxDeviationBps);
  requireU128("actualSqrtPriceX64", actualSqrtPriceX64);

  const expectedRatioQ128 = ratioQ128(
    memeAmount,
    quoteAmount,
    memeIsCoinA,
  );
  const actualRatioQ128 = actualSqrtPriceX64 * actualSqrtPriceX64;
  const difference =
    actualRatioQ128 >= expectedRatioQ128
      ? actualRatioQ128 - expectedRatioQ128
      : expectedRatioQ128 - actualRatioQ128;

  if (
    difference > expectedRatioQ128 ||
    difference * BASIS_POINTS_DENOMINATOR >
      expectedRatioQ128 * maxDeviationBps
  ) {
    throw new RangeError(
      `price deviation exceeds ${maxDeviationBps} basis points`,
    );
  }
}

/** Mirrors the minimum venue-consumed amount after residual rounding. */
export function minimumUtilizedAmount(
  amount: bigint,
  maxResidualBps: bigint,
): bigint {
  requireU64("amount", amount);
  return amount - maximumResidualAmount(amount, maxResidualBps);
}

/** Mirrors the venue residual guard in `migration_math`. */
export function assertResidualWithinBps(
  sourceAmount: bigint,
  residualAmount: bigint,
  maxResidualBps: bigint,
): void {
  requireU64("sourceAmount", sourceAmount);
  requireU64("residualAmount", residualAmount);
  if (residualAmount > maximumResidualAmount(sourceAmount, maxResidualBps)) {
    throw new RangeError(
      `residual exceeds ${maxResidualBps} basis points`,
    );
  }
}

function ratioQ128(
  memeAmount: bigint,
  quoteAmount: bigint,
  memeIsCoinA: boolean,
): bigint {
  requirePositiveU64("memeAmount", memeAmount);
  requirePositiveU64("quoteAmount", quoteAmount);
  const numerator = memeIsCoinA ? quoteAmount : memeAmount;
  const denominator = memeIsCoinA ? memeAmount : quoteAmount;
  return (numerator << 128n) / denominator;
}

function integerSqrt(value: bigint): bigint {
  let low = 0n;
  let high = 1n << 96n;
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    if (middle * middle <= value) low = middle;
    else high = middle;
  }
  return low;
}

function maximumResidualAmount(amount: bigint, maxResidualBps: bigint): bigint {
  requireBasisPoints("maxResidualBps", maxResidualBps);
  return mulDivUp(
    amount,
    maxResidualBps,
    BASIS_POINTS_DENOMINATOR,
  );
}
