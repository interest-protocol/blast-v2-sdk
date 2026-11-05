import assert from "node:assert/strict";
import test from "node:test";
import type { AllocationPlan } from "@interest-protocol/blast-launchpad-sdk/allocation";
import {
  addProtocolAllocation,
  allocationPlanBcs,
  apportionMeme,
  apportionQuote,
  normalizeAllocationPlan,
  requireCompletePlan,
} from "@interest-protocol/blast-launchpad-sdk/allocation";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { LAUNCHPAD_FIXTURE_HEX } from "./fixtures/launchpad-68db57b.ts";

/** A plan recipient paid outright. */
const share = (destination: string, memeBps: bigint, quoteBps: bigint) => ({
  recipient: { destination, vestingTerms: null },
  memeBps,
  quoteBps,
});

const U64_MAX = (1n << 64n) - 1n;

/** A finalized plan: Blast's `protocol` share of both assets, then the pool. */
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
      recipients: memeShares.map((memeBps, index) =>
        share(
          `0x${(index + 2).toString(16)}`,
          memeBps,
          quoteShares[index] ?? 0n,
        ),
      ),
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
  assert.deepEqual(apportionMeme(tied, 1n), {
    curve: 0n,
    lp: 0n,
    protocol: 1n,
    recipients: [],
  });
  assert.deepEqual(apportionMeme(tied, 2n), {
    curve: 1n,
    lp: 0n,
    protocol: 1n,
    recipients: [],
  });
  assert.deepEqual(apportionMeme(tied, 3n), {
    curve: 1n,
    lp: 1n,
    protocol: 1n,
    recipients: [],
  });
  assert.deepEqual(apportionQuote(tied, 1n), {
    lp: 0n,
    protocol: 1n,
    recipients: [],
  });
  // 7 over 5,714 / 2,857 / 1,429: Blast ceil(1.0003) = 2, floors 3 and 1,
  // and the leftover atom goes to the pool's 9,999 remainder.
  assert.deepEqual(apportionMeme(plan(1_429n, 2_857n), 7n), {
    curve: 3n,
    lp: 2n,
    protocol: 2n,
    recipients: [],
  });
  // Recipients are not rounded up.
  const shared = addProtocolAllocation(
    {
      curveMemeBps: 5_000n,
      lpMemeBps: 4_000n,
      lpQuoteBps: 9_000n,
      recipients: [share("0xc", 500n, 500n)],
    },
    { memeBps: 500n, quoteBps: 500n },
  );
  assert.deepEqual(apportionQuote(shared, 1n), {
    lp: 0n,
    protocol: 1n,
    recipients: [0n],
  });
  assert.deepEqual(apportionQuote(shared, 3n), {
    lp: 2n,
    protocol: 1n,
    recipients: [0n],
  });
});

test("conserves both assets at the u64 maximum", () => {
  const maximum = plan(1_000n, 8_999n);
  const meme = apportionMeme(maximum, U64_MAX);
  const quote = apportionQuote(maximum, U64_MAX);
  assert.equal(
    meme.recipients.reduce(
      (sum, amount) => sum + amount,
      meme.curve + meme.lp + meme.protocol,
    ),
    U64_MAX,
  );
  assert.equal(
    quote.recipients.reduce(
      (sum, amount) => sum + amount,
      quote.lp + quote.protocol,
    ),
    U64_MAX,
  );
});

test("stores Blast's shares and checks both sums like allocation::add_protocol", () => {
  const creator = normalizeAllocationPlan({
    curveMemeBps: 7_000n,
    lpMemeBps: 2_000n,
    lpQuoteBps: 9_000n,
    recipients: [share("0xc", 500n, 0n)],
  });
  const complete = addProtocolAllocation(creator, {
    memeBps: 500n,
    quoteBps: 1_000n,
  });
  assert.equal(complete.protocolMemeBps, 500n);
  assert.equal(complete.protocolQuoteBps, 1_000n);
  assert.deepEqual(
    complete.recipients.map(({ recipient }) => recipient.destination),
    [normalizeSuiAddress("0xc")],
  );
  assert.deepEqual(requireCompletePlan(complete), complete);
  assert.throws(
    () => addProtocolAllocation(creator, { memeBps: 500n, quoteBps: 500n }),
    /sum to 10,000/,
  );
  // Blast no longer takes a recipient slot: sixteen recipients are accepted.
  const sixteen = Array.from({ length: 16 }, (_, index) =>
    share(`0x${(index + 1).toString(16)}`, 0n, 0n),
  );
  assert.equal(
    normalizeAllocationPlan({ ...creator, recipients: sixteen }).recipients
      .length,
    16,
  );
  assert.throws(
    () =>
      normalizeAllocationPlan({
        ...creator,
        recipients: [...sixteen, share("0x99", 0n, 0n)],
      }),
    /at most sixteen/,
  );
  assert.throws(
    () => normalizeAllocationPlan({ ...creator, lpQuoteBps: 0n }),
    /positive Quote/,
  );
  assert.throws(
    () => normalizeAllocationPlan({ ...creator, lpMemeBps: 0n }),
    /positive Meme shares/,
  );
});

test("round-trips a complete plan through BCS", () => {
  const complete = plan(500n, 2_000n);
  assert.deepEqual(
    allocationPlanBcs.parse(allocationPlanBcs.serialize(complete).toBytes()),
    complete,
  );
});

test("rejects plans the Move constructors abort on", () => {
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
  // `payout::recipient` rejects the zero address.
  assert.throws(
    () =>
      normalizeAllocationPlan({
        curveMemeBps: 5_000n,
        lpMemeBps: 5_000n,
        lpQuoteBps: 10_000n,
        recipients: [share("0x0", 0n, 0n)],
      }),
    /nonzero Sui address/,
  );
});

test("decodes a finalized plan with a vested recipient from literal contract bytes", () => {
  // `LaunchCreated.allocation_plan` of the a1a8f6c fixture.
  const bytes = Buffer.from(
    [
      "581b000000000000",
      "d007000000000000",
      "1c25000000000000",
      "ee02000000000000",
      "fa00000000000000",
      "01",
      "000000000000000000000000000000000000000000000000000000000000feed",
      "01",
      "e803000000000000",
      "d007000000000000",
      "0300000000000000",
      "fa00000000000000",
      "fa00000000000000",
    ].join(""),
    "hex",
  );
  assert.ok(
    LAUNCHPAD_FIXTURE_HEX.launchCreated.includes(bytes.toString("hex")),
  );
  const decoded = allocationPlanBcs.parse(bytes);

  assert.deepEqual(decoded, {
    curveMemeBps: 7_000n,
    lpMemeBps: 2_000n,
    lpQuoteBps: 9_500n,
    protocolMemeBps: 750n,
    protocolQuoteBps: 250n,
    recipients: [
      {
        recipient: {
          destination: normalizeSuiAddress("0xfeed"),
          vestingTerms: {
            cliffDelayMs: 1_000n,
            periodDurationMs: 2_000n,
            periods: 3n,
          },
        },
        memeBps: 250n,
        quoteBps: 250n,
      },
    ],
  });
  assert.deepEqual(requireCompletePlan(decoded), decoded);
});

test("requires positive LP Quote when constructing a plan", () => {
  const allocation = {
    curveMemeBps: 8_000n,
    lpMemeBps: 2_000n,
    lpQuoteBps: 0n,
    recipients: [],
  };
  assert.throws(() => normalizeAllocationPlan(allocation), /positive Quote/);
  assert.equal(
    normalizeAllocationPlan({ ...allocation, lpQuoteBps: 1n }).lpQuoteBps,
    1n,
  );
});
