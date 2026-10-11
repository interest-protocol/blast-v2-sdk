import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
  toHex,
} from "@mysten/sui/utils";

import { moveTypeNameBcs, suiObjectIdBcs } from "../lib/bcs.ts";
import type { SuiEventPosition } from "../lib/events.ts";
import { normalizeSuiEventPosition, suiEventId } from "../lib/events.ts";
import type {
  EligibilityPolicy,
  HardCap,
  UncappedPhase,
  VestingTerms,
} from "./state.ts";
import {
  eligibilityPolicyBcs,
  hardCapBcs,
  uncappedPhaseBcs,
  vestingTermsBcs,
} from "./state.ts";

type PresaleEventFieldDescriptor =
  | "id"
  | "typeName"
  | "address"
  | "bool"
  | "u32"
  | "u64"
  | "u128"
  | "bytes"
  | "addressVector"
  | "u64Vector"
  | "eligibility"
  | "optionUncapped"
  | "optionHardCap"
  | "optionU64"
  | "optionAddress"
  | "optionId"
  | "optionVesting"
  | "vestingVector";

/** Every event `blast_presale` emits, by module, in Move field order. */
export const presaleEventSpecs = {
  blast_presale: {
    PresaleCreated: {
      presale_id: "id",
      presale_cap_id: "id",
      treasury_cap_id: "id",
      token_supply: "u64",
      token_allocation_bps: "u64",
      participant_vesting: "optionVesting",
      liquidity_token_allocation_bps: "u64",
      recipients: "addressVector",
      recipient_bps: "u64Vector",
      recipient_vesting: "vestingVector",
      burnable: "bool",
      raise_target: "u64",
      raise_recipients: "addressVector",
      raise_recipient_bps: "u64Vector",
      raise_recipient_vesting: "vestingVector",
      duration_ms: "u64",
      liquidity_window_ms: "u64",
      eligibility: "eligibility",
      uncapped: "optionUncapped",
      hard_cap: "optionHardCap",
      migration_witness: "typeName",
      fee_recipients: "addressVector",
      fee_recipient_bps: "u64Vector",
      holder_rewards_bps: "u64",
      protocol_raise_bps: "u64",
      protocol_token_bps: "u64",
      protocol_lp_fee_meme_bps: "u64",
      protocol_lp_fee_quote_bps: "u64",
      protocol_quote: "u64",
      protocol_tokens: "u64",
    },
    PresaleOpened: {
      presale_id: "id",
      start_ms: "u64",
      end_ms: "u64",
      liquidity_deadline_ms: "u64",
      uncapped_from_ms: "u64",
      hard_cap_from_ms: "optionU64",
      partner_id: "optionId",
    },
    ProtocolFeesChanged: {
      presale_id: "id",
      protocol_raise_bps: "u64",
      protocol_token_bps: "u64",
      protocol_lp_fee_meme_bps: "u64",
      protocol_lp_fee_quote_bps: "u64",
      protocol_quote: "u64",
      protocol_tokens: "u64",
      token_allocation: "u64",
    },
    Committed: {
      presale_id: "id",
      quote: "u64",
      wallet_commitment: "u64",
      total_commitments: "u64",
      participants: "u64",
    },
    PresaleFunded: {
      presale_id: "id",
      total_commitments: "u64",
      accepted_quote: "u64",
      refundable_quote: "u64",
      token_allocation: "u64",
      end_ms: "u64",
      liquidity_deadline_ms: "u64",
    },
    PresaleCancelled: {
      presale_id: "id",
      total_commitments: "u64",
      refundable_quote: "u64",
    },
    PresaleMigrated: {
      presale_id: "id",
      migration_witness: "typeName",
      liquidity_quote: "u64",
      liquidity_tokens: "u64",
      recipient_tokens: "u64",
    },
    ProtocolFeesPaid: {
      presale_id: "id",
      destination: "address",
      quote: "u64",
      tokens: "u64",
      partner_quote: "u64",
    },
    RaiseAllocated: {
      presale_id: "id",
      recipient: "address",
      quote: "u64",
      vesting_id: "optionId",
    },
    RecipientAllocated: {
      presale_id: "id",
      recipient: "address",
      tokens: "u64",
      vesting_id: "optionId",
    },
    Claimed: {
      presale_id: "id",
      participant: "address",
      wallet_commitment: "u64",
      tokens: "u64",
      quote_refund: "u64",
      remaining_participants: "u64",
      vesting_id: "optionId",
    },
  },
  presale_vault: {
    VaultCreated: {
      vault_id: "id",
      presale_id: "id",
      pool_id: "id",
      position_id: "id",
      liquidity: "u128",
      fee_recipients: "addressVector",
      fee_recipient_bps: "u64Vector",
      holder_rewards_bps: "u64",
      protocol_lp_fee_meme_bps: "u64",
      protocol_lp_fee_quote_bps: "u64",
      migration_meme_residual: "u64",
      migration_quote_residual: "u64",
    },
    FeesCollected: {
      vault_id: "id",
      gross_meme: "u64",
      gross_quote: "u64",
      protocol_destination: "optionAddress",
      protocol_meme: "u64",
      protocol_quote: "u64",
      fee_recipient_meme: "u64Vector",
      fee_recipient_quote: "u64Vector",
      holder_rewards_meme: "u64",
      holder_rewards_quote: "u64",
    },
    MigrationResidualsClaimed: {
      vault_id: "id",
      meme: "u64",
      quote: "u64",
    },
    ProtocolLpFeesPaid: {
      vault_id: "id",
      protocol_destination: "address",
      protocol_meme: "u64",
      protocol_quote: "u64",
      partner_meme: "u64",
      partner_quote: "u64",
    },
    ProtocolLpFeesChanged: {
      vault_id: "id",
      protocol_lp_fee_meme_bps: "u64",
      protocol_lp_fee_quote_bps: "u64",
    },
    HolderMemePaid: {
      vault_id: "id",
      treasury: "address",
      meme_amount: "u64",
      unallocated_meme_remaining: "u64",
    },
  },
  venue_config: {
    PoolTierReserved: {
      tick_spacing: "u32",
      pool_fee_rate: "u64",
    },
  },
  holder_rewards: {
    RoundPublished: {
      vault_id: "id",
      round_id: "id",
      number: "u64",
      start_checkpoint: "u64",
      end_checkpoint: "u64",
      claim_deadline_ms: "u64",
      root: "bytes",
      manifest_digest: "bytes",
      leaf_count: "u64",
      meme_amount: "u64",
      quote_amount: "u64",
      meme_unallocated: "u64",
      quote_unallocated: "u64",
      treasury: "address",
      gas_reserve_amount: "u64",
    },
    RewardClaimed: {
      round_id: "id",
      index: "u64",
      beneficiary: "address",
      meme_amount: "u64",
      quote_amount: "u64",
      meme_remaining: "u64",
      quote_remaining: "u64",
    },
    GasReserveSettled: {
      vault_id: "id",
      round_id: "id",
      number: "u64",
      treasury: "address",
      reimbursement_amount: "u64",
      reserve_returned: "u64",
      quote_unallocated: "u64",
    },
    RoundClosed: {
      vault_id: "id",
      round_id: "id",
      number: "u64",
      meme_returned: "u64",
      quote_returned: "u64",
      gas_reserve_returned: "u64",
    },
  },
} as const satisfies Record<
  string,
  Record<string, Record<string, PresaleEventFieldDescriptor>>
