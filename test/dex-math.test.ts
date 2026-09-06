import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  decayDexVolume,
  dexBuyPrincipal,
  integratedQuoteFee,
  previewDexBuy,
  previewDexDeposit,
  previewDexPositionFees,
  previewDexSell,
  previewDexWithdrawal,
} from "../src/dex/math.ts";

const pool = {
  memeReserve: 100_000n,
  quoteReserve: 100_000n,
  quoteFees: 0n,
  totalShares: 100_000n,
  feeGrowthX64: 0n,
  volumeX32: 0n,
  lastTradeSeconds: 0n,
  volumeTarget: 100_000n,
  maxFeeBps: 200n,
  burnBps: 0n,
};
const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/dex-fees.json", import.meta.url), "utf8"),
);

test("DEX matches independent fee and decay vectors at full u64 width", () => {
  for (const v of vectors.fee_vectors)
    assert.equal(
      integratedQuoteFee(
        BigInt(v.volume_x32),
        BigInt(v.target),
        BigInt(v.principal),
        BigInt(v.max_bps),
      ),
      BigInt(v.fee),
    );
  for (const v of vectors.decay_vectors)
    assert.equal(
      decayDexVolume(BigInt(v.volume_x32), BigInt(v.elapsed_seconds)),
      BigInt(v.result_x32),
    );
});

test("DEX integer inverse conserves gross and finds maximal affordable principal", () => {
  for (let gross = 1n; gross < 500n; gross++) {
    const r = dexBuyPrincipal(300n << 32n, 1_000n, gross, 500n);
    assert.equal(r.principal + r.fee + r.refund, gross);
    assert.ok(
      r.principal +
        1n +
        integratedQuoteFee(300n << 32n, 1_000n, r.principal + 1n, 500n) >
        gross,
    );
  }
});

test("DEX buy and sell retain only principal in reserves and report actual fee limits", () => {
  const buy = previewDexBuy(pool, 101_000n, 0n);
  assert.equal(buy.memeOut, 50_000n);
  assert.equal(buy.quoteFee, 1_000n);
  assert.equal(buy.quoteRefund, 0n);
  assert.equal(buy.after.quoteReserve, 200_000n);
  const sell = previewDexSell(buy.after, 50_000n, 0n);
  assert.equal(sell.quoteOut, 98_000n);
  assert.equal(sell.after.quoteReserve, 100_000n);
  assert.equal(sell.after.quoteFees, 3_000n);
  const rounded = previewDexBuy(buy.after, 1_022n, 0n);
  assert.equal(rounded.minimumFeeLimitBps, 210n);
  assert.throws(
    () => previewDexBuy(buy.after, 1_022n, 0n, { maximumFeeBps: 200n }),
    /fee limit/,
  );
});

test("DEX burn reduces the net receipt, and deposits refund the excess side", () => {
  const buy = previewDexBuy({ ...pool, burnBps: 500n }, 101_000n, 0n);
  assert.equal(buy.memeBurn, 2_500n);
  assert.equal(buy.memeOut, 47_500n);
  assert.throws(
    () =>
      previewDexBuy({ ...pool, burnBps: 500n }, 101_000n, 0n, {
        minimumOutput: 47_501n,
      }),
    /minimum/,
  );
  const deposit = previewDexDeposit(pool, 10_000n, 30_000n);
  assert.deepEqual(deposit, {
    shares: 10_000n,
    memeUsed: 10_000n,
    quoteUsed: 10_000n,
    memeRefund: 0n,
    quoteRefund: 20_000n,
  });
  assert.equal(previewDexDeposit(pool, 0n, 30_000n).shares, 0n);
  assert.deepEqual(previewDexWithdrawal(pool, 10_000n), {
    meme: 10_000n,
    quote: 10_000n,
  });
});

test("DEX fee entitlement keeps fractions with the position and excludes history", () => {
  const after = previewDexBuy(pool, 101_000n, 0n).after;
  assert.equal(
    previewDexPositionFees(after, {
      shares: 99_000n,
      feeCheckpointX64: 0n,
      feesOwed: 0n,
      feeFractionX64: 0n,
    }).quote,
    989n,
  );
  assert.equal(
    previewDexPositionFees(after, {
      shares: 10_000n,
      feeCheckpointX64: after.feeGrowthX64,
      feesOwed: 0n,
      feeFractionX64: 0n,
    }).quote,
    0n,
  );
});

test("DEX previews reject expired or impossible states and preserve exact deadline", () => {
  assert.doesNotThrow(() =>
    previewDexBuy(pool, 101_000n, 1_001n, { deadlineMs: 1_001n }),
  );
  assert.throws(
    () => previewDexBuy(pool, 101_000n, 1_001n, { deadlineMs: 1_000n }),
    /deadline/,
  );
  assert.throws(
    () => previewDexBuy({ ...pool, lastTradeSeconds: 2n }, 101_000n, 1_999n),
    /clock/,
  );
  assert.throws(() => integratedQuoteFee(0n, 0n, 1n, 200n), /positive/);
  assert.throws(() => integratedQuoteFee(0n, 1n, 1n, 501n), /500/);
});

test("sell preview matches Move's burn-before-swap and fee-after-output boundary", () => {
  const quote = previewDexSell({ ...pool, burnBps: 500n }, 10_000n, 0n);
  assert.equal(quote.memeBurn, 500n);
  assert.equal(quote.memePrincipal, 9500n);
  assert.equal(quote.quotePrincipal, 8675n);
  assert.equal(quote.quoteFee, 8n);
  assert.equal(quote.quoteOut, 8667n);
  assert.throws(
    () =>
      previewDexSell({ ...pool, burnBps: 500n }, 10_000n, 0n, {
        minimumOutput: 8668n,
      }),
    /minimum/,
  );
});
