declare const U64_BRAND: unique symbol;

/** A `bigint` that has passed the Move `u64` range check. */
export type U64 = bigint & { readonly [U64_BRAND]: true };

export const U64_MAX = (1n << 64n) - 1n;

/** Requires an unsigned Move `u64` value. */
export function requireU64(name: string, value: bigint): U64 {
  if (value < 0n || value > U64_MAX) {
    throw new RangeError(`${name} must be a u64`);
  }
  return value as U64;
}

/** Requires a non-zero unsigned Move `u64` value. */
export function requirePositiveU64(name: string, value: bigint): U64 {
  if (value <= 0n || value > U64_MAX) {
    throw new RangeError(`${name} must be a positive u64`);
  }
  return value as U64;
}

/** Multiplies before dividing, rounding the non-negative result down. */
export function mulDivDown(
  multiplicand: bigint,
  multiplier: bigint,
  denominator: bigint,
): bigint {
  requireMulDivOperands(multiplicand, multiplier, denominator);
  return (multiplicand * multiplier) / denominator;
}

/** Multiplies before dividing, rounding the non-negative result up. */
export function mulDivUp(
  multiplicand: bigint,
  multiplier: bigint,
  denominator: bigint,
): bigint {
  requireMulDivOperands(multiplicand, multiplier, denominator);
  if (multiplicand === 0n || multiplier === 0n) return 0n;
  return (multiplicand * multiplier + denominator - 1n) / denominator;
}

/** Parses and canonicalizes a positive `u64` supplied by a transport API. */
export function normalizePositiveU64(
  name: string,
  value: number | string,
): string {
  let normalized: bigint;
  try {
    normalized = BigInt(value);
  } catch {
    throw new TypeError(`${name} must be a u64`);
  }

  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a positive u64`);
  }
  return requirePositiveU64(name, normalized).toString();
}

function requireMulDivOperands(
  multiplicand: bigint,
  multiplier: bigint,
  denominator: bigint,
): void {
  if (multiplicand < 0n || multiplier < 0n) {
    throw new RangeError("multiply-divide operands must be non-negative");
  }
  if (denominator <= 0n) {
    throw new RangeError("multiply-divide requires a positive denominator");
  }
}
