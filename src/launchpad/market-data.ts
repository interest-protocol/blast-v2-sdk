import { BASIS_POINTS_DENOMINATOR, requireU64 } from "../lib/integers.ts";
import type { LaunchLifecycle } from "./state.ts";
import { memeAtomicSupply } from "./template.ts";

/**
 * Display economics shared with the blast-infra indexer and checked against
 * its pinned `market-data.json` vectors. Contract objects and completed events
 * stay authoritative; these are exact `bigint` derivations from them.
 */

/**
 * An exact price in Quote atoms per Meme atom, reduced to lowest terms with a
 * positive denominator.
 */
export type ExactPrice = { numerator: bigint; denominator: bigint };

/** Digits kept after the point by `formatPrice`, truncating toward zero. */
export const PRICE_FRACTION_DIGITS = 36;

/**
 * The curve's spot price `(virtualQuote + realQuoteReserve) / memeReserve`, in
 * Quote atoms per Meme atom, exact. Null when the Meme reserve is empty. Inputs
 * are non-negative integers of any size, like the shared vectors.
 */
export function curvePrice(reserves: {
  virtualQuote: bigint;
  realQuoteReserve: bigint;
  memeReserve: bigint;
}): ExactPrice | null {
  const virtualQuote = requireAtoms("virtualQuote", reserves.virtualQuote);
  const realQuote = requireAtoms("realQuoteReserve", reserves.realQuoteReserve);
  const memeReserve = requireAtoms("memeReserve", reserves.memeReserve);
  if (memeReserve === 0n) return null;
  return reduce(virtualQuote + realQuote, memeReserve);
}

/**
 * The canonical price string: the exact ratio truncated toward zero at 36
 * fractional digits, with no exponent, no trailing fractional zeros, and at
 * least one digit before the point.
 */
export function formatPrice(price: ExactPrice): string {
  const { numerator, denominator } = requirePrice(price);
  const whole = numerator / denominator;
  const fraction =
    ((numerator % denominator) * 10n ** BigInt(PRICE_FRACTION_DIGITS)) /
    denominator;
  const digits = fraction
    .toString()
    .padStart(PRICE_FRACTION_DIGITS, "0")
    .replace(/0+$/, "");
  return digits === "" ? whole.toString() : `${whole}.${digits}`;
}

/** `numerator/denominator` in lowest terms, e.g. `3/725000` or `2/1`. */
export function formatPriceRational(price: ExactPrice): string {
  const { numerator, denominator } = requirePrice(price);
  return `${numerator}/${denominator}`;
}

/** Parses `numerator/denominator` and reduces it. */
export function parsePriceRational(value: string): ExactPrice {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new RangeError(`invalid price ratio ${value}`);
  return requirePrice(reduce(BigInt(match[1]!), BigInt(match[2]!)));
}

/**
 * What leaves or enters a Meme's live supply, in Meme atoms. `balance0x0` is
 * Meme held by `0x0`, which is burned in either supply mode and is no holder.
 */
export type LiveSupplyState = {
  currencySupply: bigint;
  /** Running total of `Sold.pending_burn` until migration disposes it. */
  pendingBurnTotal: bigint;
  balance0x0: bigint;
};

export type LiveSupplyChange =
  /** `launch_ticket::new` mints the whole supply once. */
  | { kind: "intake"; decimals: number }
  /** `Sold.pending_burn`: the sell's delta joins the pending burn. */
  | { kind: "sell_burn"; pendingBurnDelta: bigint }
  /**
   * `Migrated`: the pending burn and the unsold reserve are disposed. A fixed
   * supply sends them to `0x0`; a burn-only supply burns them, and
   * `total_supply_after` is the currency supply afterward.
   */
  | {
      kind: "migration";
      supplyMode: "fixed" | "burn_only";
      disposedMeme: bigint;
      totalSupplyAfter: bigint;
    }
  /** `coin_registry::burn` emits no event; read the supply from `Currency`. */
  | { kind: "user_burn"; currencySupplyAfter: bigint }
  | { kind: "transfer_to_0x0"; balance0x0Delta: bigint };

