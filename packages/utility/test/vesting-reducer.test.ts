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
    beneficiary: normalizeSuiAddress("0x5"),
    amount: 400n,
    released_total: 400n,
  });
  const finalClaim = event("linear.VestingClaimed", {
    vesting_id: linearId,
    coin_type: normalizeStructTag("0x2::sui::SUI"),
    beneficiary: normalizeSuiAddress("0x5"),
    amount: 600n,
    released_total: 1_000n,
  });
  const closed = event("linear.VestingClosed", {
    vesting_id: linearId,
    coin_type: normalizeStructTag("0x2::sui::SUI"),
  });

  let projection = createVestingProjection();
  for (const lifecycleEvent of [created, claimed, finalClaim, closed]) {
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
    funder: normalizeSuiAddress("0x101"),
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
    beneficiary: normalizeSuiAddress("0x8"),
    refund_recipient: normalizeSuiAddress("0x9"),
    cancel_cap_id: cancelCapId,
    total_amount: 900n,
    checkpoint_count: 3n,
  });
  const claimed = event("checkpoints.VestingClaimed", {
    vesting_id: checkpointId,
    coin_type: normalizeStructTag("0x2::sui::SUI"),
    beneficiary: normalizeSuiAddress("0x8"),
    amount: 300n,
    released_total: 300n,
  });
  const canceled = event("checkpoints.VestingCanceled", {
    vesting_id: checkpointId,
    coin_type: normalizeStructTag("0x2::sui::SUI"),
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
    funder: normalizeSuiAddress("0x101"),
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

test("replays a valid linear cancellation path", () => {
  const vestingId = normalizeSuiObjectId("0x10");
  let projection = reduceVestingInput(
    createVestingProjection(),
    event("linear.VestingCreated", {
      vesting_id: vestingId,
      coin_type: "0x2::sui::SUI",
      beneficiary: "0x12",
      refund_recipient: "0x13",
      cancel_cap_id: "0x14",
      total_amount: 1_000n,
      start_ms: 100n,
      cliff_ms: 20n,
      period_ms: 10n,
      periods: 10n,
    }),
  );
  projection = reduceVestingInput(
    projection,
    event("linear.VestingCanceled", {
      vesting_id: vestingId,
      coin_type: "0x2::sui::SUI",
      beneficiary: "0x12",
      refund_recipient: "0x13",
      beneficiary_amount: 400n,
      refund_amount: 600n,
      released_total: 400n,
    }),
  );

  assert.equal(projection.positions[vestingId]?.status, "canceled");
  assert.equal(projection.positions[vestingId]?.releasedTotal, 400n);
});

test("replays a valid irrevocable checkpoint close path", () => {
  const vestingId = normalizeSuiObjectId("0x20");
  let projection = reduceVestingInput(
    createVestingProjection(),
    event("checkpoints.VestingCreated", {
      vesting_id: vestingId,
      coin_type: "0x2::sui::SUI",
      beneficiary: "0x22",
      refund_recipient: null,
      cancel_cap_id: null,
      total_amount: 900n,
      checkpoint_count: 3n,
    }),
  );
  projection = reduceVestingInput(
    projection,
    event("checkpoints.VestingClaimed", {
      vesting_id: vestingId,
      coin_type: "0x2::sui::SUI",
      beneficiary: "0x22",
      amount: 900n,
      released_total: 900n,
    }),
  );
  projection = reduceVestingInput(
    projection,
    event("checkpoints.VestingClosed", {
      vesting_id: vestingId,
      coin_type: "0x2::sui::SUI",
    }),
  );

  assert.equal(projection.positions[vestingId]?.status, "closed");
  assert.equal(projection.positions[vestingId]?.remainingBalance, 0n);
});

test("stores validated checkpoint schedules only as normalized object-read facts", () => {
  let projection = reduceVestingInput(
    createVestingProjection(),
    event("checkpoints.VestingCreated", {
      vesting_id: "0x2",
      coin_type: "0x2::sui::SUI",
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
  const projection = reduceVestingInput(createVestingProjection(), ownership);

  assert.deepEqual(projection.native.cancelCapOwners[cancelCapId], {
    source: "objectOwnership",
    kind: "cancelCapOwnership",
    checkpoint: 60n,
    cancelCapId,
    owner: normalizeSuiAddress("0xc"),
  });
  assert.deepEqual(projection.positions, {});
  assert.strictEqual(reduceVestingInput(projection, ownership), projection);
  assert.throws(
    () =>
      reduceVestingInput(projection, {
        ...ownership,
        owner: "0xd",
      }),
    /ownership conflict at checkpoint 60/,
  );
});

test("merges cancel-cap ownership monotonically", () => {
  const first: VestingNativeFact = {
    source: "objectOwnership",
    kind: "cancelCapOwnership",
    checkpoint: 60n,
    cancelCapId: "0x3",
    owner: "0xc",
  };
  const latest: VestingNativeFact = {
    ...first,
    checkpoint: 62n,
    owner: "0xd",
  };
  let projection = reduceVestingInput(createVestingProjection(), first);
  projection = reduceVestingInput(projection, latest);

  assert.strictEqual(
    reduceVestingInput(projection, { ...first, checkpoint: 61n }),
    projection,
  );
  assert.equal(
    projection.native.cancelCapOwners[cancelCapId]?.owner,
    normalizeSuiAddress("0xd"),
  );
  assert.throws(
    () => reduceVestingInput(projection, { ...latest, owner: "0xe" }),
    /ownership conflict at checkpoint 62/,
  );
  assert.strictEqual(reduceVestingInput(projection, latest), projection);
});

test("clears cancel-cap ownership only from a native deletion fact", () => {
  const vestingId = normalizeSuiObjectId("0x30");
  const capId = normalizeSuiObjectId("0x31");
  let projection = reduceVestingInput(
    createVestingProjection(),
    event("linear.VestingCreated", {
      vesting_id: vestingId,
      coin_type: "0x2::sui::SUI",
      beneficiary: "0x33",
      refund_recipient: "0x34",
      cancel_cap_id: capId,
      total_amount: 1_000n,
      start_ms: 100n,
      cliff_ms: 20n,
      period_ms: 10n,
      periods: 10n,
    }),
  );
  projection = reduceVestingInput(projection, {
    source: "objectOwnership",
    kind: "cancelCapOwnership",
    checkpoint: 70n,
    cancelCapId: capId,
    owner: "0x35",
  });
  projection = reduceVestingInput(
    projection,
    event("linear.VestingCanceled", {
      vesting_id: vestingId,
      coin_type: "0x2::sui::SUI",
      beneficiary: "0x33",
      refund_recipient: "0x34",
      beneficiary_amount: 400n,
      refund_amount: 600n,
      released_total: 400n,
    }),
  );
  assert.equal(
    projection.native.cancelCapOwners[capId]?.owner,
    normalizeSuiAddress("0x35"),
  );
  assert.throws(
    () =>
      reduceVestingInput(projection, {
        source: "transactionEffects",
        kind: "cancelCapDeleted",
        position: {
          checkpoint: 70n,
          transactionDigest: "same-checkpoint-deletion",
        },
        cancelCapId: capId,
      }),
    /deletion conflicts at checkpoint 70/,
  );

  const deletion: VestingNativeFact = {
    source: "transactionEffects",
    kind: "cancelCapDeleted",
    position: { checkpoint: 71n, transactionDigest: "cancel-cap-deleted" },
    cancelCapId: capId,
  };
  projection = reduceVestingInput(projection, deletion);
  assert.equal(projection.native.cancelCapOwners[capId], undefined);
  assert.deepEqual(projection.native.cancelCapDeletions[capId], deletion);
  assert.strictEqual(reduceVestingInput(projection, deletion), projection);
  assert.strictEqual(
    reduceVestingInput(projection, {
      source: "objectOwnership",
      kind: "cancelCapOwnership",
      checkpoint: 69n,
      cancelCapId: capId,
      owner: "0x36",
    }),
    projection,
  );
  assert.throws(
    () =>
      reduceVestingInput(projection, {
        source: "objectOwnership",
        kind: "cancelCapOwnership",
        checkpoint: 72n,
        cancelCapId: capId,
        owner: "0x36",
      }),
    /deleted cancellation cap cannot have an owner/,
  );
});

test("deduplicates events by transaction digest and event index, not checkpoint", () => {
  const created = event("linear.VestingCreated", {
    vesting_id: "0x1",
    coin_type: "0x2::sui::SUI",
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

test("rejects claims that violate release conservation", () => {
  const created = linearCreated("0x20", "0x21", 1_000n);
  const projection = reduceVestingInput(createVestingProjection(), created);

  assert.throws(
    () =>
      reduceVestingInput(projection, linearClaimed("0x20", "0x21", 300n, 400n)),
    /claim amount.*released total delta/,
  );

  const claimed = reduceVestingInput(
    projection,
    linearClaimed("0x20", "0x21", 400n, 400n),
  );
  assert.throws(
    () => reduceVestingInput(claimed, linearClaimed("0x20", "0x21", 0n, 300n)),
    /released total must not decrease/,
  );
});

test("rejects lifecycle updates after cancellation or closure", () => {
  const checkpointCreated = event("checkpoints.VestingCreated", {
    vesting_id: "0x30",
    coin_type: "0x2::sui::SUI",
    beneficiary: "0x32",
    refund_recipient: "0x33",
    cancel_cap_id: "0x34",
    total_amount: 900n,
    checkpoint_count: 3n,
  });
  let canceled = reduceVestingInput(
    createVestingProjection(),
    checkpointCreated,
  );
  canceled = reduceVestingInput(
    canceled,
    event("checkpoints.VestingCanceled", {
      vesting_id: "0x30",
      coin_type: "0x2::sui::SUI",
      beneficiary: "0x32",
      refund_recipient: "0x33",
      beneficiary_amount: 500n,
      refund_amount: 400n,
      released_total: 500n,
    }),
  );
  assert.throws(
    () =>
      reduceVestingInput(
        canceled,
        event("checkpoints.VestingClaimed", {
          vesting_id: "0x30",
          coin_type: "0x2::sui::SUI",
          beneficiary: "0x32",
          amount: 1n,
          released_total: 501n,
        }),
      ),
    /vesting position is not active/,
  );

  let closed = reduceVestingInput(
    createVestingProjection(),
    linearCreated("0x40", "0x41", 1_000n),
  );
  closed = reduceVestingInput(
    closed,
    linearClaimed("0x40", "0x41", 1_000n, 1_000n),
  );
  closed = reduceVestingInput(
    closed,
    event("linear.VestingClosed", {
      vesting_id: "0x40",
      coin_type: "0x2::sui::SUI",
    }),
  );
  assert.throws(
    () => reduceVestingInput(closed, linearClaimed("0x40", "0x41", 1n, 1_001n)),
    /vesting position is not active/,
  );
});

test("rejects cancellation settlement and party mismatches", () => {
  const created = event("checkpoints.VestingCreated", {
    vesting_id: "0x50",
    coin_type: "0x2::sui::SUI",
    beneficiary: "0x52",
    refund_recipient: "0x53",
    cancel_cap_id: "0x54",
    total_amount: 900n,
    checkpoint_count: 3n,
  });
  let projection = reduceVestingInput(createVestingProjection(), created);
  projection = reduceVestingInput(
    projection,
    event("checkpoints.VestingClaimed", {
      vesting_id: "0x50",
      coin_type: "0x2::sui::SUI",
      beneficiary: "0x52",
      amount: 300n,
      released_total: 300n,
    }),
  );
  const cancellation = {
    vesting_id: "0x50",
    coin_type: "0x2::sui::SUI",
    beneficiary: "0x52",
    refund_recipient: "0x53",
    beneficiary_amount: 200n,
    refund_amount: 400n,
    released_total: 500n,
  } as const;

  assert.throws(
    () =>
      reduceVestingInput(
        projection,
        event("checkpoints.VestingCanceled", {
          ...cancellation,
          beneficiary_amount: 100n,
        }),
      ),
    /beneficiary amount.*released total delta/,
  );
  assert.throws(
    () =>
      reduceVestingInput(
        projection,
        event("checkpoints.VestingCanceled", {
          ...cancellation,
          beneficiary: "0x99",
        }),
      ),
    /beneficiary does not match/,
  );
  assert.throws(
    () =>
      reduceVestingInput(
        projection,
        event("checkpoints.VestingCanceled", {
          ...cancellation,
          refund_recipient: "0x99",
        }),
      ),
    /refund recipient does not match/,
  );
});

test("allows cancellation before any beneficiary release", () => {
  let projection = reduceVestingInput(
    createVestingProjection(),
    event("checkpoints.VestingCreated", {
      vesting_id: "0x58",
      coin_type: "0x2::sui::SUI",
      beneficiary: "0x52",
      refund_recipient: "0x53",
      cancel_cap_id: "0x54",
      total_amount: 900n,
      checkpoint_count: 3n,
    }),
  );
  projection = reduceVestingInput(
    projection,
    event("checkpoints.VestingCanceled", {
      vesting_id: "0x58",
      coin_type: "0x2::sui::SUI",
      beneficiary: "0x52",
      refund_recipient: "0x53",
      beneficiary_amount: 0n,
      refund_amount: 900n,
      released_total: 0n,
    }),
  );
  assert.equal(
    projection.positions[normalizeSuiObjectId("0x58")]?.status,
    "canceled",
  );
});

test("rejects close events that invent an unreplayed release", () => {
  const projection = reduceVestingInput(
    createVestingProjection(),
    linearCreated("0x60", "0x61", 1_000n),
  );
  assert.throws(
    () =>
      reduceVestingInput(
        projection,
        event("linear.VestingClosed", {
          vesting_id: "0x60",
          coin_type: "0x2::sui::SUI",
        }),
      ),
    /close must not change released total|remaining balance must be zero/,
  );
});

test("rejects a zero-amount claim with no release delta", () => {
  const projection = reduceVestingInput(
    createVestingProjection(),
    linearCreated("0x80", "0x81", 1_000n),
  );
  assert.throws(
    () => reduceVestingInput(projection, linearClaimed("0x80", "0x81", 0n, 0n)),
    /claim amount must be a positive u64/,
  );
});

test("rejects close for fully drained cancelable linear vesting", () => {
  let projection = reduceVestingInput(
    createVestingProjection(),
    event("linear.VestingCreated", {
      vesting_id: "0x90",
      coin_type: "0x2::sui::SUI",
      beneficiary: "0x92",
      refund_recipient: "0x93",
      cancel_cap_id: "0x94",
      total_amount: 1_000n,
      start_ms: 100n,
      cliff_ms: 20n,
      period_ms: 10n,
      periods: 10n,
    }),
  );
  projection = reduceVestingInput(
    projection,
    linearClaimed("0x90", "0x92", 1_000n, 1_000n),
  );
  assert.throws(
    () =>
      reduceVestingInput(
        projection,
        event("linear.VestingClosed", {
          vesting_id: "0x90",
          coin_type: "0x2::sui::SUI",
        }),
      ),
    /only irrevocable vesting can close/,
  );
});

test("rejects close for fully drained cancelable checkpoint vesting", () => {
  let projection = reduceVestingInput(
    createVestingProjection(),
    event("checkpoints.VestingCreated", {
      vesting_id: "0xa0",
      coin_type: "0x2::sui::SUI",
      beneficiary: "0xa2",
      refund_recipient: "0xa3",
      cancel_cap_id: "0xa4",
      total_amount: 900n,
      checkpoint_count: 3n,
    }),
  );
  projection = reduceVestingInput(
    projection,
    event("checkpoints.VestingClaimed", {
      vesting_id: "0xa0",
      coin_type: "0x2::sui::SUI",
      beneficiary: "0xa2",
      amount: 900n,
      released_total: 900n,
    }),
  );
  assert.throws(
    () =>
      reduceVestingInput(
        projection,
        event("checkpoints.VestingClosed", {
          vesting_id: "0xa0",
          coin_type: "0x2::sui::SUI",
        }),
      ),
    /only irrevocable vesting can close/,
  );
});

function linearCreated(
  vestingId: string,
  beneficiary: string,
  totalAmount: bigint,
) {
  return event("linear.VestingCreated", {
    vesting_id: vestingId,
    coin_type: "0x2::sui::SUI",
    beneficiary,
    refund_recipient: null,
    cancel_cap_id: null,
    total_amount: totalAmount,
    start_ms: 100n,
    cliff_ms: 20n,
    period_ms: 10n,
    periods: 10n,
  });
}

function linearClaimed(
  vestingId: string,
  beneficiary: string,
  amount: bigint,
  releasedTotal: bigint,
) {
  return event("linear.VestingClaimed", {
    vesting_id: vestingId,
    coin_type: "0x2::sui::SUI",
    beneficiary,
    amount,
    released_total: releasedTotal,
  });
}

function event<Kind extends VestingEventKind>(
  kind: Kind,
  payload: PayloadForKind<Kind>,
): Extract<DecodedVestingEvent, { kind: Kind }> {
  const [module, name] = kind.split(".") as [
    "linear" | "checkpoints",
    "VestingCreated" | "VestingClaimed" | "VestingCanceled" | "VestingClosed",
  ];
  const eventIndex = nextEventIndex++;
  const sender = normalizeSuiAddress("0x101");
  return {
    source: "vesting",
    module,
    name,
    kind,
    payload,
    emitterPackageId: normalizeSuiObjectId("0x100"),
    sender,
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
