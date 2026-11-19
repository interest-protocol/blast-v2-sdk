import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

import type { NativeTransactionPosition } from "../lib/events.ts";
import { normalizeNativeTransactionPosition } from "../lib/events.ts";
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
    }
  | {
      source: "transactionEffects";
      kind: "cancelCapDeleted";
      position: NativeTransactionPosition;
      cancelCapId: string;
    };

type CancelCapDeletionFact = Extract<
  VestingNativeFact,
  { kind: "cancelCapDeleted" }
>;

export type VestingNativeProjection = {
  appliedFactIds: Record<string, true>;
  cancelCapOwners: Record<
    string,
    Extract<VestingNativeFact, { kind: "cancelCapOwnership" }>
  >;
  cancelCapDeletions: Record<string, CancelCapDeletionFact>;
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
      cancelCapDeletions: {},
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
    funder: normalizeSuiAddress(event.sender),
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
  return updateClosedPosition(position);
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
  const amount = requirePositiveU64("claim amount", event.payload.amount);
  if (amount !== delta) {
    throw new RangeError("claim amount must equal the released total delta");
  }
  if (releasedTotal > position.totalAmount) {
    throw new RangeError("released total must not exceed total amount");
  }
  return {
    ...position,
    releasedTotal,
    remainingBalance: position.totalAmount - releasedTotal,
  };
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
): VestingPositionProjection {
  if (position.refundRecipient !== null || position.cancelCapId !== null) {
    throw new TypeError("only irrevocable vesting can close");
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
  if (normalized.kind === "cancelCapOwnership") {
    return reduceCancelCapOwnership(state, normalized, factId);
  }
  if (normalized.kind === "cancelCapDeleted") {
    return reduceCancelCapDeletion(state, normalized, factId);
  }
  return {
    ...state,
    native: {
      ...state.native,
      appliedFactIds: {
        ...state.native.appliedFactIds,
        [factId]: true,
      },
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
  if (fact.kind === "cancelCapOwnership") {
    requireU64("native fact checkpoint", fact.checkpoint);
    return {
      ...fact,
      cancelCapId: normalizeSuiObjectId(fact.cancelCapId),
      owner: normalizeSuiAddress(fact.owner),
    };
  }
  if (fact.kind === "cancelCapDeleted") {
    return {
      ...fact,
      position: normalizeNativeTransactionPosition(
        fact.position,
        "cancel-cap deletion fact",
      ),
      cancelCapId: normalizeSuiObjectId(fact.cancelCapId),
    };
  }

  requireU64("native fact checkpoint", fact.checkpoint);
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
  if (fact.kind === "cancelCapOwnership") {
    return `${fact.source}:${fact.kind}:${fact.checkpoint}:${fact.cancelCapId}:${fact.owner}`;
  }
  if (fact.kind === "cancelCapDeleted") {
    return `${fact.position.transactionDigest}:${fact.kind}:${fact.cancelCapId}`;
  }
  return `${fact.source}:${fact.kind}:${fact.checkpoint}:${fact.vestingId}`;
}

function reduceCancelCapOwnership(
  state: VestingProjection,
  fact: Extract<VestingNativeFact, { kind: "cancelCapOwnership" }>,
  factId: string,
): VestingProjection {
  const deletion = state.native.cancelCapDeletions[fact.cancelCapId];
  if (deletion !== undefined) {
    if (fact.checkpoint < deletion.position.checkpoint) return state;
    throw new TypeError("deleted cancellation cap cannot have an owner");
  }
  const current = state.native.cancelCapOwners[fact.cancelCapId];
  if (current !== undefined) {
    if (fact.checkpoint < current.checkpoint) return state;
    if (fact.checkpoint === current.checkpoint) {
      throw new TypeError(
        `cancellation-cap ownership conflict at checkpoint ${fact.checkpoint}`,
      );
    }
  }
  return {
    ...state,
    native: {
      ...state.native,
      appliedFactIds: { ...state.native.appliedFactIds, [factId]: true },
      cancelCapOwners: {
        ...state.native.cancelCapOwners,
        [fact.cancelCapId]: fact,
      },
    },
  };
}

function reduceCancelCapDeletion(
  state: VestingProjection,
  fact: CancelCapDeletionFact,
  factId: string,
): VestingProjection {
  const existing = state.native.cancelCapDeletions[fact.cancelCapId];
  if (existing !== undefined) {
    if (fact.position.checkpoint < existing.position.checkpoint) return state;
    throw new TypeError("cancellation-cap deletion provenance conflicts");
  }
  const owner = state.native.cancelCapOwners[fact.cancelCapId];
  if (owner !== undefined) {
    if (fact.position.checkpoint < owner.checkpoint) return state;
    if (fact.position.checkpoint === owner.checkpoint) {
      throw new TypeError(
        `cancellation-cap deletion conflicts at checkpoint ${owner.checkpoint}`,
      );
    }
  }
  const cancelCapOwners = { ...state.native.cancelCapOwners };
  delete cancelCapOwners[fact.cancelCapId];
  return {
    ...state,
    native: {
      ...state.native,
      appliedFactIds: { ...state.native.appliedFactIds, [factId]: true },
      cancelCapOwners,
      cancelCapDeletions: {
        ...state.native.cancelCapDeletions,
        [fact.cancelCapId]: fact,
      },
    },
  };
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
