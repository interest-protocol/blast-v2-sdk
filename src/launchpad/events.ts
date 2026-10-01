import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import { moveTypeNameBcs, suiObjectIdBcs } from "../lib/bcs.ts";
import type { SuiEventPosition } from "../lib/events.ts";
import { normalizeSuiEventPosition, suiEventId } from "../lib/events.ts";
import { requireU64 } from "../lib/integers.ts";
import type { AllocationPlan, FeeSplit } from "./allocation.ts";
import { allocationPlanBcs, feeSplitBcs } from "./allocation.ts";
import type { CreatorRecipient } from "./state.ts";
import { creatorRecipientBcs, decodeCreatorRecipient } from "./state.ts";

type EventFieldDescriptor =
  | "id"
  | "optionId"
  | "typeName"
  | "address"
  | "u64"
  | "u32"
  | "u8"
  | "bool"
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
    metadata_cap_id: "id",
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
  LaunchTradeFeesChanged: {
    quote_fee_bps: "u64",
    meme_fee_bps: "u64",
  },
  MemeDecimalsSet: { decimals: "u8", allowed: "bool" },
  Migrated: {
    launch_id: "id",
    meme: "u64",
    quote: "u64",
    disposed_meme: "u64",
    total_supply_after: "u64",
  },
  MigrationAllocationPaid: {
    launch_id: "id",
    destination: "address",
    meme: "u64",
    quote: "u64",
  },
  MemeMetadataUpdated: {
    launch_id: "id",
    name: "string",
    description: "string",
    icon_url: "string",
  },
  MetadataCapReassigned: {
    launch_id: "id",
    metadata_cap_id: "id",
    recipient: "address",
  },
  MigrationWitnessSet: { migration_witness: "typeName", allowed: "bool" },
  OpeningRoundDelivered: {
    launch_id: "id",
    bidder: "address",
    bid: "u64",
    meme: "u64",
    quote: "u64",
  },
  OpeningRoundJoined: { launch_id: "id", quote: "u64", bids: "u64" },
  OpeningRoundSettled: {
    launch_id: "id",
    bids: "u64",
    meme: "u64",
    quote: "u64",
  },
  PartnerAdded: { partner_id: "id" },
  PartnerRemoved: { partner_id: "id", accepted_until_ms: "u64" },
  ProtocolAllocationSet: { meme_bps: "u64", quote_bps: "u64" },
  ProtocolFeesAccrued: {
    launch_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  ProtocolFeesClaimed: {
    launch_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
    sui_amount: "u64",
    partner_meme_amount: "u64",
    partner_quote_amount: "u64",
    partner_sui_amount: "u64",
  },
  ProtocolFeeShareChanged: { pos0: "u64" },
  QuoteSet: { quote: "typeName", allowed: "bool" },
  Sold: {
    launch_id: "id",
    meme_in_gross: "u64",
    pending_burn: "u64",
    quote_out_gross: "u64",
    ...tradeFees,
    meme_reserve: "u64",
    real_quote_reserve: "u64",
  },
  CreatorClaimSignerSet: { pos0: "bytes" },
  CreationFeeChanged: { pos0: "u64" },
} as const satisfies Record<string, Record<string, EventFieldDescriptor>>;

export type LaunchpadEventKind = keyof typeof launchpadEventSpecs;

type DescriptorOutputs = {
  id: string;
  optionId: string | null;
  typeName: string;
  address: string;
  u64: bigint;
  u32: number;
  u8: number;
  bool: boolean;
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
  optionId: bcs.option(suiObjectIdBcs) as BcsType<unknown, unknown>,
  typeName: moveTypeNameBcs as BcsType<unknown, unknown>,
  address: AddressBcs as BcsType<unknown, unknown>,
  u64: U64Bcs as BcsType<unknown, unknown>,
  u32: bcs.u32() as BcsType<unknown, unknown>,
  u8: bcs.u8() as BcsType<unknown, unknown>,
  bool: bcs.bool() as BcsType<unknown, unknown>,
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
 * `MigrationAllocationPaid`, `ProtocolFeesAccrued`, and `Migrated`, and a Meme
 * package's publication emits `LaunchTicketCreated`.
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
    envelope.name !== "Event" ||
    envelope.typeParams.length !== 1
  ) {
    throw new TypeError("launchpad event has an unexpected event package");
  }
  const payloadTag = envelope.typeParams[0]!;
  if (
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

export function launchpadEventId(event: DecodedLaunchpadEvent): string {
  return suiEventId(event.position);
}
