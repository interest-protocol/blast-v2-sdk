import { bcs } from "@mysten/sui/bcs";
import {
  fromHex,
  isValidSuiAddress,
  normalizeSuiAddress,
  toHex,
} from "@mysten/sui/utils";
import { requireU64 } from "../lib/integers.ts";
import {
  blake2b256,
  merkleLayers,
  merkleNode,
  merkleProof,
  merkleRoot,
} from "../lib/merkle.ts";

export const MAX_REWARD_LEAVES = 65_536;
export type HolderWeight = { address: string; weight: bigint };
export type RewardAllocation = {
  beneficiary: string;
  memeAmount: bigint;
  quoteAmount: bigint;
};
export type RewardProof = {
  index: string;
  beneficiary: string;
  memeAmount: string;
  quoteAmount: string;
  proof: string[];
};
export type RewardManifest = {
  version: 1;
  vaultId: string;
  number: string;
  startCheckpoint: string;
  endCheckpoint: string;
  root: string;
  manifestDigest: string;
  memeAmount: string;
  quoteAmount: string;
  allocations: RewardProof[];
};

const leafBcs = bcs.struct("RewardLeaf", {
  vault: bcs.Address,
  number: bcs.u64(),
  index: bcs.u64(),
  beneficiary: bcs.Address,
  meme: bcs.u64(),
  quote: bcs.u64(),
});
const manifestBcs = bcs.struct("RewardManifest", {
  vault: bcs.Address,
  number: bcs.u64(),
  start: bcs.u64(),
  end: bcs.u64(),
  leaves: bcs.vector(leafBcs),
});
/** Leaf domain of `blast_fun_migrators` holder-reward rounds. */
export const MIGRATOR_REWARD_LEAF_DOMAIN = "\x00blast-holder-rewards-v1";
/** Leaf domain of `blast_presale::holder_rewards` rounds; same leaf layout. */
export const PRESALE_REWARD_LEAF_DOMAIN = "\x00blast-presale-holder-rewards-v1";
/** The package whose rounds a manifest pays: each hashes leaves under its own domain. */
export type RewardLeafDomain =
  | typeof MIGRATOR_REWARD_LEAF_DOMAIN
  | typeof PRESALE_REWARD_LEAF_DOMAIN;

/** Exact atomic-unit allocations, rounded down. Dust stays in the vault rewards balance. */
export function allocateHolderRewards(
  holders: readonly HolderWeight[],
  memeBudget: bigint,
  quoteBudget: bigint,
) {
  requireU64("memeBudget", memeBudget);
  requireU64("quoteBudget", quoteBudget);
  const weights = new Map<string, bigint>();
  for (const holder of holders) {
    if (holder.weight < 0n) throw new RangeError("weight must be nonnegative");
    const address = rewardAddress(holder.address);
    weights.set(address, (weights.get(address) ?? 0n) + holder.weight);
  }
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0n);
  const allocations: RewardAllocation[] = [];
  let memeDust = memeBudget;
  let quoteDust = quoteBudget;
  if (total > 0n) {
    for (const [beneficiary, weight] of [...weights.entries()].sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    )) {
      const memeAmount = (memeBudget * weight) / total;
      const quoteAmount = (quoteBudget * weight) / total;
      if (memeAmount === 0n && quoteAmount === 0n) continue;
      allocations.push({ beneficiary, memeAmount, quoteAmount });
      memeDust -= memeAmount;
      quoteDust -= quoteAmount;
    }
  }
  return { allocations, memeDust, quoteDust };
}

/** Builds the public payout list and every positional proof, independent of the signing key. */
export function buildRewardManifest(options: {
  vaultId: string;
  number: bigint;
  startCheckpoint: bigint;
  endCheckpoint: bigint;
  allocations: readonly RewardAllocation[];
  leafDomain: RewardLeafDomain;
}): RewardManifest {
  const leafPrefix = new TextEncoder().encode(options.leafDomain);
  const vaultId = rewardAddress(options.vaultId);
  requireU64("number", options.number);
  requireU64("startCheckpoint", options.startCheckpoint);
  requireU64("endCheckpoint", options.endCheckpoint);
  if (options.startCheckpoint >= options.endCheckpoint)
    throw new RangeError("checkpoint interval must be nonempty");
  if (
    options.allocations.length === 0 ||
    options.allocations.length > MAX_REWARD_LEAVES
  )
    throw new RangeError("invalid allocation count");
  const seen = new Set<string>();
  const allocations = options.allocations
    .map((allocation) => {
      const beneficiary = rewardAddress(allocation.beneficiary);
      if (seen.has(beneficiary)) throw new Error("duplicate beneficiary");
      seen.add(beneficiary);
      requireU64("memeAmount", allocation.memeAmount);
      requireU64("quoteAmount", allocation.quoteAmount);
      if (allocation.memeAmount === 0n && allocation.quoteAmount === 0n)
        throw new RangeError("allocation must be nonzero");
      return { ...allocation, beneficiary };
    })
    .sort((a, b) =>
      a.beneficiary < b.beneficiary
        ? -1
        : a.beneficiary > b.beneficiary
          ? 1
          : 0,
    );
  const leaves = allocations.map((allocation, index) => ({
    vault: vaultId,
    number: options.number,
    index: BigInt(index),
    beneficiary: allocation.beneficiary,
    meme: allocation.memeAmount,
    quote: allocation.quoteAmount,
  }));
  const layers = merkleLayers(
    leaves.map((leaf) =>
      blake2b256(concat(leafPrefix, leafBcs.serialize(leaf).toBytes())),
    ),
  );
  const memeAmount = requireU64(
    "total Meme",
    allocations.reduce((sum, item) => sum + item.memeAmount, 0n),
  );
  const quoteAmount = requireU64(
    "total Quote",
    allocations.reduce((sum, item) => sum + item.quoteAmount, 0n),
  );
  return {
    version: 1,
    vaultId,
    number: options.number.toString(),
    startCheckpoint: options.startCheckpoint.toString(),
    endCheckpoint: options.endCheckpoint.toString(),
    root: toHex(merkleRoot(layers)),
    manifestDigest: toHex(
      blake2b256(
        manifestBcs
          .serialize(
            {
              vault: vaultId,
              number: options.number,
              start: options.startCheckpoint,
              end: options.endCheckpoint,
              leaves,
            },
            { maxSize: 16_000_000 },
          )
          .toBytes(),
      ),
    ),
    memeAmount: memeAmount.toString(),
    quoteAmount: quoteAmount.toString(),
    allocations: allocations.map((allocation, index) => ({
      index: index.toString(),
      beneficiary: allocation.beneficiary,
      memeAmount: allocation.memeAmount.toString(),
      quoteAmount: allocation.quoteAmount.toString(),
      proof: merkleProof(layers, index).map(toHex),
    })),
  };
}

