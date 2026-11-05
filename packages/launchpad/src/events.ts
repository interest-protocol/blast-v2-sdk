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
import { requireU64 } from "@interest-protocol/blast-core/integers";
import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";
import type { AllocationPlan, FeeSplit } from "./allocation.ts";
import {
  allocationPlanBcs,
  bpsBcs,
  feeSplitBcs,
  protocolAllocationBcs,
} from "./allocation.ts";
import type { CreatorRecipient } from "./state.ts";
import {
  claimSignerKeyBcs,
  creatorRecipientBcs,
  decodeCreatorRecipient,
  tradeFeesBcs,
} from "./state.ts";

type EventFieldDescriptor =
  | "id"
  | "typeName"
  | "address"
  | "u64"
  | "u32"
  | "u8"
  | "bool"
  | "optionId"
  | "bytes"
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

export const launchpadEventSpecs = {
  Paused: { bits: "u8", paused: "u8" },
  Unpaused: { bits: "u8", paused: "u8" },

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
  CreatorCapsClaimed: {
    meme: "typeName",
    curve_fee_cap_id: "id",
    blast_metadata_cap_id: "id",
  },
  CurveFeeCapReassigned: {
    launch_id: "id",
    curve_fee_cap_id: "id",
    recipient: "address",
  },
  CreatorFeesClaimed: {
    launch_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  LaunchCreated: {
    launch_id: "id",
    ticket_id: "id",
    quote: "typeName",
    migration_witness: "typeName",
    pool_tick_spacing: "u32",
    pool_fee_rate: "u64",
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
  LaunchShared: {
    launch_id: "id",
    public_start_ms: "u64",
  },
  LaunchTicketCreated: {
    ticket_id: "id",
    meme: "typeName",
    decimals: "u8",
    metadata_cap_id: "id",
    creator: "creatorRecipient",
    burnable: "bool",
    sell_burn_bps: "u64",
  },
  MemeDecimalsSet: { decimals: "u8", allowed: "bool" },
  Migrated: {
    launch_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
    disposed_meme: "u64",
    total_supply_after: "u64",
  },
  MigrationAllocationPaid: {
    launch_id: "id",
    destination: "address",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  MemeMetadataUpdated: {
    launch_id: "id",
    name: "string",
    description: "string",
    icon_url: "string",
  },
  MetadataCapReassigned: {
    launch_id: "id",
    blast_metadata_cap_id: "id",
    recipient: "address",
  },
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
  PartnerAdded: { partner_id: "id" },
  PartnerRemoved: { partner_id: "id", accepted_until_ms: "u64" },
  ProtocolFeesAccrued: {
    launch_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  ProtocolFeesClaimed: {
    launch_id: "id",
    treasury: "address",
    meme_amount: "u64",
    quote_amount: "u64",
    sui_amount: "u64",
    partner_meme_amount: "u64",
    partner_quote_amount: "u64",
    partner_sui_amount: "u64",
  },
  QuoteSet: {
    quote: "typeName",
    allowed: "bool",
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
} as const satisfies Record<string, Record<string, EventFieldDescriptor>>;

export type LaunchpadEventKind = keyof typeof launchpadEventSpecs;

type DescriptorOutputs = {
  id: string;
  typeName: string;
  address: string;
  u64: bigint;
  u32: number;
  u8: number;
  bool: boolean;
  optionId: string | null;
  bytes: Uint8Array;
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

const U64Bcs = bcs.u64().transform({
  input: (value: bigint) => requireU64("event u64", value),
  output: (value) => BigInt(value),
});
const AddressBcs = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});
const BytesBcs = bcs.vector(bcs.u8()).transform({
  input: (value: Uint8Array) => Array.from(value),
  output: (value) => Uint8Array.from(value),
});

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
  address: AddressBcs as BcsType<unknown, unknown>,
  u64: U64Bcs as BcsType<unknown, unknown>,
  u32: bcs.u32() as BcsType<unknown, unknown>,
  u8: bcs.u8() as BcsType<unknown, unknown>,
  bool: bcs.bool() as BcsType<unknown, unknown>,
  optionId: bcs.option(suiObjectIdBcs) as BcsType<unknown, unknown>,
  bytes: BytesBcs as BcsType<unknown, unknown>,
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
 * package. Sui records the transaction's called package and module on each
 * event, not the emitting module: adapters in the migrators package emit
 * `Migrated` and `MigrationAllocationPaid`, and a Meme package's publication
 * emits `LaunchTicketCreated`.
 */
export type LaunchpadEventPackageIdentity = {
  originalPackageId: string;
};

export type LaunchpadEventPosition = SuiEventPosition;

type DecodedLaunchpadEventBase = {
  source: "launchpad";
  sender: string;
  position: LaunchpadEventPosition;
};

export type DecodedLaunchpadEvent = {
  [Kind in LaunchpadEventKind]: DecodedLaunchpadEventBase & {
    kind: Kind;
    payload: LaunchpadEventPayloads[Kind];
  };
}[LaunchpadEventKind];

export function decodeLaunchpadEvent(
  event: SuiClientTypes.EventEntry,
  packages: LaunchpadEventPackageIdentity,
): DecodedLaunchpadEvent {
  const originalPackageId = normalizeSuiAddress(packages.originalPackageId);
  const envelope = parseStructTag(event.eventType);
  if (
    envelope.address !== originalPackageId ||
    envelope.module !== "blast_events" ||
    envelope.name !== "Event"
  ) {
    throw new TypeError("launchpad event has an unexpected event package");
  }
  const [payloadTag, ...extra] = envelope.typeParams;
  if (
    payloadTag === undefined ||
    extra.length > 0 ||
    typeof payloadTag === "string" ||
    payloadTag.address !== originalPackageId ||
    payloadTag.module !== "events" ||
    payloadTag.typeParams.length !== 0 ||
    !Object.hasOwn(launchpadEventSpecs, payloadTag.name)
  ) {
    throw new TypeError("launchpad event has an unexpected payload type");
  }

  const kind = payloadTag.name as LaunchpadEventKind;
  const payload = launchpadEventBcs[kind].parse(event.bcs);
  return {
    source: "launchpad",
    kind,
    payload,
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
 * Launchpad keys of `blast_admin::delayed` values. Every schedule, cancel,
 * apply and creation fact is emitted by `delayed` under one of these keys;
 * `owner` names the `LaunchConfig`, `RuntimeConfig`, `Launch` or
 * `PackageAdmin` that stores the value.
 */
export const launchpadDelayedKeys = {
  TradeFees: {
    key: "launch_config::TradeFeesKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: tradeFeesBcs,
    valueType: "{package}::launch_config::TradeFees",
  },
  MigrationWitnesses: {
    key: "launch_config::MigrationWitnessKey",
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
    valueType: "{package}::bps::Bps",
  },
  Treasury: {
    key: "runtime_config::TreasuryKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: addressBcs,
    valueType: "address",
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
  MetadataCapReassignment: {
    key: "launch::MetadataCapReassignment",
    family: "action",
    keyBcs: unitKeyBcs,
    valueBcs: addressBcs,
    valueType: "address",
  },
} as const satisfies DelayedKeySpecs;

export type DecodedLaunchpadDelayedEvent = DecodedDelayedEvent<
  typeof launchpadDelayedKeys
>;

/** Decodes a `<adminPackageId>::delayed` event keyed by the launchpad. */
export function decodeLaunchpadDelayedEvent(
  event: SuiClientTypes.EventEntry,
  packages: LaunchpadEventPackageIdentity & { adminPackageId: string },
): DecodedLaunchpadDelayedEvent {
  return decodeDelayedEvent(event, {
    adminPackageId: packages.adminPackageId,
    packageId: packages.originalPackageId,
    keys: launchpadDelayedKeys,
  });
}
