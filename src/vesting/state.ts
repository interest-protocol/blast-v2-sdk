import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";

import {
  normalizePositiveU64,
  requireU64,
} from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";
import {
  MAX_CHECKPOINT_PAGE_SIZE,
  MAX_CHECKPOINTS,
} from "./schedules.ts";
import type {
  LinearSchedule,
  VestingCheckpoint,
} from "./schedules.ts";

const IdBcs = bcs.struct("ID", { bytes: bcs.Address });
const UidBcs = bcs.struct("UID", { id: IdBcs });
const BalanceBcs = bcs.struct("Balance", { value: bcs.u64() });
const TableBcs = bcs.struct("Table", {
  id: UidBcs,
  size: bcs.u64(),
});
const TableVecBcs = bcs.struct("TableVec", { contents: TableBcs });

/** BCS layout of the canonical Sui `Clock`. */
export const clockBcs = bcs.struct("Clock", {
  id: UidBcs,
  timestamp_ms: bcs.u64(),
});

/** BCS layout of `blast_fun_vesting::checkpoints::Checkpoint`. */
export const checkpointBcs = bcs.struct("Checkpoint", {
  timestamp_ms: bcs.u64(),
  cumulative_amount: bcs.u64(),
});

/** BCS layout of `blast_fun_vesting::linear::Vesting<CoinType>`. */
export const linearVestingBcs = bcs.struct("LinearVesting", {
  id: UidBcs,
  balance: BalanceBcs,
  beneficiary: bcs.Address,
  cancel_refund_recipient: bcs.option(bcs.Address),
  start_ms: bcs.u64(),
  cliff_ms: bcs.u64(),
  period_ms: bcs.u64(),
  periods: bcs.u64(),
  released: bcs.u64(),
});

/** BCS layout of `blast_fun_vesting::checkpoints::Vesting<CoinType>`. */
export const checkpointVestingBcs = bcs.struct("CheckpointVesting", {
  id: UidBcs,
  balance: BalanceBcs,
  beneficiary: bcs.Address,
  cancel_refund_recipient: bcs.option(bcs.Address),
  checkpoints: TableVecBcs,
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
  checkpointTableId: string;
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
  if (
    (tag.module !== "linear" && tag.module !== "checkpoints") ||
    tag.name !== "Vesting"
  ) {
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

  if (tag.module === "linear") {
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
      refundRecipient: normalizeOptionalAddress(
        parsed.cancel_refund_recipient,
      ),
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
  const checkpointCount = BigInt(parsed.checkpoints.contents.size);
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
    checkpointTableId: normalizeSuiObjectId(
      parsed.checkpoints.contents.id.id.bytes,
    ),
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

/** Reads one checkpoint directly from its indexed `TableVec` dynamic field. */
export async function getCheckpoint(
  client: ClientWithCoreApi,
  vesting: CheckpointVestingState,
  index: bigint,
): Promise<VestingCheckpoint> {
  requireU64("index", index);
  if (index >= vesting.checkpointCount) {
    throw new RangeError("checkpoint index is out of bounds");
  }
  const { dynamicField } = await client.core.getDynamicField({
    parentId: vesting.checkpointTableId,
    name: {
      type: "u64",
      bcs: bcs.u64().serialize(index).toBytes(),
    },
  });
  const expectedType = normalizeStructTag(
    `${vesting.originalPackageId}::checkpoints::Checkpoint`,
  );
  if (normalizeStructTag(dynamicField.value.type) !== expectedType) {
    throw new TypeError(`checkpoint ${index} has an unexpected type`);
  }
  const parsed = checkpointBcs.parse(dynamicField.value.bcs);
  return {
    timestampMs: BigInt(parsed.timestamp_ms),
    cumulativeAmount: BigInt(parsed.cumulative_amount),
  };
}

/** Reads at most 32 indexed checkpoints without materializing the complete schedule. */
export async function getCheckpointPage(
  client: ClientWithCoreApi,
  vesting: CheckpointVestingState,
  start: bigint,
  limit: number = MAX_CHECKPOINT_PAGE_SIZE,
): Promise<VestingCheckpoint[]> {
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
  const count = Number(
    minBigInt(BigInt(limit), vesting.checkpointCount - start),
  );
  return Promise.all(
    Array.from({ length: count }, (_, offset) =>
      getCheckpoint(client, vesting, start + BigInt(offset)),
    ),
  );
}

/** Mirrors the on-chain binary search with indexed dynamic-field reads. */
export async function getCheckpointVestedAt(
  client: ClientWithCoreApi,
  vesting: CheckpointVestingState,
  timestampMs: bigint,
): Promise<bigint> {
  requireU64("timestampMs", timestampMs);
  let low = 0n;
  let high = vesting.checkpointCount;
  while (low < high) {
    const middle = low + (high - low) / 2n;
    const checkpoint = await getCheckpoint(client, vesting, middle);
    if (checkpoint.timestampMs <= timestampMs) {
      low = middle + 1n;
    } else {
      high = middle;
    }
  }
  return low === 0n
    ? 0n
    : (await getCheckpoint(client, vesting, low - 1n)).cumulativeAmount;
}

/** Iterates bounded pages and returns the complete schedule, capped on-chain at 256 entries. */
export async function getAllCheckpoints(
  client: ClientWithCoreApi,
  vesting: CheckpointVestingState,
): Promise<VestingCheckpoint[]> {
  const checkpoints: VestingCheckpoint[] = [];
  let start = 0n;
  while (start < vesting.checkpointCount) {
    const page = await getCheckpointPage(client, vesting, start);
    checkpoints.push(...page);
    start += BigInt(page.length);
  }
  return checkpoints;
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

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
