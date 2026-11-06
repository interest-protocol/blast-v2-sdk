import type {
  DecodedDelayedEvent,
  DelayedKeySpecs,
} from "@interest-protocol/blast-admin-sdk/events";
import { decodeDelayedEvent } from "@interest-protocol/blast-admin-sdk/events";
import {
  addressBcs,
  moveTypeNameBcs,
  suiObjectIdBcs,
  u64Bcs,
  unitKeyBcs,
} from "@interest-protocol/blast-core/bcs";
import type { SuiEventPosition } from "@interest-protocol/blast-core/events";
import {
  normalizeSuiEventPosition,
  suiEventId,
} from "@interest-protocol/blast-core/events";
import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import { feeSplitBcs } from "@interest-protocol/blast-core/fee-split";
import type {
  Recipient,
  VestingTerms,
} from "@interest-protocol/blast-core/payout";
import {
  recipientBcs,
  vestingTermsBcs,
} from "@interest-protocol/blast-core/payout";
import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from "@mysten/sui/utils";
import type { EligibilityPolicy, HardCap, UncappedPhase } from "./state.ts";
import {
  eligibilityPolicyBcs,
  hardCapBcs,
  protocolFeesBcs,
  uncappedPhaseBcs,
} from "./state.ts";

type PresaleEventFieldDescriptor =
  | "id"
  | "typeName"
  | "address"
  | "bool"
  | "u64"
  | "u64Vector"
  | "recipientVector"
  | "eligibility"
  | "feeSplit"
  | "optionUncapped"
  | "optionHardCap"
  | "optionU64"
  | "optionId"
  | "optionVesting";

/**
 * Every `<SaleToken, Quote>` event the presale package emits, by module, in
 * Move field order: `PresaleCreated` is declared in `blast_presale`, the rest
 * in `events`. `QuoteAllowed<Quote>` is `decodePresalePolicyEvent`'s; Blast's
 * fee payouts emit core `ProtocolFeesPaid` (origin = presale ID) and partner
 * list changes the partners package's events.
 */
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
      recipients: "recipientVector",
      recipient_bps: "u64Vector",
      burnable: "bool",
      raise_target: "u64",
      raise_recipients: "recipientVector",
      raise_recipient_bps: "u64Vector",
      duration_ms: "u64",
      liquidity_window_ms: "u64",
      eligibility: "eligibility",
      uncapped: "optionUncapped",
      hard_cap: "optionHardCap",
      venue: "typeName",
      fee_split: "feeSplit",
      protocol_raise_bps: "u64",
      protocol_token_bps: "u64",
      protocol_lp_fee_meme_bps: "u64",
      protocol_lp_fee_quote_bps: "u64",
      protocol_quote: "u64",
      protocol_tokens: "u64",
    },
  },
  events: {
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
      venue: "typeName",
      liquidity_quote: "u64",
      liquidity_tokens: "u64",
      recipient_tokens: "u64",
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
} as const satisfies Record<
  string,
  Record<string, Record<string, PresaleEventFieldDescriptor>>
>;

type Specs = typeof presaleEventSpecs;
export type PresaleEventModule = keyof Specs;
type FlatSpecs = Specs["blast_presale"] & Specs["events"];
export type PresaleEventKind = keyof FlatSpecs;

type DescriptorOutputs = {
  id: string;
  typeName: string;
  address: string;
  bool: boolean;
  u64: bigint;
  u64Vector: bigint[];
  recipientVector: Recipient[];
  eligibility: EligibilityPolicy;
  feeSplit: FeeSplit;
  optionUncapped: UncappedPhase | null;
  /** Null for a sale that overflows for its whole window. */
  optionHardCap: HardCap | null;
  /** Null for a sale without a hard cap. */
  optionU64: bigint | null;
  /** A partner ID, or a `blast_fun_linear_vesting::Vesting` ID; null for none. */
  optionId: string | null;
  /** Null when the tokens are paid out. */
  optionVesting: VestingTerms | null;
};

export type PresaleEventPayloads = {
  [Kind in PresaleEventKind]: {
    -readonly [Field in keyof FlatSpecs[Kind]]: DescriptorOutputs[Extract<
      FlatSpecs[Kind][Field],
      PresaleEventFieldDescriptor
    >];
  };
};

