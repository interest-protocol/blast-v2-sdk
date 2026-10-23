import { requirePositiveU64 } from "@interest-protocol/blast-core/integers";
import {
  blake2b256,
  merkleLayers,
  merkleNode,
  merkleProof,
  merkleRoot,
} from "@interest-protocol/blast-core/merkle";
import { bcs } from "@mysten/sui/bcs";
import { fromHex, normalizeSuiAddress, toHex } from "@mysten/sui/utils";
import { MAX_PRESALE_PARTICIPANTS } from "./math.ts";

export type AllowlistEntry = { wallet: string; walletCap: bigint };

/** One wallet's `commit_allowlisted` arguments; digests are lowercase hex. */
export type AllowlistProof = {
  index: bigint;
  wallet: string;
  walletCap: bigint;
  proof: string[];
};

export type Allowlist = {
  root: string;
  leafCount: bigint;
  proofs: AllowlistProof[];
};

const LEAF_DOMAIN = new TextEncoder().encode("\x00blast-presale-v1");
const leafBcs = bcs.struct("AllowlistLeaf", {
  index: bcs.u64(),
  wallet: bcs.Address,
  wallet_cap: bcs.u64(),
});

/**
 * Mirrors `blast_presale::allowlist_leaf`:
 * `blake2b256("\0blast-presale-v1" || bcs(index) || bcs(wallet) || bcs(cap))`.
 */
export function allowlistLeaf(
  index: bigint,
  wallet: string,
  walletCap: bigint,
): Uint8Array {
  return blake2b256(
    concat(
      LEAF_DOMAIN,
      leafBcs
        .serialize({
          index,
          wallet: normalizeSuiAddress(wallet),
          wallet_cap: walletCap,
        })
        .toBytes(),
    ),
  );
}

/**
 * Builds the positional Blake2b-256 tree `merkle_tree::verify` checks, leaves
 * in the given order, an odd node paired with itself, and every wallet's proof.
 */
export function buildAllowlist(entries: readonly AllowlistEntry[]): Allowlist {
  if (
    entries.length === 0 ||
    BigInt(entries.length) > MAX_PRESALE_PARTICIPANTS
  ) {
    throw new RangeError("an allowlist holds 1 to 65,536 wallets");
  }
  const wallets = entries.map((entry) => normalizeSuiAddress(entry.wallet));
  if (new Set(wallets).size !== wallets.length) {
    throw new RangeError("allowlist wallets must be distinct");
  }
  const leaves = entries.map((entry, index) =>
    allowlistLeaf(
      BigInt(index),
      entry.wallet,
      requirePositiveU64("walletCap", entry.walletCap),
    ),
  );
  const layers = merkleLayers(leaves);
  return {
    root: toHex(merkleRoot(layers)),
    leafCount: BigInt(entries.length),
    proofs: entries.map((entry, index) => ({
      index: BigInt(index),
      wallet: normalizeSuiAddress(entry.wallet),
      walletCap: entry.walletCap,
      proof: merkleProof(layers, index).map(toHex),
    })),
  };
}

/** Mirrors `merkle_tree::verify` over `allowlistLeaf`, including the depth check. */
export function verifyAllowlistProof(
  root: string,
  leafCount: bigint,
  { index, wallet, walletCap, proof }: AllowlistProof,
): boolean {
  if (leafCount === 0n || index < 0n || index >= leafCount) return false;
  let depth = 0;
  for (let width = leafCount; width > 1n; width = (width + 1n) / 2n) depth++;
  if (proof.length !== depth) return false;
  let digest = allowlistLeaf(index, wallet, walletCap);
  let position = index;
  for (const sibling of proof) {
    const bytes = fromHex(sibling);
    if (bytes.length !== 32) return false;
    digest =
      position % 2n === 0n
        ? merkleNode(digest, bytes)
        : merkleNode(bytes, digest);
    position /= 2n;
  }
  return toHex(digest) === root;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(left.length + right.length);
  bytes.set(left);
  bytes.set(right, left.length);
  return bytes;
}
