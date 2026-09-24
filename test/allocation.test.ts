import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { AllocationPlan, FeeSplit } from "../src/launchpad/allocation.ts";
import {
  addProtocolAllocation,
  allocationPlanBcs,
  apportionFeeSplit,
  apportionMeme,
  apportionQuote,
  feeSplitBcs,
  normalizeAllocationPlan,
  normalizeFeeSplit,
  previewFeeCollection,
  requireCompletePlan,
} from "../src/launchpad/allocation.ts";

const U64_MAX = (1n << 64n) - 1n;

/** A finalized plan: Blast first with `protocol` of both assets, then the pool. */
function plan(protocol: bigint, liquidity: bigint): AllocationPlan {
  return addProtocolAllocation(
    {
      curveMemeBps: 10_000n - protocol - liquidity,
      lpMemeBps: liquidity,
      lpQuoteBps: 10_000n - protocol,
      recipients: [],
    },
    { destination: "0x1", memeBps: protocol, quoteBps: protocol },
  );
}

function split(
  creatorBps: bigint,
  autoLpBps: bigint,
  rewardsBps: bigint,
  burnBps: bigint,
  recipients: FeeSplit["recipients"] = [],
): FeeSplit {
  return normalizeFeeSplit({
    creatorBps,
    autoLpBps,
    rewardsBps,
    burnBps,
    recipients,
  });
}

test("rounds Blast's allocation up and the rest by largest remainder", () => {
  assert.deepEqual(apportionMeme(plan(500n, 2_000n), 1_000_000_000_000_000n), {
    curve: 750_000_000_000_000n,
    lp: 200_000_000_000_000n,
    recipients: [50_000_000_000_000n],
  });
  // Curve 4,000, pool 4,000, Blast 2,000: Blast takes its ceiling first.
  const tied = plan(2_000n, 4_000n);
  assert.deepEqual(apportionMeme(tied, 1n), {
    curve: 0n,
    lp: 0n,
    recipients: [1n],
  });
  assert.deepEqual(apportionMeme(tied, 2n), {
    curve: 1n,
    lp: 0n,
    recipients: [1n],
  });
  assert.deepEqual(apportionMeme(tied, 3n), {
    curve: 1n,
    lp: 1n,
    recipients: [1n],
  });
  assert.deepEqual(apportionQuote(tied, 1n), { lp: 0n, recipients: [1n] });
  // 7 over 5,714 / 2,857 / 1,429: Blast ceil(1.0003) = 2, floors 3 and 1,
  // and the leftover atom goes to the pool's 9,999 remainder.
  assert.deepEqual(apportionMeme(plan(1_429n, 2_857n), 7n), {
    curve: 3n,
    lp: 2n,
    recipients: [2n],
  });
  // Later recipients are not rounded up.
  const shared = addProtocolAllocation(
    {
      curveMemeBps: 5_000n,
      lpMemeBps: 4_000n,
      lpQuoteBps: 9_000n,
      recipients: [{ destination: "0xc", memeBps: 500n, quoteBps: 500n }],
    },
    { destination: "0xb", memeBps: 500n, quoteBps: 500n },
  );
  assert.deepEqual(apportionQuote(shared, 1n), {
    lp: 0n,
    recipients: [1n, 0n],
  });
  assert.deepEqual(apportionQuote(shared, 3n), {
    lp: 2n,
    recipients: [1n, 0n],
  });
});

test("conserves both assets at the u64 maximum", () => {
  const maximum = plan(1_000n, 8_999n);
  const meme = apportionMeme(maximum, U64_MAX);
  const quote = apportionQuote(maximum, U64_MAX);
  assert.equal(
    meme.recipients.reduce((sum, amount) => sum + amount, meme.curve + meme.lp),
    U64_MAX,
  );
  assert.equal(
    quote.recipients.reduce((sum, amount) => sum + amount, quote.lp),
    U64_MAX,
  );
});

test("adds Blast first and checks both sums like allocation::add_protocol", () => {
  const creator = normalizeAllocationPlan({
    curveMemeBps: 7_000n,
    lpMemeBps: 2_000n,
    lpQuoteBps: 9_000n,
    recipients: [{ destination: "0xc", memeBps: 500n, quoteBps: 0n }],
  });
  const complete = addProtocolAllocation(creator, {
    destination: "0xb",
    memeBps: 500n,
    quoteBps: 1_000n,
  });
  assert.deepEqual(
    complete.recipients.map(({ destination }) => destination),
    [normalizeSuiAddress("0xb"), normalizeSuiAddress("0xc")],
  );
  assert.deepEqual(requireCompletePlan(complete), complete);
  assert.throws(
    () =>
      addProtocolAllocation(creator, {
        destination: "0xb",
        memeBps: 500n,
        quoteBps: 500n,
      }),
    /sum to 10,000/,
  );
  assert.throws(
    () =>
      normalizeAllocationPlan({
        ...creator,
        recipients: Array.from({ length: 16 }, (_, index) => ({
          destination: `0x${(index + 1).toString(16)}`,
          memeBps: 0n,
          quoteBps: 0n,
        })),
      }),
    /at most fifteen/,
  );
});

