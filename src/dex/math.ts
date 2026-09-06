import {
  mulDivDown,
  mulDivUp,
  requireBasisPoints,
  requirePositiveU64,
  requireU64,
  requireU128,
} from "../lib/integers.ts";

export const DEX_X32 = 1n << 32n;
export const DEX_X64 = 1n << 64n;
export const DEX_HALF_LIFE_SECONDS = 1_800n;
export const DEX_MAX_FEE_BPS = 500n;
export const DEX_MINIMUM_SHARES = 1_000n;
const DECAY_SECOND_X64 = 18_439_641_936_446_208_054n;

export type DexPoolEconomics = {
  memeReserve: bigint;
  quoteReserve: bigint;
  quoteFees: bigint;
  totalShares: bigint;
  feeGrowthX64: bigint;
  volumeX32: bigint;
  lastTradeSeconds: bigint;
  volumeTarget: bigint;
  maxFeeBps: bigint;
  burnBps: bigint;
};
export type DexPositionEconomics = {
  shares: bigint;
  feeCheckpointX64: bigint;
  feesOwed: bigint;
  feeFractionX64: bigint;
};
export type DexTradeLimits = {
  minimumOutput?: bigint;
  maximumFeeBps?: bigint;
  deadlineMs?: bigint;
};

/** Quote atoms. Integrates the capped marginal ramp and rounds up to the separate fee pot. */
export function integratedQuoteFee(
  volumeX32: bigint,
  target: bigint,
  principal: bigint,
  maximumBps: bigint,
): bigint {
  requirePositiveU64("target", target);
  requireU64("principal", principal);
  requireU128("volumeX32", volumeX32);
  requireU64("maximumBps", maximumBps);
  if (maximumBps > DEX_MAX_FEE_BPS)
    throw new RangeError("maximumBps exceeds 500");
  const cap = target * DEX_X32;
  if (volumeX32 > cap) throw new RangeError("volumeX32 exceeds target");
  const input = principal * DEX_X32;
  const ramp = input < cap - volumeX32 ? input : cap - volumeX32;
  const integral = ramp * (2n * volumeX32 + ramp) + 2n * cap * (input - ramp);
  return mulDivUp(integral, maximumBps, 2n * cap * DEX_X32 * 10_000n);
}

/** Quote atoms. Finds the greatest affordable principal; unused gross stays with the trader. */
export function dexBuyPrincipal(
  volumeX32: bigint,
  target: bigint,
  gross: bigint,
  maximumBps: bigint,
) {
  requireU64("gross", gross);
  integratedQuoteFee(volumeX32, target, 0n, maximumBps);
  let low = 0n;
  let high = gross;
  while (low < high) {
    const mid = low + (high - low + 1n) / 2n;
    if (mid + integratedQuoteFee(volumeX32, target, mid, maximumBps) <= gross)
      low = mid;
    else high = mid - 1n;
  }
  const fee = integratedQuoteFee(volumeX32, target, low, maximumBps);
  return { principal: low, fee, refund: gross - low - fee };
}

/** Q32 Quote score. Exact whole half-lives, upward Q64 factors, then one final floor. */
export function decayDexVolume(
  volumeX32: bigint,
  elapsedSeconds: bigint,
): bigint {
  requireU128("volumeX32", volumeX32);
  requireU64("elapsedSeconds", elapsedSeconds);
  if (elapsedSeconds >= 129n * DEX_HALF_LIFE_SECONDS) return 0n;
  const halves = elapsedSeconds / DEX_HALF_LIFE_SECONDS;
  if (halves >= 128n) return 0n;
  let seconds = elapsedSeconds % DEX_HALF_LIFE_SECONDS;
  let factor = DEX_X64;
  let base = DECAY_SECOND_X64;
  while (seconds > 0n) {
    if (seconds % 2n === 1n) factor = mulDivUp(factor, base, DEX_X64);
    seconds /= 2n;
    if (seconds > 0n) base = mulDivUp(base, base, DEX_X64);
  }
  return (volumeX32 * factor) / (DEX_X64 << halves);
}

