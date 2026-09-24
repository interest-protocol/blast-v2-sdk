import { bcs } from "@mysten/sui/bcs";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

import {
  BASIS_POINTS_DENOMINATOR,
  mulDivUp,
  requireBasisPoints,
  requireU64,
} from "../lib/integers.ts";

/** Most channels one allocation plan may name, excluding the curve (channel zero). */
export const MAX_MIGRATION_CHANNELS = 16;
/** Most direct recipients one LP-fee split may name. */
export const MAX_FEE_SPLIT_RECIPIENTS = 16;

export type AllocationChannelRole = "Liquidity" | "Protocol" | "External";

/** One stable migration identity and the destination its allocation is paid to. */
export type AllocationChannel = {
  channelId: bigint;
  role: AllocationChannelRole;
  destination: string;
};

/** One positive table entry; channel zero is the curve and appears only in the Meme table. */
export type AllocationWeight = { channelId: bigint; bps: bigint };

/** Mirrors `blast_fun::allocation::AllocationPlan` in canonical ascending channel order. */
export type AllocationPlan = {
  channels: AllocationChannel[];
  meme: AllocationWeight[];
  quote: AllocationWeight[];
};

export type FeeSplitRecipient = { destination: string; bps: bigint };

/**
 * Mirrors `blast_fun::allocation::FeeSplit`: the creator's split of every LP-fee
 * collection after Blast's share, with recipients in canonical address order.
 */
export type FeeSplit = {
  creatorBps: bigint;
  autoLpBps: bigint;
  rewardsBps: bigint;
  recipients: FeeSplitRecipient[];
};

/** Exact per-part amounts of one apportioned fee-split total. */
export type FeeSplitAmounts = {
  creator: bigint;
  autoLp: bigint;
  rewards: bigint;
  recipients: bigint[];
};

const u64Bcs = bcs.u64().transform({
  input: (value: bigint) => value,
  output: (value) => BigInt(value),
});
/** BCS layout of `blast_fun::bps::Bps`. */
export const bpsBcs = bcs.struct("Bps", { value: u64Bcs }).transform({
  input: (value: bigint) => ({ value }),
  output: (value) => value.value,
});
const addressBcs = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});
const channelRoleBcs = bcs
  .enum("ChannelRole", { Liquidity: null, Protocol: null, External: null })
  .transform({
    input: (role: AllocationChannelRole) =>
      ({ [role]: true }) as Record<AllocationChannelRole, true>,
    output: (role) => role.$kind as AllocationChannelRole,
  });
const channelBcs = bcs.struct("Channel", {
  channelId: u64Bcs,
  role: channelRoleBcs,
  destination: addressBcs,
});
const weightBcs = bcs.struct("Weight", { channelId: u64Bcs, bps: bpsBcs });
/** BCS layout of `blast_fun::allocation::AllocationPlan`. */
export const allocationPlanBcs = bcs.struct("AllocationPlan", {
  channels: bcs.vector(channelBcs),
  meme: bcs.vector(weightBcs),
  quote: bcs.vector(weightBcs),
});
const routeBcs = bcs.struct("Route", {
  destination: addressBcs,
  bps: bpsBcs,
});
/** BCS layout of `blast_fun::allocation::FeeSplit`. */
export const feeSplitBcs = bcs.struct("FeeSplit", {
  creatorBps: bpsBcs,
  autoLpBps: bpsBcs,
  rewardsBps: bpsBcs,
  recipients: bcs.vector(routeBcs),
});

/**
 * Canonicalizes a plan exactly as `allocation::new` does and rejects any plan
 * the constructor aborts on. Launch intake additionally checks the Blast
 * protocol channel against live `LaunchConfig` policy, which this SDK does not
 * duplicate.
 */
export function normalizeAllocationPlan(plan: AllocationPlan): AllocationPlan {
  const channels = [...plan.channels]
    .map((channel) => {
      requireU64("channelId", channel.channelId);
      if (channel.channelId === 0n) {
        throw new RangeError("channel zero is reserved for the curve");
      }
      if (!["Liquidity", "Protocol", "External"].includes(channel.role)) {
        throw new TypeError(
          "channel role must be Liquidity, Protocol, or External",
        );
      }
      return {
        channelId: channel.channelId,
        role: channel.role,
        destination: requireDestination(
          "channel destination",
          channel.destination,
        ),
      };
    })
    .sort(byChannelId);
  const meme = normalizeWeights(plan.meme);
  const quote = normalizeWeights(plan.quote);
  if (
    channels.length > MAX_MIGRATION_CHANNELS ||
    meme.length > MAX_MIGRATION_CHANNELS + 1 ||
    quote.length > MAX_MIGRATION_CHANNELS
  ) {
    throw new RangeError("allocation plan exceeds sixteen migration channels");
  }
  requireUniqueIds(channels);
  requireUniqueIds(meme);
  requireUniqueIds(quote);
  const roles = channels.map((channel) => channel.role);
  if (roles.filter((role) => role === "Liquidity").length !== 1) {
    throw new RangeError("allocation plan needs exactly one Liquidity channel");
  }
  if (roles.filter((role) => role === "Protocol").length > 1) {
    throw new RangeError("allocation plan allows at most one Protocol channel");
  }
  validateTable(meme, channels, true);
  validateTable(quote, channels, false);
  for (const channel of channels) {
    const memeBps = tableBps(meme, channel.channelId);
    const quoteBps = tableBps(quote, channel.channelId);
    if (memeBps === 0n && quoteBps === 0n) {
      throw new RangeError(`channel ${channel.channelId} has no allocation`);
    }
    if (channel.role === "Liquidity" && (memeBps === 0n || quoteBps === 0n)) {
      throw new RangeError(
        "the Liquidity channel needs Meme and Quote weights",
      );
    }
  }
  return { channels, meme, quote };
}

