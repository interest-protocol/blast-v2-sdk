import assert from "node:assert/strict";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";

import {
  checkpointVestingBcs,
  clockBcs,
  decodeVestingObject,
  getAllCheckpoints,
  getCheckpointVestedAt,
  getCurrentTimestampMs,
  linearVestingBcs,
} from "../src/vesting/state.ts";

const objectId = "0xc";
const beneficiary = "0xb0b";
const refundRecipient = "0xcafe";
const coinType = "0x2::sui::SUI";

const uid = (id: string) => ({ id: { bytes: id } });
const balance = (value: bigint) => ({ value });

test("decodes linear custody and derives its original total", () => {
  const state = decodeVestingObject({
    objectId,
    initialSharedVersion: "7",
    mutable: true,
    type: `0x1::blast_fun_linear_vesting::Vesting<${coinType}>`,
    content: linearVestingBcs
      .serialize({
        id: uid(objectId),
        balance: balance(700n),
        beneficiary,
        cancel_refund_recipient: refundRecipient,
        start_ms: 1_000n,
        cliff_ms: 200n,
        period_ms: 100n,
        periods: 10n,
        released: 300n,
      })
      .toBytes(),
  });

  assert.equal(state.kind, "linear");
  assert.equal(state.totalAmount, 1_000n);
  assert.equal(state.balance, 700n);
  assert.equal(state.released, 300n);
  assert.equal(state.refundRecipient?.endsWith("cafe"), true);
  if (state.kind === "linear") {
    assert.equal(state.endMs, 2_000n);
    assert.deepEqual(state.schedule, {
      startMs: 1_000n,
      cliffMs: 200n,
      periodMs: 100n,
      periods: 10n,
    });
  }
});

test("decodes the inline checkpoint vector", () => {
  const values = [
    { timestampMs: 100n, cumulativeAmount: 200n },
    { timestampMs: 250n, cumulativeAmount: 456n },
    { timestampMs: 700n, cumulativeAmount: 1_000n },
  ];
  const state = decodeVestingObject({
    objectId,
    initialSharedVersion: "8",
    mutable: true,
    type: `0x1::blast_fun_checkpoint_vesting::Vesting<${coinType}>`,
    content: checkpointVestingBcs
      .serialize({
        id: uid(objectId),
        balance: balance(800n),
        beneficiary,
        cancel_refund_recipient: null,
        checkpoints: values.map((checkpoint) => ({
          timestamp_ms: checkpoint.timestampMs,
          cumulative_amount: checkpoint.cumulativeAmount,
        })),
        released: 200n,
      })
      .toBytes(),
  });
  assert.equal(state.kind, "checkpoints");
  if (state.kind !== "checkpoints") return;
  assert.equal(state.checkpointCount, 3n);
  assert.equal(state.totalAmount, 1_000n);
  assert.deepEqual(state.checkpoints, values);
  assert.deepEqual(getAllCheckpoints(state), values);
  assert.equal(getCheckpointVestedAt(state, 250n), 456n);
});

test("reads the authoritative Sui Clock", async () => {
  const client = {
    core: {
      getObject: async () => ({
        object: {
          objectId: SUI_CLOCK_OBJECT_ID,
          owner: {
            $kind: "Shared",
            Shared: { initialSharedVersion: "1" },
          },
          type: "0x2::clock::Clock",
          content: clockBcs
            .serialize({
              id: uid(SUI_CLOCK_OBJECT_ID),
              timestamp_ms: 123_456n,
            })
            .toBytes(),
        },
      }),
    },
  } as unknown as ClientWithCoreApi;

  assert.equal(await getCurrentTimestampMs(client), 123_456n);
});

test("rejects an object with a mismatched UID or package", () => {
  const content = linearVestingBcs
    .serialize({
      id: uid("0xf"),
      balance: balance(1n),
      beneficiary,
      cancel_refund_recipient: null,
      start_ms: 1n,
      cliff_ms: 0n,
      period_ms: 1n,
      periods: 1n,
      released: 0n,
    })
    .toBytes();
  assert.throws(
    () =>
      decodeVestingObject({
        objectId,
        initialSharedVersion: "7",
        mutable: true,
        type: `0x1::blast_fun_linear_vesting::Vesting<${coinType}>`,
        content,
      }),
    /mismatched UID/,
  );
  assert.throws(
    () =>
      decodeVestingObject(
        {
          objectId: "0xf",
          initialSharedVersion: "7",
          mutable: true,
          type: `0x1::blast_fun_linear_vesting::Vesting<${coinType}>`,
          content,
        },
        "0x9",
      ),
    /unexpected package/,
  );
});
