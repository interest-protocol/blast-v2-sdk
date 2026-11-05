import type {
  Deadline,
  Delayed,
  DelayedSet,
  PendingDelay,
} from "@interest-protocol/blast-core/bcs";
import {
  admission,
  balanceBcs,
  delayedBcs,
  delayedSetBcs,
  moveTypeNameBcs,
  suiIdBcs,
  suiObjectIdBcs,
  suiUidBcs,
  u64Bcs,
  unitKeyBcs,
  vecSetBcs,
} from "@interest-protocol/blast-core/bcs";
import { bpsBcs } from "@interest-protocol/blast-core/bps";
import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import { feeSplitBcs } from "@interest-protocol/blast-core/fee-split";
import { normalizePositiveU64 } from "@interest-protocol/blast-core/integers";
import type {
  Recipient,
  VestingTerms,
} from "@interest-protocol/blast-core/payout";
import {
  recipientBcs,
  vestingTermsBcs,
} from "@interest-protocol/blast-core/payout";
import type { Ledger } from "@interest-protocol/blast-core/protocol-fees";
import { ledgerBcs } from "@interest-protocol/blast-core/protocol-fees";
import type {
  SharedObjectIdentity,
  SharedObjectReference,
} from "@interest-protocol/blast-core/sui";
import { partnerListBcs } from "@interest-protocol/blast-partners-sdk/state";
import { vaultId } from "@interest-protocol/blast-vault-sdk/state";
import type { VaultDeployment } from "@interest-protocol/blast-vault-sdk/transactions";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  deriveObjectID,
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
  toHex,
} from "@mysten/sui/utils";
import { presaleWindows } from "./math.ts";

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

/**
 * `blast_presale::UncappedPhase`; `startsAfterMs` is an offset into the window.
 * It only lifts wallet caps; whether the sale then stops at its raise is the
 * sale's `HardCap`.
 */
export type UncappedPhase = {
  startsAfterMs: bigint;
  access: UncappedAccess;
};

/**
 * `blast_presale::HardCap`: from `startsAfterMs` into the window the sale takes
 * Quote only up to its raise, first come, first served; before then it
 * overflows. With `closesWhenFilled`, anyone may settle the sale as soon as its
 * raise is full under the hard cap.
 */
export type HardCap = {
  startsAfterMs: bigint;
  closesWhenFilled: boolean;
};

/**
 * `blast_presale::RecipientShare`: one recipient's BPS share of the supply or
 * of the raise, paid at migration or vested from it as its core `Recipient`
 * says.
 */
export type RecipientShare = {
  recipient: Recipient;
  bps: bigint;
};

/** `blast_presale::RecipientPayout`: the exact atoms apportioned at creation. */
export type RecipientPayout = {
  recipient: Recipient;
  amount: bigint;
};

/**
 * `fee_policy::ProtocolFees`: Blast's BPS of the accepted raise, of the token
 * supply, and of each collected LP-fee asset. A presale snapshots them at
 * creation; the LP-fee rates pass to its vault at migration.
 */
export type ProtocolFees = {
  raiseBps: bigint;
  tokenBps: bigint;
  lpFeeMemeBps: bigint;
  lpFeeQuoteBps: bigint;
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

const digest = bcs.vector(bcs.u8()).transform({
  input: (value: string) => Array.from(fromHex(value)),
  output: (value) => toHex(Uint8Array.from(value)),
});

/** BCS layout of `blast_presale::EligibilityPolicy`. */
export const eligibilityPolicyBcs = bcs
  .enum("EligibilityPolicy", {
    Open: bcs.struct("Open", {
      wallet_cap: u64Bcs,
      max_participants: u64Bcs,
      min_commitment: u64Bcs,
    }),
    Allowlisted: bcs.struct("Allowlisted", {
      root: digest,
      leaf_count: u64Bcs,
    }),
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
    starts_after_ms: u64Bcs,
    access: bcs.enum("UncappedAccess", {
      Eligible: null,
      Anyone: bcs.struct("Anyone", {
        max_participants: u64Bcs,
        min_commitment: u64Bcs,
      }),
    }),
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
    }),
  });

