import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeNativeTransactionPosition,
  normalizeSuiEventPosition,
  suiEventId,
} from "../src/lib/events.ts";

test("normalizes one native Sui event position", () => {
  const position = normalizeSuiEventPosition({
    checkpoint: "42",
    transactionDigest: "digest",
    eventIndex: 3,
  });
  assert.deepEqual(position, {
    checkpoint: 42n,
    transactionDigest: "digest",
    eventIndex: 3,
  });
  assert.equal(suiEventId(position), "digest:3");
  assert.deepEqual(
    normalizeSuiEventPosition({
      checkpoint: 43n,
      transactionDigest: "bigint-digest",
      eventIndex: 4,
    }),
    {
      checkpoint: 43n,
      transactionDigest: "bigint-digest",
      eventIndex: 4,
    },
  );
});

test("rejects missing or unsafe native metadata", () => {
  assert.throws(
    () =>
      normalizeSuiEventPosition({
        checkpoint: null,
        transactionDigest: "digest",
        eventIndex: 0,
      }),
    /checkpoint/,
  );
  assert.throws(
    () =>
      normalizeSuiEventPosition({
        checkpoint: "1",
        transactionDigest: "",
        eventIndex: 0,
      }),
    /transaction digest/,
  );
  assert.throws(
    () =>
      normalizeSuiEventPosition({
        checkpoint: Number.MAX_SAFE_INTEGER + 1,
        transactionDigest: "digest",
        eventIndex: 0,
      }),
    /event checkpoint must be a u64/,
  );
});

test("validates native transaction positions", () => {
  const position = normalizeNativeTransactionPosition({
    checkpoint: 42n,
    transactionDigest: "digest",
  });
  assert.deepEqual(position, { checkpoint: 42n, transactionDigest: "digest" });
  assert.throws(
    () =>
      normalizeNativeTransactionPosition({
        checkpoint: -1n,
        transactionDigest: "digest",
      }),
    /checkpoint/,
  );
});