>;

type Specs = typeof presaleEventSpecs;
export type PresaleEventModule = keyof Specs;
type FlatSpecs = Specs["blast_presale"] &
  Specs["presale_vault"] &
  Specs["venue_config"] &
  Specs["holder_rewards"];
export type PresaleEventKind = keyof FlatSpecs;

type DescriptorOutputs = {
  id: string;
  typeName: string;
  address: string;
  bool: boolean;
  u32: number;
  u64: bigint;
  u128: bigint;
  /** Lowercase hex without `0x`. */
  bytes: string;
  addressVector: string[];
  u64Vector: bigint[];
  eligibility: EligibilityPolicy;
  optionUncapped: UncappedPhase | null;
  /** Null for a sale that overflows for its whole window. */
  optionHardCap: HardCap | null;
  /** Null for a sale without a hard cap. */
  optionU64: bigint | null;
  /** Null when a partnered vault holds Blast's LP fees for its partner payout. */
  optionAddress: string | null;
  /** A `blast_fun_linear_vesting::Vesting` ID, or null for a direct payout. */
  optionId: string | null;
  /** Null when the tokens are paid out. */
  optionVesting: VestingTerms | null;
  /** Aligned with the share list it follows; null for an unvested share. */
  vestingVector: (VestingTerms | null)[];
};

