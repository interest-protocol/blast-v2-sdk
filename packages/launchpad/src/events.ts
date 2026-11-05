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
import { bpsBcs } from "@interest-protocol/blast-core/bps";
import type { SuiEventPosition } from "@interest-protocol/blast-core/events";
import {
  normalizeSuiEventPosition,
  suiEventId,
} from "@interest-protocol/blast-core/events";
import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import { feeSplitBcs } from "@interest-protocol/blast-core/fee-split";
import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from "@mysten/sui/utils";
import type { AllocationPlan } from "./allocation.ts";
import { allocationPlanBcs, protocolAllocationBcs } from "./allocation.ts";
import type { CreatorRecipient } from "./state.ts";
import {
  claimSignerKeyBcs,
  creatorRecipientBcs,
  decodeCreatorRecipient,
  protocolLpFeesBcs,
  tradeFeesBcs,
} from "./state.ts";

type EventFieldDescriptor =
  | "id"
  | "typeName"
  | "address"
  | "u64"
  | "u8"
  | "bool"
  | "optionId"
  | "string"
  | "creatorRecipient"
  | "allocationPlan"
  | "feeSplit";

const tradeFees = {
  protocol_meme_fee: "u64",
  creator_meme_fee: "u64",
  protocol_quote_fee: "u64",
  creator_quote_fee: "u64",
} as const;

