import assert from "node:assert/strict";
import test from "node:test";

import type { AllocationPlan } from "../src/launchpad/allocation.ts";
import { addProtocolAllocation } from "../src/launchpad/allocation.ts";
import { deriveLaunchEconomics } from "../src/launchpad/economics.ts";

const liquidityOnly = (curveBps: bigint): AllocationPlan => ({
  curveMemeBps: curveBps,
  lpMemeBps: 10_000n - curveBps,
  lpQuoteBps: 10_000n,
  recipients: [],
});

test("derives the complete worked SUI outcome", () => {
  assert.deepEqual(
    deriveLaunchEconomics({
      atomicSupply: 1_000_000_000_000_000_000n,
      allocationPlan: liquidityOnly(8_000n),
      virtualQuote: 1_000_000_000_000n,
      graduationTarget: 3_000_000_000_000n,
    }),
    {
      curveMeme: 800_000_000_000_000_000n,
      liquidityMeme: 200_000_000_000_000_000n,
      liquidityQuote: 3_000_000_000_000n,
      allocatedQuote: 0n,
      terminalCurveMeme: 200_000_000_000_000_000n,
      curveMemeReleased: 600_000_000_000_000_000n,
      openingValuation: 1_250_000_000_000n,
      curveTerminalValuation: 20_000_000_000_000n,
      dexOpeningValuation: 15_000_000_000_000n,
    },
  );
});

test("pays Blast its ceiling before the liquidity handoff", () => {
  const economics = deriveLaunchEconomics({
    atomicSupply: 1_000_000_000_000_000_000n,
    allocationPlan: addProtocolAllocation(
      {
        curveMemeBps: 8_000n,
        lpMemeBps: 1_999n,
        lpQuoteBps: 9_900n,
        recipients: [],
      },
      { destination: "0xb", memeBps: 1n, quoteBps: 100n },
    ),
    virtualQuote: 1_000_000_000_000n,
    graduationTarget: 3_000_000_000_001n,
  });
  // Blast Quote = ceil(3_000_000_000_001 * 100 / 10_000) = 30_000_000_001.
  assert.equal(economics.allocatedQuote, 30_000_000_001n);
  assert.equal(economics.liquidityQuote, 2_970_000_000_000n);
  assert.equal(economics.liquidityMeme, 199_900_000_000_000_000n);
});

test("rounds terminal Meme up and valuations down on inexact division", () => {
  // R = ceil(7 * 3 / 8) = 3; valuations floor 30/7, 80/3, and 50/3.
  assert.deepEqual(
    deriveLaunchEconomics({
      atomicSupply: 10n,
      allocationPlan: liquidityOnly(7_000n),
      virtualQuote: 3n,
      graduationTarget: 5n,
    }),
    {
      curveMeme: 7n,
      liquidityMeme: 3n,
      liquidityQuote: 5n,
      allocatedQuote: 0n,
      terminalCurveMeme: 3n,
      curveMemeReleased: 4n,
      openingValuation: 4n,
      curveTerminalValuation: 26n,
      dexOpeningValuation: 16n,
    },
  );
});

test("rejects a plan whose liquidity handoff rounds to zero", () => {
  assert.throws(
    () =>
      deriveLaunchEconomics({
        atomicSupply: 10n,
        allocationPlan: liquidityOnly(9_999n),
        virtualQuote: 1n,
        graduationTarget: 1n,
      }),
    /liquidityMeme must be a positive u64/,
  );
});

test("rejects a non-positive curve input", () => {
  assert.throws(
    () =>
      deriveLaunchEconomics({
        atomicSupply: 10n,
        allocationPlan: liquidityOnly(7_000n),
        virtualQuote: 0n,
        graduationTarget: 1n,
      }),
    /virtualQuote must be a positive u64/,
  );
});