/**
 * Canonicalizes a split exactly as `allocation::fee_split` does: recipients in
 * ascending address order, at most sixteen distinct positive routes, and every
 * part summing to 10,000 basis points.
 */
export function normalizeFeeSplit(split: FeeSplit): FeeSplit {
  const creatorBps = requireBasisPoints("creatorBps", split.creatorBps);
  const autoLpBps = requireBasisPoints("autoLpBps", split.autoLpBps);
  const rewardsBps = requireBasisPoints("rewardsBps", split.rewardsBps);
  const recipients = split.recipients
    .map((recipient) => {
      const bps = requireBasisPoints("recipient bps", recipient.bps);
      if (bps === 0n) throw new RangeError("recipient bps must be positive");
      return {
        destination: requireDestination("recipient", recipient.destination),
        bps,
      };
    })
    .sort((left, right) => compare(left.destination, right.destination));
  if (recipients.length > MAX_FEE_SPLIT_RECIPIENTS) {
    throw new RangeError("fee split exceeds sixteen recipients");
  }
  for (let index = 1; index < recipients.length; index++) {
    if (recipients[index - 1]?.destination === recipients[index]?.destination) {
      throw new RangeError("fee split recipients must be distinct");
    }
  }
  const total = recipients.reduce(
    (sum, recipient) => sum + recipient.bps,
    creatorBps + autoLpBps + rewardsBps,
  );
  if (total !== BASIS_POINTS_DENOMINATOR) {
    throw new RangeError("fee split must sum to 10,000 basis points");
  }
  return { creatorBps, autoLpBps, rewardsBps, recipients };
}

/** Returns the plan's sole Liquidity channel ID. */
export function liquidityChannelId(plan: AllocationPlan): bigint {
  const channel = plan.channels.find((entry) => entry.role === "Liquidity");
  if (!channel)
    throw new RangeError("allocation plan has no Liquidity channel");
  return channel.channelId;
}

/**
 * Mirrors `allocation::apportion_meme`: amounts aligned with `plan.meme`. The
 * Protocol channel receives its ceiling; every other entry its floor, then one
 * atom each by descending remainder, ties by ascending channel ID.
 */
export function apportionMeme(plan: AllocationPlan, total: bigint): bigint[] {
  return apportion(plan.meme, protocolChannelId(plan), total);
}

/** Mirrors `allocation::apportion_quote`: amounts aligned with `plan.quote`. */
export function apportionQuote(plan: AllocationPlan, total: bigint): bigint[] {
  return apportion(plan.quote, protocolChannelId(plan), total);
}

/** Returns one channel's apportioned amount, or zero when the table omits it. */
export function allocationAmountFor(
  table: readonly AllocationWeight[],
  amounts: readonly bigint[],
  channelId: bigint,
): bigint {
  const index = table.findIndex((entry) => entry.channelId === channelId);
  return index < 0 ? 0n : (amounts[index] ?? 0n);
}

/**
 * Mirrors `allocation::apportion_fee_split`. Nothing is protected: every part
 * gets its floor, then one atom each by descending remainder, ties in creator,
 * auto-LP, rewards, then recipient order. Conserves `total` exactly.
 */
export function apportionFeeSplit(
  split: FeeSplit,
  total: bigint,
): FeeSplitAmounts {
  const weights = [
    { channelId: 0n, bps: split.creatorBps },
    { channelId: 1n, bps: split.autoLpBps },
    { channelId: 2n, bps: split.rewardsBps },
    ...split.recipients.map((recipient, index) => ({
      channelId: BigInt(index + 3),
      bps: recipient.bps,
    })),
  ];
  const amounts = apportion(weights, null, total);
  return {
    creator: amounts[0] ?? 0n,
    autoLp: amounts[1] ?? 0n,
    rewards: amounts[2] ?? 0n,
    recipients: amounts.slice(3),
  };
}

export type FeeCollectionPreview = {
  protocolMeme: bigint;
  protocolQuote: bigint;
  meme: FeeSplitAmounts;
  quote: FeeSplitAmounts;
};