/** The 18 `blast_fun::events` structs, in Move field order. */
export const launchpadEventSpecs = {
  MemeDecimalsAllowed: { decimals: "u8", allowed: "bool" },
  /** The Quote is the event's type argument. */
  QuoteAllowed: { allowed: "bool" },
  CreatorCapsClaimed: {
    curve_fee_cap_id: "id",
    creator_metadata_cap_id: "id",
  },
  CurveFeeCapReassigned: {
    launch_id: "id",
    curve_fee_cap_id: "id",
    recipient: "address",
  },
  CreatorMetadataCapReassigned: {
    launch_id: "id",
    creator_metadata_cap_id: "id",
    recipient: "address",
  },
  MemeMetadataUpdated: {
    launch_id: "id",
    name: "string",
    description: "string",
    icon_url: "string",
  },
  LaunchTicketCreated: {
    ticket_id: "id",
    decimals: "u8",
    metadata_cap_id: "id",
    creator: "creatorRecipient",
    burnable: "bool",
    sell_burn_bps: "u64",
  },
  LaunchCreated: {
    launch_id: "id",
    ticket_id: "id",
    venue: "typeName",
    lp_fee_split: "feeSplit",
    virtual_quote: "u64",
    graduation_target: "u64",
    quote_fee_bps: "u64",
    meme_fee_bps: "u64",
    allocation_plan: "allocationPlan",
    opening_round_ms: "u64",
    creation_fee: "u64",
    partner_id: "optionId",
  },
  LaunchShared: { launch_id: "id", public_start_ms: "u64" },
  OpeningRoundJoined: { launch_id: "id", quote_amount: "u64", bids: "u64" },
  OpeningRoundSettled: {
    launch_id: "id",
    bids: "u64",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  OpeningRoundDelivered: {
    launch_id: "id",
    bidder: "address",
    bid: "u64",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  Bought: {
    launch_id: "id",
    quote_in: "u64",
    meme_out_gross: "u64",
    meme_out_net: "u64",
    quote_refund: "u64",
    ...tradeFees,
    meme_reserve: "u64",
    real_quote_reserve: "u64",
  },
  Sold: {
    launch_id: "id",
    meme_in_gross: "u64",
    pending_burn: "u64",
    quote_out_gross: "u64",
    ...tradeFees,
    meme_reserve: "u64",
    real_quote_reserve: "u64",
  },
  MigrationAllocationPaid: {
    launch_id: "id",
    destination: "address",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  Migrated: {
    launch_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
    disposed_meme: "u64",
    total_supply_after: "u64",
  },
  CreatorFeesClaimed: {
    launch_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  ProtocolFeesAccrued: {
    launch_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
  },
} as const satisfies Record<string, Record<string, EventFieldDescriptor>>;

export type LaunchpadEventKind = keyof typeof launchpadEventSpecs;

/** Events typed by the Quote only, by the Meme only, or by neither. */
const QUOTE_EVENTS: readonly LaunchpadEventKind[] = ["QuoteAllowed"];
const MEME_EVENTS: readonly LaunchpadEventKind[] = ["LaunchTicketCreated"];
const UNTYPED_EVENTS: readonly LaunchpadEventKind[] = ["MemeDecimalsAllowed"];

type DescriptorOutputs = {
  id: string;
  typeName: string;
  address: string;
  u64: bigint;
  u8: number;
  bool: boolean;
  optionId: string | null;
  string: string;
  creatorRecipient: NonNullable<CreatorRecipient>;
  allocationPlan: AllocationPlan;
  feeSplit: FeeSplit;
};
type DescriptorOutput<Descriptor extends EventFieldDescriptor> =
  DescriptorOutputs[Descriptor];

export type LaunchpadEventPayloads = {
  [Kind in LaunchpadEventKind]: {
    [Field in keyof (typeof launchpadEventSpecs)[Kind]]: DescriptorOutput<
      Extract<(typeof launchpadEventSpecs)[Kind][Field], EventFieldDescriptor>
    >;
  };
};

const CreatorRecipientBcs = creatorRecipientBcs.transform({
  input: (recipient: NonNullable<CreatorRecipient>) =>
    recipient.kind === "address"
      ? { Address: recipient.address }
      : { Account: Array.from(recipient.accountCommitment) },
  output: (recipient) =>
    decodeCreatorRecipient(recipient) as NonNullable<CreatorRecipient>,
});

const EVENT_FIELD_BCS: Record<
  EventFieldDescriptor,
  BcsType<unknown, unknown>
> = {
  id: suiObjectIdBcs as BcsType<unknown, unknown>,
  typeName: moveTypeNameBcs as BcsType<unknown, unknown>,
  address: addressBcs as BcsType<unknown, unknown>,
  u64: u64Bcs as BcsType<unknown, unknown>,
  u8: bcs.u8() as BcsType<unknown, unknown>,
  bool: bcs.bool() as BcsType<unknown, unknown>,
  optionId: bcs.option(suiObjectIdBcs) as BcsType<unknown, unknown>,
  string: bcs.string() as BcsType<unknown, unknown>,
  creatorRecipient: CreatorRecipientBcs as BcsType<unknown, unknown>,
  allocationPlan: allocationPlanBcs as BcsType<unknown, unknown>,
  feeSplit: feeSplitBcs as BcsType<unknown, unknown>,
};

type LaunchpadEventBcsMap = {
  [Kind in LaunchpadEventKind]: BcsType<
    LaunchpadEventPayloads[Kind],
    LaunchpadEventPayloads[Kind]
  >;
};

export const launchpadEventBcs = Object.fromEntries(
  Object.entries(launchpadEventSpecs).map(([name, spec]) => [
    name,
    bcs.struct(
      name,
      Object.fromEntries(
        Object.entries(spec).map(([field, descriptor]) => [
          field,
          EVENT_FIELD_BCS[descriptor],
        ]),
      ),
    ),
  ]),
) as unknown as LaunchpadEventBcsMap;

/**
 * Launchpad events are authenticated by their type, which names the original
 * package. Sui records the transaction's called package on each event, not the
 * emitting module: a venue's `migrate` in the same PTB, or a Meme package's
 * publication (`LaunchTicketCreated`), may carry them.
 */
export type LaunchpadEventPackageIdentity = {
  originalPackageId: string;
};

export type LaunchpadEventPosition = SuiEventPosition;

export type DecodedLaunchpadEvent = {
  [Kind in LaunchpadEventKind]: {
    source: "launchpad";
    kind: Kind;
    /** The event's `Meme` type argument; null on `QuoteAllowed` and `MemeDecimalsAllowed`. */
    memeType: string | null;
    /** The event's `Quote` type argument; null on `LaunchTicketCreated` and `MemeDecimalsAllowed`. */
    quoteType: string | null;
    payload: LaunchpadEventPayloads[Kind];
    sender: string;
    position: LaunchpadEventPosition;
  };
}[LaunchpadEventKind];

/** Decodes one `<launchpad original>::events::<Kind>[<Meme>][<Quote>]` event. */
export function decodeLaunchpadEvent(
  event: SuiClientTypes.EventEntry,
  packages: LaunchpadEventPackageIdentity,
): DecodedLaunchpadEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as LaunchpadEventKind;
  const types = tag.typeParams.map((type) => normalizeStructTag(type));
  const arity = UNTYPED_EVENTS.includes(kind)
    ? 0
    : QUOTE_EVENTS.includes(kind) || MEME_EVENTS.includes(kind)
      ? 1
      : 2;
  if (
    tag.address !== normalizeSuiAddress(packages.originalPackageId) ||
    tag.module !== "events" ||
    !Object.hasOwn(launchpadEventSpecs, kind) ||
    types.length !== arity
  ) {
    throw new TypeError(`unexpected launchpad event type ${event.eventType}`);
  }
  return {
    source: "launchpad",
    kind,
    memeType: QUOTE_EVENTS.includes(kind) ? null : (types[0] ?? null),
    quoteType: QUOTE_EVENTS.includes(kind)
      ? (types[0] ?? null)
      : (types[1] ?? null),
    payload: launchpadEventBcs[kind].parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedLaunchpadEvent;
}

export function launchpadEventId(event: {
  position: LaunchpadEventPosition;
}): string {
  return suiEventId(event.position);
}

/**
 * Launchpad keys of `blast_admin` delayed values. Every schedule, cancel,
 * apply and creation fact is emitted by `delayed`, `delayed_set` or
 * `delayed_action` under one of these keys; `owner` names the `LaunchConfig`,
 * `RuntimeConfig` or `Launch` that stores the value. `{core}` stands for the
 * `blast_core` original package.
 */
export const launchpadDelayedKeys = {
  TradeFees: {
    key: "launch_config::TradeFeesKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: tradeFeesBcs,
    valueType: "{package}::launch_config::TradeFees",
  },
  Venues: {
    key: "launch_config::VenueKey",
    family: "set",
    keyBcs: unitKeyBcs,
    valueBcs: moveTypeNameBcs,
    valueType: "0x1::type_name::TypeName",
  },
  ProtocolAllocation: {
    key: "launch_config::ProtocolAllocationKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: protocolAllocationBcs,
    valueType: "{package}::allocation::ProtocolAllocation",
  },
  ProtocolLpFees: {
    key: "launch_config::ProtocolLpFeesKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: protocolLpFeesBcs,
    valueType: "{package}::launch_config::ProtocolLpFees",
  },
  CreationFee: {
    key: "launch_config::CreationFeeKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: u64Bcs,
    valueType: "u64",
  },
  ProtocolFeeShare: {
    key: "runtime_config::ProtocolFeeShareKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: bpsBcs,
    valueType: "{core}::bps::Bps",
  },
  /** Hex Ed25519 keys that may sign account claims; revocation is `MemberRemoved`. */
  ClaimSigners: {
    key: "runtime_config::ClaimSignerKey",
    family: "set",
    keyBcs: unitKeyBcs,
    valueBcs: claimSignerKeyBcs,
    valueType: "vector<u8>",
  },
  CurveFeeCapReassignment: {
    key: "launch::CurveFeeCapReassignment",
    family: "action",
    keyBcs: unitKeyBcs,
    valueBcs: addressBcs,
    valueType: "address",
  },
  CreatorMetadataCapReassignment: {
    key: "launch::CreatorMetadataCapReassignment",
    family: "action",
    keyBcs: unitKeyBcs,
    valueBcs: addressBcs,
    valueType: "address",
  },
} as const satisfies DelayedKeySpecs;

export type DecodedLaunchpadDelayedEvent = DecodedDelayedEvent<
  typeof launchpadDelayedKeys
>;

/** Decodes a `blast_admin` delayed event keyed by the launchpad. */
export function decodeLaunchpadDelayedEvent(
  event: SuiClientTypes.EventEntry,
  packages: LaunchpadEventPackageIdentity & {
    adminPackageId: string;
    coreOriginalPackageId: string;
  },
): DecodedLaunchpadDelayedEvent {
  const core = normalizeSuiAddress(packages.coreOriginalPackageId);
  const keys = Object.fromEntries(
    Object.entries(launchpadDelayedKeys).map(([name, spec]) => [
      name,
      { ...spec, valueType: spec.valueType.replaceAll("{core}", core) },
    ]),
  ) as typeof launchpadDelayedKeys;
  return decodeDelayedEvent(event, {
    adminPackageId: packages.adminPackageId,
    packageId: packages.originalPackageId,
    keys,
  });
}
