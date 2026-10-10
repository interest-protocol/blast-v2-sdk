import { bcs } from "@mysten/sui/bcs";
import {
  fromHex,
  isValidSuiAddress,
  normalizeSuiAddress,
  toHex,
} from "@mysten/sui/utils";
import { blake2b } from "@noble/hashes/blake2.js";
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

/** Complete commitment after durable paged construction; it does not contain all proofs in memory. */
export type RewardManifestSummary = Omit<RewardManifest, "allocations"> & {
  leafCount: number;
  leafDomain: RewardLeafDomain;
};

/**
 * One immutable, canonically ordered allocation snapshot and its durable output namespace.
 * Writes must reject different content at an existing position and resolve only after durability.
 * The caller owns snapshot identity, progress, locking, and publication readiness.
 */
export type RewardManifestPageStore = {
  readAllocations(
    offset: number,
    count: number,
  ): Promise<readonly RewardAllocation[]>;
  readHashes(
    level: number,
    offset: number,
    count: number,
  ): Promise<readonly string[]>;
  writeHashes(
    level: number,
    offset: number,
    hashes: readonly string[],
  ): Promise<void>;
  readProofs(offset: number, count: number): Promise<readonly RewardProof[]>;
  writeProofs(offset: number, proofs: readonly RewardProof[]): Promise<void>;
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
const manifestHeaderBcs = bcs.struct("RewardManifestHeader", {
  vault: bcs.Address,
  number: bcs.u64(),
  start: bcs.u64(),
  end: bcs.u64(),
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

/**
 * Quote atoms = floor(budget * wallet weight / frozen global weight), never a page denominator.
 * Remainders stay holder-owned; sum quoteAllocated over every page to calculate global dust.
 * Inputs are distinct qualifying wallets in canonical order; carry lastAddress into the next page.
 */
export function allocateHolderRewardPage(
  holders: readonly HolderWeight[],
  quoteBudget: bigint,
  totalWeight: bigint,
  afterAddress?: string,
) {
  requireU64("quoteBudget", quoteBudget);
  if (totalWeight <= 0n) throw new RangeError("global weight must be positive");
  let lastAddress =
    afterAddress === undefined ? undefined : rewardAddress(afterAddress);
  let pageWeight = 0n;
  let quoteAllocated = 0n;
  const allocations: RewardAllocation[] = [];
  for (const holder of holders) {
    const beneficiary = rewardAddress(holder.address);
    if (lastAddress !== undefined && beneficiary <= lastAddress)
      throw new RangeError(
        "holder pages must be distinct and canonically ordered",
      );
    if (holder.weight < 0n) throw new RangeError("weight must be nonnegative");
    pageWeight += holder.weight;
    if (pageWeight > totalWeight)
      throw new RangeError("page weight exceeds global weight");
    const quoteAmount = (quoteBudget * holder.weight) / totalWeight;
    if (quoteAmount > 0n)
      allocations.push({ beneficiary, memeAmount: 0n, quoteAmount });
    quoteAllocated += quoteAmount;
    lastAddress = beneficiary;
  }
  return { allocations, pageWeight, quoteAllocated, lastAddress };
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

/**
 * Constructs the same BCS commitment/tree as buildRewardManifest using bounded
 * hash pages and pageSize proofs at once. Each durable output page is
 * read back before proceeding. Restarts replay identical writes; no partial result is returned.
 */
export async function buildRewardManifestPages(
  options: Omit<Parameters<typeof buildRewardManifest>[0], "allocations"> & {
    leafCount: number;
    pageSize: number;
  },
  store: RewardManifestPageStore,
): Promise<RewardManifestSummary> {
  const vaultId = rewardAddress(options.vaultId);
  requireU64("number", options.number);
  requireU64("startCheckpoint", options.startCheckpoint);
  requireU64("endCheckpoint", options.endCheckpoint);
  if (options.startCheckpoint >= options.endCheckpoint)
    throw new RangeError("checkpoint interval must be nonempty");
  if (
    !Number.isSafeInteger(options.leafCount) ||
    options.leafCount < 1 ||
    options.leafCount > MAX_REWARD_LEAVES
  )
    throw new RangeError("invalid allocation count");
  if (
    !Number.isSafeInteger(options.pageSize) ||
    options.pageSize < 1 ||
    options.pageSize > MAX_REWARD_LEAVES
  )
    throw new RangeError("invalid page size");
  const leafPrefix = new TextEncoder().encode(options.leafDomain);
  const digest = blake2b.create({ dkLen: 32 });
  digest.update(
    manifestHeaderBcs
      .serialize({
        vault: vaultId,
        number: options.number,
        start: options.startCheckpoint,
        end: options.endCheckpoint,
      })
      .toBytes(),
  );
  digest.update(bcs.uleb128().serialize(options.leafCount).toBytes());
  const readHashes = async (level: number, offset: number, count: number) => {
    const hashes = await store.readHashes(level, offset, count);
    if (hashes.length !== count) throw new Error("incomplete Merkle page");
    for (const hash of hashes) rewardDigest(hash);
    return hashes;
  };
  const writeHashes = async (
    level: number,
    offset: number,
    hashes: readonly string[],
  ) => {
    await store.writeHashes(level, offset, hashes);
    const stored = await readHashes(level, offset, hashes.length);
    if (stored.some((hash, i) => hash !== hashes[i]))
      throw new Error("Merkle page readback mismatch");
  };
  const { memeAmount, quoteAmount } = await writeManifestLeaves(
    options,
    vaultId,
    digest,
    leafPrefix,
    store,
    writeHashes,
  );
  const level = await buildManifestMerkleLayers(
    options,
    readHashes,
    writeHashes,
  );
  const root = (await readHashes(level, 0, 1))[0];
  if (root === undefined) throw new Error("missing Merkle root");
  const summary: RewardManifestSummary = {
    version: 1,
    vaultId,
    number: options.number.toString(),
    startCheckpoint: options.startCheckpoint.toString(),
    endCheckpoint: options.endCheckpoint.toString(),
    root,
    manifestDigest: toHex(digest.digest()),
    memeAmount: memeAmount.toString(),
    quoteAmount: quoteAmount.toString(),
    leafCount: options.leafCount,
    leafDomain: options.leafDomain,
  };
  await writeManifestProofs(options, summary, leafPrefix, store, readHashes);
  return summary;
}

type PagedManifestOptions = Omit<
  Parameters<typeof buildRewardManifest>[0],
  "allocations"
> & { leafCount: number; pageSize: number };
type ReadRewardHashes = (
  level: number,
  offset: number,
  count: number,
) => Promise<readonly string[]>;
type WriteRewardHashes = (
  level: number,
  offset: number,
  hashes: readonly string[],
) => Promise<void>;

function rewardLeafBytes(
  options: PagedManifestOptions,
  vaultId: string,
  allocation: RewardAllocation,
  index: number,
) {
  const beneficiary = rewardAddress(allocation.beneficiary);
  if (allocation.beneficiary !== beneficiary)
    throw new RangeError("manifest beneficiary must be canonical");
  requireU64("memeAmount", allocation.memeAmount);
  requireU64("quoteAmount", allocation.quoteAmount);
  if (allocation.memeAmount === 0n && allocation.quoteAmount === 0n)
    throw new RangeError("allocation must be nonzero");
  return leafBcs
    .serialize({
      vault: vaultId,
      number: options.number,
      index: BigInt(index),
      beneficiary,
      meme: allocation.memeAmount,
      quote: allocation.quoteAmount,
    })
    .toBytes();
}
async function writeManifestLeaves(
  options: PagedManifestOptions,
  vaultId: string,
  digest: ReturnType<typeof blake2b.create>,
  leafPrefix: Uint8Array,
  store: RewardManifestPageStore,
  writeHashes: WriteRewardHashes,
) {
  let memeAmount = 0n;
  let quoteAmount = 0n;
  let previous: string | undefined;
  for (let offset = 0; offset < options.leafCount; offset += options.pageSize) {
    const count = Math.min(options.pageSize, options.leafCount - offset);
    const allocations = await store.readAllocations(offset, count);
    if (allocations.length !== count)
      throw new Error("incomplete allocation page");
    const hashes: string[] = [];
    for (const [i, allocation] of allocations.entries()) {
      const bytes = rewardLeafBytes(options, vaultId, allocation, offset + i);
      if (previous !== undefined && allocation.beneficiary <= previous)
        throw new RangeError(
          "manifest pages must be distinct and canonically ordered",
        );
      previous = allocation.beneficiary;
      memeAmount = requireU64("total Meme", memeAmount + allocation.memeAmount);
      quoteAmount = requireU64(
        "total Quote",
        quoteAmount + allocation.quoteAmount,
      );
      digest.update(bytes);
      hashes.push(toHex(blake2b256(concat(leafPrefix, bytes))));
    }
    await writeHashes(0, offset, hashes);
  }
  return { memeAmount, quoteAmount };
}
async function buildManifestMerkleLayers(
  options: PagedManifestOptions,
  readHashes: ReadRewardHashes,
  writeHashes: WriteRewardHashes,
) {
  let width = options.leafCount;
  let level = 0;
  while (width > 1) {
    const parentWidth = Math.ceil(width / 2);
    for (let offset = 0; offset < parentWidth; offset += options.pageSize) {
      const count = Math.min(options.pageSize, parentWidth - offset);
      const below = await readHashes(
        level,
        offset * 2,
        Math.min(count * 2, width - offset * 2),
      );
      const parents: string[] = [];
      for (let i = 0; i < below.length; i += 2) {
        const left = rewardDigest(below[i] ?? "");
        const right = rewardDigest(below[i + 1] ?? below[i] ?? "");
        parents.push(toHex(merkleNode(left, right)));
      }
      await writeHashes(level + 1, offset, parents);
    }
    width = parentWidth;
    level += 1;
  }
  return level;
}
async function writeManifestProofs(
  options: PagedManifestOptions,
  summary: RewardManifestSummary,
  leafPrefix: Uint8Array,
  store: RewardManifestPageStore,
  readHashes: ReadRewardHashes,
) {
  for (let offset = 0; offset < options.leafCount; offset += options.pageSize) {
    const count = Math.min(options.pageSize, options.leafCount - offset);
    const allocations = await store.readAllocations(offset, count);
    if (allocations.length !== count)
      throw new Error("incomplete allocation page");
    const hashes = await readHashes(0, offset, count);
    const proofs = allocations.map((allocation, i): RewardProof => {
      if (
        toHex(
          blake2b256(
            concat(
              leafPrefix,
              rewardLeafBytes(options, summary.vaultId, allocation, offset + i),
            ),
          ),
        ) !== hashes[i]
      )
        throw new Error("allocation snapshot changed during construction");
      return {
        index: (offset + i).toString(),
        beneficiary: allocation.beneficiary,
        memeAmount: allocation.memeAmount.toString(),
        quoteAmount: allocation.quoteAmount.toString(),
        proof: [],
      };
    });
    await fillManifestProofs(options, offset, proofs, readHashes);
    for (const proof of proofs)
      if (!verifyRewardSummaryProof(summary, proof, options.leafDomain))
        throw new Error("proof does not match constructed root");
    await store.writeProofs(offset, proofs);
    const stored = await store.readProofs(offset, count);
    if (!rewardProofPagesMatch(stored, proofs))
      throw new Error("proof page readback mismatch");
  }
}
async function fillManifestProofs(
  options: PagedManifestOptions,
  offset: number,
  proofs: RewardProof[],
  readHashes: ReadRewardHashes,
) {
  let width = options.leafCount;
  for (let proofLevel = 0; width > 1; proofLevel += 1) {
    const first = Math.floor(offset / 2 ** proofLevel);
    const last = Math.floor((offset + proofs.length - 1) / 2 ** proofLevel);
    const start = first - (first % 2);
    const end = Math.min(width - 1, last + (last % 2 === 0 ? 1 : 0));
    const siblings = await readHashes(proofLevel, start, end - start + 1);
    for (const [i, proof] of proofs.entries()) {
      const position = Math.floor((offset + i) / 2 ** proofLevel);
      const sibling = position ^ 1;
      const hash = siblings[(sibling < width ? sibling : position) - start];
      if (hash === undefined) throw new Error("missing proof sibling");
      proof.proof.push(hash);
    }
    width = Math.ceil(width / 2);
  }
}
function rewardProofPagesMatch(
  stored: readonly RewardProof[],
  proofs: readonly RewardProof[],
) {
  return !(
    stored.length !== proofs.length ||
    stored.some((actual, i) => {
      const wanted = proofs[i];
      return (
        wanted === undefined ||
        actual.index !== wanted.index ||
        actual.beneficiary !== wanted.beneficiary ||
        actual.memeAmount !== wanted.memeAmount ||
        actual.quoteAmount !== wanted.quoteAmount ||
        actual.proof.length !== wanted.proof.length ||
        actual.proof.some((hash, n) => hash !== wanted.proof[n])
      );
    })
  );
}

/** Matches the contract's leaf domain and exact positional proof depth. */
export function verifyRewardProof(
  manifest: RewardManifest,
  allocation: RewardProof,
  leafDomain: RewardLeafDomain,
): boolean {
  return verifyRewardSummaryProof(
    { ...manifest, leafCount: manifest.allocations.length, leafDomain },
    allocation,
    leafDomain,
  );
}

/** Checks one durable proof without loading every allocation; no historical or financial policy is inferred. */
export function verifyRewardSummaryProof(
  manifest: RewardManifestSummary,
  allocation: RewardProof,
  leafDomain: RewardLeafDomain,
): boolean {
  if (manifest.leafDomain !== leafDomain) return false;
  const leafPrefix = new TextEncoder().encode(leafDomain);
  try {
    let index = Number(requireU64("index", BigInt(allocation.index)));
    const count = manifest.leafCount;
    if (
      !Number.isSafeInteger(count) ||
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

/** Structural validation only; ready-plan evidence must prove durable construction upstream. */
export function validateRewardManifestSummary(
  summary: RewardManifestSummary,
  leafDomain: RewardLeafDomain,
): RewardManifestSummary {
  if (summary.leafDomain !== leafDomain)
    throw new TypeError("manifest leaf domain mismatch");
  if (summary.version !== 1) throw new Error("unsupported manifest version");
  if (summary.vaultId !== rewardAddress(summary.vaultId))
    throw new TypeError("noncanonical vault");
  for (const key of [
    "number",
    "startCheckpoint",
    "endCheckpoint",
    "memeAmount",
    "quoteAmount",
  ] as const) {
    const value = requireU64(key, BigInt(summary[key]));
    if (value.toString() !== summary[key])
      throw new TypeError(`noncanonical ${key}`);
  }
  if (BigInt(summary.startCheckpoint) >= BigInt(summary.endCheckpoint))
    throw new RangeError("checkpoint interval must be nonempty");
  if (
    !Number.isSafeInteger(summary.leafCount) ||
    summary.leafCount < 1 ||
    summary.leafCount > MAX_REWARD_LEAVES
  )
    throw new RangeError("invalid allocation count");
  if (BigInt(summary.memeAmount) === 0n && BigInt(summary.quoteAmount) === 0n)
    throw new RangeError("empty budget");
  rewardDigest(summary.root);
  rewardDigest(summary.manifestDigest);
  return summary;
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
