import assert from "node:assert/strict";
import test from "node:test";

import { fromHex, toHex } from "@mysten/sui/utils";
import { blake2b } from "@noble/hashes/blake2.js";

import {
  buildRewardManifest,
  PRESALE_REWARD_LEAF_DOMAIN,
  verifyRewardProof,
} from "../src/holder-rewards/allocations.ts";
import { itemAt } from "../src/lib/arrays.ts";
import {
  allowlistLeaf,
  buildAllowlist,
  verifyAllowlistProof,
} from "../src/presale/allowlist.ts";

// Digests a Move unit test printed from `blast_presale::allowlist_leaf`,
// `merkle_tree::node`, and `holder_rewards::leaf` at contracts 442116a.
const ALICE_LEAF =
  "0b917a43909cf551596a5dc4bc03d62a638a81b058ddc3de0a4e57367f24519e";
const BOB_LEAF =
  "8cc656fc8a2d3d5c17e433e4cf25b365e041779ea5c2ab729689eed1b970a70b";
const ROOT = "04e0fa5e426457543e725f1ad0774f40c8d4daa3f8b3394adcaae81efc91e25b";
const REWARD_LEAF =
  "185a1c43d67ccf9a349bb83c92490c4aad70978e6c1244bd081f565297b94921";

test("hashes allowlist leaves and nodes exactly like the Move package", () => {
  assert.equal(toHex(allowlistLeaf(0n, "0xa11ce", 500n)), ALICE_LEAF);
  assert.equal(toHex(allowlistLeaf(1n, "0xb0b", 700n)), BOB_LEAF);

  const allowlist = buildAllowlist([
    { wallet: "0xa11ce", walletCap: 500n },
    { wallet: "0xb0b", walletCap: 700n },
  ]);
  assert.equal(allowlist.root, ROOT);
  assert.equal(allowlist.leafCount, 2n);
  assert.deepEqual(itemAt(allowlist.proofs, 0).proof, [BOB_LEAF]);
  assert.deepEqual(itemAt(allowlist.proofs, 1).proof, [ALICE_LEAF]);
  for (const proof of allowlist.proofs) {
    assert.equal(verifyAllowlistProof(ROOT, 2n, proof), true);
  }
  const alice = itemAt(allowlist.proofs, 0);
  assert.equal(
    verifyAllowlistProof(ROOT, 2n, { ...alice, walletCap: 501n }),
    false,
  );
  assert.equal(verifyAllowlistProof(ROOT, 2n, { ...alice, index: 1n }), false);
  assert.equal(verifyAllowlistProof(ROOT, 3n, alice), false);
  assert.equal(verifyAllowlistProof(ROOT, 2n, { ...alice, proof: [] }), false);
});

test("proves every leaf of odd-sized allowlists", () => {
  for (const size of [1, 3, 5, 9]) {
    const allowlist = buildAllowlist(
      Array.from({ length: size }, (_, i) => ({
        wallet: `0x${(i + 1).toString(16)}`,
        walletCap: BigInt(100 + i),
      })),
    );
    assert.equal(
      itemAt(allowlist.proofs, 0).proof.length,
      Math.ceil(Math.log2(size)),
    );
    for (const proof of allowlist.proofs) {
      assert.equal(
        verifyAllowlistProof(allowlist.root, allowlist.leafCount, proof),
        true,
      );
    }
  }
  assert.throws(() => buildAllowlist([]), /1 to 65,536/);
  assert.throws(
    () =>
      buildAllowlist([
        { wallet: "0xa", walletCap: 1n },
        { wallet: "0x0a", walletCap: 2n },
      ]),
    /distinct/,
  );
  assert.throws(() => buildAllowlist([{ wallet: "0xa", walletCap: 0n }]));
});

test("builds presale holder-reward manifests in the presale leaf domain", () => {
  const manifest = buildRewardManifest({
    vaultId: "0xcafe",
    number: 3n,
    startCheckpoint: 1n,
    endCheckpoint: 2n,
    allocations: [
      { beneficiary: "0xa", memeAmount: 1n, quoteAmount: 0n },
      { beneficiary: "0xb0b", memeAmount: 40n, quoteAmount: 5n },
    ],
    leafDomain: PRESALE_REWARD_LEAF_DOMAIN,
  });
  const bob = itemAt(manifest.allocations, 1);
  assert.equal(bob.index, "1");
  // Index 1 is the right child: root = node(sibling, holder_rewards::leaf).
  const root = blake2b(
    Uint8Array.from([
      1,
      ...fromHex(itemAt(bob.proof, 0)),
      ...fromHex(REWARD_LEAF),
    ]),
    { dkLen: 32 },
  );
  assert.equal(manifest.root, toHex(root));
  assert.equal(
    verifyRewardProof(manifest, bob, PRESALE_REWARD_LEAF_DOMAIN),
    true,
  );
  assert.equal(verifyRewardProof(manifest, bob), false);
});