/** `currency_supply - pending_burn_total - balance_0x0`, in Meme atoms. */
export function liveSupply(state: LiveSupplyState): bigint {
  const live = state.currencySupply - state.pendingBurnTotal - state.balance0x0;
  if (live < 0n) throw new RangeError("live supply cannot be negative");
  return live;
}

/** Applies one supply fact; `state` is null only before intake. */
export function applyLiveSupplyChange(
  state: LiveSupplyState | null,
  change: LiveSupplyChange,
): LiveSupplyState {
  if (change.kind === "intake") {
    return {
      currencySupply: memeAtomicSupply(change.decimals),
      pendingBurnTotal: 0n,
      balance0x0: 0n,
    };
  }
  if (state === null) {
    throw new RangeError("a supply change cannot come before intake");
  }
  switch (change.kind) {
    case "sell_burn":
      return {
        ...state,
        pendingBurnTotal:
          state.pendingBurnTotal +
          requireU64("pendingBurnDelta", change.pendingBurnDelta),
      };
    case "migration":
      return applyMigration(state, change);
    case "user_burn":
      return {
        ...state,
        currencySupply: requireU64(
          "currencySupplyAfter",
          change.currencySupplyAfter,
        ),
      };
    case "transfer_to_0x0":
      return {
        ...state,
        balance0x0:
          state.balance0x0 +
          requireU64("balance0x0Delta", change.balance0x0Delta),
      };
  }
}

/**
 * `floor(liveSupply * price)` in Quote atoms, from the exact ratio rather than
 * its truncated string. Null without a price.
 */
export function marketCap(
  liveSupplyAtoms: bigint,
  price: ExactPrice | null,
): bigint | null {
  if (price === null) return null;
  const { numerator, denominator } = requirePrice(price);
  if (liveSupplyAtoms < 0n) throw new RangeError("live supply is negative");
  return (liveSupplyAtoms * numerator) / denominator;
}

/**
 * Curve progress toward graduation in basis points: `floor(real * 10,000 /
 * target)`, capped at 10,000, and 10,000 once migration-ready or migrated (a
 * migrated launch's reserve is zero).
 */
export function launchProgressBps(input: {
  realQuoteReserve: bigint;
  graduationTarget: bigint;
  lifecycle: LaunchLifecycle;
}): bigint {
  if (input.lifecycle === "MigrationReady" || input.lifecycle === "Migrated") {
    return BASIS_POINTS_DENOMINATOR;
  }
  const target = requireU64("graduationTarget", input.graduationTarget);
  if (target === 0n) throw new RangeError("graduationTarget must be positive");
  const progress =
    (requireU64("realQuoteReserve", input.realQuoteReserve) *
      BASIS_POINTS_DENOMINATOR) /
    target;
  return progress > BASIS_POINTS_DENOMINATOR
    ? BASIS_POINTS_DENOMINATOR
    : progress;
}

function applyMigration(
  state: LiveSupplyState,
  change: Extract<LiveSupplyChange, { kind: "migration" }>,
): LiveSupplyState {
  const disposed = requireU64("disposedMeme", change.disposedMeme);
  const after = requireU64("totalSupplyAfter", change.totalSupplyAfter);
  if (disposed < state.pendingBurnTotal) {
    throw new RangeError("the disposal must include the pending burn");
  }
  const expected =
    change.supplyMode === "fixed"
      ? state.currencySupply
      : state.currencySupply - disposed;
  if (after !== expected) {
    throw new RangeError(
      `total supply after migration must be ${expected} in ${change.supplyMode} mode`,
    );
  }
  return change.supplyMode === "fixed"
    ? {
        currencySupply: after,
        pendingBurnTotal: 0n,
        balance0x0: state.balance0x0 + disposed,
      }
    : {
        currencySupply: after,
        pendingBurnTotal: 0n,
        balance0x0: state.balance0x0,
      };
}

function requireAtoms(name: string, value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function reduce(numerator: bigint, denominator: bigint): ExactPrice {
  if (denominator <= 0n) {
    throw new RangeError("a price needs a positive denominator");
  }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function requirePrice(price: ExactPrice): ExactPrice {
  if (price.denominator <= 0n || price.numerator < 0n) {
    throw new RangeError("a price needs a positive denominator");
  }
  return price;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
