import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

import { requirePositiveU64, requireU64 } from "../lib/integers.ts";
import type { DecodedVestingEvent, VestingEventPayloads } from "./events.ts";
import { vestingEventId } from "./events.ts";
import type { LinearSchedule, VestingCheckpoint } from "./schedules.ts";
import {
  linearEndMs,
  MAX_CHECKPOINTS,
  validateCheckpointSchedule,
} from "./schedules.ts";

type VestingPositionBase = {
  vestingId: string;
  coinType: string;
  funder: string;
  beneficiary: string;
  refundRecipient: string | null;
  cancelCapId: string | null;
  totalAmount: bigint;
  releasedTotal: bigint;
  remainingBalance: bigint;
  status: "active" | "canceled" | "closed";
};

export type LinearVestingProjection = VestingPositionBase & {
  kind: "linear";
  schedule: LinearSchedule;
};

export type CheckpointVestingProjection = VestingPositionBase & {
  kind: "checkpoints";
  checkpointCount: bigint;
};

export type VestingPositionProjection =
  | LinearVestingProjection
  | CheckpointVestingProjection;

export type VestingNativeFact =
  | {
      source: "objectOwnership";
      kind: "cancelCapOwnership";
      checkpoint: bigint;
      cancelCapId: string;
      owner: string;
    }
  | {
      source: "objectRead";
      kind: "checkpointSchedule";
      checkpoint: bigint;
      vestingId: string;
      checkpoints: readonly VestingCheckpoint[];
    };

export type VestingNativeProjection = {
  appliedFactIds: Record<string, true>;
  cancelCapOwners: Record<
    string,
    Extract<VestingNativeFact, { kind: "cancelCapOwnership" }>
  >;
  checkpointSchedules: Record<
    string,
    Extract<VestingNativeFact, { kind: "checkpointSchedule" }>
  >;
};

export type VestingProjection = {
  appliedEventIds: Record<string, true>;
  positions: Record<string, VestingPositionProjection>;
  native: VestingNativeProjection;
};

export type VestingReducerInput = DecodedVestingEvent | VestingNativeFact;

export function createVestingProjection(): VestingProjection {
  return {
    appliedEventIds: {},
    positions: {},
    native: {
      appliedFactIds: {},
      cancelCapOwners: {},
      checkpointSchedules: {},
    },
  };
}

export function reduceVestingInput(
  state: VestingProjection,
  input: VestingReducerInput,
): VestingProjection {
  return input.source === "vesting"
    ? reduceVestingEvent(state, input)
    : reduceNativeFact(state, input);
}

function reduceVestingEvent(
  state: VestingProjection,
  event: DecodedVestingEvent,
): VestingProjection {
  const eventId = vestingEventId(event);
  if (state.appliedEventIds[eventId]) return state;

  const vestingId = normalizeSuiObjectId(event.payload.vesting_id);
  const position =
    event.name === "VestingCreated"
      ? createPosition(event)
      : updatePosition(requirePosition(state, vestingId), event);
  return {
    ...state,
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
    positions: { ...state.positions, [vestingId]: position },
  };
}

function createPosition(
  event: Extract<DecodedVestingEvent, { name: "VestingCreated" }>,
): VestingPositionProjection {
  const payload = event.payload;
  const common: VestingPositionBase = {
    vestingId: normalizeSuiObjectId(payload.vesting_id),
    coinType: normalizeStructTag(payload.coin_type),
    funder: normalizeSuiAddress(payload.funder),
    beneficiary: normalizeSuiAddress(payload.beneficiary),
    refundRecipient: normalizeOptionalAddress(payload.refund_recipient),
    cancelCapId: normalizeOptionalId(payload.cancel_cap_id),
    totalAmount: requirePositiveU64("total amount", payload.total_amount),
    releasedTotal: 0n,
    remainingBalance: payload.total_amount,
    status: "active",
  };
  if (event.kind === "linear.VestingCreated") {
    const schedule = {
      startMs: event.payload.start_ms,
      cliffMs: event.payload.cliff_ms,
      periodMs: event.payload.period_ms,
      periods: event.payload.periods,
    };
    linearEndMs(schedule);
    return { ...common, kind: "linear", schedule };
  }

  const checkpointPayload =
    event.payload as VestingEventPayloads["checkpoints"]["VestingCreated"];
  const checkpointCount = requirePositiveU64(
    "checkpoint count",
    checkpointPayload.checkpoint_count,
  );
  if (checkpointCount > BigInt(MAX_CHECKPOINTS)) {
    throw new RangeError(
      `checkpoint count must be from 1 to ${MAX_CHECKPOINTS}`,
    );
  }
  return { ...common, kind: "checkpoints", checkpointCount };
}

function updatePosition(
  position: VestingPositionProjection,
  event: Exclude<DecodedVestingEvent, { name: "VestingCreated" }>,
): VestingPositionProjection {
  if (position.status !== "active") {
    throw new TypeError("vesting position is not active");
  }
  if (event.module !== position.kind) {
    throw new TypeError("vesting event module does not match its position");
  }
  if (normalizeStructTag(event.payload.coin_type) !== position.coinType) {
    throw new TypeError("vesting event coin type does not match its position");
  }
  if (event.name === "VestingClaimed") {
    return updateClaimedPosition(position, event);
  }
  if (event.name === "VestingCanceled") {
    return updateCanceledPosition(position, event);
  }
  return updateClosedPosition(position, event);
}

