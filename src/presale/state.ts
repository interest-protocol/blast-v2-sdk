import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
  toHex,
} from "@mysten/sui/utils";

import {
  moveTypeNameBcs,
  suiBalanceBcs,
  suiIdBcs,
  suiUidBcs,
} from "../lib/bcs.ts";
import { normalizePositiveU64 } from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";

// === Configuration values (Move `copy + drop + store` types) ===

/** `blast_presale::EligibilityPolicy`. `root` is 32 lowercase hex bytes, no `0x`. */
export type EligibilityPolicy =
  | {
      kind: "open";
      walletCap: bigint;
      maxParticipants: bigint;
      minCommitment: bigint;
    }
  | { kind: "allowlisted"; root: string; leafCount: bigint };

/** `blast_presale::UncappedAccess`. */
export type UncappedAccess =
  | { kind: "eligible" }
  | { kind: "anyone"; maxParticipants: bigint; minCommitment: bigint };

/** `blast_presale::UncappedPhase`; `startsAfterMs` is an offset into the window. */
export type UncappedPhase = {
  startsAfterMs: bigint;
  access: UncappedAccess;
  hardCap: boolean;
};

/** `blast_presale::RecipientAllocation` and `FeeRecipient`: a BPS share for an address. */
export type BpsShare = { recipient: string; bps: bigint };

/** `blast_presale::RecipientPayout`: exact atoms apportioned at creation. */
export type RecipientPayout = { recipient: string; amount: bigint };

/**
 * `fee_policy::ProtocolFees`: Blast's BPS of the accepted raise, of the token
 * supply, and of each collected LP-fee asset. A presale snapshots them at
 * creation.
 */
export type ProtocolFees = {
  raiseBps: bigint;
  tokenBps: bigint;
  lpMemeBps: bigint;
  lpQuoteBps: bigint;
};

export const PRESALE_LIFECYCLES = [
  "Pending",
  "Open",
  "Funded",
  "Migrated",
  "Cancelled",
] as const;
export type PresaleLifecycle = (typeof PRESALE_LIFECYCLES)[number];

// === BCS layouts (field order is the Move declaration order) ===

const u64 = bcs.u64().transform({
  input: (value: bigint) => value,
  output: (value) => BigInt(value),
});
const address = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});
const digest = bcs.vector(bcs.u8()).transform({
  input: (value: string) => Array.from(fromHex(value)),
  output: (value) => toHex(Uint8Array.from(value)),
});

/** BCS layout of `blast_presale::EligibilityPolicy`. */
export const eligibilityPolicyBcs = bcs
  .enum("EligibilityPolicy", {
    Open: bcs.struct("Open", {
      wallet_cap: u64,
      max_participants: u64,
      min_commitment: u64,
    }),
    Allowlisted: bcs.struct("Allowlisted", { root: digest, leaf_count: u64 }),
  })
  .transform({
    input: (policy: EligibilityPolicy) =>
      policy.kind === "open"
        ? {
            Open: {
              wallet_cap: policy.walletCap,
              max_participants: policy.maxParticipants,
              min_commitment: policy.minCommitment,
            },
          }
        : {
            Allowlisted: { root: policy.root, leaf_count: policy.leafCount },
          },
    output: (value): EligibilityPolicy =>
      value.$kind === "Open"
        ? {
            kind: "open",
            walletCap: value.Open.wallet_cap,
            maxParticipants: value.Open.max_participants,
            minCommitment: value.Open.min_commitment,
          }
        : {
            kind: "allowlisted",
            root: value.Allowlisted.root,
            leafCount: value.Allowlisted.leaf_count,
          },
  });

/** BCS layout of `blast_presale::UncappedPhase`. */
export const uncappedPhaseBcs = bcs
  .struct("UncappedPhase", {
    starts_after_ms: u64,
    access: bcs.enum("UncappedAccess", {
      Eligible: null,
      Anyone: bcs.struct("Anyone", {
        max_participants: u64,
        min_commitment: u64,
      }),
    }),
    hard_cap: bcs.bool(),
  })
  .transform({
    input: (phase: UncappedPhase) => ({
      starts_after_ms: phase.startsAfterMs,
      access:
        phase.access.kind === "eligible"
          ? { Eligible: true }
          : {
              Anyone: {
                max_participants: phase.access.maxParticipants,
                min_commitment: phase.access.minCommitment,
              },
            },
      hard_cap: phase.hardCap,
    }),
    output: (value): UncappedPhase => ({
      startsAfterMs: value.starts_after_ms,
      access:
        value.access.$kind === "Eligible"
          ? { kind: "eligible" }
          : {
              kind: "anyone",
              maxParticipants: value.access.Anyone.max_participants,
              minCommitment: value.access.Anyone.min_commitment,
            },
      hardCap: value.hard_cap,
    }),
  });

