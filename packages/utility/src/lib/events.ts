import { requireU64 } from "./integers.ts";

export type SuiEventPosition = {
  checkpoint: bigint;
  transactionDigest: string;
  eventIndex: number;
};

export type NativeTransactionPosition = Pick<
  SuiEventPosition,
  "checkpoint" | "transactionDigest"
>;

export function normalizeSuiEventPosition(input: {
  checkpoint: bigint | number | string | null;
  transactionDigest: string;
  eventIndex: number;
}): SuiEventPosition {
  if (input.checkpoint === null) {
    throw new TypeError("event requires checkpoint metadata");
  }
  if (
    typeof input.checkpoint === "number" &&
    !Number.isSafeInteger(input.checkpoint)
  ) {
    throw new TypeError("event checkpoint must be a u64");
  }
  let checkpoint: bigint;
  try {
    checkpoint = BigInt(input.checkpoint);
  } catch {
    throw new TypeError("event checkpoint must be a u64");
  }
  requireU64("event checkpoint", checkpoint);
  if (!input.transactionDigest) {
    throw new TypeError("event transaction digest is required");
  }
  if (!Number.isSafeInteger(input.eventIndex) || input.eventIndex < 0) {
    throw new RangeError("event index must be a non-negative integer");
  }
  return {
    checkpoint,
    transactionDigest: input.transactionDigest,
    eventIndex: input.eventIndex,
  };
}

export function normalizeNativeTransactionPosition(
  input: NativeTransactionPosition,
  label: string = "native transaction",
): NativeTransactionPosition {
  requireU64(`${label} checkpoint`, input.checkpoint);
  if (!input.transactionDigest) {
    throw new TypeError(`${label} transaction digest is required`);
  }
  return {
    checkpoint: input.checkpoint,
    transactionDigest: input.transactionDigest,
  };
}

export function suiEventId(position: SuiEventPosition): string {
  return `${position.transactionDigest}:${position.eventIndex}`;
}