/** Quote-in buy; output floors to reserves, burn ceilings to destroyed Meme, fee ceilings to LPs. */
export function previewDexBuy(
  pool: DexPoolEconomics,
  grossQuote: bigint,
  timestampMs: bigint,
  limits: DexTradeLimits = {},
) {
  const volume = agedVolume(pool, timestampMs, limits);
  requirePositiveU64("grossQuote", grossQuote);
  const { principal, fee, refund } = dexBuyPrincipal(
    volume,
    pool.volumeTarget,
    grossQuote,
    pool.maxFeeBps,
  );
  requirePositiveU64("principal", principal);
  const memeGross = mulDivDown(
    principal,
    pool.memeReserve,
    pool.quoteReserve + principal,
  );
  const memeBurn = mulDivUp(memeGross, pool.burnBps, 10_000n);
  const memeOut = memeGross - memeBurn;
  const minimumFeeLimitBps = checkTrade(principal, fee, memeOut, limits);
  const after = afterTrade(
    pool,
    pool.memeReserve - memeGross,
    pool.quoteReserve + principal,
    volume,
    principal,
    fee,
    timestampMs,
  );
  return {
    quotePrincipal: principal,
    quoteFee: fee,
    quoteRefund: refund,
    memeOut,
    memeBurn,
    minimumFeeLimitBps,
    after,
  };
}

/** Meme-in sell; destroys the rounded-up burn first, then deducts Quote fees from curve output. */
export function previewDexSell(
  pool: DexPoolEconomics,
  grossMeme: bigint,
  timestampMs: bigint,
  limits: DexTradeLimits = {},
) {
  const volume = agedVolume(pool, timestampMs, limits);
  requirePositiveU64("grossMeme", grossMeme);
  const memeBurn = mulDivUp(grossMeme, pool.burnBps, 10_000n);
  const memePrincipal = grossMeme - memeBurn;
  requirePositiveU64("memePrincipal", memePrincipal);
  const quotePrincipal = mulDivDown(
    memePrincipal,
    pool.quoteReserve,
    pool.memeReserve + memePrincipal,
  );
  const quoteFee = integratedQuoteFee(
    volume,
    pool.volumeTarget,
    quotePrincipal,
    pool.maxFeeBps,
  );
  const quoteOut = quotePrincipal - quoteFee;
  const minimumFeeLimitBps = checkTrade(
    quotePrincipal,
    quoteFee,
    quoteOut,
    limits,
  );
  const after = afterTrade(
    pool,
    pool.memeReserve + memePrincipal,
    pool.quoteReserve - quotePrincipal,
    volume,
    quotePrincipal,
    quoteFee,
    timestampMs,
  );
  return {
    memePrincipal,
    memeBurn,
    quotePrincipal,
    quoteFee,
    quoteOut,
    minimumFeeLimitBps,
    after,
  };
}

/** Both maxima in atomic units; shares floor, required contributions ceil, excess refunds to depositor. */
export function previewDexDeposit(
  pool: Pick<DexPoolEconomics, "memeReserve" | "quoteReserve" | "totalShares">,
  memeMaximum: bigint,
  quoteMaximum: bigint,
) {
  validateReserves(pool);
  requireU64("memeMaximum", memeMaximum);
  requireU64("quoteMaximum", quoteMaximum);
  const memeShares = (memeMaximum * pool.totalShares) / pool.memeReserve;
  const quoteShares = (quoteMaximum * pool.totalShares) / pool.quoteReserve;
  const shares = memeShares < quoteShares ? memeShares : quoteShares;
  requireU128("totalSharesAfter", pool.totalShares + shares);
  const memeUsed = mulDivUp(shares, pool.memeReserve, pool.totalShares);
  const quoteUsed = mulDivUp(shares, pool.quoteReserve, pool.totalShares);
  requireU64("memeReserveAfter", pool.memeReserve + memeUsed);
  requireU64("quoteReserveAfter", pool.quoteReserve + quoteUsed);
  return {
    shares,
    memeUsed,
    quoteUsed,
    memeRefund: memeMaximum - memeUsed,
    quoteRefund: quoteMaximum - quoteUsed,
  };
}

/** Principal only, rounded down; separate fee balances are never redeemed as principal. */
export function previewDexWithdrawal(
  pool: Pick<DexPoolEconomics, "memeReserve" | "quoteReserve" | "totalShares">,
  shares: bigint,
) {
  validateReserves(pool);
  requireU128("shares", shares);
  if (shares === 0n || shares > pool.totalShares - DEX_MINIMUM_SHARES)
    throw new RangeError("invalid redeemable shares");
  const meme = mulDivDown(shares, pool.memeReserve, pool.totalShares);
  const quote = mulDivDown(shares, pool.quoteReserve, pool.totalShares);
  requirePositiveU64("meme output", meme);
  requirePositiveU64("quote output", quote);
  return { meme, quote };
}