const bpsShareBcs = bcs
  .struct("BpsShare", { recipient: address, bps: u64 })
  .transform({
    input: (value: BpsShare) => value,
    output: (value): BpsShare => value,
  });
const payoutBcs = bcs
  .struct("RecipientPayout", { recipient: address, amount: u64 })
  .transform({
    input: (value: RecipientPayout) => value,
    output: (value): RecipientPayout => value,
  });

/** BCS layout of `fee_policy::ProtocolFees`. */
export const protocolFeesBcs = bcs
  .struct("ProtocolFees", {
    raise_bps: u64,
    token_bps: u64,
    lp_meme_bps: u64,
    lp_quote_bps: u64,
  })
  .transform({
    input: (value: ProtocolFees) => ({
      raise_bps: value.raiseBps,
      token_bps: value.tokenBps,
      lp_meme_bps: value.lpMemeBps,
      lp_quote_bps: value.lpQuoteBps,
    }),
    output: (value): ProtocolFees => ({
      raiseBps: value.raise_bps,
      tokenBps: value.token_bps,
      lpMemeBps: value.lp_meme_bps,
      lpQuoteBps: value.lp_quote_bps,
    }),
  });

/** BCS layout of `blast_presale::Lifecycle`. */
export const lifecycleBcs = bcs
  .enum("Lifecycle", {
    Pending: null,
    Open: null,
    Funded: null,
    Migrated: null,
    Cancelled: null,
  })
  .transform({
    input: (value: PresaleLifecycle) => ({ [value]: true }) as never,
    output: (value): PresaleLifecycle => value.$kind,
  });

/** BCS layout of `blast_presale::Presale<SaleToken, Quote>`. */
export const presaleBcs = bcs.struct("Presale", {
  id: suiUidBcs,
  presale_cap_id: suiIdBcs,
  lifecycle: lifecycleBcs,
  duration_ms: u64,
  liquidity_window_ms: u64,
  end_ms: u64,
  liquidity_deadline_ms: u64,
  raise_target: u64,
  eligibility: eligibilityPolicyBcs,
  uncapped: bcs.option(uncappedPhaseBcs),
  uncapped_from_ms: u64,
  migration_witness: moveTypeNameBcs,
  tick_spacing: bcs.u32(),
  fee_rate: u64,
  fee_recipients: bcs.vector(bpsShareBcs),
  rewards_fee_bps: u64,
  total_commitments: u64,
  remaining_commitments: u64,
  participants: u64,
  quote: suiBalanceBcs,
  token_allocation: u64,
  sale_tokens: suiBalanceBcs,
  liquidity_tokens: suiBalanceBcs,
  recipient_payouts: bcs.vector(payoutBcs),
  recipient_tokens: suiBalanceBcs,
  raise_payouts: bcs.vector(payoutBcs),
  protocol_fees: protocolFeesBcs,
  protocol_quote: u64,
  protocol_tokens: suiBalanceBcs,
});

/** BCS layout of `blast_presale::Commitment`, stored under `CommitmentKey(address)`. */
export const commitmentBcs = bcs.struct("Commitment", {
  quote: u64,
  wallet_cap: u64,
});

/** BCS layout of `presale_vault::PresaleVault<Meme, Quote>`. */
export const presaleVaultBcs = bcs.struct("PresaleVault", {
  id: suiUidBcs,
  presale_id: suiIdBcs,
  presale_cap_id: suiIdBcs,
  pool_id: suiIdBcs,
  fee_recipients: bcs.vector(bpsShareBcs),
  rewards_fee_bps: u64,
  protocol_fees: protocolFeesBcs,
  migration_meme_residual: suiBalanceBcs,
  migration_quote_residual: suiBalanceBcs,
  rewards_meme: suiBalanceBcs,
  rewards_quote: suiBalanceBcs,
  next_round: u64,
  last_checkpoint: bcs.option(u64),
});

