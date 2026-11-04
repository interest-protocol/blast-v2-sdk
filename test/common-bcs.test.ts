import assert from "node:assert/strict";
import test from "node:test";

import {
  isDelayedActionGuarded,
  isDelayedGuarded,
  isDelayedSetGuarded,
  MAX_DELAY_MS,
  moveTypeNameBcs,
  suiBalanceBcs,
  suiIdBcs,
  suiObjectIdBcs,
  suiUidBcs,
} from "@interest-protocol/blast-core/bcs";

test("round-trips canonical Sui BCS primitives", () => {
  assert.match(
    suiIdBcs.parse(suiIdBcs.serialize({ bytes: "0xc" }).toBytes()).bytes,
    /0c$/,
  );
  assert.match(
    suiUidBcs.parse(suiUidBcs.serialize({ id: { bytes: "0xd" } }).toBytes()).id
      .bytes,
    /0d$/,
  );
  assert.equal(
    suiBalanceBcs.parse(suiBalanceBcs.serialize({ value: 7n }).toBytes()).value,
    "7",
  );
  assert.match(
    suiObjectIdBcs.parse(suiObjectIdBcs.serialize("0xe").toBytes()),
    /0e$/,
  );
  assert.equal(
    moveTypeNameBcs.parse(moveTypeNameBcs.serialize("0x2::sui::SUI").toBytes()),
    "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  );
});

test("mirrors blast_admin::delayed's notice ceiling and guards", () => {
  assert.equal(MAX_DELAY_MS, 30n * 24n * 60n * 60n * 1_000n);
  const notice = { delay_ms: 7_200_000n, ready_at_ms: 1n };
  const delayed = {
    owner: "0x1",
    key: null,
    value: 0n,
    delay_ms: 7_200_000n,
    pending: null,
  };
  assert.equal(isDelayedGuarded(delayed), true);
  assert.equal(isDelayedGuarded({ ...delayed, delay_ms: 0n }), false);
  assert.equal(
    isDelayedGuarded({ ...delayed, pending: { value: 1n, ...notice } }),
    true,
  );
  assert.equal(
    isDelayedGuarded({
      ...delayed,
      pending: { value: 1n, delay_ms: 0n, ready_at_ms: 1n },
    }),
    false,
  );
  const action = {
    owner: "0x1",
    key: null,
    delay_ms: 7_200_000n,
    pending: null,
  };
  assert.equal(isDelayedActionGuarded(action), true);
  assert.equal(
    isDelayedActionGuarded({
      ...action,
      pending: { value: { kind: "Delay" }, delay_ms: 0n, ready_at_ms: 1n },
    }),
    false,
  );
  const set = {
    owner: "0x1",
    key: null,
    members: [],
    delay_ms: 7_200_000n,
    admissions: [],
    pending_delay: null,
  };
  assert.equal(isDelayedSetGuarded(set), true);
  assert.equal(
    isDelayedSetGuarded({ ...set, admissions: [{ member: 1, notice }] }),
    false,
  );
  assert.equal(
    isDelayedSetGuarded({ ...set, pending_delay: { ...notice, delay_ms: 0n } }),
    false,
  );
});
