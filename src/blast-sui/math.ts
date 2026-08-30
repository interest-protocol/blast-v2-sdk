import {
  BASIS_POINTS_DENOMINATOR,
  mulDivDown,
  mulDivUp,
  requirePositiveU64,
  requireU64,
} from "../lib/integers.ts";
import type { BasisPoints } from "../lib/integers.ts";

/**
 * Quotes blastSUI shares from atomic-MIST `deposit`, `blastAssets`, and share
 * `blastSupply`. Rounds down; the remainder stays with existing holders.
 */
export function blastSharesOutDown(
  deposit: bigint,
  blastAssets: bigint,
  blastSupply: bigint,
): bigint {
  requirePositiveU64("deposit", deposit);
  requirePositiveU64("blastAssets", blastAssets);
  requireU64("blastSupply", blastSupply);
  const shares = mulDivDown(deposit, blastSupply, blastAssets);
  if (shares === 0n) {
    throw new RangeError("blast shares must be positive");
  }
  return requireU64("shares", shares);
}

/**
 * Quotes the gross atomic-MIST claim for `shares`. Rounds down; the remainder
 * stays in blast custody.
 */
export function blastGrossSuiOutDown(
  shares: bigint,
  blastAssets: bigint,
  blastSupply: bigint,
): bigint {
  requirePositiveU64("shares", shares);
  requirePositiveU64("blastAssets", blastAssets);
  requireU64("blastSupply", blastSupply);
  if (shares > blastSupply) {
    throw new RangeError("shares must not exceed blastSupply");
  }
  const grossSui = mulDivDown(shares, blastAssets, blastSupply);
  if (grossSui === 0n) {
    throw new RangeError("gross SUI must be positive");
  }
  return requireU64("grossSui", grossSui);
}

/**
 * Quotes the atomic-MIST redemption fee at a validated basis-point rate.
 * Rounds up; the remainder is retained in blast custody.
 */
export function blastRedeemFeeUp(
  grossSui: bigint,
  redeemFeeBps: BasisPoints,
): bigint {
  requirePositiveU64("grossSui", grossSui);
  requireU64("redeemFeeBps", redeemFeeBps);
  return requireU64(
    "feeSui",
    mulDivUp(grossSui, redeemFeeBps, BASIS_POINTS_DENOMINATOR),
  );
}

/**
 * Quotes a blastSUI redemption in atomic MIST. The gross claim rounds down
 * and the fee rounds up, so both remainders remain in blast custody.
 */
export function blastRedemptionQuote(
  shares: bigint,
  blastAssets: bigint,
  blastSupply: bigint,
  redeemFeeBps: BasisPoints,
): { grossSui: bigint; feeSui: bigint; netSui: bigint } {
  const grossSui = blastGrossSuiOutDown(shares, blastAssets, blastSupply);
  const feeSui = blastRedeemFeeUp(grossSui, redeemFeeBps);
  return { grossSui, feeSui, netSui: grossSui - feeSui };
}

/**
 * Values native pool tokens in atomic MIST at a stored rate. Rounds down; the
 * fractional remainder is unclaimed. An empty rate is one MIST per token.
 */
export function suiAtRateDown(
  poolTokens: bigint,
  rateSui: bigint,
  ratePoolTokens: bigint,
): bigint {
  requireU64("poolTokens", poolTokens);
  requireU64("rateSui", rateSui);
  requireU64("ratePoolTokens", ratePoolTokens);
  if (rateSui === 0n || ratePoolTokens === 0n) return poolTokens;
  return requireU64(
    "suiAmount",
    mulDivDown(poolTokens, rateSui, ratePoolTokens),
  );
}

/**
 * Values atomic MIST in native pool tokens at a stored rate. Rounds down, so
 * the quoted tokens are worth at most the input. An empty rate is one-to-one.
 */
export function poolTokensAtRateDown(
  suiAmount: bigint,
  rateSui: bigint,
  ratePoolTokens: bigint,
): bigint {
  requireU64("suiAmount", suiAmount);
  requireU64("rateSui", rateSui);
  requireU64("ratePoolTokens", ratePoolTokens);
  if (rateSui === 0n || ratePoolTokens === 0n) return suiAmount;
  return requireU64(
    "poolTokens",
    mulDivDown(suiAmount, ratePoolTokens, rateSui),
  );
}

/**
 * Bounds atomic MIST lost by a native floor conversion. Rounds up to keep the
 * bound conservative; an empty rate has no conversion remainder.
 */
export function funConversionLossBoundUp(
  rateSui: bigint,
  ratePoolTokens: bigint,
): bigint {
  requireU64("rateSui", rateSui);
  requireU64("ratePoolTokens", ratePoolTokens);
  if (rateSui === 0n || ratePoolTokens === 0n) return 0n;
  return requireU64("lossBound", mulDivUp(rateSui, 1n, ratePoolTokens));
}

/**
 * Quotes active pool tokens needed for atomic MIST. Rounds up so the tokens
 * cover the requested value, then caps the result at `held`; an empty active
 * valuation requests all held tokens.
 */
export function poolTokensForSuiUp(
  suiAmount: bigint,
  held: bigint,
  activeSui: bigint,
): bigint {
  requireU64("suiAmount", suiAmount);
  requireU64("held", held);
  requireU64("activeSui", activeSui);
  if (activeSui === 0n) return held;
  const requested = requireU64(
    "poolTokens",
    mulDivUp(suiAmount, held, activeSui),
  );
  return requested < held ? requested : held;
}