export type PresaleEventPayloads = {
  [Kind in PresaleEventKind]: {
    -readonly [Field in keyof FlatSpecs[Kind]]: DescriptorOutputs[Extract<
      FlatSpecs[Kind][Field],
      PresaleEventFieldDescriptor
    >];
  };
};

const u64 = bcs.u64().transform({
  input: (value: bigint) => value,
  output: (value) => BigInt(value),
});
const address = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});
const FIELD_BCS: Record<PresaleEventFieldDescriptor, BcsType<unknown>> = {
  id: suiObjectIdBcs as BcsType<unknown>,
  typeName: moveTypeNameBcs as BcsType<unknown>,
  address: address as BcsType<unknown>,
  bool: bcs.bool() as BcsType<unknown>,
  u32: bcs.u32() as BcsType<unknown>,
  u64: u64 as BcsType<unknown>,
  u128: bcs.u128().transform({
    input: (value: bigint) => value,
    output: (value) => BigInt(value),
  }) as BcsType<unknown>,
  bytes: bcs.vector(bcs.u8()).transform({
    input: (value: string) => Array.from(fromHex(value)),
    output: (value) => toHex(Uint8Array.from(value)),
  }) as BcsType<unknown>,
  addressVector: bcs.vector(address) as BcsType<unknown>,
  u64Vector: bcs.vector(u64) as BcsType<unknown>,
  eligibility: eligibilityPolicyBcs as BcsType<unknown>,
  optionUncapped: bcs.option(uncappedPhaseBcs) as BcsType<unknown>,
  optionHardCap: bcs.option(hardCapBcs) as BcsType<unknown>,
  optionU64: bcs.option(u64) as BcsType<unknown>,
  optionAddress: bcs.option(address) as BcsType<unknown>,
  optionId: bcs.option(suiObjectIdBcs) as BcsType<unknown>,
  optionVesting: bcs.option(vestingTermsBcs) as BcsType<unknown>,
  vestingVector: bcs.vector(bcs.option(vestingTermsBcs)) as BcsType<unknown>,
};

/** Kind to Move module, e.g. `FeesCollected` to `presale_vault`. */
export const presaleEventModules = Object.fromEntries(
  Object.entries(presaleEventSpecs).flatMap(([module, events]) =>
    Object.keys(events).map((kind) => [kind, module]),
  ),
) as Record<PresaleEventKind, PresaleEventModule>;

export const presaleEventBcs = Object.fromEntries(
  Object.values(presaleEventSpecs).flatMap((events) =>
    Object.entries(events).map(([kind, spec]) => [
      kind,
      bcs.struct(
        kind,
        Object.fromEntries(
          Object.entries(spec).map(([field, descriptor]) => [
            field,
            FIELD_BCS[descriptor as PresaleEventFieldDescriptor],
          ]),
        ),
      ),
    ]),
  ),
) as unknown as {
  [Kind in PresaleEventKind]: BcsType<
    PresaleEventPayloads[Kind],
    PresaleEventPayloads[Kind]
  >;
};

export type DecodedPresaleEvent = {
  [Kind in PresaleEventKind]: {
    source: "presale";
    kind: Kind;
    payload: PresaleEventPayloads[Kind];
    /** The event's `SaleToken` / `Meme` type argument. */
    memeType: string;
    quoteType: string;
    /**
     * `VaultCreated` and `PoolTierReserved` only: the venue marker, e.g.
     * `<pkg>::cetus::Venue`.
     */
    venueType: Kind extends VenueTypedKind ? string : null;
    /** Transaction sender; for `Committed`, the committing wallet. */
    sender: string;
    position: SuiEventPosition;
  };
}[PresaleEventKind];

/** The events generic over a venue marker after `<SaleToken, Quote>`. */
type VenueTypedKind = "VaultCreated" | "PoolTierReserved";
const VENUE_TYPED_KINDS: ReadonlySet<string> = new Set<VenueTypedKind>([
  "VaultCreated",
  "PoolTierReserved",
]);

/**
 * Decodes one event whose type is `<originalPackageId>::<module>::<Kind><...>`.
 * Every presale event is generic over `<SaleToken, Quote>`, and
 * `VaultCreated` and `PoolTierReserved` also over their `Venue`.
 */