/**
 * Mirrors `vault::split_fees` for one collection in atomic units. Blast's share
 * of each asset rounds up to the protocol (`bps::apply_up`); the rest follows
 * `apportionFeeSplit`.
 */
export function previewFeeCollection(input: {
  grossMeme: bigint;
  grossQuote: bigint;
  memeShareBps: bigint;
  quoteShareBps: bigint;
  feeSplit: FeeSplit;
}): FeeCollectionPreview {
  const grossMeme = requireU64("grossMeme", input.grossMeme);
  const grossQuote = requireU64("grossQuote", input.grossQuote);
  const protocolMeme = mulDivUp(
    grossMeme,
    requireBasisPoints("memeShareBps", input.memeShareBps),
    BASIS_POINTS_DENOMINATOR,
  );
  const protocolQuote = mulDivUp(
    grossQuote,
    requireBasisPoints("quoteShareBps", input.quoteShareBps),
    BASIS_POINTS_DENOMINATOR,
  );
  return {
    protocolMeme,
    protocolQuote,
    meme: apportionFeeSplit(input.feeSplit, grossMeme - protocolMeme),
    quote: apportionFeeSplit(input.feeSplit, grossQuote - protocolQuote),
  };
}

function apportion(
  table: readonly AllocationWeight[],
  protocolId: bigint | null,
  total: bigint,
): bigint[] {
  requireU64("total", total);
  const amounts: bigint[] = [];
  const ranked: number[] = [];
  let allocated = 0n;
  table.forEach((entry, index) => {
    const product = total * entry.bps;
    const isProtected = entry.channelId === protocolId;
    const amount = isProtected
      ? mulDivUp(total, entry.bps, BASIS_POINTS_DENOMINATOR)
      : product / BASIS_POINTS_DENOMINATOR;
    amounts.push(amount);
    allocated += amount;
    if (!isProtected) ranked.push(index);
  });
  const remainder = (index: number) =>
    (total * (table[index]?.bps ?? 0n)) % BASIS_POINTS_DENOMINATOR;
  ranked.sort((left, right) => {
    const difference = remainder(right) - remainder(left);
    if (difference !== 0n) return difference > 0n ? 1 : -1;
    return compareBigInt(
      table[left]?.channelId ?? 0n,
      table[right]?.channelId ?? 0n,
    );
  });
  const residue = total - allocated;
  if (residue < 0n || residue > BigInt(ranked.length)) {
    throw new RangeError("allocation table does not conserve its total");
  }
  for (let index = 0; index < Number(residue); index++) {
    const target = ranked[index] as number;
    amounts[target] = (amounts[target] ?? 0n) + 1n;
  }
  return amounts;
}

function protocolChannelId(plan: AllocationPlan): bigint | null {
  return (
    plan.channels.find((channel) => channel.role === "Protocol")?.channelId ??
    null
  );
}

function normalizeWeights(
  weights: readonly AllocationWeight[],
): AllocationWeight[] {
  return weights
    .map((weight) => {
      requireU64("weight channelId", weight.channelId);
      const bps = requireBasisPoints("weight bps", weight.bps);
      if (bps === 0n)
        throw new RangeError("allocation weights must be positive");
      return { channelId: weight.channelId, bps };
    })
    .sort(byChannelId);
}

function validateTable(
  table: readonly AllocationWeight[],
  channels: readonly AllocationChannel[],
  hasCurve: boolean,
): void {
  for (const entry of table) {
    const known =
      (hasCurve && entry.channelId === 0n) ||
      channels.some((channel) => channel.channelId === entry.channelId);
    if (!known) {
      throw new RangeError(`unknown migration channel ${entry.channelId}`);
    }
  }
  const sum = table.reduce((total, entry) => total + entry.bps, 0n);
  if (sum !== BASIS_POINTS_DENOMINATOR) {
    throw new RangeError("allocation table must sum to 10,000 basis points");
  }
  if (hasCurve && tableBps(table, 0n) === 0n) {
    throw new RangeError("the Meme table needs a positive curve weight");
  }
}

function tableBps(table: readonly AllocationWeight[], channelId: bigint) {
  return table.find((entry) => entry.channelId === channelId)?.bps ?? 0n;
}

function requireUniqueIds(entries: readonly { channelId: bigint }[]): void {
  for (let index = 1; index < entries.length; index++) {
    if (entries[index - 1]?.channelId === entries[index]?.channelId) {
      throw new RangeError("migration channel IDs must be distinct");
    }
  }
}

function requireDestination(name: string, value: string): string {
  const address = normalizeSuiAddress(value);
  if (!isValidSuiAddress(address) || BigInt(address) === 0n) {
    throw new RangeError(`${name} must be a nonzero Sui address`);
  }
  return address;
}

function byChannelId(
  left: { channelId: bigint },
  right: { channelId: bigint },
): number {
  return compareBigInt(left.channelId, right.channelId);
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
