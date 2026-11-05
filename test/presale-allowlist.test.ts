import assert from "node:assert/strict";
import test from "node:test";
import { itemAt } from "@interest-protocol/blast-core/arrays";
import {
  allowlistLeaf,
  buildAllowlist,
  verifyAllowlistProof,
} from "@interest-protocol/blast-presale-sdk/allowlist";
import { toHex } from "@mysten/sui/utils";

// Digests a Move unit test printed from `blast_presale::allowlist_leaf` and the
// Merkle node hash. At 4fe8d73 `allowlist_leaf` hashes the same bytes through
// `blast_core::merkle::leaf` (blake2b256(0x00 || "blast-presale-v1" || payload)).
const ALICE_LEAF =
  "0b917a43909cf551596a5dc4bc03d62a638a81b058ddc3de0a4e57367f24519e";
const BOB_LEAF =
  "8cc656fc8a2d3d5c17e433e4cf25b365e041779ea5c2ab729689eed1b970a70b";
const ROOT = "04e0fa5e426457543e725f1ad0774f40c8d4daa3f8b3394adcaae81efc91e25b";

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