/** BCS layout of `fee_policy::FeePolicy`, the package's one shared fee policy. */
export const feePolicyBcs = bcs.struct("FeePolicy", {
  id: suiUidBcs,
  destination: address,
  fees: protocolFeesBcs,
});

/** BCS layout of `holder_rewards::Round<Meme, Quote>`. */
export const presaleRewardRoundBcs = bcs.struct("Round", {
  id: suiUidBcs,
  vault: suiIdBcs,
  number: u64,
  claim_deadline_ms: u64,
  root: digest,
  leaf_count: u64,
  claimed: bcs.vector(bcs.u256()),
  meme: suiBalanceBcs,
  quote: suiBalanceBcs,
});

// === Decoded objects ===

export type PresaleObject = {
  objectId: string;
  initialSharedVersion: number | string;
  type: string;
  content: Uint8Array;
};

export type PresaleState = SharedObjectReference<true> & {
  /** The `SaleToken` type argument. */
  memeType: string;
  quoteType: string;
  presaleCapId: string;
  lifecycle: PresaleLifecycle;
  durationMs: bigint;
  liquidityWindowMs: bigint;
  /** Exclusive commitment end; zero while Pending. */
  endMs: bigint;
  /** From this timestamp anyone may cancel an unmigrated funded sale; zero while Pending. */
  liquidityDeadlineMs: bigint;
  raiseTarget: bigint;
  eligibility: EligibilityPolicy;
  uncapped: UncappedPhase | null;
  /** When wallet caps lift; `endMs` without an uncapped phase, zero while Pending. */
  uncappedFromMs: bigint;
  migrationWitness: string;
  tickSpacing: number;
  feeRate: bigint;
  feeRecipients: BpsShare[];
  rewardsFeeBps: bigint;
  totalCommitments: bigint;
  /** Commitments not yet claimed. */
  remainingCommitments: bigint;
  participants: bigint;
  /** Quote custody balance. */
  quote: bigint;
  /** Participant token allocation fixed at creation. */
  tokenAllocation: bigint;
  /** Participant tokens still in custody. */
  saleTokens: bigint;
  liquidityTokens: bigint;
  recipientPayouts: RecipientPayout[];
  recipientTokens: bigint;
  raisePayouts: RecipientPayout[];
  /** Blast's rates, snapshotted at creation. */
  protocolFees: ProtocolFees;
  /** Blast's share of the raise, paid on migration. */
  protocolQuote: bigint;
  /** Blast's token share still in custody: paid on migration, locked forever on cancellation. */
  protocolTokens: bigint;
};

export type PresaleVaultState = SharedObjectReference<true> & {
  memeType: string;
  quoteType: string;
  presaleId: string;
  presaleCapId: string;
  poolId: string;
  feeRecipients: BpsShare[];
  rewardsFeeBps: bigint;
  /** The presale's snapshotted rates; only the LP-fee shares apply to the vault. */
  protocolFees: ProtocolFees;
  migrationMemeResidual: bigint;
  migrationQuoteResidual: bigint;
  /** Holder-reward share not yet reserved by a round. */
  rewardsMeme: bigint;
  rewardsQuote: bigint;
  nextRound: bigint;
  /** Checkpoint the next round must start at; null before the first round. */
  lastCheckpoint: bigint | null;
};

export type PresaleRewardRoundState = SharedObjectReference<true> & {
  memeType: string;
  quoteType: string;
  vaultId: string;
  number: bigint;
  claimDeadlineMs: bigint;
  root: string;
  leafCount: bigint;
  /** Claim bitmap, 256 leaves per word; see `presaleRewardIsClaimed`. */
  claimed: bigint[];
  memeRemaining: bigint;
  quoteRemaining: bigint;
};

/**
 * `fee_policy::FeePolicy`: the rates new presales snapshot and the address
 * every protocol payout goes to. A creation must size its allocations against
 * the current `tokenBps`.
 */
