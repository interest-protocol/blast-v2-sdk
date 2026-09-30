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

/** A finalized plan: Blast's `protocol` of both assets, then the pool. */
function plan(protocol: bigint, liquidity: bigint): AllocationPlan {
  return addProtocolAllocation(
    {
      curveMemeBps: 10_000n - protocol - liquidity,
      lpMemeBps: liquidity,
      lpQuoteBps: 10_000n - protocol,
      recipients: [],
    },
    { memeBps: protocol, quoteBps: protocol },
  );
}

/**
 * Mirrors the Move tests' `shaped`: Meme `[curve, lp, blast, ...]` and Quote
 * `[lp, blast, ...]`, recipients paid to `0x2` onward.
 */
function shaped(meme: bigint[], quote: bigint[]): AllocationPlan {
  const [curveMemeBps = 0n, lpMemeBps = 0n, memeBps = 0n, ...memeShares] = meme;
  const [lpQuoteBps = 0n, quoteBps = 0n, ...quoteShares] = quote;
  return addProtocolAllocation(
    {
      curveMemeBps,
      lpMemeBps,
      lpQuoteBps,
      recipients: memeShares.map((share, index) => ({
        destination: `0x${(index + 2).toString(16)}`,
        memeBps: share,
        quoteBps: quoteShares[index] ?? 0n,
      })),
    },
    { memeBps, quoteBps },
  );
}

function memeAmounts(allocation: AllocationPlan, supply: bigint): bigint[] {
  const { curve, lp, protocol, recipients } = apportionMeme(allocation, supply);
  return [curve, lp, protocol, ...recipients];
}