/** Claimable Quote atoms floor; the sub-atom Q64 remainder stays with the position. */
export function previewDexPositionFees(
  pool: Pick<DexPoolEconomics, "feeGrowthX64">,
  position: DexPositionEconomics,
) {
  requireU128("feeGrowthX64", pool.feeGrowthX64);
  requireU128("shares", position.shares);
  requireU128("feeCheckpointX64", position.feeCheckpointX64);
  requireU64("feesOwed", position.feesOwed);
  requireU64("feeFractionX64", position.feeFractionX64);
  if (position.feeCheckpointX64 > pool.feeGrowthX64)
    throw new RangeError("position checkpoint exceeds pool growth");
  const earned =
    position.shares * (pool.feeGrowthX64 - position.feeCheckpointX64) +
    position.feeFractionX64;
  return {
    quote: requireU64("claimable Quote", position.feesOwed + earned / DEX_X64),
    feeFractionX64: earned % DEX_X64,
  };
}

function validateReserves(
  pool: Pick<DexPoolEconomics, "memeReserve" | "quoteReserve" | "totalShares">,
) {
  requirePositiveU64("memeReserve", pool.memeReserve);
  requirePositiveU64("quoteReserve", pool.quoteReserve);
  requireU128("totalShares", pool.totalShares);
  if (pool.totalShares < DEX_MINIMUM_SHARES)
    throw new RangeError("totalShares below minimum locked supply");
}
function agedVolume(
  pool: DexPoolEconomics,
  timestampMs: bigint,
  limits: DexTradeLimits,
) {
  validateReserves(pool);
  requireU64("quoteFees", pool.quoteFees);
  requireU128("feeGrowthX64", pool.feeGrowthX64);
  requireU64("timestampMs", timestampMs);
  requireU64("lastTradeSeconds", pool.lastTradeSeconds);
  requireU64("burnBps", pool.burnBps);
  if (pool.burnBps > 500n) throw new RangeError("burnBps exceeds 500");
  if (
    limits.deadlineMs !== undefined &&
    timestampMs > requireU64("deadlineMs", limits.deadlineMs)
  )
    throw new RangeError("deadline has expired");
  if (timestampMs / 1_000n < pool.lastTradeSeconds)
    throw new RangeError("clock precedes the previous trade");
  integratedQuoteFee(pool.volumeX32, pool.volumeTarget, 0n, pool.maxFeeBps);
  return decayDexVolume(
    pool.volumeX32,
    timestampMs / 1_000n - pool.lastTradeSeconds,
  );
}
function checkTrade(
  principal: bigint,
  fee: bigint,
  output: bigint,
  limits: DexTradeLimits,
) {
  requirePositiveU64("net output", output);
  const minimumFeeLimitBps = mulDivUp(fee, 10_000n, principal);
  if (
    limits.maximumFeeBps !== undefined &&
    fee * 10_000n >
      principal * requireBasisPoints("maximumFeeBps", limits.maximumFeeBps)
  )
    throw new RangeError("rounded fee exceeds signed fee limit");
  if (
    limits.minimumOutput !== undefined &&
    output < requireU64("minimumOutput", limits.minimumOutput)
  )
    throw new RangeError("net output below minimum");
  return minimumFeeLimitBps;
}
function afterTrade(
  pool: DexPoolEconomics,
  meme: bigint,
  quote: bigint,
  volume: bigint,
  principal: bigint,
  fee: bigint,
  timestampMs: bigint,
): DexPoolEconomics {
  const score = volume + principal * DEX_X32;
  return {
    ...pool,
    memeReserve: requireU64("memeReserveAfter", meme),
    quoteReserve: requireU64("quoteReserveAfter", quote),
    quoteFees: requireU64("quoteFeesAfter", pool.quoteFees + fee),
    feeGrowthX64: requireU128(
      "feeGrowthX64After",
      pool.feeGrowthX64 + (fee * DEX_X64) / pool.totalShares,
    ),
    volumeX32:
      score < pool.volumeTarget * DEX_X32 ? score : pool.volumeTarget * DEX_X32,
    lastTradeSeconds: timestampMs / 1_000n,
  };
}
