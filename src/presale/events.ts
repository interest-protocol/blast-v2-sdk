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
  ProtocolFees,
  UncappedPhase,
} from "./state.ts";
import {
  eligibilityPolicyBcs,
  protocolFeesBcs,
  uncappedPhaseBcs,
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
  | "protocolFees";

/** Every event `blast_presale` emits, by module, in Move field order. */
export const presaleEventSpecs = {
  blast_presale: {
    PresaleCreated: {
      presale_id: "id",
      presale_cap_id: "id",
      treasury_cap_id: "id",
      token_supply: "u64",
      token_allocation_bps: "u64",
      liquidity_token_allocation_bps: "u64",
      recipients: "addressVector",
      recipient_bps: "u64Vector",
      burnable: "bool",
      raise_target: "u64",
      raise_recipients: "addressVector",
      raise_recipient_bps: "u64Vector",
      duration_ms: "u64",
      liquidity_window_ms: "u64",
      eligibility: "eligibility",
      uncapped: "optionUncapped",
      migration_witness: "typeName",
      tick_spacing: "u32",
      fee_rate: "u64",
      fee_recipients: "addressVector",
      fee_recipient_bps: "u64Vector",
      rewards_fee_bps: "u64",
      protocol_fees: "protocolFees",
      protocol_quote: "u64",
      protocol_tokens: "u64",
    },
    PresaleOpened: {
      presale_id: "id",
      start_ms: "u64",
      end_ms: "u64",
      liquidity_deadline_ms: "u64",
      uncapped_from_ms: "u64",
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
      commitments: "u64",
      accepted_quote: "u64",
      refundable_quote: "u64",
      token_allocation: "u64",
    },
    PresaleCancelled: {
      presale_id: "id",
      commitments: "u64",
      refundable_quote: "u64",
    },
    PresaleMigrated: {
      presale_id: "id",
      migration_witness: "typeName",
      quote: "u64",
      liquidity_tokens: "u64",
      recipient_tokens: "u64",
    },
    ProtocolFeesPaid: {
      presale_id: "id",
      destination: "address",
      quote: "u64",
      tokens: "u64",
    },
    RaiseAllocated: {
      presale_id: "id",
      recipient: "address",
      quote: "u64",
    },
    RecipientAllocated: {
      presale_id: "id",
      recipient: "address",
      tokens: "u64",
    },
    Claimed: {
      presale_id: "id",
      participant: "address",
      commitment: "u64",
      tokens: "u64",
      quote_refund: "u64",
      remaining_commitments: "u64",
    },
  },
  presale_vault: {
    PresaleVaultCreated: {
      vault_id: "id",
      presale_id: "id",
      pool_id: "id",
      position_id: "id",
      liquidity: "u128",
      fee_recipients: "addressVector",
      fee_recipient_bps: "u64Vector",
      rewards_fee_bps: "u64",
      protocol_lp_meme_bps: "u64",
      protocol_lp_quote_bps: "u64",
      migration_meme_residual: "u64",
      migration_quote_residual: "u64",
    },
    FeesCollected: {
      vault_id: "id",
      gross_meme: "u64",
      gross_quote: "u64",
      protocol_destination: "address",
      protocol_meme: "u64",
      protocol_quote: "u64",
      recipient_meme: "u64Vector",
      recipient_quote: "u64Vector",
      rewards_meme: "u64",
      rewards_quote: "u64",
    },
    MigrationResidualsClaimed: {
      vault_id: "id",
      meme: "u64",
      quote: "u64",
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
    },
    RoundClosed: {
      vault_id: "id",
      round_id: "id",
      number: "u64",
      meme_returned: "u64",
      quote_returned: "u64",
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
  },
} as const satisfies Record<
  string,
  Record<string, Record<string, PresaleEventFieldDescriptor>>
>;

type Specs = typeof presaleEventSpecs;
export type PresaleEventModule = keyof Specs;
type FlatSpecs = Specs["blast_presale"] &
  Specs["presale_vault"] &
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
  protocolFees: ProtocolFees;
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
  protocolFees: protocolFeesBcs as BcsType<unknown>,
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
    /** `PresaleVaultCreated` only: the venue marker, e.g. `<pkg>::cetus::Venue`. */
    venueType: string | null;
    /** Transaction sender; for `Committed`, the committing wallet. */
    sender: string;
    position: SuiEventPosition;
  };
}[PresaleEventKind];