/** BCS layout of `blast_presale::HardCap`. */
export const hardCapBcs = bcs
  .struct("HardCap", {
    starts_after_ms: u64Bcs,
    closes_when_filled: bcs.bool(),
  })
  .transform({
    input: (value: HardCap) => ({
      starts_after_ms: value.startsAfterMs,
      closes_when_filled: value.closesWhenFilled,
    }),
    output: (value): HardCap => ({
      startsAfterMs: value.starts_after_ms,
      closesWhenFilled: value.closes_when_filled,
    }),
  });

/** BCS layout of `blast_presale::RecipientPayout`. */
export const recipientPayoutBcs = bcs.struct("RecipientPayout", {
  recipient: recipientBcs,
  amount: u64Bcs,
});

/** BCS layout of `fee_policy::ProtocolFees`. */
export const protocolFeesBcs = bcs
  .struct("ProtocolFees", {
    raise_bps: bpsBcs,
    token_bps: bpsBcs,
    lp_fee_meme_bps: bpsBcs,
    lp_fee_quote_bps: bpsBcs,
  })
  .transform({
    input: (value: ProtocolFees) => ({
      raise_bps: value.raiseBps,
      token_bps: value.tokenBps,
      lp_fee_meme_bps: value.lpFeeMemeBps,
      lp_fee_quote_bps: value.lpFeeQuoteBps,
    }),
    output: (value): ProtocolFees => ({
      raiseBps: value.raise_bps,
      tokenBps: value.token_bps,
      lpFeeMemeBps: value.lp_fee_meme_bps,
      lpFeeQuoteBps: value.lp_fee_quote_bps,
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
  duration_ms: u64Bcs,
  liquidity_window_ms: u64Bcs,
  start_ms: u64Bcs,
  raise_target: u64Bcs,
  eligibility: eligibilityPolicyBcs,
  uncapped: bcs.option(uncappedPhaseBcs),
  hard_cap: bcs.option(hardCapBcs),
  venue: moveTypeNameBcs,
  fee_split: feeSplitBcs,
  total_commitments: u64Bcs,
  participants: u64Bcs,
  quote: balanceBcs,
  token_allocation: u64Bcs,
  participant_vesting: bcs.option(vestingTermsBcs),
  sale_tokens: balanceBcs,
  liquidity_tokens: balanceBcs,
  recipient_payouts: bcs.vector(recipientPayoutBcs),
  recipient_tokens: balanceBcs,
  raise_payouts: bcs.vector(recipientPayoutBcs),
  protocol_fees: protocolFeesBcs,
  protocol_quote: u64Bcs,
  protocol_tokens: balanceBcs,
  partner_id: bcs.option(suiObjectIdBcs),
  fee_ledger: ledgerBcs,
});

/** BCS layout of `blast_presale::PresaleCap`, the creator's owned capability. */
export const presaleCapBcs = bcs.struct("PresaleCap", {
  id: suiUidBcs,
  presale_id: suiObjectIdBcs,
});

/** BCS layout of `blast_presale::Commitment`, stored under `CommitmentKey(address)`. */
export const commitmentBcs = bcs.struct("Commitment", {
  quote: u64Bcs,
  wallet_cap: u64Bcs,
});

/** BCS layout of `fee_policy::FeePolicy`, the package's one shared fee policy. */
export const feePolicyBcs = bcs.struct("FeePolicy", {
  id: suiUidBcs,
  fees: delayedBcs(unitKeyBcs, protocolFeesBcs),
});

/** BCS layout of `creation_policy::CreationPolicy`, the package's one shared creation policy. */
export const creationPolicyBcs = bcs.struct("CreationPolicy", {
  id: suiUidBcs,
  allowed_quotes: vecSetBcs(moveTypeNameBcs),
  venues: delayedSetBcs(unitKeyBcs, moveTypeNameBcs),
  partners: partnerListBcs,
});

// === Decoded objects ===

export type PresaleObject = {
  objectId: string;
  initialSharedVersion: number | string;
  type: string;
  content: Uint8Array;
};

export type PresaleState = SharedObjectReference<true> & {
  saleTokenType: string;
  quoteType: string;
  presaleCapId: string;
  lifecycle: PresaleLifecycle;
  /** The window's length: as created until the sale closes early, then the time it ran. */
  durationMs: bigint;
  liquidityWindowMs: bigint;
  /** When commitments open, fixed by `share`; zero while Pending. */
  startMs: bigint;
  /**
   * Exclusive commitment end, derived from the start; zero while Pending. An
   * early close moves it to the settle.
   */
  endMs: bigint;
  /**
   * From this timestamp anyone may cancel an unmigrated funded sale, derived
   * from the start; zero while Pending.
   */
  liquidityDeadlineMs: bigint;
  raiseTarget: bigint;
  eligibility: EligibilityPolicy;
  uncapped: UncappedPhase | null;
  /**
   * When wallet caps lift, derived from the start; `endMs` without an
   * uncapped phase, zero while Pending.
   */
  uncappedFromMs: bigint;
  hardCap: HardCap | null;
  /**
   * When the hard cap takes hold, derived from the start; null without one,
   * zero while Pending.
   */
  hardCapFromMs: bigint | null;
  /** The venue witness type (original IDs) the sale migrates to; see `venueOf`. */
  venue: string;
  /** The LP-fee split the sale's vault starts with. */
  feeSplit: FeeSplit;
  totalCommitments: bigint;
  /**
   * Wallets holding an undelivered commitment: each joins with its first
   * commitment and leaves with its claim, so the claim that leaves one
   * takes the rounding remainder.
   */
  participants: bigint;
  /** Quote custody balance. */
  quote: bigint;
  /**
   * Participant token allocation: fixed at creation, then by any
   * `ProtocolFeesChanged` before the start.
   */
  tokenAllocation: bigint;
  /**
   * Terms each claim locks a participant's tokens under, in a schedule that
   * starts at the claim; null when claims pay tokens out.
   */
  participantVesting: VestingTerms | null;
  /** Participant tokens still in custody. */
  saleTokens: bigint;
  liquidityTokens: bigint;
  recipientPayouts: RecipientPayout[];
  recipientTokens: bigint;
  raisePayouts: RecipientPayout[];
  /** Blast's rates: snapshotted at creation; Blast's `FeeAdmin` may replace them before the start. */
  protocolFees: ProtocolFees;
  /** Blast's share of the raise, moved into `feeLedger` on migration. */
  protocolQuote: bigint;
  /** Blast's token share still in custody until migration; locked forever on cancellation. */
  protocolTokens: bigint;
  /** The Blast partner named at creation, paid its cut of Blast's fees. */
  partnerId: string | null;
  /**
   * Blast's raise and token fees from migration until paid: paid at once
   * without a partner, held for `pay_protocol_fees_with_partner` with one.
   */
  feeLedger: Ledger;
};

/** `fee_policy::FeePolicy`: the rates new presales snapshot. */
export type PresaleFeePolicyState = SharedObjectReference<true> & {
  fees: ProtocolFees;
  feesPolicy: Delayed<null, ProtocolFees>;
};

/**
 * `creation_policy::CreationPolicy`: the Quote types, venue witnesses and
 * partners new presales may use, as normalized type strings and IDs. Checked
 * once, at creation; existing sales are unaffected. Accepted partners are
 * entries of the `partners.acceptanceTableId` table.
 */
export type PresaleCreationPolicyState = SharedObjectReference<true> & {
  allowedQuotes: string[];
  venues: string[];
  /** The applied delay for new venue admissions. */
  venueDelayMs: bigint;
  /** A proposed next admission delay. */
  pendingVenueDelay: PendingDelay | null;
  /** Pending admissions; each keeps the deadline it was scheduled with. */
  pendingVenues: Readonly<Record<string, Deadline>>;
  venuesPolicy: DelayedSet<null, string>;
  partners: { owner: string; acceptanceTableId: string; size: bigint };
};

export type PresaleCommitment = { quote: bigint; walletCap: bigint };

export function decodePresaleObject(
  object: PresaleObject,
  originalPackageId: string,
): PresaleState {
  const [saleTokenType, quoteType] = pairTypes(object, originalPackageId);
  const parsed = presaleBcs.parse(object.content);
  return {
    ...sharedIdentity(object, parsed.id.id.bytes),
    saleTokenType,
    quoteType,
    presaleCapId: normalizeSuiObjectId(parsed.presale_cap_id.bytes),
    lifecycle: parsed.lifecycle,
    durationMs: parsed.duration_ms,
    liquidityWindowMs: parsed.liquidity_window_ms,
    startMs: parsed.start_ms,
    ...presaleWindowsOf(parsed),
    raiseTarget: parsed.raise_target,
    eligibility: parsed.eligibility,
    uncapped: parsed.uncapped,
    hardCap: parsed.hard_cap,
    venue: parsed.venue,
    feeSplit: parsed.fee_split,
    totalCommitments: parsed.total_commitments,
    participants: parsed.participants,
    quote: parsed.quote,
    tokenAllocation: parsed.token_allocation,
    participantVesting: parsed.participant_vesting,
    saleTokens: parsed.sale_tokens,
    liquidityTokens: parsed.liquidity_tokens,
    recipientPayouts: parsed.recipient_payouts,
    recipientTokens: parsed.recipient_tokens,
    raisePayouts: parsed.raise_payouts,
    protocolFees: parsed.protocol_fees,
    protocolQuote: parsed.protocol_quote,
    protocolTokens: parsed.protocol_tokens,
    partnerId: parsed.partner_id,
    feeLedger: parsed.fee_ledger,
  };
}

/**
 * The windows `share` fixed. The contract stores only the start and derives
 * the rest; every window reads zero while the sale is Pending.
 */
function presaleWindowsOf(
  parsed: ReturnType<typeof presaleBcs.parse>,
): Pick<
  PresaleState,
  "endMs" | "liquidityDeadlineMs" | "uncappedFromMs" | "hardCapFromMs"
> {
  if (parsed.lifecycle === "Pending") {
    return {
      endMs: 0n,
      liquidityDeadlineMs: 0n,
      uncappedFromMs: 0n,
      hardCapFromMs: parsed.hard_cap ? 0n : null,
    };
  }
  return presaleWindows(
    parsed.start_ms,
    parsed.duration_ms,
    parsed.liquidity_window_ms,
    parsed.uncapped,
    parsed.hard_cap,
  );
}

export function decodePresaleFeePolicyObject(
  object: PresaleObject,
  originalPackageId: string,
): PresaleFeePolicyState {
  assertSingletonType(object, "fee_policy", "FeePolicy", originalPackageId);
  const parsed = feePolicyBcs.parse(object.content);
  return {
    ...sharedIdentity(object, parsed.id.id.bytes, [parsed.fees.owner]),
    fees: parsed.fees.value,
    feesPolicy: parsed.fees,
  };
}

export function decodePresaleCreationPolicyObject(
  object: PresaleObject,
  originalPackageId: string,
): PresaleCreationPolicyState {
  assertSingletonType(
    object,
    "creation_policy",
    "CreationPolicy",
    originalPackageId,
  );
  const parsed = creationPolicyBcs.parse(object.content);
  const venues = admission(parsed.venues);
  return {
    ...sharedIdentity(object, parsed.id.id.bytes, [
      parsed.venues.owner,
      parsed.partners.owner,
    ]),
    allowedQuotes: parsed.allowed_quotes,
    venues: venues.members,
    venueDelayMs: venues.delayMs,
    pendingVenueDelay: venues.pendingDelay,
    pendingVenues: venues.pendingMembers,
    venuesPolicy: parsed.venues,
    partners: {
      owner: parsed.partners.owner,
      acceptanceTableId: parsed.partners.acceptance_ends_at_ms.id,
      size: parsed.partners.acceptance_ends_at_ms.size,
    },
  };
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

export async function getPresaleFeePolicy(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<PresaleFeePolicyState> {
  return decodePresaleFeePolicyObject(
    await getSharedObject(client, objectId),
    originalPackageId,
  );
}

export async function getPresaleCreationPolicy(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<PresaleCreationPolicyState> {
  return decodePresaleCreationPolicyObject(
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
  originalPackageId: string,
): [string, string] {
  const tag = parseStructTag(object.type);
  const [saleTokenType, quoteType, ...extra] = tag.typeParams;
  if (
    tag.module !== "blast_presale" ||
    tag.name !== "Presale" ||
    saleTokenType === undefined ||
    quoteType === undefined ||
    extra.length > 0 ||
    tag.address !== normalizeSuiAddress(originalPackageId)
  ) {
    throw new TypeError(`object ${object.objectId} is not a presale Presale`);
  }
  return [normalizeStructTag(saleTokenType), normalizeStructTag(quoteType)];
}

/** The package's shared singletons have no type arguments. */
function assertSingletonType(
  object: PresaleObject,
  module: string,
  name: string,
  originalPackageId: string,
): void {
  const tag = parseStructTag(object.type);
  if (
    tag.module !== module ||
    tag.name !== name ||
    tag.typeParams.length !== 0 ||
    tag.address !== normalizeSuiAddress(originalPackageId)
  ) {
    throw new TypeError(`object ${object.objectId} is not a presale ${name}`);
  }
}

/** `owners` are the object's delayed values' and partner list's owners, which must be the object. */
function sharedIdentity(
  object: PresaleObject,
  uid: string,
  owners: readonly string[] = [],
): SharedObjectReference<true> {
  const objectId = normalizeSuiObjectId(object.objectId);
  if (
    normalizeSuiObjectId(uid) !== objectId ||
    owners.some((owner) => normalizeSuiObjectId(owner) !== objectId)
  ) {
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

/**
 * The ID of the `Presale<SaleToken, Quote>` for `saleTokenType`:
 * `derived_object::derive_address(presale_registry, PresaleKey<SaleToken>())`.
 * The key has no fields (one `dummy_field: bool` byte); pass original package
 * IDs, as `type_name::with_original_ids` would name them.
 */
export function presaleId(
  presale: {
    originalPackageId: string;
    presaleRegistry: SharedObjectIdentity;
  },
  saleTokenType: string,
): string {
  return deriveObjectID(
    normalizeSuiObjectId(presale.presaleRegistry.objectId),
    `${normalizeSuiObjectId(presale.originalPackageId)}::blast_presale::PresaleKey<${normalizeStructTag(saleTokenType)}>`,
    unitKeyBcs.serialize(null).toBytes(),
  );
}

/**
 * The ID of the vault a migrated presale's venue created: the vault's
 * `vaultId` keyed by `blast_presale::blast_presale_package::PackageWitness`
 * (original IDs) and the presale ID. The Aftermath DAO-pool vendor creates no
 * vault, so its sales have none.
 */
export function presaleVaultId(
  vault: Pick<VaultDeployment, "originalPackageId" | "registry">,
  presale: { originalPackageId: string },
  presaleId: string,
): string {
  return vaultId(
    vault,
    `${normalizeSuiObjectId(presale.originalPackageId)}::blast_presale_package::PackageWitness`,
    presaleId,
  );
}