test("matches the Move fee-split apportionment vectors", () => {
  const fifths = split(2_000n, 2_000n, 2_000n, 2_000n, [
    { destination: "0xa", bps: 2_000n },
  ]);
  for (let total = 0n; total < 33n; total++) {
    assert.deepEqual(apportionFeeSplit(fifths, total), {
      creator: (total + 4n) / 5n,
      autoLp: (total + 3n) / 5n,
      rewards: (total + 2n) / 5n,
      burn: (total + 1n) / 5n,
      recipients: [total / 5n],
    });
  }
  // Move `a_larger_total_can_pay_a_floored_part_one_unit_less`.
  const floored = split(4_700n, 4_200n, 0n, 0n, [
    { destination: "0xa", bps: 1_100n },
  ]);
  assert.deepEqual(apportionFeeSplit(floored, 23n), {
    creator: 11n,
    autoLp: 10n,
    rewards: 0n,
    burn: 0n,
    recipients: [2n],
  });
  const routes = split(0n, 0n, 0n, 0n, [
    { destination: "0x7", bps: 6_000n },
    { destination: "0x3", bps: 1_000n },
    { destination: "0x9", bps: 3_000n },
  ]);
  assert.deepEqual(apportionFeeSplit(routes, 3n).recipients, [2n, 0n, 1n]);
  assert.deepEqual(apportionFeeSplit(routes, 10n).recipients, [6n, 1n, 3n]);
});

test("previews one collection with Blast's share rounded up", () => {
  const preview = previewFeeCollection({
    grossMeme: 11n,
    grossQuote: 0n,
    memeShareBps: 1_000n,
    quoteShareBps: 1_000n,
    feeSplit: split(0n, 0n, 0n, 0n, [
      { destination: "0x3", bps: 5_000n },
      { destination: "0x7", bps: 5_000n },
    ]),
  });
  assert.equal(preview.protocolMeme, 2n);
  assert.deepEqual(preview.meme.recipients, [5n, 4n]);
  assert.equal(preview.protocolQuote, 0n);
});

test("keeps recipient order like the Move constructors and round-trips BCS", () => {
  const unordered = normalizeFeeSplit({
    creatorBps: 5_000n,
    autoLpBps: 0n,
    rewardsBps: 0n,
    burnBps: 0n,
    recipients: [
      { destination: "0xb", bps: 2_500n },
      { destination: "0xa", bps: 0n },
      { destination: "0xc", bps: 2_500n },
    ],
  });
  assert.deepEqual(
    unordered.recipients.map(({ destination }) => destination),
    [
      normalizeSuiAddress("0xb"),
      normalizeSuiAddress("0xa"),
      normalizeSuiAddress("0xc"),
    ],
  );
  assert.deepEqual(
    feeSplitBcs.parse(feeSplitBcs.serialize(unordered).toBytes()),
    unordered,
  );
  const complete = plan(500n, 2_000n);
  assert.deepEqual(
    allocationPlanBcs.parse(allocationPlanBcs.serialize(complete).toBytes()),
    complete,
  );
});

test("rejects plans and splits the Move constructors abort on", () => {
  assert.throws(() => split(2_500n, 2_500n, 2_500n, 0n), /sum to 10,000/);
  assert.throws(
    () =>
      split(
        0n,
        0n,
        9_983n,
        0n,
        Array.from({ length: 17 }, (_, index) => ({
          destination: `0x${(index + 1).toString(16)}`,
          bps: 1n,
        })),
      ),
    /sixteen recipients/,
  );
  assert.throws(
    () =>
      split(0n, 0n, 0n, 0n, [
        { destination: "0xa", bps: 5_000n },
        { destination: "0xa", bps: 5_000n },
      ]),
    /distinct/,
  );
  assert.throws(
    () => split(0n, 0n, 0n, 0n, [{ destination: "0x0", bps: 10_000n }]),
    /nonzero Sui address/,
  );
  assert.throws(
    () =>
      normalizeAllocationPlan({
        curveMemeBps: 0n,
        lpMemeBps: 10_000n,
        lpQuoteBps: 10_000n,
        recipients: [],
      }),
    /positive shares/,
  );
  assert.throws(
    () =>
      normalizeAllocationPlan({
        curveMemeBps: 5_000n,
        lpMemeBps: 5_000n,
        lpQuoteBps: 10_000n,
        recipients: [{ destination: "0x0", memeBps: 0n, quoteBps: 0n }],
      }),
    /nonzero Sui address/,
  );
});
