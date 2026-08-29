export const U64_MAX = (1n << 64n) - 1n;

/** Requires an unsigned Move `u64` value. */
export function requireU64(name: string, value: bigint): void {
  if (value < 0n || value > U64_MAX) {
    throw new RangeError(`${name} must be a u64`);
  }
}

/** Requires a non-zero unsigned Move `u64` value. */
export function requirePositiveU64(name: string, value: bigint): void {
  if (value <= 0n || value > U64_MAX) {
    throw new RangeError(`${name} must be a positive u64`);
  }
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
  requirePositiveU64(name, normalized);
  return normalized.toString();
}
