import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";
import type {
  DecodedVestingEvent,
  VestingEventKind,
  VestingEventPayloads,
  VestingNativeFact,
} from "../src/vesting/index.ts";
import {
  createVestingProjection,
  reduceVestingInput,
} from "../src/vesting/index.ts";

const linearId = normalizeSuiObjectId("0x1");
const checkpointId = normalizeSuiObjectId("0x2");
const cancelCapId = normalizeSuiObjectId("0x3");

test("replays a linear vesting lifecycle and ignores duplicate native event ids", () => {
  const created = event("linear.VestingCreated", {
    vesting_id: linearId,
    coin_type: normalizeStructTag("0x2::sui::SUI"),
    funder: normalizeSuiAddress("0x4"),
    beneficiary: normalizeSuiAddress("0x5"),
    refund_recipient: null,
    cancel_cap_id: null,
    total_amount: 1_000n,
    start_ms: 100n,
    cliff_ms: 20n,
    period_ms: 10n,
    periods: 10n,
  });
  const claimed = event("linear.VestingClaimed", {
    vesting_id: linearId,
    coin_type: normalizeStructTag("0x2::sui::SUI"),
    caller: normalizeSuiAddress("0x6"),
    beneficiary: normalizeSuiAddress("0x5"),
    amount: 400n,
    released_total: 400n,
    remaining_balance: 600n,
  });
  const closed = event("linear.VestingClosed", {
    vesting_id: linearId,
    coin_type: normalizeStructTag("0x2::sui::SUI"),
    caller: normalizeSuiAddress("0x6"),
    released_total: 1_000n,
  });

  let projection = createVestingProjection();
  for (const lifecycleEvent of [created, claimed, closed]) {
    projection = reduceVestingInput(projection, lifecycleEvent);
    assert.strictEqual(
      reduceVestingInput(projection, lifecycleEvent),
      projection,
    );
  }

  assert.deepEqual(projection.positions[linearId], {
    kind: "linear",
    vestingId: linearId,
    coinType: normalizeStructTag("0x2::sui::SUI"),
    funder: normalizeSuiAddress("0x4"),
    beneficiary: normalizeSuiAddress("0x5"),
    refundRecipient: null,
    cancelCapId: null,
    totalAmount: 1_000n,
    schedule: {
      startMs: 100n,
      cliffMs: 20n,
      periodMs: 10n,
      periods: 10n,
    },
    releasedTotal: 1_000n,
    remainingBalance: 0n,
    status: "closed",
  });
  assert.deepEqual(projection.native.cancelCapOwners, {});
  assert.deepEqual(projection.native.checkpointSchedules, {});
});

test("replays checkpoint creation, claim, and cancellation without inventing native facts", () => {
  const created = event("checkpoints.VestingCreated", {
    vesting_id: checkpointId,
    coin_type: normalizeStructTag("0x2::sui::SUI"),
    funder: normalizeSuiAddress("0x7"),
    beneficiary: normalizeSuiAddress("0x8"),
    refund_recipient: normalizeSuiAddress("0x9"),
    cancel_cap_id: cancelCapId,
    total_amount: 900n,
    checkpoint_count: 3n,
  });
  const claimed = event("checkpoints.VestingClaimed", {
    vesting_id: checkpointId,
    coin_type: normalizeStructTag("0x2::sui::SUI"),
    caller: normalizeSuiAddress("0xa"),
    beneficiary: normalizeSuiAddress("0x8"),
    amount: 300n,
    released_total: 300n,
    remaining_balance: 600n,
  });
  const canceled = event("checkpoints.VestingCanceled", {
    vesting_id: checkpointId,
    coin_type: normalizeStructTag("0x2::sui::SUI"),
    caller: normalizeSuiAddress("0xb"),
    beneficiary: normalizeSuiAddress("0x8"),
    refund_recipient: normalizeSuiAddress("0x9"),
    beneficiary_amount: 200n,
    refund_amount: 400n,
    released_total: 500n,
  });

  let projection = createVestingProjection();
  for (const lifecycleEvent of [created, claimed, canceled]) {
    projection = reduceVestingInput(projection, lifecycleEvent);
  }

  assert.deepEqual(projection.positions[checkpointId], {
    kind: "checkpoints",
    vestingId: checkpointId,
    coinType: normalizeStructTag("0x2::sui::SUI"),
    funder: normalizeSuiAddress("0x7"),
    beneficiary: normalizeSuiAddress("0x8"),
    refundRecipient: normalizeSuiAddress("0x9"),
    cancelCapId,
    totalAmount: 900n,
    checkpointCount: 3n,
    releasedTotal: 500n,
    remainingBalance: 0n,
    status: "canceled",
  });
  assert.equal(projection.native.checkpointSchedules[checkpointId], undefined);
  assert.equal(projection.native.cancelCapOwners[cancelCapId], undefined);
});

