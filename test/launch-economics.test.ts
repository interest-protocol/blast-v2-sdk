import assert from "node:assert/strict";
import test from "node:test";

import { deriveLaunchEconomics } from "../src/launch-economics.ts";

test("derives the complete worked SUI outcome", () => {
  assert.deepEqual(
    deriveLaunchEconomics({
      initialMemeSupply: 1_000_000_000_000_000_000n,
      curveMemeInventory: 800_000_000_000_000_000n,
      poolMemeProvision: 200_000_000_000_000_000n,
      virtualQuote: 1_000_000_000_000n,
      migrationQuoteTarget: 3_000_000_000_000n,
      quoteMigrationFeeBps: 100n,
    }),
    {
      terminalCurveMeme: 200_000_000_000_000_000n,
      curveMemeReleased: 600_000_000_000_000_000n,
      quoteMigrationFee: 30_000_000_000n,
      netQuote: 2_970_000_000_000n,
      openingValuation: 1_250_000_000_000n,
      curveTerminalValuation: 20_000_000_000_000n,
      dexOpeningValuation: 14_850_000_000_000n,
    },
  );
});

test("shows that a 1,000 SUI opening and 40% release derive a 4,000 SUI endpoint", () => {
  assert.deepEqual(
    deriveLaunchEconomics({
      initialMemeSupply: 1_000_000_000_000_000_000n,
      curveMemeInventory: 800_000_000_000_000_000n,
      poolMemeProvision: 200_000_000_000_000_000n,
      virtualQuote: 800_000_000_000n,
      migrationQuoteTarget: 800_000_000_000n,
      quoteMigrationFeeBps: 0n,
    }),
    {
      terminalCurveMeme: 400_000_000_000_000_000n,
      curveMemeReleased: 400_000_000_000_000_000n,
      quoteMigrationFee: 0n,
      netQuote: 800_000_000_000n,
      openingValuation: 1_000_000_000_000n,
      curveTerminalValuation: 4_000_000_000_000n,
      dexOpeningValuation: 4_000_000_000_000n,
    },
  );
});

test("rounds terminal Meme and the fee up and valuations down on inexact division", () => {
  // R = ceil(7 * 3 / 8) = 3, M = ceil(5 * 1 / 10_000) = 1, and each valuation
  // floors its exact rational value (30/7, 80/3, 40/2).
  assert.deepEqual(
    deriveLaunchEconomics({
      initialMemeSupply: 10n,
      curveMemeInventory: 7n,
      poolMemeProvision: 2n,
      virtualQuote: 3n,
      migrationQuoteTarget: 5n,
      quoteMigrationFeeBps: 1n,
    }),
    {
      terminalCurveMeme: 3n,
      curveMemeReleased: 4n,
      quoteMigrationFee: 1n,
      netQuote: 4n,
      openingValuation: 4n,
      curveTerminalValuation: 26n,
      dexOpeningValuation: 20n,
    },
  );
});

test("rejects an impossible Meme partition", () => {
  assert.throws(
    () =>
      deriveLaunchEconomics({
        initialMemeSupply: 10n,
        curveMemeInventory: 8n,
        poolMemeProvision: 3n,
        virtualQuote: 1n,
        migrationQuoteTarget: 1n,
        quoteMigrationFeeBps: 0n,
      }),
    /cannot exceed initialMemeSupply/,
  );
});

test("rejects a fee above 10,000 basis points", () => {
  assert.throws(
    () =>
      deriveLaunchEconomics({
        initialMemeSupply: 10n,
        curveMemeInventory: 7n,
        poolMemeProvision: 2n,
        virtualQuote: 1n,
        migrationQuoteTarget: 1n,
        quoteMigrationFeeBps: 10_001n,
      }),
    /between 0 and 10,000/,
  );
});

test("rejects a non-positive curve input", () => {
  assert.throws(
    () =>
      deriveLaunchEconomics({
        initialMemeSupply: 10n,
        curveMemeInventory: 7n,
        poolMemeProvision: 2n,
        virtualQuote: 0n,
        migrationQuoteTarget: 1n,
        quoteMigrationFeeBps: 0n,
      }),
    /virtualQuote must be positive/,
  );
});
