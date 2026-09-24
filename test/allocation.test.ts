import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { AllocationPlan, FeeSplit } from "../src/launchpad/allocation.ts";
import {
  allocationPlanBcs,
  apportionFeeSplit,
  apportionMeme,
  apportionQuote,
  feeSplitBcs,
  liquidityChannelId,
  normalizeAllocationPlan,
  normalizeFeeSplit,
  previewFeeCollection,
} from "../src/launchpad/allocation.ts";

const U64_MAX = (1n << 64n) - 1n;

/** Mirrors `graduation_tests::plan`: Liquidity is channel 2, Protocol channel 1. */
function plan(protocol: bigint, liquidity: bigint): AllocationPlan {
  const channels: AllocationPlan["channels"] = [
    { channelId: 2n, role: "Liquidity", destination: "0x2" },
  ];
  const meme = [
    { channelId: 0n, bps: 10_000n - protocol - liquidity },
    { channelId: 2n, bps: liquidity },
  ];
  const quote = [{ channelId: 2n, bps: 10_000n - protocol }];
  if (protocol > 0n) {
    channels.push({ channelId: 1n, role: "Protocol", destination: "0x1" });
    meme.push({ channelId: 1n, bps: protocol });
    quote.push({ channelId: 1n, bps: protocol });
  }
  return normalizeAllocationPlan({ channels, meme, quote });
}

function split(
  creatorBps: bigint,
  autoLpBps: bigint,
  rewardsBps: bigint,
  recipients: FeeSplit["recipients"] = [],
): FeeSplit {
  return normalizeFeeSplit({ creatorBps, autoLpBps, rewardsBps, recipients });
}

test("matches the Move graduation apportionment vectors", () => {
  assert.deepEqual(apportionMeme(plan(500n, 2_000n), 1_000_000_000_000_000n), [
    750_000_000_000_000n,
    50_000_000_000_000n,
    200_000_000_000_000n,
  ]);
  const protectedPlan = plan(2_000n, 4_000n);
  assert.deepEqual(apportionMeme(protectedPlan, 1n), [0n, 1n, 0n]);
  assert.deepEqual(apportionMeme(protectedPlan, 2n), [1n, 1n, 0n]);
  assert.deepEqual(apportionMeme(protectedPlan, 3n), [1n, 1n, 1n]);
  assert.deepEqual(apportionQuote(protectedPlan, 1n), [1n, 0n]);
  assert.deepEqual(apportionMeme(plan(1_429n, 2_857n), 7n), [3n, 2n, 2n]);
  assert.deepEqual(apportionMeme(plan(1_000n, 4_500n), 11n), [5n, 2n, 4n]);
  assert.equal(liquidityChannelId(protectedPlan), 2n);
});

test("conserves both assets at the u64 maximum", () => {
  const maximum = plan(1_000n, 8_999n);
  for (const amounts of [
    apportionMeme(maximum, U64_MAX),
    apportionQuote(maximum, U64_MAX),
  ]) {
    assert.equal(
      amounts.reduce((sum, amount) => sum + amount, 0n),
      U64_MAX,
    );
  }
});

test("matches the Move fee-split apportionment vectors", () => {
  const quarters = split(2_500n, 2_500n, 2_500n, [
    { destination: "0xa", bps: 2_500n },
  ]);
  for (let total = 0n; total < 33n; total++) {
    assert.deepEqual(apportionFeeSplit(quarters, total), {
      creator: (total + 3n) / 4n,
      autoLp: (total + 2n) / 4n,
      rewards: (total + 1n) / 4n,
      recipients: [total / 4n],
    });
  }
  const routes = split(0n, 0n, 0n, [
    { destination: "0x7", bps: 6_000n },
    { destination: "0x3", bps: 1_000n },
    { destination: "0x9", bps: 3_000n },
  ]);
  assert.deepEqual(apportionFeeSplit(routes, 3n).recipients, [0n, 2n, 1n]);
  assert.deepEqual(apportionFeeSplit(routes, 10n).recipients, [1n, 6n, 3n]);
});

test("previews one collection with Blast's share rounded up", () => {
  const preview = previewFeeCollection({
    grossMeme: 11n,
    grossQuote: 0n,
    memeShareBps: 1_000n,
    quoteShareBps: 1_000n,
    feeSplit: split(0n, 0n, 0n, [
      { destination: "0x3", bps: 5_000n },
      { destination: "0x7", bps: 5_000n },
    ]),
  });
  assert.equal(preview.protocolMeme, 2n);
  assert.deepEqual(preview.meme.recipients, [5n, 4n]);
  assert.equal(preview.protocolQuote, 0n);
});

test("canonicalizes like the Move constructors and round-trips BCS", () => {
  const unordered = normalizeFeeSplit({
    creatorBps: 5_000n,
    autoLpBps: 0n,
    rewardsBps: 0n,
    recipients: [
      { destination: "0xb", bps: 2_500n },
      { destination: "0xa", bps: 2_500n },
    ],
  });
  assert.deepEqual(
    unordered.recipients.map(({ destination }) => destination),
    [normalizeSuiAddress("0xa"), normalizeSuiAddress("0xb")],
  );
  assert.deepEqual(
    feeSplitBcs.parse(feeSplitBcs.serialize(unordered).toBytes()),
    unordered,
  );
  const reversed = normalizeAllocationPlan({
    channels: [...plan(500n, 2_000n).channels].reverse(),
    meme: [...plan(500n, 2_000n).meme].reverse(),
    quote: [...plan(500n, 2_000n).quote].reverse(),
  });
  assert.deepEqual(reversed, plan(500n, 2_000n));
  assert.deepEqual(
    allocationPlanBcs.parse(allocationPlanBcs.serialize(reversed).toBytes()),
    reversed,
  );
});

test("rejects plans and splits the Move constructors abort on", () => {
  assert.throws(() => split(2_500n, 2_500n, 2_500n), /sum to 10,000/);
  assert.throws(
    () =>
      split(0n, 0n, 0n, [
        { destination: "0xa", bps: 5_000n },
        { destination: "0xa", bps: 5_000n },
      ]),
    /distinct/,
  );
  assert.throws(
    () =>
      split(
        0n,
        0n,
        9_983n,
        Array.from({ length: 17 }, (_, index) => ({
          destination: `0x${(index + 1).toString(16)}`,
          bps: 1n,
        })),
      ),
    /sixteen recipients/,
  );
  assert.throws(
    () =>
      normalizeAllocationPlan({
        channels: [{ channelId: 1n, role: "External", destination: "0x1" }],
        meme: [
          { channelId: 0n, bps: 9_000n },
          { channelId: 1n, bps: 1_000n },
        ],
        quote: [{ channelId: 1n, bps: 10_000n }],
      }),
    /exactly one Liquidity channel/,
  );
  assert.throws(
    () =>
      normalizeAllocationPlan({
        channels: [{ channelId: 2n, role: "Liquidity", destination: "0x2" }],
        meme: [{ channelId: 2n, bps: 10_000n }],
        quote: [{ channelId: 2n, bps: 10_000n }],
      }),
    /positive curve weight/,
  );
});