export type PresaleFeePolicyState = SharedObjectReference<true> & {
  destination: string;
  fees: ProtocolFees;
};

export type PresaleCommitment = { quote: bigint; walletCap: bigint };

export function decodePresaleObject(
  object: PresaleObject,
  originalPackageId: string,
): PresaleState {
  const [memeType, quoteType] = pairTypes(
    object,
    "blast_presale",
    "Presale",
    originalPackageId,
  );
  const parsed = presaleBcs.parse(object.content);
  return {
    ...sharedIdentity(object, parsed.id.id.bytes),
    memeType,
    quoteType,
    presaleCapId: normalizeSuiObjectId(parsed.presale_cap_id.bytes),
    lifecycle: parsed.lifecycle,
    durationMs: parsed.duration_ms,
    liquidityWindowMs: parsed.liquidity_window_ms,
    endMs: parsed.end_ms,
    liquidityDeadlineMs: parsed.liquidity_deadline_ms,
    raiseTarget: parsed.raise_target,
    eligibility: parsed.eligibility,
    uncapped: parsed.uncapped,
    uncappedFromMs: parsed.uncapped_from_ms,
    migrationWitness: parsed.migration_witness,
    tickSpacing: parsed.tick_spacing,
    feeRate: parsed.fee_rate,
    feeRecipients: parsed.fee_recipients,
    rewardsFeeBps: parsed.rewards_fee_bps,
    totalCommitments: parsed.total_commitments,
    remainingCommitments: parsed.remaining_commitments,
    participants: parsed.participants,
    quote: BigInt(parsed.quote.value),
    tokenAllocation: parsed.token_allocation,
    saleTokens: BigInt(parsed.sale_tokens.value),
    liquidityTokens: BigInt(parsed.liquidity_tokens.value),
    recipientPayouts: parsed.recipient_payouts,
    recipientTokens: BigInt(parsed.recipient_tokens.value),
    raisePayouts: parsed.raise_payouts,
    protocolFees: parsed.protocol_fees,
    protocolQuote: parsed.protocol_quote,
    protocolTokens: BigInt(parsed.protocol_tokens.value),
  };
}

export function decodePresaleVaultObject(
  object: PresaleObject,
  originalPackageId: string,
): PresaleVaultState {
  const [memeType, quoteType] = pairTypes(
    object,
    "presale_vault",
    "PresaleVault",
    originalPackageId,
  );
  const parsed = presaleVaultBcs.parse(object.content);
  return {
    ...sharedIdentity(object, parsed.id.id.bytes),
    memeType,
    quoteType,
    presaleId: normalizeSuiObjectId(parsed.presale_id.bytes),
    presaleCapId: normalizeSuiObjectId(parsed.presale_cap_id.bytes),
    poolId: normalizeSuiObjectId(parsed.pool_id.bytes),
    feeRecipients: parsed.fee_recipients,
    rewardsFeeBps: parsed.rewards_fee_bps,
    protocolFees: parsed.protocol_fees,
    migrationMemeResidual: BigInt(parsed.migration_meme_residual.value),
    migrationQuoteResidual: BigInt(parsed.migration_quote_residual.value),
    rewardsMeme: BigInt(parsed.rewards_meme.value),
    rewardsQuote: BigInt(parsed.rewards_quote.value),
    nextRound: parsed.next_round,
    lastCheckpoint: parsed.last_checkpoint,
  };
}

export function decodePresaleRewardRoundObject(
  object: PresaleObject,
  originalPackageId: string,
): PresaleRewardRoundState {
  const [memeType, quoteType] = pairTypes(
    object,
    "holder_rewards",
    "Round",
    originalPackageId,
  );
  const parsed = presaleRewardRoundBcs.parse(object.content);
  return {
    ...sharedIdentity(object, parsed.id.id.bytes),
    memeType,
    quoteType,
    vaultId: normalizeSuiObjectId(parsed.vault.bytes),
    number: parsed.number,
    claimDeadlineMs: parsed.claim_deadline_ms,
    root: parsed.root,
    leafCount: parsed.leaf_count,
    claimed: parsed.claimed.map(BigInt),
    memeRemaining: BigInt(parsed.meme.value),
    quoteRemaining: BigInt(parsed.quote.value),
  };
}

