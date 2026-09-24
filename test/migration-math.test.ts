import assert from "node:assert/strict";
import test from "node:test";

import { autoLpFixedSide, sqrtPriceX64 } from "../src/migrators/index.ts";

test("matches the contract Q64.64 migration-price vectors", () => {
  const oneX64 = 18_446_744_073_709_551_616n;
  assert.equal(sqrtPriceX64(1n, 1n, true), oneX64);
  assert.equal(sqrtPriceX64(1n, 1n, false), oneX64);
  assert.equal(
    sqrtPriceX64(196_608_503_317_768_494n, 3_038_310_000_000n, true),
    72_516_129_429_223_843n,
  );
  assert.equal(
    sqrtPriceX64(196_608_503_317_768_494n, 3_038_310_000_000n, false),
    4_692_505_923_844_928_806_099n,
  );
  assert.equal(
    sqrtPriceX64(196_608_503_317_768_494n, 3_038_310_000n, true),
    2_293_161_360_959_133n,
  );
});

const ONE = 1n << 64n;
const MIN_SQRT_PRICE = 4_295_048_016n;
const MAX_SQRT_PRICE = 79_226_673_515_401_279_992_447_579_055n;
const U64_MAX = (1n << 64n) - 1n;

test("matches the contract auto-LP side-selection vectors", () => {
  const vectors: [bigint, bigint, bigint, bigint, bigint, boolean, bigint][] = [
    [ONE / 2n, ONE, ONE * 2n, 1_000_000n, 1_000_010n, true, 1_000_000n],
    [
      MIN_SQRT_PRICE,
      ONE,
      MAX_SQRT_PRICE,
      1_000_000_000n,
      2_000_000_000n,
      true,
      1_000_000_000n,
    ],
    [ONE / 2n, ONE, ONE * 2n, 1_000_010n, 1_000_000n, false, 1_000_000n],
    [ONE / 2n, ONE, ONE * 2n, 1_000_000n, 1_000_000n, true, 0n],
    [ONE / 2n, ONE, ONE * 2n, 2n, 2n, true, 0n],
    [ONE / 2n, ONE, ONE * 2n, 0n, 1_000_000n, true, 0n],
    [ONE / 2n, ONE / 2n, ONE * 2n, 1_000_000n, 1_000_000n, true, 0n],
    [ONE / 2n, ONE * 2n, ONE * 2n, 1_000_000n, 1_000_000n, true, 0n],
    [
      MIN_SQRT_PRICE,
      MAX_SQRT_PRICE - 1n,
      MAX_SQRT_PRICE,
      U64_MAX,
      U64_MAX,
      false,
      U64_MAX,
    ],
    [
      MIN_SQRT_PRICE,
      MIN_SQRT_PRICE + 1n,
      MAX_SQRT_PRICE,
      U64_MAX,
      U64_MAX,
      true,
      U64_MAX,
    ],
  ];
  for (const [lower, price, upper, a, b, fixA, amount] of vectors) {
    assert.deepEqual(autoLpFixedSide(lower, price, upper, a, b), {
      fixA,
      amount,
    });
  }
});

test("rejects invalid migration math inputs", () => {
  assert.throws(() => sqrtPriceX64(0n, 1n, true), /positive u64/);
  assert.throws(() => autoLpFixedSide(0n, 1n << 128n, 1n, 1n, 1n), /u128/);
});
