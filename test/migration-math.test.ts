import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPriceWithinBps,
  assertResidualWithinBps,
  minimumUtilizedAmount,
  sqrtPriceX64,
} from "../src/migrators/index.ts";

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

test("matches price-deviation and residual boundaries", () => {
  const atBoundary = sqrtPriceX64(10_000n, 10_050n, true);
  assert.doesNotThrow(() =>
    assertPriceWithinBps(10_000n, 10_000n, true, atBoundary, 50n),
  );
  const outside = sqrtPriceX64(10_000n, 10_051n, true);
  assert.throws(
    () => assertPriceWithinBps(10_000n, 10_000n, true, outside, 50n),
    /price deviation exceeds 50 basis points/,
  );

  assert.equal(minimumUtilizedAmount(10_000n, 1n), 9_999n);
  assert.equal(minimumUtilizedAmount(10_001n, 1n), 9_999n);
  assert.doesNotThrow(() => assertResidualWithinBps(10_001n, 2n, 1n));
  assert.throws(
    () => assertResidualWithinBps(10_000n, 2n, 1n),
    /residual exceeds 1 basis points/,
  );
});

test("rejects invalid migration math inputs", () => {
  assert.throws(() => sqrtPriceX64(0n, 1n, true), /positive u64/);
  assert.throws(() => minimumUtilizedAmount(10_000n, 10_001n), /basis points/);
  assert.throws(
    () => assertPriceWithinBps(1n, 1n, true, 1n << 128n, 1n),
    /u128/,
  );
});
