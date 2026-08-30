import type { BasisPoints } from "../lib/integers.ts";
import {
  BASIS_POINTS_DENOMINATOR,
  mulDivDown,
  mulDivUp,
  requireBasisPoints,
  requirePositiveU64,
  requireU64,
} from "../lib/integers.ts";

/**
 * Inputs `deposit` and `blastAssets` are MIST; `blastSupply` is atomic
 * blastSUI shares. The output is atomic blastSUI shares. It rounds down with
 * a bigint intermediate. No value is transferred; the unminted fractional
 * share remains value for existing holders.
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
 * Inputs `shares` and `blastSupply` are atomic blastSUI shares;
 * `blastAssets` is MIST. The output is MIST. It rounds down with a bigint
 * intermediate. No value is transferred; fractional MIST stays in blast
 * custody.
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
 * Input `grossSui` and the output fee are MIST; `redeemFeeBps` is basis
 * points. It rounds the fee up with a bigint intermediate. This helper does
 * not transfer value; during redemption, the fee and ceiling remainder stay
 * in blast custody for remaining holders.
 */
export function blastRedeemFeeUp(
  grossSui: bigint,
  redeemFeeBps: BasisPoints,
): bigint {
  requirePositiveU64("grossSui", grossSui);
  requireBasisPoints("redeemFeeBps", redeemFeeBps);
  return requireU64(
    "feeSui",
    mulDivUp(grossSui, redeemFeeBps, BASIS_POINTS_DENOMINATOR),
  );
}

/**
 * Inputs `shares` and `blastSupply` are atomic blastSUI shares;
 * `blastAssets` is MIST and `redeemFeeBps` is basis points. All three outputs
 * are MIST. Gross rounds down, fee rounds up, and net is their checked exact
 * difference. The caller transfers only net MIST; fee and rounding remainders
 * stay in blast custody. This pure helper transfers nothing.
 */
export function blastRedemptionQuote(
  shares: bigint,
  blastAssets: bigint,
  blastSupply: bigint,
  redeemFeeBps: BasisPoints,
): { grossSui: bigint; feeSui: bigint; netSui: bigint } {
  const grossSui = blastGrossSuiOutDown(shares, blastAssets, blastSupply);
  const feeSui = blastRedeemFeeUp(grossSui, redeemFeeBps);
  const netSui = requireU64("netSui", grossSui - feeSui);
  return { grossSui, feeSui, netSui };
}

/**
 * Input `poolTokens` and `ratePoolTokens` are native pool-token units;
 * `rateSui` and the output are MIST. It rounds down with a bigint intermediate;
 * an empty rate is one MIST per token. This valuation transfers nothing, and
 * the fractional MIST is omitted as conservative value rather than assigned.
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
 * Inputs `suiAmount` and `rateSui` are MIST; `ratePoolTokens` and the output
 * are native pool-token units. It rounds down with a bigint intermediate; an
 * empty rate is one-to-one. This quote transfers nothing, and the fractional
 * pool token is omitted so the result is worth at most the input.
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
 * Input `rateSui` is MIST and `ratePoolTokens` is native pool-token units; the
 * output is a MIST loss bound. It rounds up to stay conservative; an empty
 * rate returns zero. No value is transferred or assigned: the ceiling is only
 * safety headroom for a possible floor-conversion remainder.
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
 * Inputs `suiAmount` and `activeSui` are MIST; `held` and the output are native
 * pool-token units. It rounds up with a bigint intermediate, then caps at
 * `held`; an empty valuation returns all held tokens. The ceiling surplus is
 * requested from the same active position. This quote transfers nothing.
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
