import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  LiveSupplyChange,
  LiveSupplyState,
} from "../src/launchpad/market-data.ts";
import {
  applyLiveSupplyChange,
  curvePrice,
  formatPrice,
  formatPriceRational,
  launchProgressBps,
  liveSupply,
  marketCap,
  parsePriceRational,
} from "../src/launchpad/market-data.ts";
import type { LaunchLifecycle } from "../src/launchpad/state.ts";
import {
  bluefinVenuePrice,
  bluefinVenueTrade,
} from "../src/migrators/bluefin-venue.ts";
import {
  cetusVenuePrice,
  cetusVenueTrade,
} from "../src/migrators/cetus-venue.ts";

/**
 * blast-infra's `tests/vectors/market-data.sha256`, generated from the contracts
 * branch `market-data-vectors` at 78de5e5. Updating the vectors means vendoring
 * the file and this pin together in both repositories.
 */
const MARKET_DATA_PIN =
  "1fd14d23e58b6f5901b55adbf1327b39a185ad3d77a4f415f3a56df87ce5c2d4";

type VectorCase = {
  name: string;
  kind: string;
  given: Record<string, unknown>;
  expect: Record<string, unknown>;
};

/** Parses the vendored vectors only when both the bytes and the pin file match `pin`. */
function loadPinnedVectors(
  bytes: Uint8Array,
  pinFile: string,
  pin: string,
): { cases: VectorCase[] } {
  const recorded = pinFile.trim().split(/\s+/)[0];
  if (recorded !== pin) {
    throw new Error(`vector pin file records ${recorded}, expected ${pin}`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== pin) {
    throw new Error(`vector copy hashes to ${actual}, not its pin ${pin}`);
  }
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

const bytes = readFileSync(
  new URL("./vectors/market-data.json", import.meta.url),
);
const pinFile = readFileSync(
  new URL("./vectors/market-data.sha256", import.meta.url),
  "utf8",
);
const vectors = loadPinnedVectors(bytes, pinFile, MARKET_DATA_PIN);
const casesOf = (kind: string) =>
  vectors.cases.filter((vector) => vector.kind === kind);

test("refuses a vector copy that differs from its pin", () => {
  const tampered = Uint8Array.from(bytes);
  const index = tampered.length - 2;
  tampered[index] = (tampered[index] ?? 0) ^ 1;
  assert.throws(
    () => loadPinnedVectors(tampered, pinFile, MARKET_DATA_PIN),
    /not its pin/,
  );
  assert.throws(
    () => loadPinnedVectors(bytes, `${"0".repeat(64)}\n`, MARKET_DATA_PIN),
    /pin file records/,
  );
});

test("runs every curve_price vector case", () => {
  const cases = casesOf("curve_price");
  assert.equal(cases.length, 14);
  for (const vector of cases) {
    const given = vector.given as Record<string, string>;
    const price = curvePrice({
      virtualQuote: BigInt(given.virtual_quote!),
      realQuoteReserve: BigInt(given.real_quote_reserve!),
      memeReserve: BigInt(given.meme_reserve!),
    });
    assert.deepEqual(
      {
        price: price === null ? null : formatPrice(price),
        price_exact_rational:
          price === null ? null : formatPriceRational(price),
      },
      vector.expect,
      vector.name,
    );
  }
});

test("runs every venue_price vector case through the Cetus adapter", () => {
  const cases = casesOf("venue_price");
  assert.equal(cases.length, 7);
  for (const vector of cases) {
    const price = cetusVenuePrice(
      BigInt(vector.given.sqrt_price_x64 as string),
      vector.given.meme_is_coin_a as boolean,
    );
    assert.deepEqual(
      {
        price: formatPrice(price),
        price_exact_rational: formatPriceRational(price),
      },
      vector.expect,
      vector.name,
    );
  }
});

test("runs every venue_trade vector case through the Cetus adapter", () => {
  const cases = casesOf("venue_trade");
  assert.equal(cases.length, 4);
  for (const vector of cases) {
    const given = vector.given as Record<string, string | boolean>;
    const trade = cetusVenueTrade(
      {
        atob: given.a_to_b as boolean,
        amountIn: BigInt(given.amount_in as string),
        amountOut: BigInt(given.amount_out as string),
        feeAmount: BigInt(given.fee_amount as string),
        beforeSqrtPrice: BigInt(given.before_sqrt_price as string),
        afterSqrtPrice: BigInt(given.after_sqrt_price as string),
      },
      given.meme_is_coin_a as boolean,
    );
    assert.deepEqual(
      {
        side: trade.side,
        quote_amount: trade.quoteAmount.toString(),
        meme_amount: trade.memeAmount.toString(),
        quote_fee: trade.quoteFee.toString(),
        meme_fee: trade.memeFee.toString(),
        price_before: formatPrice(trade.priceBefore),
        price_after: formatPrice(trade.priceAfter),
      },
      vector.expect,
      vector.name,
    );
  }
});

/** The cases a Bluefin pool produces: the migrators always create `Pool<Meme, Quote>`. */
const bluefinCasesOf = (kind: string) =>
  casesOf(kind).filter((vector) => vector.given.meme_is_coin_a === true);

test("runs every Meme-is-coin-A venue_price vector case through the Bluefin adapter", () => {
  const cases = bluefinCasesOf("venue_price");
  assert.equal(cases.length, 4);
  for (const vector of cases) {
    const price = bluefinVenuePrice(
      BigInt(vector.given.sqrt_price_x64 as string),
    );
    assert.deepEqual(
      {
        price: formatPrice(price),
        price_exact_rational: formatPriceRational(price),
      },
      vector.expect,
      vector.name,
    );
  }
});

test("runs every Meme-is-coin-A venue_trade vector case through the Bluefin adapter", () => {
  const cases = bluefinCasesOf("venue_trade");
  assert.equal(cases.length, 2);
  for (const vector of cases) {
    const given = vector.given as Record<string, string | boolean>;
    const trade = bluefinVenueTrade({
      a2b: given.a_to_b as boolean,
      amountIn: BigInt(given.amount_in as string),
      amountOut: BigInt(given.amount_out as string),
      fee: BigInt(given.fee_amount as string),
      beforeSqrtPrice: BigInt(given.before_sqrt_price as string),
      afterSqrtPrice: BigInt(given.after_sqrt_price as string),
    });
    assert.deepEqual(
      {
        side: trade.side,
        quote_amount: trade.quoteAmount.toString(),
        meme_amount: trade.memeAmount.toString(),
        quote_fee: trade.quoteFee.toString(),
        meme_fee: trade.memeFee.toString(),
        price_before: formatPrice(trade.priceBefore),
        price_after: formatPrice(trade.priceAfter),
      },
      vector.expect,
      vector.name,
    );
  }
});

test("runs every live_supply vector case", () => {
  const cases = casesOf("live_supply");
  assert.equal(cases.length, 11);
  for (const vector of cases) {
    const before = vector.given.before as Record<string, string> | null;
    const state: LiveSupplyState | null =
      before === null
        ? null
        : {
            currencySupply: BigInt(before.currency_supply!),
            pendingBurnTotal: BigInt(before.pending_burn_total!),
            balance0x0: BigInt(before.balance_0x0!),
          };
    const after = applyLiveSupplyChange(state, liveSupplyChange(vector));
    assert.deepEqual(
      {
        after: {
          currency_supply: after.currencySupply.toString(),
          pending_burn_total: after.pendingBurnTotal.toString(),
          balance_0x0: after.balance0x0.toString(),
        },
        live_supply: liveSupply(after).toString(),
      },
      vector.expect,
      vector.name,
    );
  }
});

test("runs every market_cap vector case", () => {
  const cases = casesOf("market_cap");
  assert.equal(cases.length, 4);
  for (const vector of cases) {
    const given = vector.given as Record<string, string | null>;
    const price =
      given.price_exact_rational === null
        ? null
        : parsePriceRational(given.price_exact_rational!);
    const cap = marketCap(BigInt(given.live_supply!), price);
    assert.deepEqual(
      { market_cap: cap === null ? null : cap.toString() },
      vector.expect,
      vector.name,
    );
  }
});

test("runs every progress vector case", () => {
  const lifecycles: Record<string, LaunchLifecycle> = {
    opening_round: "OpeningRound",
    live: "Live",
    migration_ready: "MigrationReady",
    migrated: "Migrated",
  };
  const cases = casesOf("progress");
  assert.equal(cases.length, 11);
  for (const vector of cases) {
    const given = vector.given as Record<string, string>;
    const lifecycle = lifecycles[given.lifecycle!];
    assert.ok(lifecycle, vector.name);
    assert.deepEqual(
      {
        progress_bps: Number(
          launchProgressBps({
            realQuoteReserve: BigInt(given.real_quote_reserve!),
            graduationTarget: BigInt(given.graduation_target!),
            lifecycle,
          }),
        ),
      },
      vector.expect,
      vector.name,
    );
  }
});

test("rejects live-supply transitions a launch cannot produce", () => {
  const state = {
    currencySupply: 1_000n,
    pendingBurnTotal: 10n,
    balance0x0: 0n,
  };
  assert.throws(
    () =>
      applyLiveSupplyChange(state, {
        kind: "migration",
        supplyMode: "fixed",
        disposedMeme: 5n,
        totalSupplyAfter: 1_000n,
      }),
    /disposal must include the pending burn/,
  );
  assert.throws(
    () =>
      applyLiveSupplyChange(state, {
        kind: "migration",
        supplyMode: "burn_only",
        disposedMeme: 20n,
        totalSupplyAfter: 1_000n,
      }),
    /total supply after/,
  );
  assert.throws(
    () =>
      applyLiveSupplyChange(null, { kind: "sell_burn", pendingBurnDelta: 1n }),
    /before intake/,
  );
  assert.throws(() => parsePriceRational("1/0"), /positive denominator/);
});

function liveSupplyChange(vector: VectorCase): LiveSupplyChange {
  const given = vector.given;
  const change = given.change as Record<string, string | null> | null;
  switch (given.path) {
    case "intake":
      return { kind: "intake", decimals: Number(given.decimals) };
    case "sell_burn":
      return {
        kind: "sell_burn",
        pendingBurnDelta: BigInt(change!.pending_burn_delta!),
      };
    case "migration_fixed":
    case "migration_burn_only":
      return {
        kind: "migration",
        supplyMode: given.supply_mode as "fixed" | "burn_only",
        disposedMeme: BigInt(change!.disposed_meme!),
        totalSupplyAfter: BigInt(change!.total_supply_after!),
      };
    case "user_burn":
      return {
        kind: "user_burn",
        currencySupplyAfter: BigInt(change!.currency_supply_after!),
      };
    case "transfer_to_0x0":
      return {
        kind: "transfer_to_0x0",
        balance0x0Delta: BigInt(change!.balance_0x0_delta!),
      };
    default:
      throw new Error(`unknown live_supply path ${String(given.path)}`);
  }
}