export function decodePresaleEvent(
  event: SuiClientTypes.EventEntry,
  packages: { originalPackageId: string },
): DecodedPresaleEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as PresaleEventKind;
  const [memeType, quoteType, venueType = null, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(packages.originalPackageId) ||
    !Object.hasOwn(presaleEventModules, kind) ||
    presaleEventModules[kind] !== tag.module ||
    memeType === undefined ||
    quoteType === undefined ||
    (venueType === null) === VENUE_TYPED_KINDS.has(kind) ||
    extra.length > 0
  ) {
    throw new TypeError(`unexpected presale event type ${event.eventType}`);
  }
  return {
    source: "presale",
    kind,
    payload: presaleEventBcs[kind].parse(event.bcs),
    memeType: normalizeStructTag(memeType),
    quoteType: normalizeStructTag(quoteType),
    venueType: venueType && normalizeStructTag(venueType),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedPresaleEvent;
}

export function presaleEventId(event: DecodedPresaleEvent): string {
  return suiEventId(event.position);
}

/**
 * The `fee_policy` and `creation_policy` events, by module. Unlike every other presale event they have no type arguments.
 */
export const presalePolicyEventSpecs = {
  fee_policy: {
    FeesChanged: {
      raise_bps: "u64",
      token_bps: "u64",
      lp_fee_meme_bps: "u64",
      lp_fee_quote_bps: "u64",
    },
    DestinationChanged: { destination: "address" },
  },
  creation_policy: {
    QuoteSet: { quote: "typeName", allowed: "bool" },
    MigrationWitnessSet: { migration_witness: "typeName", allowed: "bool" },
    PartnerAdded: { partner_id: "id" },
    PartnerRemoved: { partner_id: "id", accepted_until_ms: "u64" },
  },
} as const satisfies Record<
  string,
  Record<string, Record<string, PresaleEventFieldDescriptor>>
>;

type PolicySpecs = typeof presalePolicyEventSpecs;
type FlatPolicySpecs = PolicySpecs["fee_policy"] &
  PolicySpecs["creation_policy"];
export type PresalePolicyEventKind = keyof FlatPolicySpecs;

export type DecodedPresalePolicyEvent = {
  [Kind in PresalePolicyEventKind]: {
    source: "presale-policy";
    kind: Kind;
    payload: {
      -readonly [Field in keyof FlatPolicySpecs[Kind]]: DescriptorOutputs[Extract<
        FlatPolicySpecs[Kind][Field],
        PresaleEventFieldDescriptor
      >];
    };
    sender: string;
    position: SuiEventPosition;
  };
}[PresalePolicyEventKind];

const presalePolicyEventModules = Object.fromEntries(
  Object.entries(presalePolicyEventSpecs).flatMap(([module, events]) =>
    Object.keys(events).map((kind) => [kind, module]),
  ),
) as Record<PresalePolicyEventKind, keyof PolicySpecs>;

const presalePolicyEventBcs = Object.fromEntries(
  Object.values(presalePolicyEventSpecs).flatMap((events) =>
    Object.entries(events).map(([kind, spec]) => [
      kind,
      bcs.struct(
        kind,
        Object.fromEntries(
          Object.entries(spec).map(([field, descriptor]) => [
            field,
            FIELD_BCS[descriptor as PresaleEventFieldDescriptor],
          ]),
        ),
      ),
    ]),
  ),
) as Record<PresalePolicyEventKind, BcsType<unknown>>;

/**
 * Decodes one `<originalPackageId>::fee_policy::<Kind>` or
 * `creation_policy::<Kind>` event.
 */
export function decodePresalePolicyEvent(
  event: SuiClientTypes.EventEntry,
  packages: { originalPackageId: string },
): DecodedPresalePolicyEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as PresalePolicyEventKind;
  if (
    tag.address !== normalizeSuiAddress(packages.originalPackageId) ||
    !Object.hasOwn(presalePolicyEventModules, kind) ||
    presalePolicyEventModules[kind] !== tag.module ||
    tag.typeParams.length !== 0
  ) {
    throw new TypeError(`unexpected presale policy event ${event.eventType}`);
  }
  return {
    source: "presale-policy",
    kind,
    payload: presalePolicyEventBcs[kind].parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedPresalePolicyEvent;
}
