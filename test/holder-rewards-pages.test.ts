import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import type {
  RewardAllocation,
  RewardLeafDomain,
  RewardManifestPageStore,
  RewardProof,
} from "../src/holder-rewards/allocations.ts";
import {
  allocateHolderRewardPage,
  allocateHolderRewards,
  buildRewardManifest,
  buildRewardManifestPages,
  MAX_REWARD_LEAVES,
  MIGRATOR_REWARD_LEAF_DOMAIN,
  PRESALE_REWARD_LEAF_DOMAIN,
  validateRewardManifestSummary,
  verifyRewardSummaryProof,
} from "../src/holder-rewards/allocations.ts";

import { itemAt } from "../src/lib/arrays.ts";

const address = (index: number) =>
  normalizeSuiAddress(`0x${(index + 1).toString(16)}`);
const options: Omit<Parameters<typeof buildRewardManifest>[0], "allocations"> =
  {
    vaultId: normalizeSuiAddress("0xd"),
    number: 2n,
    startCheckpoint: 21n,
    endCheckpoint: 30n,
    leafDomain: PRESALE_REWARD_LEAF_DOMAIN,
  };

function pageStore(read: RewardManifestPageStore["readAllocations"]) {
  const hashes = new Map<string, string>();
  const proofs = new Map<number, RewardProof>();
  const stats = { allocations: 0, hashes: 0, proofs: 0, hashWrites: 0 };
  const store: RewardManifestPageStore = {
    async readAllocations(offset, count) {
      stats.allocations = Math.max(stats.allocations, count);
      return read(offset, count);
    },
    async readHashes(level, offset, count) {
      stats.hashes = Math.max(stats.hashes, count);
      return Array.from({ length: count }, (_, i) => {
        const hash = hashes.get(`${level}/${offset + i}`);
        assert.ok(hash, "a complete durable hash page exists");
        return hash;
      });
    },
    async writeHashes(level, offset, values) {
      stats.hashWrites += 1;
      for (const [i, hash] of values.entries()) {
        const key = `${level}/${offset + i}`;
        const old = hashes.get(key);
        if (old !== undefined)
          assert.equal(hash, old, "immutable hash position");
        hashes.set(key, hash);
      }
    },
    async readProofs(offset, count) {
      return Array.from({ length: count }, (_, i) => {
        const proof = proofs.get(offset + i);
        assert.ok(proof, "a complete durable proof page exists");
        return proof;
      });
    },
    async writeProofs(offset, values) {
      stats.proofs = Math.max(stats.proofs, values.length);
      for (const [i, proof] of values.entries()) {
        const old = proofs.get(offset + i);
        if (old !== undefined)
          assert.deepEqual(proof, old, "immutable proof position");
        proofs.set(offset + i, structuredClone(proof));
      }
    },
  };
  return { store, proofs, stats };
}

const allocations = (count: number): RewardAllocation[] =>
  Array.from({ length: count }, (_, i) => ({
    beneficiary: address(i),
    memeAmount: BigInt(i % 2),
    quoteAmount: BigInt(i + 1),
  }));

test("allocation pages use one global denominator and preserve zero-atom qualifiers and dust", () => {
  const holders = Array.from({ length: 17 }, (_, i) => ({
    address: address(i),
    weight: BigInt(i + 1),
  }));
  const total = holders.reduce((sum, item) => sum + item.weight, 0n);
  const expected = allocateHolderRewards(holders, 0n, 20n);
  for (const size of [1, 3, 8, 17]) {
    const actual: RewardAllocation[] = [];
    let last: string | undefined;
    let allocated = 0n;
    let weight = 0n;
    for (let offset = 0; offset < holders.length; offset += size) {
      const page = allocateHolderRewardPage(
        holders.slice(offset, offset + size),
        20n,
        total,
        last,
      );
      actual.push(...page.allocations);
      allocated += page.quoteAllocated;
      weight += page.pageWeight;
      last = page.lastAddress;
    }
    assert.deepEqual(actual, expected.allocations);
    assert.equal(20n - allocated, expected.quoteDust);
    assert.equal(weight, total);
    assert.ok(
      actual.length < holders.length,
      "qualification count precedes payout flooring",
    );
  }
  assert.throws(
    () => allocateHolderRewardPage(holders.slice(0, 1), 20n, total, address(0)),
    /distinct/,
  );
  assert.throws(
    () =>
      allocateHolderRewardPage(
        [itemAt(holders, 1), itemAt(holders, 0)],
        20n,
        total,
      ),
    /distinct/,
  );
  assert.throws(
    () =>
      allocateHolderRewardPage(
        [{ address: address(0), weight: -1n }],
        20n,
        total,
      ),
    /nonnegative/,
  );
  assert.throws(
    () => allocateHolderRewardPage(holders, 20n, total - 1n),
    /exceeds/,
  );
});

