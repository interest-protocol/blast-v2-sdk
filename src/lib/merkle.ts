import { blake2b } from "@noble/hashes/blake2.js";

export function blake2b256(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, { dkLen: 32 });
}

/** Mirrors the contracts' Merkle `node`: `blake2b256(0x01 || left || right)`. */
export function merkleNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return blake2b256(new Uint8Array([1, ...left, ...right]));
}

/**
 * Every layer of the positional tree the contracts verify, leaves first and
 * the one-node root layer last; an odd node pairs with itself.
 */
export function merkleLayers(leaves: readonly Uint8Array[]): Uint8Array[][] {
  if (leaves.length === 0) throw new RangeError("a Merkle tree needs a leaf");
  let layer = [...leaves];
  const layers = [layer];
  while (layer.length > 1) {
    const below = layer;
    layer = below.flatMap((left, i) =>
      i % 2 === 0 ? [merkleNode(left, below[i + 1] ?? left)] : [],
    );
    layers.push(layer);
  }
  return layers;
}

export function merkleRoot(layers: readonly Uint8Array[][]): Uint8Array {
  const root = layers.at(-1)?.[0];
  if (!root) throw new RangeError("a Merkle tree needs a leaf");
  return root;
}

/** Leaf `index`'s siblings, bottom up. */
export function merkleProof(
  layers: readonly Uint8Array[][],
  index: number,
): Uint8Array[] {
  return layers.slice(0, -1).map((layer, level) => {
    const position = index >> level;
    const sibling = layer[position ^ 1] ?? layer[position];
    if (!sibling) throw new RangeError(`no Merkle leaf at index ${index}`);
    return sibling;
  });
}
