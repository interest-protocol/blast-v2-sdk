import { bcs } from "@mysten/sui/bcs";
import { u64Bcs } from "./bcs.ts";
import type { BasisPoints } from "./integers.ts";
import {
  BASIS_POINTS_DENOMINATOR,
  mulDivUp,
  requireBasisPoints,
  requireU64,
} from "./integers.ts";

/** `blast_core::constants::max_lp_fee_bps`: Blast's largest LP-fee share of each asset. */
export const MAX_LP_FEE_BPS = 3_000n;
/** `blast_core::constants::max_routes`: the most routes one fee split holds. */
export const MAX_ROUTES = 20;
/** `blast_core::constants::max_vesting_duration_ms`: the technical bound on a schedule. */
export const MAX_VESTING_DURATION_MS = 2n ** 63n;

/** BCS layout of the positional `blast_core::bps::Bps(u64)`. */
export const bpsBcs = bcs.struct("Bps", { value: u64Bcs }).transform({
  input: (value: bigint) => ({ value: requireBps(value) }),
  output: (value) => value.value,
});

/** Mirrors `bps::new`: a rate from zero through 10,000 basis points. */
export function requireBps(value: bigint): BasisPoints {
  return requireBasisPoints("bps", value);
}

/**
 * Mirrors `bps::apply_up`: `ceil(amount * bps / 10,000)` over atomic units,
 * at most `amount`.
 */
export function applyBpsUp(amount: bigint, bps: bigint): bigint {
  return mulDivUp(
    requireU64("amount", amount),
    requireBps(bps),
    BASIS_POINTS_DENOMINATOR,
  );
}

/**
 * Mirrors `bps::apportion`: largest-remainder apportionment of `total` atoms
 * over `rates`, which must sum to exactly 10,000. The `roundedUp` part takes
 * its ceiling and every other part its floor; the leftover atoms go one each
 * to the largest remaining remainders, earlier parts first. The amounts sum
 * to `total`. Throws where the contract aborts (`EInvalidApportionment`).
 */
export function apportionBps(
  rates: readonly bigint[],
  total: bigint,
  roundedUp: number | null,
): bigint[] {
  requireU64("total", total);
  rates.forEach(requireBps);
  if (
    rates.reduce((sum, rate) => sum + rate, 0n) !== BASIS_POINTS_DENOMINATOR ||
    (roundedUp !== null &&
      !(
        Number.isInteger(roundedUp) &&
        roundedUp >= 0 &&
        roundedUp < rates.length
      ))
  ) {
    throw new RangeError(
      "apportioned rates must sum to 10,000 and name a rounded-up part inside them",
    );
  }
  const products = rates.map((rate) => total * rate);
  const amounts = products.map((product, index) =>
    index === roundedUp
      ? (product + BASIS_POINTS_DENOMINATOR - 1n) / BASIS_POINTS_DENOMINATOR
      : product / BASIS_POINTS_DENOMINATOR,
  );
  const order = products
    .map((product, index) => ({
      index,
      remainder: product % BASIS_POINTS_DENOMINATOR,
    }))
    .filter(({ index }) => index !== roundedUp)
    .sort((left, right) =>
      left.remainder === right.remainder
        ? left.index - right.index
        : left.remainder > right.remainder
          ? -1
          : 1,
    );
  const leftover = Number(total - amounts.reduce((sum, a) => sum + a, 0n));
  for (const { index } of order.slice(0, leftover)) {
    amounts[index] = (amounts[index] ?? 0n) + 1n;
  }
  return amounts;
}
