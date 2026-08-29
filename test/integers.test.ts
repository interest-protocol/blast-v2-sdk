import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePositiveU64,
  requirePositiveU64,
  requireU64,
  U64_MAX,
} from "../src/lib/integers.ts";

test("accepts the complete u64 range", () => {
  assert.doesNotThrow(() => requireU64("value", 0n));
  assert.doesNotThrow(() => requireU64("value", U64_MAX));
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