test("stores validated checkpoint schedules only as normalized object-read facts", () => {
  let projection = reduceVestingInput(
    createVestingProjection(),
    event("checkpoints.VestingCreated", {
      vesting_id: "0x2",
      coin_type: "0x2::sui::SUI",
      funder: "0x7",
      beneficiary: "0x8",
      refund_recipient: "0x9",
      cancel_cap_id: "0x3",
      total_amount: 900n,
      checkpoint_count: 3n,
    }),
  );
  const scheduleFact: VestingNativeFact = {
    source: "objectRead",
    kind: "checkpointSchedule",
    checkpoint: 50n,
    vestingId: "0x2",
    checkpoints: [
      { timestampMs: 100n, cumulativeAmount: 300n },
      { timestampMs: 200n, cumulativeAmount: 600n },
      { timestampMs: 300n, cumulativeAmount: 900n },
    ],
  };

  projection = reduceVestingInput(projection, scheduleFact);
  assert.deepEqual(projection.native.checkpointSchedules[checkpointId], {
    source: "objectRead",
    kind: "checkpointSchedule",
    checkpoint: 50n,
    vestingId: checkpointId,
    checkpoints: scheduleFact.checkpoints,
  });
  assert.strictEqual(reduceVestingInput(projection, scheduleFact), projection);
  const eventPosition = projection.positions[checkpointId];
  assert.ok(eventPosition);
  assert.equal("checkpoints" in eventPosition, false);

  assert.throws(
    () =>
      reduceVestingInput(projection, {
        ...scheduleFact,
        checkpoint: 51n,
        checkpoints: [
          { timestampMs: 100n, cumulativeAmount: 300n },
          { timestampMs: 90n, cumulativeAmount: 600n },
          { timestampMs: 300n, cumulativeAmount: 900n },
        ],
      }),
    /timestamps must strictly increase/,
  );
  assert.throws(
    () =>
      reduceVestingInput(projection, {
        ...scheduleFact,
        checkpoint: 52n,
        checkpoints: scheduleFact.checkpoints.slice(0, 2),
      }),
    /checkpoint count/,
  );
});

test("stores cancel-cap ownership only as a normalized ownership fact", () => {
  const ownership: VestingNativeFact = {
    source: "objectOwnership",
    kind: "cancelCapOwnership",
    checkpoint: 60n,
    cancelCapId: "0x3",
    owner: "0xc",
  };
  let projection = reduceVestingInput(createVestingProjection(), ownership);

  assert.deepEqual(projection.native.cancelCapOwners[cancelCapId], {
    source: "objectOwnership",
    kind: "cancelCapOwnership",
    checkpoint: 60n,
    cancelCapId,
    owner: normalizeSuiAddress("0xc"),
  });
  assert.deepEqual(projection.positions, {});
  assert.strictEqual(reduceVestingInput(projection, ownership), projection);
  projection = reduceVestingInput(projection, {
    ...ownership,
    owner: "0xd",
  });
  assert.equal(
    projection.native.cancelCapOwners[cancelCapId]?.owner,
    normalizeSuiAddress("0xc"),
  );
});

test("deduplicates events by transaction digest and event index, not checkpoint", () => {
  const created = event("linear.VestingCreated", {
    vesting_id: "0x1",
    coin_type: "0x2::sui::SUI",
    funder: "0x4",
    beneficiary: "0x5",
    refund_recipient: null,
    cancel_cap_id: null,
    total_amount: 1_000n,
    start_ms: 100n,
    cliff_ms: 20n,
    period_ms: 10n,
    periods: 10n,
  });
  const projection = reduceVestingInput(createVestingProjection(), created);
  const correctedCheckpoint = {
    ...created,
    position: { ...created.position, checkpoint: 999n },
  };
  assert.strictEqual(
    reduceVestingInput(projection, correctedCheckpoint),
    projection,
  );
});

test("rejects invalid native fact metadata and schedules without event context", () => {
  assert.throws(
    () =>
      reduceVestingInput(createVestingProjection(), {
        source: "objectOwnership",
        kind: "cancelCapOwnership",
        checkpoint: -1n,
        cancelCapId: "0x3",
        owner: "0xc",
      }),
    /checkpoint.*u64/,
  );
  assert.throws(
    () =>
      reduceVestingInput(createVestingProjection(), {
        source: "objectRead",
        kind: "checkpointSchedule",
        checkpoint: 1n,
        vestingId: "0x2",
        checkpoints: [{ timestampMs: 1n, cumulativeAmount: 1n }],
      }),
    /unknown checkpoint vesting/,
  );
});

function event<Kind extends VestingEventKind>(
  kind: Kind,
  payload: PayloadForKind<Kind>,
): Extract<DecodedVestingEvent, { kind: Kind }> {
  const [module, name] = kind.split(".") as [
    "linear" | "checkpoints",
    "VestingCreated" | "VestingClaimed" | "VestingCanceled" | "VestingClosed",
  ];
  const eventIndex = nextEventIndex++;
  return {
    source: "vesting",
    module,
    name,
    kind,
    payload,
    emitterPackageId: normalizeSuiObjectId("0x100"),
    sender: normalizeSuiAddress("0x101"),
    position: {
      checkpoint: BigInt(eventIndex + 1),
      transactionDigest: `vesting-${eventIndex}`,
      eventIndex,
    },
  } as Extract<DecodedVestingEvent, { kind: Kind }>;
}

type PayloadForKind<Kind extends VestingEventKind> =
  Kind extends `${infer Module}.${infer Name}`
    ? Module extends keyof VestingEventPayloads
      ? Name extends keyof VestingEventPayloads[Module]
        ? VestingEventPayloads[Module][Name]
        : never
      : never
    : never;

let nextEventIndex = 0;