/**
 * Decodes one event whose type is `<originalPackageId>::<module>::<Kind><...>`.
 * Every presale event is generic over `<SaleToken, Quote>`, and
 * `PresaleVaultCreated` also over its `Venue`.
 */
export function decodePresaleEvent(
  event: SuiClientTypes.EventEntry,
  packages: { originalPackageId: string },
): DecodedPresaleEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as PresaleEventKind;
  const venue = kind === "PresaleVaultCreated";
  if (
    tag.address !== normalizeSuiAddress(packages.originalPackageId) ||
    !Object.hasOwn(presaleEventModules, kind) ||
    presaleEventModules[kind] !== tag.module ||
    tag.typeParams.length !== (venue ? 3 : 2)
  ) {
    throw new TypeError(`unexpected presale event type ${event.eventType}`);
  }
  const [memeType, quoteType, venueType] = tag.typeParams.map((type) =>
    normalizeStructTag(type),
  );
  return {
    source: "presale",
    kind,
    payload: presaleEventBcs[kind].parse(event.bcs),
    memeType: memeType!,
    quoteType: quoteType!,
    venueType: venueType ?? null,
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedPresaleEvent;
}

export function presaleEventId(event: DecodedPresaleEvent): string {
  return suiEventId(event.position);
}

/** `fee_policy` events. Unlike every other presale event they have no type arguments. */
export const presaleFeePolicyEventSpecs = {
  FeesChanged: {
    raise_bps: "u64",
    token_bps: "u64",
    lp_meme_bps: "u64",
    lp_quote_bps: "u64",
  },
  DestinationChanged: { destination: "address" },
} as const satisfies Record<
  string,
  Record<string, PresaleEventFieldDescriptor>
>;

type FeePolicySpecs = typeof presaleFeePolicyEventSpecs;
export type PresaleFeePolicyEventKind = keyof FeePolicySpecs;

export type DecodedPresaleFeePolicyEvent = {
  [Kind in PresaleFeePolicyEventKind]: {
    source: "presale-fee-policy";
    kind: Kind;
    payload: {
      -readonly [Field in keyof FeePolicySpecs[Kind]]: DescriptorOutputs[Extract<
        FeePolicySpecs[Kind][Field],
        PresaleEventFieldDescriptor
      >];
    };
    sender: string;
    position: SuiEventPosition;
  };
}[PresaleFeePolicyEventKind];

const presaleFeePolicyEventBcs = Object.fromEntries(
  Object.entries(presaleFeePolicyEventSpecs).map(([kind, spec]) => [
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
) as Record<PresaleFeePolicyEventKind, BcsType<unknown>>;

/** Decodes one `<originalPackageId>::fee_policy::<Kind>` event. */
export function decodePresaleFeePolicyEvent(
  event: SuiClientTypes.EventEntry,
  packages: { originalPackageId: string },
): DecodedPresaleFeePolicyEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as PresaleFeePolicyEventKind;
  if (
    tag.address !== normalizeSuiAddress(packages.originalPackageId) ||
    tag.module !== "fee_policy" ||
    !Object.hasOwn(presaleFeePolicyEventSpecs, kind) ||
    tag.typeParams.length !== 0
  ) {
    throw new TypeError(
      `unexpected presale fee-policy event ${event.eventType}`,
    );
  }
  return {
    source: "presale-fee-policy",
    kind,
    payload: presaleFeePolicyEventBcs[kind].parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedPresaleFeePolicyEvent;
}
