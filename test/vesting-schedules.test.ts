import assert from "node:assert/strict";
import test from "node:test";

import {
  checkpointVestedAt,
  linearEndMs,
  linearVestedAt,
  validateCheckpointSchedule,
  validateLinearSchedule,
  vestingPreview,
} from "../src/vesting/schedules.ts";

const linear = {
  startMs: 100n,
  cliffMs: 200n,
  periodMs: 100n,
  periods: 10n,
};

const checkpoints = [
  { timestampMs: 100n, cumulativeAmount: 200n },
  { timestampMs: 250n, cumulativeAmount: 456n },
  { timestampMs: 700n, cumulativeAmount: 1_000n },
] as const;

test("mirrors stepped-linear cliff, rounding, and final release", () => {
  validateLinearSchedule(linear, 100n, 0n);
  assert.equal(linearEndMs(linear), 1_100n);
  assert.equal(linearVestedAt(1_001n, linear, 299n), 0n);
  assert.equal(linearVestedAt(1_001n, linear, 300n), 200n);
  assert.equal(linearVestedAt(1_001n, linear, 1_099n), 900n);
  assert.equal(linearVestedAt(1_001n, linear, 1_100n), 1_001n);
});

test("returns exact cumulative checkpoint amounts at every boundary", () => {
  validateCheckpointSchedule(checkpoints, 1_000n, 100n, 0n);
  assert.equal(checkpointVestedAt(checkpoints, 99n), 0n);
  assert.equal(checkpointVestedAt(checkpoints, 100n), 200n);
  assert.equal(checkpointVestedAt(checkpoints, 249n), 200n);
  assert.equal(checkpointVestedAt(checkpoints, 250n), 456n);
  assert.equal(checkpointVestedAt(checkpoints, 699n), 456n);
  assert.equal(checkpointVestedAt(checkpoints, 700n), 1_000n);
  assert.equal(checkpointVestedAt(checkpoints, 701n), 1_000n);
});

test("derives claimable and unvested amounts from cumulative state", () => {
  assert.deepEqual(vestingPreview(1_000n, 456n, 200n), {
    vested: 456n,
    released: 200n,
    releasable: 256n,
    unvested: 544n,
  });
});

test("rejects schedules the constructors cannot accept", () => {
  assert.throws(
    () => validateLinearSchedule({ ...linear, startMs: 100_000n }, 40_001n),
    /minimumLeadTimeMs/,
  );
  assert.throws(
    () => validateLinearSchedule({ ...linear, cliffMs: 1_001n }, 0n, 0n),
    /cliffMs must not exceed/,
  );
  assert.throws(
    () => validateCheckpointSchedule([], 1_000n, 0n, 0n),
    /1 to 256/,
  );
  assert.throws(
    () =>
      validateCheckpointSchedule(
        [checkpoints[1], checkpoints[0]],
        200n,
        0n,
        0n,
      ),
    /timestamps must strictly increase/,
  );
  assert.throws(
    () => validateCheckpointSchedule(checkpoints, 999n, 0n, 0n),
    /must equal totalAmount/,
  );
  assert.throws(
    () => vestingPreview(1_000n, 100n, 101n),
    /released must not exceed vested/,
  );
});
