import { requirePositiveU64, requireU64, requireU128 } from "./integers.ts";

const Q64 = 1n << 64n;
const Q128 = 1n << 128n;
/** Atoms of the other asset `auto_lp_fixed_side` keeps beyond its estimate. */
export const AUTO_LP_MARGIN = 2n;

/** Mirrors `blast_fun_migrators::migration_math::sqrt_price_x64` over atomic Meme/Quote units. */
export function sqrtPriceX64(
  memeAmount: bigint,
  quoteAmount: bigint,
  memeIsCoinA: boolean,
): bigint {
  return integerSqrt(ratioQ128(memeAmount, quoteAmount, memeIsCoinA));
}

/**
 * Mirrors `migration_math::auto_lp_fixed_side`, which Bluefin auto-LP uses to
 * choose the fixed side from the pool's and the position's Q64.64 sqrt prices.
 * Returns `{ fixA, amount }`; a zero amount means nothing is added now.
 * Divisions round down except the other side's requirement, which rounds up.
 */
export function autoLpFixedSide(
  sqrtLower: bigint,
  sqrtPrice: bigint,
  sqrtUpper: bigint,
  amountA: bigint,
  amountB: bigint,
): { fixA: boolean; amount: bigint } {
  const lower = requireU128("sqrtLower", sqrtLower);
  const price = requireU128("sqrtPrice", sqrtPrice);
  const upper = requireU128("sqrtUpper", sqrtUpper);
  requireU64("amountA", amountA);
  requireU64("amountB", amountB);
  if (amountA === 0n || amountB === 0n) return { fixA: true, amount: 0n };
  if (price <= lower || price >= upper) return { fixA: true, amount: 0n };

  const liquidityA = (amountA * ((price * upper) / Q64)) / (upper - price);
  if (liquidityA > 0n && liquidityA < Q128) {
    const neededB = divCeil(liquidityA * (price - lower), Q64);
    if (neededB + AUTO_LP_MARGIN <= amountB) {
      return { fixA: true, amount: amountA };
    }
  }
  const liquidityB = (amountB << 64n) / (price - lower);
  if (liquidityB > 0n) {
    const neededA =
      divCeil(liquidityB << 64n, price) - (liquidityB << 64n) / upper;
    if (neededA + AUTO_LP_MARGIN <= amountA) {
      return { fixA: false, amount: amountB };
    }
  }
  return { fixA: true, amount: 0n };
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

function divCeil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
