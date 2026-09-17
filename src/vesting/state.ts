import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";

import { suiBalanceBcs, suiUidBcs } from "../lib/bcs.ts";
import { normalizePositiveU64, requireU64 } from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";
import { vestingKindOfModule } from "./modules.ts";
import type { LinearSchedule, VestingCheckpoint } from "./schedules.ts";
import {
  checkpointVestedAt,
  MAX_CHECKPOINT_PAGE_SIZE,
  MAX_CHECKPOINTS,
} from "./schedules.ts";

/** BCS layout of the canonical Sui `Clock`. */
export const clockBcs = bcs.struct("Clock", {
  id: suiUidBcs,
  timestamp_ms: bcs.u64(),
});

/** BCS layout of `blast_fun_vesting::blast_fun_checkpoint_vesting::Checkpoint`. */
export const checkpointBcs = bcs.struct("Checkpoint", {
  timestamp_ms: bcs.u64(),
  cumulative_amount: bcs.u64(),
});

/** BCS layout of `blast_fun_vesting::blast_fun_linear_vesting::Vesting<CoinType>`. */
export const linearVestingBcs = bcs.struct("LinearVesting", {
  id: suiUidBcs,
  balance: suiBalanceBcs,
  beneficiary: bcs.Address,
  cancel_refund_recipient: bcs.option(bcs.Address),
  start_ms: bcs.u64(),
  cliff_ms: bcs.u64(),
  period_ms: bcs.u64(),
  periods: bcs.u64(),
  released: bcs.u64(),
});

/** BCS layout of `blast_fun_vesting::blast_fun_checkpoint_vesting::Vesting<CoinType>`. */
export const checkpointVestingBcs = bcs.struct("CheckpointVesting", {
  id: suiUidBcs,
  balance: suiBalanceBcs,
  beneficiary: bcs.Address,
  cancel_refund_recipient: bcs.option(bcs.Address),
  checkpoints: bcs.vector(checkpointBcs),
  released: bcs.u64(),
});

type BaseVestingState = SharedObjectReference<true> & {
  originalPackageId: string;
  coinType: string;
  balance: bigint;
  beneficiary: string;
  refundRecipient: string | null;
  released: bigint;
  totalAmount: bigint;
};

export type LinearVestingState = BaseVestingState & {
  kind: "linear";
  schedule: LinearSchedule;
  endMs: bigint;
};

export type CheckpointVestingState = BaseVestingState & {
  kind: "checkpoints";
  checkpoints: VestingCheckpoint[];
  checkpointCount: bigint;
};

export type VestingState = LinearVestingState | CheckpointVestingState;

export type VestingObject = SharedObjectReference<true> & {
  type: string;
  content: Uint8Array;
};

/** Decodes one canonical linear or checkpoint vesting object. */
export function decodeVestingObject(
  object: VestingObject,
  originalPackageId?: string,
): VestingState {
  const tag = parseStructTag(object.type);
  const kind = vestingKindOfModule(tag.module);
  if (kind === undefined || tag.name !== "Vesting") {
    throw new TypeError(`object ${object.objectId} is not a vesting position`);
  }
  if (tag.typeParams.length !== 1) {
    throw new TypeError(
      `vesting position ${object.objectId} must have one type argument`,
    );
  }
  const typePackageId = normalizeSuiAddress(tag.address);
  if (
    originalPackageId !== undefined &&
    typePackageId !== normalizeSuiAddress(originalPackageId)
  ) {
    throw new TypeError(
      `vesting position ${object.objectId} has an unexpected package`,
    );
  }
  if (object.mutable !== true) {
    throw new TypeError(`vesting position ${object.objectId} must be mutable`);
  }

  const objectId = normalizeSuiObjectId(object.objectId);
  const initialSharedVersion = normalizePositiveU64(
    "initialSharedVersion",
    object.initialSharedVersion,
  );
  const coinType = normalizeTypeParameter(tag.typeParams[0]);

  if (kind === "linear") {
    const parsed = linearVestingBcs.parse(object.content);
    assertUid(objectId, parsed.id.id.bytes);
    const balance = BigInt(parsed.balance.value);
    const released = BigInt(parsed.released);
    requireU64("totalAmount", balance + released);
    const schedule = {
      startMs: BigInt(parsed.start_ms),
      cliffMs: BigInt(parsed.cliff_ms),
      periodMs: BigInt(parsed.period_ms),
      periods: BigInt(parsed.periods),
    };
    return {
      kind: "linear",
      objectId,
      initialSharedVersion,
      mutable: true,
      originalPackageId: typePackageId,
      coinType,
      balance,
      beneficiary: normalizeSuiAddress(parsed.beneficiary),
      refundRecipient: normalizeOptionalAddress(parsed.cancel_refund_recipient),
      released,
      totalAmount: balance + released,
      schedule,
      endMs: schedule.startMs + schedule.periodMs * schedule.periods,
    };
  }

  const parsed = checkpointVestingBcs.parse(object.content);
  assertUid(objectId, parsed.id.id.bytes);
  const balance = BigInt(parsed.balance.value);
  const released = BigInt(parsed.released);
  requireU64("totalAmount", balance + released);
  const checkpoints = parsed.checkpoints.map((checkpoint) => ({
    timestampMs: BigInt(checkpoint.timestamp_ms),
    cumulativeAmount: BigInt(checkpoint.cumulative_amount),
  }));
  const checkpointCount = BigInt(checkpoints.length);
  if (checkpointCount === 0n || checkpointCount > BigInt(MAX_CHECKPOINTS)) {
    throw new RangeError(
      `checkpointCount must be from 1 to ${MAX_CHECKPOINTS}`,
    );
  }
  return {
    kind: "checkpoints",
    objectId,
    initialSharedVersion,
    mutable: true,
    originalPackageId: typePackageId,
    coinType,
    balance,
    beneficiary: normalizeSuiAddress(parsed.beneficiary),
    refundRecipient: normalizeOptionalAddress(parsed.cancel_refund_recipient),
    released,
    totalAmount: balance + released,
    checkpoints,
    checkpointCount,
  };
}

