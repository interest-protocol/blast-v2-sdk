declare const U64_BRAND: unique symbol;
declare const U128_BRAND: unique symbol;

/** A `bigint` that has passed the Move `u64` range check. */
export type U64 = bigint & { readonly [U64_BRAND]: true };
/** A `bigint` that has passed the Move `u128` range check. */
export type U128 = bigint & { readonly [U128_BRAND]: true };

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const BASIS_POINTS_DENOMINATOR = 10_000n;

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

/** Requires an unsigned Move `u128` value. */
export function requireU128(name: string, value: bigint): U128 {
  if (value < 0n || value > U128_MAX) {
    throw new RangeError(`${name} must be a u128`);
  }
  return value as U128;
}

/** Requires a basis-point value in the inclusive range 0 through 10,000. */
export function requireBasisPoints(name: string, value: bigint): U64 {
  if (value < 0n || value > BASIS_POINTS_DENOMINATOR) {
    throw new RangeError(
      `${name} must be between 0 and 10,000 basis points`,
    );
  }
  return value as U64;
}

/** Adds two values and requires the result to remain a Move `u64`. */
export function checkedAddU64(
  name: string,
  left: bigint,
  right: bigint,
): U64 {
  return requireU64(name, left + right);
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