const FIELD_BCS: Record<PresaleEventFieldDescriptor, BcsType<unknown>> = {
  id: suiObjectIdBcs as BcsType<unknown>,
  typeName: moveTypeNameBcs as BcsType<unknown>,
  address: addressBcs as BcsType<unknown>,
  bool: bcs.bool() as BcsType<unknown>,
  u64: u64Bcs as BcsType<unknown>,
  u64Vector: bcs.vector(u64Bcs) as BcsType<unknown>,
  recipientVector: bcs.vector(recipientBcs) as BcsType<unknown>,
  eligibility: eligibilityPolicyBcs as BcsType<unknown>,
  feeSplit: feeSplitBcs as BcsType<unknown>,
  optionUncapped: bcs.option(uncappedPhaseBcs) as BcsType<unknown>,
  optionHardCap: bcs.option(hardCapBcs) as BcsType<unknown>,
  optionU64: bcs.option(u64Bcs) as BcsType<unknown>,
  optionId: bcs.option(suiObjectIdBcs) as BcsType<unknown>,
  optionVesting: bcs.option(vestingTermsBcs) as BcsType<unknown>,
};

/** Kind to Move module: `PresaleCreated` to `blast_presale`, the rest to `events`. */
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
    /** The event's `SaleToken` type argument. */
    saleTokenType: string;
    quoteType: string;
    /** Transaction sender; for `Committed`, the committing wallet. */
    sender: string;
    position: SuiEventPosition;
  };
}[PresaleEventKind];

/**
 * Decodes one `<originalPackageId>::<module>::<Kind><SaleToken, Quote>`
 * event: `blast_presale::PresaleCreated` or one of the `events` structs.
 */
export function decodePresaleEvent(
  event: SuiClientTypes.EventEntry,
  presale: { originalPackageId: string },
): DecodedPresaleEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as PresaleEventKind;
  const [saleTokenType, quoteType, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(presale.originalPackageId) ||
    !Object.hasOwn(presaleEventModules, kind) ||
    presaleEventModules[kind] !== tag.module ||
    saleTokenType === undefined ||
    quoteType === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(`unexpected presale event type ${event.eventType}`);
  }
  return {
    source: "presale",
    kind,
    payload: presaleEventBcs[kind].parse(event.bcs),
    saleTokenType: normalizeStructTag(saleTokenType),
    quoteType: normalizeStructTag(quoteType),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedPresaleEvent;
}

export function presaleEventId(event: { position: SuiEventPosition }): string {
  return suiEventId(event.position);
}

/** BCS of `events::QuoteAllowed<Quote>`; the Quote is only in the event type. */
export const quoteAllowedBcs = bcs.struct("QuoteAllowed", {
  allowed: bcs.bool(),
});

export type DecodedPresalePolicyEvent = {
  source: "presale-policy";
  kind: "QuoteAllowed";
  /** The event's `Quote` type argument. */
  quoteType: string;
  payload: { allowed: boolean };
  sender: string;
  position: SuiEventPosition;
};

/**
 * Decodes `<originalPackageId>::events::QuoteAllowed<Quote>`, emitted by
 * `creation_policy::set_quote_allowed`. Venue admissions and the fee policy
 * emit `blast_admin` delayed events (`decodePresaleDelayedEvent`); partner
 * acceptance emits `blast_partners::partner_list` events.
 */
export function decodePresalePolicyEvent(
  event: SuiClientTypes.EventEntry,
  presale: { originalPackageId: string },
): DecodedPresalePolicyEvent {
  const tag = parseStructTag(event.eventType);
  const [quoteType, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(presale.originalPackageId) ||
    tag.module !== "events" ||
    tag.name !== "QuoteAllowed" ||
    quoteType === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(`unexpected presale policy event ${event.eventType}`);
  }
  return {
    source: "presale-policy",
    kind: "QuoteAllowed",
    quoteType: normalizeStructTag(quoteType),
    payload: quoteAllowedBcs.parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  };
}

/**
 * Presale keys of `blast_admin` delayed values. Every schedule, cancel,
 * apply and creation fact is emitted by `blast_admin` under one of these
 * keys; `parent` names the `CreationPolicy` or `FeePolicy` that stores it. The
 * package's upgrade key is the admin package's `upgradeDelayedKey`.
 */
export const presaleDelayedKeys = {
  Venues: {
    key: "creation_policy::VenueKey",
    family: "set",
    keyBcs: unitKeyBcs,
    valueBcs: moveTypeNameBcs,
    valueType: "0x1::type_name::TypeName",
  },
  Fees: {
    key: "fee_policy::FeesKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: protocolFeesBcs,
    valueType: "{package}::fee_policy::ProtocolFees",
  },
} as const satisfies DelayedKeySpecs;

export type DecodedPresaleDelayedEvent = DecodedDelayedEvent<
  typeof presaleDelayedKeys
>;

/** Decodes a `<adminPackageId>::delayed*` event keyed by the presale package. */
export function decodePresaleDelayedEvent(
  event: SuiClientTypes.EventEntry,
  packages: { originalPackageId: string; adminPackageId: string },
): DecodedPresaleDelayedEvent {
  return decodeDelayedEvent(event, {
    adminPackageId: packages.adminPackageId,
    packageId: packages.originalPackageId,
    keys: presaleDelayedKeys,
  });
}
