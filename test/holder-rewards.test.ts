import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  allocateHolderRewards,
  buildRewardManifest,
  MIGRATOR_REWARD_LEAF_DOMAIN,
  verifyRewardProof,
} from "@interest-protocol/blast-core/rewards/allocations";
import {
  applyHolderCheckpoint,
  createHolderLedger,
  holderWeights,
  resetHolderWeights,
} from "@interest-protocol/blast-core/rewards/holders";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const ALICE = normalizeSuiAddress("0xa");
const BOB = normalizeSuiAddress("0xb");
const MEME = "0x42::meme::MEME";
const checkpoint = (
  sequence: bigint,
  timestampMs: bigint,
  changes: { address: string; amount: bigint }[],
) => ({
  sequence,
  digest: `checkpoint-${sequence}`,
  previousDigest: sequence === 0n ? null : `checkpoint-${sequence - 1n}`,
  timestampMs,
  changes,
});

test("published contract vector is reproduced byte for byte", () => {
  const expected = JSON.parse(
    readFileSync(
      new URL("./fixtures/holder-rewards.json", import.meta.url),
      "utf8",
    ),
  );
  const actual = buildRewardManifest({
    leafDomain: MIGRATOR_REWARD_LEAF_DOMAIN,
    vaultId: "0xd",
    number: 0n,
    startCheckpoint: 10n,
    endCheckpoint: 20n,
    allocations: [
      { beneficiary: "0xa", memeAmount: 10n, quoteAmount: 20n },
      { beneficiary: "0xb", memeAmount: 30n, quoteAmount: 40n },
      { beneficiary: "0xc", memeAmount: 50n, quoteAmount: 60n },
    ],
  });
  assert.deepEqual(actual, expected);
});

test("zero-address transfers are tracked but never become eligible recipients", () => {
  let ledger = createHolderLedger(MEME, 0n);
  ledger = applyHolderCheckpoint(
    ledger,
    checkpoint(0n, 1000n, [{ address: "0x0", amount: 100n }]),
  );
  ledger = applyHolderCheckpoint(ledger, checkpoint(1n, 2000n, []));
  assert.deepEqual(holderWeights(ledger), []);
});

test("allocation uses exact integers, aggregates wallets and leaves rounding dust", () => {
  const result = allocateHolderRewards(
    [
      { address: ALICE, weight: 1n },
      { address: BOB, weight: 2n },
      { address: ALICE, weight: 1n },
    ],
    11n,
    5n,
  );
  assert.deepEqual(result.allocations, [
    { beneficiary: ALICE, memeAmount: 5n, quoteAmount: 2n },
    { beneficiary: BOB, memeAmount: 5n, quoteAmount: 2n },
  ]);
  assert.equal(result.memeDust, 1n);
  assert.equal(result.quoteDust, 1n);
});

test("zero eligible holders never grant historical funds to a made-up recipient", () => {
  assert.deepEqual(allocateHolderRewards([], 10n, 20n), {
    allocations: [],
    memeDust: 10n,
    quoteDust: 20n,
  });
});

test("odd-sized tree verifies all leaves and binds recipient, amount, vault and round", () => {
  const manifest = buildRewardManifest({
    leafDomain: MIGRATOR_REWARD_LEAF_DOMAIN,
    vaultId: "0xd",
    number: 0n,
    startCheckpoint: 10n,
    endCheckpoint: 20n,
    allocations: [ALICE, BOB, normalizeSuiAddress("0xc")].map(
      (beneficiary) => ({ beneficiary, memeAmount: 10n, quoteAmount: 20n }),
    ),
  });
  for (const allocation of manifest.allocations) {
    assert.equal(
      verifyRewardProof(manifest, allocation, MIGRATOR_REWARD_LEAF_DOMAIN),
      true,
    );
    assert.equal(
      verifyRewardProof(
        manifest,
        { ...allocation, quoteAmount: "19" },
        MIGRATOR_REWARD_LEAF_DOMAIN,
      ),
      false,
    );
    assert.equal(
      verifyRewardProof(
        { ...manifest, number: "1" },
        allocation,
        MIGRATOR_REWARD_LEAF_DOMAIN,
      ),
      false,
    );
    assert.equal(
      verifyRewardProof(
        { ...manifest, vaultId: normalizeSuiAddress("0xe") },
        allocation,
        MIGRATOR_REWARD_LEAF_DOMAIN,
      ),
      false,
    );
  }
  assert.equal(manifest.memeAmount, "30");
  assert.equal(manifest.quoteAmount, "60");
});

