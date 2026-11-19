import { requirePositiveU64, requireU64, U64_MAX } from "../lib/integers.ts";

export const MAX_CHECKPOINTS = 256;
export const MAX_CHECKPOINT_PAGE_SIZE = 32;
export const DEFAULT_START_LEAD_TIME_MS = 60_000n;

export type LinearSchedule = Readonly<{
  startMs: bigint;
  cliffMs: bigint;
  periodMs: bigint;
  periods: bigint;
}>;

export type VestingCheckpoint = Readonly<{
  timestampMs: bigint;
  cumulativeAmount: bigint;
}>;

export type VestingPreview = Readonly<{
  vested: bigint;
  released: bigint;
  releasable: bigint;
  unvested: bigint;
}>;

/** Validates one linear schedule for a new transaction against milliseconds since Unix epoch. */
export function validateLinearSchedule(
  schedule: LinearSchedule,
  currentTimestampMs: bigint = BigInt(Date.now()),
  minimumLeadTimeMs: bigint = DEFAULT_START_LEAD_TIME_MS,
): void {
  validateLinearShape(schedule);
  const minimumStartMs = minimumStart(currentTimestampMs, minimumLeadTimeMs);
  if (schedule.startMs < minimumStartMs) {
    throw new RangeError(
      "startMs must include minimumLeadTimeMs after currentTimestampMs",
    );
  }
}

/** Returns the absolute end timestamp in milliseconds. */
export function linearEndMs(schedule: LinearSchedule): bigint {
  validateLinearShape(schedule);
  return schedule.startMs + schedule.periodMs * schedule.periods;
}

/**
 * Returns vested atomic units, rounding intermediate proportional release down.
 * The final boundary releases the complete allocation.
 */
export function linearVestedAt(
  totalAmount: bigint,
  schedule: LinearSchedule,
  timestampMs: bigint,
): bigint {
  requirePositiveU64("totalAmount", totalAmount);
  requireU64("timestampMs", timestampMs);
  const endMs = linearEndMs(schedule);
  if (
    timestampMs < schedule.startMs ||
    timestampMs < schedule.startMs + schedule.cliffMs
  ) {
    return 0n;
  }
  if (timestampMs >= endMs) return totalAmount;
  const elapsedPeriods = (timestampMs - schedule.startMs) / schedule.periodMs;
  return (totalAmount * elapsedPeriods) / schedule.periods;
}

/** Validates exact cumulative checkpoints for a new funded transaction. */
export function validateCheckpointSchedule(
  checkpoints: readonly VestingCheckpoint[],
  totalAmount: bigint,
  currentTimestampMs: bigint = BigInt(Date.now()),
  minimumLeadTimeMs: bigint = DEFAULT_START_LEAD_TIME_MS,
): void {
  requirePositiveU64("totalAmount", totalAmount);
  validateCheckpointShape(checkpoints);
  const minimumCheckpointMs = minimumStart(
    currentTimestampMs,
    minimumLeadTimeMs,
  );
  if (checkpoints[0]!.timestampMs < minimumCheckpointMs) {
    throw new RangeError(
      "first checkpoint must include minimumLeadTimeMs after currentTimestampMs",
    );
  }
  if (checkpoints.at(-1)!.cumulativeAmount !== totalAmount) {
    throw new RangeError(
      "final checkpoint cumulativeAmount must equal totalAmount",
    );
  }
}

/** Returns the exact cumulative atomic units vested at a timestamp. */
export function checkpointVestedAt(
  checkpoints: readonly VestingCheckpoint[],
  timestampMs: bigint,
): bigint {
  requireU64("timestampMs", timestampMs);
  validateCheckpointShape(checkpoints);

  let low = 0;
  let high = checkpoints.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (checkpoints[middle]!.timestampMs <= timestampMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low === 0 ? 0n : checkpoints[low - 1]!.cumulativeAmount;
}

/** Derives claim and cancellation amounts from canonical cumulative state. */
export function vestingPreview(
  totalAmount: bigint,
  vested: bigint,
  released: bigint,
): VestingPreview {
  requirePositiveU64("totalAmount", totalAmount);
  requireU64("vested", vested);
  requireU64("released", released);
  if (vested > totalAmount) {
    throw new RangeError("vested must not exceed totalAmount");
  }
  if (released > vested) {
    throw new RangeError("released must not exceed vested");
  }
  return {
    vested,
    released,
    releasable: vested - released,
    unvested: totalAmount - vested,
  };
}

function validateLinearShape(schedule: LinearSchedule): void {
  requireU64("startMs", schedule.startMs);
  requireU64("cliffMs", schedule.cliffMs);
  requirePositiveU64("periodMs", schedule.periodMs);
  requirePositiveU64("periods", schedule.periods);
  if (schedule.periodMs > U64_MAX / schedule.periods) {
    throw new RangeError("linear schedule duration must be a u64");
  }
  const durationMs = schedule.periodMs * schedule.periods;
  if (schedule.cliffMs > durationMs) {
    throw new RangeError("cliffMs must not exceed the schedule duration");
  }
  if (durationMs > U64_MAX - schedule.startMs) {
    throw new RangeError("linear schedule end must be a u64");
  }
}

function validateCheckpointShape(
  checkpoints: readonly VestingCheckpoint[],
): void {
  if (checkpoints.length === 0 || checkpoints.length > MAX_CHECKPOINTS) {
    throw new RangeError(
      `checkpoints must contain 1 to ${MAX_CHECKPOINTS} entries`,
    );
  }
  let previousTimestamp: bigint | null = null;
  let previousAmount = 0n;
  checkpoints.forEach((checkpoint, index) => {
    requireU64(`checkpoints[${index}].timestampMs`, checkpoint.timestampMs);
    requirePositiveU64(
      `checkpoints[${index}].cumulativeAmount`,
      checkpoint.cumulativeAmount,
    );
    if (
      previousTimestamp !== null &&
      checkpoint.timestampMs <= previousTimestamp
    ) {
      throw new RangeError("checkpoint timestamps must strictly increase");
    }
    if (checkpoint.cumulativeAmount <= previousAmount) {
      throw new RangeError(
        "checkpoint cumulative amounts must strictly increase",
      );
    }
    previousTimestamp = checkpoint.timestampMs;
    previousAmount = checkpoint.cumulativeAmount;
  });
}

function minimumStart(
  currentTimestampMs: bigint,
  minimumLeadTimeMs: bigint,
): bigint {
  requireU64("currentTimestampMs", currentTimestampMs);
  requireU64("minimumLeadTimeMs", minimumLeadTimeMs);
  if (minimumLeadTimeMs > U64_MAX - currentTimestampMs) {
    throw new RangeError(
      "currentTimestampMs plus minimumLeadTimeMs must be a u64",
    );
  }
  return currentTimestampMs + minimumLeadTimeMs;
}