function quoteAmounts(allocation: AllocationPlan, reserve: bigint): bigint[] {
  const { lp, protocol, recipients } = apportionQuote(allocation, reserve);
  return [lp, protocol, ...recipients];
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

test("matches the Move allocation apportionment vectors", () => {
  const smallest = shaped([1n, 1n, 9_998n], [1n, 9_999n]);
  assert.deepEqual(memeAmounts(smallest, 10_000n), [1n, 1n, 9_998n]);
  assert.deepEqual(quoteAmounts(smallest, 10_000n), [1n, 9_999n]);
  const unpaid = shaped([7_000n, 2_000n, 1_000n, 0n], [9_000n, 1_000n, 0n]);
  assert.deepEqual(memeAmounts(unpaid, 999n), [699n, 200n, 100n, 0n]);
  assert.deepEqual(quoteAmounts(unpaid, 999n), [899n, 100n, 0n]);
  const ceiling = shaped([7_000n, 2_000n, 500n, 500n], [9_000n, 500n, 500n]);
  assert.deepEqual(memeAmounts(ceiling, 0n), [0n, 0n, 0n, 0n]);
  assert.deepEqual(quoteAmounts(ceiling, 0n), [0n, 0n, 0n]);
  assert.deepEqual(memeAmounts(ceiling, 101n), [70n, 20n, 6n, 5n]);
  assert.deepEqual(quoteAmounts(ceiling, 101n), [90n, 6n, 5n]);
  const onePoint = shaped([9_998n, 1n, 1n], [1n, 9_999n]);
  assert.deepEqual(quoteAmounts(onePoint, 1n), [0n, 1n]);
  assert.deepEqual(quoteAmounts(onePoint, 9_999n), [0n, 9_999n]);
  assert.deepEqual(quoteAmounts(onePoint, 10_000n), [1n, 9_999n]);
  assert.deepEqual(quoteAmounts(onePoint, 10_001n), [1n, 10_000n]);
  assert.throws(
    () => shaped([8_000n, 2_000n, 1n], [10_000n, 0n]),
    /sum to 10,000/,
  );
  assert.throws(
    () => shaped([8_000n, 2_000n, 0n], [10_000n, 1n]),
    /sum to 10,000/,
  );
});

test("rounds Blast's allocation up and the rest by largest remainder", () => {
  assert.deepEqual(apportionMeme(plan(500n, 2_000n), 1_000_000_000_000_000n), {
    curve: 750_000_000_000_000n,
    lp: 200_000_000_000_000n,
    protocol: 50_000_000_000_000n,
    recipients: [],
  });
  // Curve 4,000, pool 4,000, Blast 2,000: Blast takes its ceiling first.
  const tied = plan(2_000n, 4_000n);
  assert.deepEqual(memeAmounts(tied, 1n), [0n, 0n, 1n]);
  assert.deepEqual(memeAmounts(tied, 2n), [1n, 0n, 1n]);
  assert.deepEqual(memeAmounts(tied, 3n), [1n, 1n, 1n]);
  assert.deepEqual(quoteAmounts(tied, 1n), [0n, 1n]);
  // 7 over 5,714 / 2,857 / 1,429: Blast ceil(1.0003) = 2, floors 3 and 1,
  // and the leftover atom goes to the pool's 9,999 remainder.
  assert.deepEqual(memeAmounts(plan(1_429n, 2_857n), 7n), [3n, 2n, 2n]);
  // Recipients are not rounded up.
  const shared = shaped([5_000n, 4_000n, 500n, 500n], [9_000n, 500n, 500n]);
  assert.deepEqual(quoteAmounts(shared, 1n), [0n, 1n, 0n]);
  assert.deepEqual(quoteAmounts(shared, 3n), [2n, 1n, 0n]);
});

test("conserves both assets at the u64 maximum", () => {
  const maximum = plan(1_000n, 8_999n);
  const sum = (amounts: bigint[]) =>
    amounts.reduce((total, amount) => total + amount, 0n);
  assert.equal(sum(memeAmounts(maximum, U64_MAX)), U64_MAX);
  assert.equal(sum(quoteAmounts(maximum, U64_MAX)), U64_MAX);
});

test("sets Blast's shares and checks both sums like allocation::add_protocol", () => {
  const creator = normalizeAllocationPlan({
    curveMemeBps: 7_000n,
    lpMemeBps: 2_000n,
    lpQuoteBps: 9_000n,
    recipients: [{ destination: "0xc", memeBps: 500n, quoteBps: 0n }],
  });
  const complete = addProtocolAllocation(creator, {
    memeBps: 500n,
    quoteBps: 1_000n,
  });
  assert.deepEqual(complete, {
    ...creator,
    protocolMemeBps: 500n,
    protocolQuoteBps: 1_000n,
  });
  assert.deepEqual(
    complete.recipients.map(({ destination }) => destination),
    [normalizeSuiAddress("0xc")],
  );
  assert.deepEqual(requireCompletePlan(complete), complete);
  assert.throws(
    () => addProtocolAllocation(creator, { memeBps: 500n, quoteBps: 500n }),
    /sum to 10,000/,
  );
  // `allocation::plan` needs positive curve and pool Meme shares only.
  assert.equal(
    normalizeAllocationPlan({ ...creator, lpQuoteBps: 0n }).lpQuoteBps,
    0n,
  );
  assert.throws(
    () => normalizeAllocationPlan({ ...creator, lpMemeBps: 0n }),
    /positive Meme shares/,
  );
  const sixteen = Array.from({ length: 16 }, (_, index) => ({
    destination: `0x${(index + 1).toString(16)}`,
    memeBps: 0n,
    quoteBps: 0n,
  }));
  assert.equal(
    normalizeAllocationPlan({ ...creator, recipients: sixteen }).recipients
      .length,
    16,
  );
  assert.throws(
    () =>
      normalizeAllocationPlan({
        ...creator,
        recipients: [
          ...sixteen,
          { destination: "0x99", memeBps: 0n, quoteBps: 0n },
        ],
      }),
    /exceeds sixteen recipients/,
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
    /positive Meme shares/,
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