test("a manifest rejects duplicate beneficiaries and zero allocations", () => {
  const options = {
    vaultId: "0xd",
    number: 0n,
    startCheckpoint: 0n,
    endCheckpoint: 1n,
  };
  assert.throws(
    () =>
      buildRewardManifest({
        leafDomain: MIGRATOR_REWARD_LEAF_DOMAIN,
        ...options,
        allocations: [
          { beneficiary: ALICE, memeAmount: 1n, quoteAmount: 0n },
          { beneficiary: ALICE, memeAmount: 1n, quoteAmount: 0n },
        ],
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      buildRewardManifest({
        leafDomain: MIGRATOR_REWARD_LEAF_DOMAIN,
        ...options,
        allocations: [{ beneficiary: ALICE, memeAmount: 0n, quoteAmount: 0n }],
      }),
    /nonzero/,
  );
});

test("checkpoint transfers preserve balance-time weight across wallets", () => {
  let ledger = createHolderLedger(MEME, 0n);
  ledger = applyHolderCheckpoint(
    ledger,
    checkpoint(0n, 1000n, [{ address: ALICE, amount: 100n }]),
  );
  ledger = applyHolderCheckpoint(
    ledger,
    checkpoint(1n, 2000n, [
      { address: ALICE, amount: -40n },
      { address: BOB, amount: 40n },
    ]),
  );
  ledger = applyHolderCheckpoint(ledger, checkpoint(2n, 3000n, []));
  assert.deepEqual(holderWeights(ledger), [
    { address: ALICE, weight: 160000n },
    { address: BOB, weight: 40000n },
  ]);
  assert.deepEqual(holderWeights(ledger, [ALICE]), [
    { address: BOB, weight: 40000n },
  ]);
  const reset = resetHolderWeights(ledger);
  assert.deepEqual(holderWeights(reset), []);
  const next = applyHolderCheckpoint(reset, checkpoint(3n, 4000n, []));
  assert.deepEqual(holderWeights(next), [
    { address: ALICE, weight: 60000n },
    { address: BOB, weight: 40000n },
  ]);
});

test("same-checkpoint changes net before balance checks and receive no extra duration", () => {
  const ledger = applyHolderCheckpoint(
    createHolderLedger(MEME, 0n),
    checkpoint(0n, 1000n, [
      { address: ALICE, amount: -50n },
      { address: ALICE, amount: 50n },
    ]),
  );
  assert.deepEqual(holderWeights(ledger), []);
});

test("replay rejects missing, duplicate, forked and backwards-time checkpoints without mutating state", () => {
  const ledger = applyHolderCheckpoint(
    createHolderLedger(MEME, 0n),
    checkpoint(0n, 1000n, [{ address: ALICE, amount: 100n }]),
  );
  const before = JSON.stringify(ledger);
  assert.throws(
    () => applyHolderCheckpoint(ledger, checkpoint(2n, 2000n, [])),
    /sequence/,
  );
  assert.throws(
    () => applyHolderCheckpoint(ledger, checkpoint(0n, 1000n, [])),
    /sequence/,
  );
  assert.throws(
    () =>
      applyHolderCheckpoint(ledger, {
        ...checkpoint(1n, 2000n, []),
        previousDigest: "wrong",
      }),
    /digest/,
  );
  assert.throws(
    () => applyHolderCheckpoint(ledger, checkpoint(1n, 999n, [])),
    /timestamp/,
  );
  assert.throws(
    () =>
      applyHolderCheckpoint(
        ledger,
        checkpoint(1n, 2000n, [{ address: ALICE, amount: -101n }]),
      ),
    /negative/,
  );
  assert.equal(JSON.stringify(ledger), before);
});

test("holder ordering and manifest commitments do not depend on host collation", (t) => {
  t.mock.method(String.prototype, "localeCompare", () => {
    throw new Error(
      "locale-sensitive comparison is not a commitment primitive",
    );
  });
  const addresses = ["0xff", "0xa0", "0x10", "0x9", "0x1"].map((address) =>
    normalizeSuiAddress(address),
  );
  const expected = ["0x1", "0x9", "0x10", "0xa0", "0xff"].map((address) =>
    normalizeSuiAddress(address),
  );
  let ledger = createHolderLedger(MEME, 0n);
  ledger = applyHolderCheckpoint(
    ledger,
    checkpoint(
      0n,
      0n,
      addresses.map((address) => ({ address, amount: 1n })),
    ),
  );
  ledger = applyHolderCheckpoint(ledger, checkpoint(1n, 1000n, []));
  const weights = holderWeights(ledger);
  assert.deepEqual(
    weights.map((holder) => holder.address),
    expected,
  );
  const allocation = allocateHolderRewards([...weights].reverse(), 100n, 100n);
  assert.deepEqual(
    allocation.allocations.map((item) => item.beneficiary),
    expected,
  );
  const manifest = buildRewardManifest({
    leafDomain: MIGRATOR_REWARD_LEAF_DOMAIN,
    vaultId: "0xd",
    number: 0n,
    startCheckpoint: 0n,
    endCheckpoint: 1n,
    allocations: [...allocation.allocations].reverse(),
  });
  assert.deepEqual(
    manifest.allocations.map((item) => item.beneficiary),
    expected,
  );
});