/** Matches the contract's leaf domain and exact positional proof depth. */
export function verifyRewardProof(
  manifest: RewardManifest,
  allocation: RewardProof,
  leafDomain: RewardLeafDomain,
): boolean {
  const leafPrefix = new TextEncoder().encode(leafDomain);
  try {
    let index = Number(requireU64("index", BigInt(allocation.index)));
    const count = manifest.allocations.length;
    if (
      count < 1 ||
      count > MAX_REWARD_LEAVES ||
      index >= count ||
      allocation.proof.length !== Math.ceil(Math.log2(count))
    )
      return false;
    let digest = blake2b256(
      concat(
        leafPrefix,
        leafBcs
          .serialize({
            vault: rewardAddress(manifest.vaultId),
            number: requireU64("number", BigInt(manifest.number)),
            index: BigInt(index),
            beneficiary: rewardAddress(allocation.beneficiary),
            meme: requireU64("meme", BigInt(allocation.memeAmount)),
            quote: requireU64("quote", BigInt(allocation.quoteAmount)),
          })
          .toBytes(),
      ),
    );
    for (const sibling of allocation.proof) {
      const bytes = rewardDigest(sibling);
      digest =
        index % 2 === 0 ? merkleNode(digest, bytes) : merkleNode(bytes, digest);
      index = Math.floor(index / 2);
    }
    return toHex(digest) === toHex(rewardDigest(manifest.root));
  } catch {
    return false;
  }
}

/** Rejects edited totals, roots, ordering, proofs and manifests before creating transactions. */
export function validateRewardManifest(
  manifest: RewardManifest,
  leafDomain: RewardLeafDomain,
): RewardManifest {
  if (manifest.version !== 1) throw new Error("unsupported manifest version");
  const expected = buildRewardManifest({
    vaultId: manifest.vaultId,
    number: BigInt(manifest.number),
    startCheckpoint: BigInt(manifest.startCheckpoint),
    endCheckpoint: BigInt(manifest.endCheckpoint),
    allocations: manifest.allocations.map((allocation) => ({
      beneficiary: allocation.beneficiary,
      memeAmount: BigInt(allocation.memeAmount),
      quoteAmount: BigInt(allocation.quoteAmount),
    })),
    leafDomain,
  });
  for (const key of [
    "vaultId",
    "number",
    "startCheckpoint",
    "endCheckpoint",
    "root",
    "manifestDigest",
    "memeAmount",
    "quoteAmount",
  ] as const) {
    if (manifest[key] !== expected[key])
      throw new Error(`manifest ${key} mismatch`);
  }
  for (const [i, wanted] of expected.allocations.entries()) {
    const actual = manifest.allocations[i];
    if (
      !actual ||
      actual.index !== wanted.index ||
      actual.beneficiary !== wanted.beneficiary ||
      actual.memeAmount !== wanted.memeAmount ||
      actual.quoteAmount !== wanted.quoteAmount ||
      actual.proof.length !== wanted.proof.length ||
      actual.proof.some((proof, n) => proof !== wanted.proof[n])
    )
      throw new Error("manifest allocation mismatch");
  }
  return expected;
}

export function rewardAddress(value: string): string {
  const address = normalizeSuiAddress(value);
  if (!isValidSuiAddress(address) || BigInt(address) === 0n)
    throw new TypeError("invalid nonzero Sui address");
  return address;
}

export function rewardDigest(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new TypeError("digest must be 32 canonical hex bytes");
  return fromHex(value);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  return new Uint8Array([...left, ...right]);
}
