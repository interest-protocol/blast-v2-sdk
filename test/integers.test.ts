import assert from "node:assert/strict";
import test from "node:test";

import {
  BASIS_POINTS_DENOMINATOR,
  checkedAddU64,
  mulDivDown,
  mulDivUp,
  normalizePositiveU64,
  requireBasisPoints,
  requirePositiveU64,
  requireU128,
  requireU64,
  type U128,
  U128_MAX,
  type U64,
  U64_MAX,
} from "../src/lib/integers.ts";

test("accepts the complete u64 range", () => {
  const zero: U64 = requireU64("value", 0n);
  const maximum: U64 = requireU64("value", U64_MAX);
  assert.equal(zero, 0n);
  assert.equal(maximum, U64_MAX);
  assert.doesNotThrow(() => requirePositiveU64("value", 1n));
  assert.doesNotThrow(() => requirePositiveU64("value", U64_MAX));
});

test("rejects values outside the requested u64 range", () => {
  assert.throws(() => requireU64("value", -1n), /value must be a u64/);
  assert.throws(
    () => requireU64("value", U64_MAX + 1n),
    /value must be a u64/,
  );
  assert.throws(
    () => requirePositiveU64("value", 0n),
    /value must be a positive u64/,
  );
});

test("normalizes transport u64 values without unsafe number coercion", () => {
  assert.equal(normalizePositiveU64("version", 7), "7");
  assert.equal(normalizePositiveU64("version", "0007"), "7");
  assert.throws(
    () => normalizePositiveU64("version", Number.MAX_SAFE_INTEGER + 1),
    /version must be a positive u64/,
  );
  assert.throws(
    () => normalizePositiveU64("version", "not-a-version"),
    /version must be a u64/,
  );
});

test("provides checked u64 and basis-point arithmetic", () => {
  assert.equal(BASIS_POINTS_DENOMINATOR, 10_000n);
  assert.equal(checkedAddU64("total", U64_MAX - 1n, 1n), U64_MAX);
  assert.throws(
    () => checkedAddU64("total", U64_MAX, 1n),
    /total must be a u64/,
  );
  assert.equal(requireBasisPoints("feeBps", 10_000n), 10_000n);
  assert.throws(
    () => requireBasisPoints("feeBps", 10_001n),
    /feeBps must be between 0 and 10,000/,
  );
});

test("rounds multiply-divide results in the named direction", () => {
  assert.equal(mulDivDown(10n, 1n, 3n), 3n);
  assert.equal(mulDivUp(10n, 1n, 3n), 4n);
  assert.equal(mulDivUp(0n, 99n, 3n), 0n);
  assert.throws(() => mulDivDown(-1n, 1n, 3n), /non-negative/);
  assert.throws(() => mulDivUp(1n, 1n, 0n), /positive denominator/);
});

test("accepts and brands the complete u128 range", () => {
  const maximum: U128 = requireU128("value", U128_MAX);
  assert.equal(maximum, U128_MAX);
  assert.throws(() => requireU128("value", -1n), /value must be a u128/);
  assert.throws(
    () => requireU128("value", U128_MAX + 1n),
    /value must be a u128/,
  );
});