function updateClaimedPosition(
  position: VestingPositionProjection,
  event: Extract<DecodedVestingEvent, { name: "VestingClaimed" }>,
): VestingPositionProjection {
  assertBeneficiary(position, event.payload.beneficiary);
  const { releasedTotal, delta } = releaseDelta(
    position,
    event.payload.released_total,
  );
  const amount = requireU64("claim amount", event.payload.amount);
  if (amount !== delta) {
    throw new RangeError("claim amount must equal the released total delta");
  }
  const remainingBalance = requireU64(
    "remaining balance",
    event.payload.remaining_balance,
  );
  if (releasedTotal + remainingBalance !== position.totalAmount) {
    throw new RangeError(
      "released total plus remaining balance must equal total amount",
    );
  }
  return { ...position, releasedTotal, remainingBalance };
}

function updateCanceledPosition(
  position: VestingPositionProjection,
  event: Extract<DecodedVestingEvent, { name: "VestingCanceled" }>,
): VestingPositionProjection {
  assertBeneficiary(position, event.payload.beneficiary);
  if (
    normalizeSuiAddress(event.payload.refund_recipient) !==
    position.refundRecipient
  ) {
    throw new TypeError("cancellation refund recipient does not match");
  }
  const { releasedTotal, delta } = releaseDelta(
    position,
    event.payload.released_total,
  );
  const beneficiaryAmount = requireU64(
    "beneficiary amount",
    event.payload.beneficiary_amount,
  );
  if (beneficiaryAmount !== delta) {
    throw new RangeError(
      "beneficiary amount must equal the released total delta",
    );
  }
  const refundAmount = requireU64("refund amount", event.payload.refund_amount);
  if (releasedTotal + refundAmount !== position.totalAmount) {
    throw new RangeError(
      "released total plus refund amount must equal total amount",
    );
  }
  return {
    ...position,
    releasedTotal,
    remainingBalance: 0n,
    status: "canceled",
  };
}

function updateClosedPosition(
  position: VestingPositionProjection,
  event: Extract<DecodedVestingEvent, { name: "VestingClosed" }>,
): VestingPositionProjection {
  const releasedTotal = requireU64(
    "released total",
    event.payload.released_total,
  );
  if (releasedTotal !== position.releasedTotal) {
    throw new RangeError("close must not change released total");
  }
  if (
    position.releasedTotal !== position.totalAmount ||
    position.remainingBalance !== 0n
  ) {
    throw new RangeError("closed vesting remaining balance must be zero");
  }
  return {
    ...position,
    status: "closed",
  };
}

function assertBeneficiary(
  position: VestingPositionProjection,
  beneficiary: string,
): void {
  if (normalizeSuiAddress(beneficiary) !== position.beneficiary) {
    throw new TypeError("vesting event beneficiary does not match");
  }
}

function releaseDelta(
  position: VestingPositionProjection,
  nextReleasedTotal: bigint,
): { releasedTotal: bigint; delta: bigint } {
  const releasedTotal = requireU64("released total", nextReleasedTotal);
  if (releasedTotal < position.releasedTotal) {
    throw new RangeError("released total must not decrease");
  }
  return {
    releasedTotal,
    delta: releasedTotal - position.releasedTotal,
  };
}

function reduceNativeFact(
  state: VestingProjection,
  fact: VestingNativeFact,
): VestingProjection {
  const normalized = normalizeNativeFact(state, fact);
  const factId = nativeFactId(normalized);
  if (state.native.appliedFactIds[factId]) return state;

  const appliedFactIds = {
    ...state.native.appliedFactIds,
    [factId]: true as const,
  };
  if (normalized.kind === "cancelCapOwnership") {
    return {
      ...state,
      native: {
        ...state.native,
        appliedFactIds,
        cancelCapOwners: {
          ...state.native.cancelCapOwners,
          [normalized.cancelCapId]: normalized,
        },
      },
    };
  }
  return {
    ...state,
    native: {
      ...state.native,
      appliedFactIds,
      checkpointSchedules: {
        ...state.native.checkpointSchedules,
        [normalized.vestingId]: normalized,
      },
    },
  };
}

function normalizeNativeFact(
  state: VestingProjection,
  fact: VestingNativeFact,
): VestingNativeFact {
  requireU64("native fact checkpoint", fact.checkpoint);
  if (fact.kind === "cancelCapOwnership") {
    return {
      ...fact,
      cancelCapId: normalizeSuiObjectId(fact.cancelCapId),
      owner: normalizeSuiAddress(fact.owner),
    };
  }

  const vestingId = normalizeSuiObjectId(fact.vestingId);
  const position = state.positions[vestingId];
  if (position?.kind !== "checkpoints") {
    throw new TypeError(`unknown checkpoint vesting ${vestingId}`);
  }
  if (BigInt(fact.checkpoints.length) !== position.checkpointCount) {
    throw new RangeError("checkpoint schedule must match checkpoint count");
  }
  const checkpoints = fact.checkpoints.map((checkpoint) => ({
    timestampMs: checkpoint.timestampMs,
    cumulativeAmount: checkpoint.cumulativeAmount,
  }));
  validateCheckpointSchedule(checkpoints, position.totalAmount, 0n, 0n);
  return { ...fact, vestingId, checkpoints };
}

function nativeFactId(fact: VestingNativeFact): string {
  return fact.kind === "cancelCapOwnership"
    ? `${fact.source}:${fact.kind}:${fact.checkpoint}:${fact.cancelCapId}`
    : `${fact.source}:${fact.kind}:${fact.checkpoint}:${fact.vestingId}`;
}

function requirePosition(
  state: VestingProjection,
  vestingId: string,
): VestingPositionProjection {
  const position = state.positions[vestingId];
  if (!position) throw new TypeError(`unknown vesting position ${vestingId}`);
  return position;
}

function normalizeOptionalAddress(value: string | null): string | null {
  return value === null ? null : normalizeSuiAddress(value);
}

function normalizeOptionalId(value: string | null): string | null {
  return value === null ? null : normalizeSuiObjectId(value);
}