export function decodePresaleFeePolicyObject(
  object: PresaleObject,
  originalPackageId?: string,
): PresaleFeePolicyState {
  const tag = parseStructTag(object.type);
  if (
    tag.module !== "fee_policy" ||
    tag.name !== "FeePolicy" ||
    tag.typeParams.length !== 0 ||
    (originalPackageId !== undefined &&
      tag.address !== normalizeSuiAddress(originalPackageId))
  ) {
    throw new TypeError(`object ${object.objectId} is not a presale FeePolicy`);
  }
  const parsed = feePolicyBcs.parse(object.content);
  return {
    ...sharedIdentity(object, parsed.id.id.bytes),
    destination: parsed.destination,
    fees: parsed.fees,
  };
}

/** Mirrors `holder_rewards::claim_bit`: whether leaf `index` was already paid. */
export function presaleRewardIsClaimed(
  round: Pick<PresaleRewardRoundState, "leafCount" | "claimed">,
  index: bigint,
): boolean {
  if (index < 0n || index >= round.leafCount) {
    throw new RangeError("claim index out of bounds");
  }
  const word = round.claimed[Number(index / 256n)] ?? 0n;
  return (word & (1n << (index % 256n))) !== 0n;
}

export async function getPresale(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<PresaleState> {
  return decodePresaleObject(
    await getSharedObject(client, objectId),
    originalPackageId,
  );
}

export async function getPresaleVault(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<PresaleVaultState> {
  return decodePresaleVaultObject(
    await getSharedObject(client, objectId),
    originalPackageId,
  );
}

export async function getPresaleRewardRound(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<PresaleRewardRoundState> {
  return decodePresaleRewardRoundObject(
    await getSharedObject(client, objectId),
    originalPackageId,
  );
}

export async function getPresaleFeePolicy(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId?: string,
): Promise<PresaleFeePolicyState> {
  return decodePresaleFeePolicyObject(
    await getSharedObject(client, objectId),
    originalPackageId,
  );
}

/**
 * Reads `wallet`'s undelivered commitment, the `Commitment` dynamic field under
 * `CommitmentKey(wallet)`. Null when the wallet never committed or already claimed.
 */
export async function getPresaleCommitment(
  client: ClientWithCoreApi,
  presaleId: string,
  wallet: string,
  originalPackageId: string,
): Promise<PresaleCommitment | null> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: normalizeSuiObjectId(presaleId),
      name: {
        type: `${normalizeSuiAddress(originalPackageId)}::blast_presale::CommitmentKey`,
        bcs: bcs.Address.serialize(normalizeSuiAddress(wallet)).toBytes(),
      },
    });
    const parsed = commitmentBcs.parse(dynamicField.value.bcs);
    return { quote: parsed.quote, walletCap: parsed.wallet_cap };
  } catch (error) {
    if (error instanceof ObjectError && error.reason === "notFound") {
      return null;
    }
    throw error;
  }
}

async function getSharedObject(
  client: ClientWithCoreApi,
  objectId: string,
): Promise<PresaleObject> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`object ${object.objectId} is not shared`);
  }
  return {
    objectId: object.objectId,
    initialSharedVersion: object.owner.Shared.initialSharedVersion,
    type: object.type,
    content: object.content,
  };
}

function pairTypes(
  object: PresaleObject,
  module: string,
  name: string,
  originalPackageId: string,
): [string, string] {
  const tag = parseStructTag(object.type);
  const [memeType, quoteType, ...extra] = tag.typeParams;
  if (
    tag.module !== module ||
    tag.name !== name ||
    memeType === undefined ||
    quoteType === undefined ||
    extra.length > 0 ||
    tag.address !== normalizeSuiAddress(originalPackageId)
  ) {
    throw new TypeError(`object ${object.objectId} is not a presale ${name}`);
  }
  return [normalizeStructTag(memeType), normalizeStructTag(quoteType)];
}

function sharedIdentity(
  object: PresaleObject,
  uid: string,
): SharedObjectReference<true> {
  const objectId = normalizeSuiObjectId(object.objectId);
  if (normalizeSuiObjectId(uid) !== objectId) {
    throw new TypeError(`object ${object.objectId} has a mismatched UID`);
  }
  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    mutable: true,
  };
}