/** Reads and decodes one shared vesting object through the Sui Core API. */
export async function getVesting(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId?: string,
): Promise<VestingState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(
      `vesting position ${object.objectId} is not a shared object`,
    );
  }
  return decodeVestingObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      mutable: true,
      type: object.type,
      content: object.content,
    },
    originalPackageId,
  );
}

/** Reads the authoritative Sui clock timestamp in milliseconds. */
export async function getCurrentTimestampMs(
  client: ClientWithCoreApi,
): Promise<bigint> {
  const { object } = await client.core.getObject({
    objectId: SUI_CLOCK_OBJECT_ID,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError("Sui Clock is not a shared object");
  }
  const tag = parseStructTag(object.type);
  if (
    normalizeSuiAddress(tag.address) !== normalizeSuiAddress("0x2") ||
    tag.module !== "clock" ||
    tag.name !== "Clock"
  ) {
    throw new TypeError("object 0x6 is not the Sui Clock");
  }
  const parsed = clockBcs.parse(object.content);
  if (
    normalizeSuiObjectId(parsed.id.id.bytes) !==
    normalizeSuiObjectId(SUI_CLOCK_OBJECT_ID)
  ) {
    throw new TypeError("Sui Clock has a mismatched UID");
  }
  return BigInt(parsed.timestamp_ms);
}

/** Returns one checkpoint from the canonical inline schedule. */
export function getCheckpoint(
  vesting: CheckpointVestingState,
  index: bigint,
): VestingCheckpoint {
  requireU64("index", index);
  if (index >= vesting.checkpointCount) {
    throw new RangeError("checkpoint index is out of bounds");
  }
  return vesting.checkpoints[Number(index)]!;
}

/** Returns at most 32 checkpoints from the decoded inline schedule. */
export function getCheckpointPage(
  vesting: CheckpointVestingState,
  start: bigint,
  limit: number = MAX_CHECKPOINT_PAGE_SIZE,
): VestingCheckpoint[] {
  requireU64("start", start);
  if (
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > MAX_CHECKPOINT_PAGE_SIZE
  ) {
    throw new RangeError(
      `limit must be an integer from 0 to ${MAX_CHECKPOINT_PAGE_SIZE}`,
    );
  }
  if (start >= vesting.checkpointCount || limit === 0) return [];
  const startIndex = Number(start);
  return vesting.checkpoints.slice(startIndex, startIndex + limit);
}

/** Mirrors the on-chain binary search over the decoded inline schedule. */
export function getCheckpointVestedAt(
  vesting: CheckpointVestingState,
  timestampMs: bigint,
): bigint {
  requireU64("timestampMs", timestampMs);
  return checkpointVestedAt(vesting.checkpoints, timestampMs);
}

/** Returns the complete decoded schedule, capped on-chain at 256 entries. */
export function getAllCheckpoints(
  vesting: CheckpointVestingState,
): VestingCheckpoint[] {
  return [...vesting.checkpoints];
}

function assertUid(objectId: string, embeddedId: string): void {
  if (normalizeSuiObjectId(embeddedId) !== objectId) {
    throw new TypeError(`vesting position ${objectId} has a mismatched UID`);
  }
}

function normalizeOptionalAddress(value: string | null): string | null {
  return value === null ? null : normalizeSuiAddress(value);
}

function normalizeTypeParameter(
  type: ReturnType<typeof parseStructTag>["typeParams"][number] | undefined,
): string {
  if (type === undefined) throw new TypeError("missing vesting type argument");
  return typeof type === "string" ? type : normalizeStructTag(type);
}
