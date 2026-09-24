import assert from "node:assert/strict";
import test from "node:test";

import { previewBuy, previewSell } from "../src/launchpad/curve.ts";

const baseState = {
  memeReserve: 800_000_000_000_000_000n,
  realQuoteReserve: 0n,
  virtualQuote: 1_000_000_000_000n,
  graduationTarget: 3_000_000_000_000n,
  quoteFeeBps: 100n,
  memeFeeBps: 0n,
};

test("matches the contract first-buy vector", () => {
  assert.deepEqual(previewBuy(baseState, 1_000_000_000n), {
    quoteSupplied: 1_000_000_000n,
    quoteInGross: 1_000_000_000n,
    quoteRefund: 0n,
    quoteFee: 10_000_000n,
    quoteInNet: 990_000_000n,
    memeOutGross: 791_216_695_471_483n,
    memeFee: 0n,
    memeOutNet: 791_216_695_471_483n,
    memeReserveAfter: 799_208_783_304_528_517n,
    realQuoteReserveAfter: 990_000_000n,
    crossedThreshold: false,
  });
});

test("caps the terminal buy at the exact net Quote target", () => {
  assert.deepEqual(
    previewBuy(
      {
        ...baseState,
        memeReserve: 230_215_827_338_129_497n,
        realQuoteReserve: 2_475_000_000_000n,
      },
      600_000_000_000n,
    ),
    {
      quoteSupplied: 600_000_000_000n,
      quoteInGross: 530_303_030_304n,
      quoteRefund: 69_696_969_696n,
      quoteFee: 5_303_030_304n,
      quoteInNet: 525_000_000_000n,
      memeOutGross: 30_215_827_338_129_496n,
      memeFee: 0n,
      memeOutNet: 30_215_827_338_129_496n,
      memeReserveAfter: 200_000_000_000_000_001n,
      realQuoteReserveAfter: 3_000_000_000_000n,
      crossedThreshold: true,
    },
  );
});

test("matches the contract fixed-burn sell vector", () => {
  assert.deepEqual(
    previewSell(
      {
        ...baseState,
        memeReserve: 534_762_932_907_305_531n,
        realQuoteReserve: 495_990_000_000n,
      },
      1_000_000_000_000_000n,
      100n,
    ),
    {
      memeInGross: 1_000_000_000_000_000n,
      memeFee: 0n,
      memeInAfterFee: 1_000_000_000_000_000n,
      progressBps: 1_653n,
      burnBps: 100n,
      pendingBurnDelta: 10_000_000_000_000n,
      memeInEffective: 990_000_000_000_000n,
      quoteOutGross: 2_764_390_092n,
      quoteFee: 27_643_901n,
      quoteOutNet: 2_736_746_191n,
      memeReserveAfter: 535_752_932_907_305_531n,
      realQuoteReserveAfter: 493_225_609_908n,
    },
  );
});

test("rejects sell burn above the contract maximum", () => {
  assert.throws(() => previewSell(baseState, 1_000n, 5_001n), /exceeds 5,000/);
});

test("applies the maximum burn after the Meme fee", () => {
  assert.deepEqual(
    previewSell(
      {
        memeReserve: 1_000n,
        realQuoteReserve: 500n,
        virtualQuote: 1_000n,
        graduationTarget: 1_000n,
        quoteFeeBps: 0n,
        memeFeeBps: 100n,
      },
      1_000n,
      5_000n,
    ),
    {
      memeInGross: 1_000n,
      memeFee: 10n,
      memeInAfterFee: 990n,
      progressBps: 5_000n,
      burnBps: 5_000n,
      pendingBurnDelta: 495n,
      memeInEffective: 495n,
      quoteOutGross: 496n,
      quoteFee: 0n,
      quoteOutNet: 496n,
      memeReserveAfter: 1_495n,
      realQuoteReserveAfter: 4n,
    },
  );
});

test("rejects a trade whose net input rounds to zero", () => {
  assert.throws(() => previewBuy(baseState, 1n), /quoteInNet rounds to zero/);
});