test("paged BCS, roots and proofs match legacy bytes across odd leaves, domains, pages and interrupted resume", async () => {
  for (const count of [1, 3, 7, 128, 129]) {
    const rows = allocations(count);
    const domains: readonly RewardLeafDomain[] = [
      MIGRATOR_REWARD_LEAF_DOMAIN,
      PRESALE_REWARD_LEAF_DOMAIN,
    ];
    for (const leafDomain of domains) {
      const expected = buildRewardManifest({
        ...options,
        leafDomain,
        allocations: rows,
      });
      const { allocations: expectedProofs, ...expectedHeader } = expected;
      for (const pageSize of [1, 3, 32]) {
        const fixture = pageStore(async (offset, size) =>
          rows.slice(offset, offset + size),
        );
        const write = fixture.store.writeHashes;
        let crashed = false;
        fixture.store.writeHashes = async (...args) => {
          await write(...args);
          if (!crashed) {
            crashed = true;
            throw new Error("injected crash after durable page");
          }
        };
        await assert.rejects(
          buildRewardManifestPages(
            { ...options, leafDomain, leafCount: count, pageSize },
            fixture.store,
          ),
          /injected crash/,
        );
        fixture.store.writeHashes = write;
        if (count === 129 && pageSize === 32) {
          const writeProofs = fixture.store.writeProofs;
          let proofCrash = false;
          fixture.store.writeProofs = async (...args) => {
            await writeProofs(...args);
            if (!proofCrash) {
              proofCrash = true;
              throw new Error("injected crash after durable proof");
            }
          };
          await assert.rejects(
            buildRewardManifestPages(
              { ...options, leafDomain, leafCount: count, pageSize },
              fixture.store,
            ),
            /durable proof/,
          );
          fixture.store.writeProofs = writeProofs;
        }
        const actual = await buildRewardManifestPages(
          { ...options, leafDomain, leafCount: count, pageSize },
          fixture.store,
        );
        assert.deepEqual(actual, {
          ...expectedHeader,
          leafCount: count,
          leafDomain,
        });
        assert.deepEqual([...fixture.proofs.values()], expectedProofs);
        assert.ok(fixture.stats.allocations <= pageSize);
        assert.ok(fixture.stats.hashes <= 2 * pageSize);
        assert.ok(fixture.stats.proofs <= pageSize);
        assert.equal(validateRewardManifestSummary(actual, leafDomain), actual);
        assert.equal(
          verifyRewardSummaryProof(
            actual,
            itemAt(expectedProofs, 0),
            leafDomain,
          ),
          true,
        );
      }
    }
  }
});

test("unfinished, changed or corrupted pages never produce a publishable summary", async () => {
  const rows = allocations(3);
  const bounded = { ...options, leafCount: rows.length, pageSize: 2 };
  const missing = pageStore(async (offset, count) =>
    rows.slice(offset, offset + count - 1),
  );
  await assert.rejects(
    buildRewardManifestPages(bounded, missing.store),
    /incomplete allocation/,
  );
  const unordered = pageStore(async (offset, count) =>
    [itemAt(rows, 0), itemAt(rows, 1), itemAt(rows, 0)].slice(
      offset,
      offset + count,
    ),
  );
  await assert.rejects(
    buildRewardManifestPages(bounded, unordered.store),
    /distinct/,
  );
  let reads = 0;
  const changed = pageStore(async (offset, count) => {
    if (offset === 0) reads += 1;
    return rows.slice(offset, offset + count).map((row) => ({
      ...row,
      quoteAmount: reads > 1 ? 999n : row.quoteAmount,
    }));
  });
  await assert.rejects(
    buildRewardManifestPages(bounded, changed.store),
    /snapshot changed/,
  );
  const corrupt = pageStore(async (offset, count) =>
    rows.slice(offset, offset + count),
  );
  const write = corrupt.store.writeProofs;
  corrupt.store.writeProofs = async (offset, proofs) => {
    await write(
      offset,
      proofs.map((proof) => ({ ...proof, quoteAmount: "999" })),
    );
  };
  await assert.rejects(
    buildRewardManifestPages(bounded, corrupt.store),
    /proof page readback/,
  );
  const untouched = pageStore(async () => {
    throw new Error("must not read");
  });
  await assert.rejects(
    buildRewardManifestPages(
      { ...bounded, leafCount: MAX_REWARD_LEAVES + 1 },
      untouched.store,
    ),
    /invalid allocation count/,
  );
  assert.equal(untouched.stats.hashWrites, 0);
  const corruptHashes = pageStore(async (offset, count) =>
    rows.slice(offset, offset + count),
  );
  const writeHashes = corruptHashes.store.writeHashes;
  corruptHashes.store.writeHashes = (level, offset, hashes) =>
    writeHashes(
      level,
      offset,
      hashes.map(() => "00".repeat(32)),
    );
  await assert.rejects(
    buildRewardManifestPages(bounded, corruptHashes.store),
    /Merkle page readback mismatch/,
  );
});

test("two 30,000-positive-leaf manifests bound every working page and retain every beneficiary", async () => {
  const count = 30_000;
  const pageSize = 512;
  const fixtures = [0, 1].map(() =>
    pageStore(async (offset, size) =>
      Array.from({ length: size }, (_, i) => ({
        beneficiary: address(offset + i),
        memeAmount: 0n,
        quoteAmount: 1n,
      })),
    ),
  );
  const summaries = await Promise.all(
    fixtures.map((fixture) =>
      buildRewardManifestPages(
        {
          ...options,
          leafCount: count,
          pageSize,
        },
        fixture.store,
      ),
    ),
  );
  assert.deepEqual(summaries[0], summaries[1]);
  for (const [i, fixture] of fixtures.entries()) {
    assert.equal(itemAt(summaries, i).quoteAmount, count.toString());
    assert.equal(fixture.proofs.size, count);
    assert.ok(fixture.stats.allocations <= pageSize);
    assert.ok(fixture.stats.hashes <= 2 * pageSize);
    assert.ok(fixture.stats.proofs <= pageSize);
    for (const [index, proof] of fixture.proofs) {
      assert.equal(proof.index, index.toString());
      assert.equal(proof.beneficiary, address(index));
      assert.equal(proof.quoteAmount, "1");
    }
  }
});
