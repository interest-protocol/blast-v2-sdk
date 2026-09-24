import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import { moveTypeNameBcs, suiObjectIdBcs } from "../lib/bcs.ts";
import type { SuiEventPosition } from "../lib/events.ts";
import { normalizeSuiEventPosition, suiEventId } from "../lib/events.ts";
import { requireU64, requireU128 } from "../lib/integers.ts";
import type { AllocationPlan, FeeSplit } from "./allocation.ts";
import { allocationPlanBcs, feeSplitBcs } from "./allocation.ts";

type EventFieldDescriptor =
  | "id"
  | "typeName"
  | "address"
  | "u64"
  | "u128"
  | "u32"
  | "u8"
  | "bool"
  | "bytes"
  | "string"
  | "u64Vector"
  | "optionAddress"
  | "optionBytes"
  | "optionId"
  | "optionU64"
  | "allocationPlan"
  | "feeSplit";

const tradeFeeDeltas = {
  protocol_meme_fee_delta: "u64",
  creator_meme_fee_delta: "u64",
  protocol_quote_fee_delta: "u64",
  creator_quote_fee_delta: "u64",
} as const;

export const launchpadEventSpecs = {
  Bought: {
    launch_id: "id",
    quote_in: "u64",
    meme_out_gross: "u64",
    ...tradeFeeDeltas,
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
    revoked_curve_fee_cap_id: "optionId",
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
    decimals: "u8",
    atomic_supply: "u64",
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
    meme_amounts: "u64Vector",
  },
  LaunchShared: {
    launch_id: "id",
    public_start_ms: "u64",
    pre_share_buy_completed: "bool",
  },
  LaunchTicketCreated: {
    ticket_id: "id",
    meme: "typeName",
    decimals: "u8",
    atomic_supply: "u64",
    metadata_cap_id: "id",
    creator_address: "optionAddress",
    account_commitment: "optionBytes",
    burnable: "bool",
    sell_burn_bps: "u64",
  },
  LaunchTradeFeesChanged: {
    quote_fee_bps: "u64",
    meme_fee_bps: "u64",
  },
  MemeDecimalsAllowed: { pos0: "u8" },
  MemeDecimalsDisallowed: { pos0: "u8" },
  Migrated: {
    launch_id: "id",
    supplied_meme: "u64",
    supplied_quote: "u64",
    residual_meme: "u64",
    residual_quote: "u64",
    liquidity: "u128",
    disposed_meme: "u64",
    native_supply_burned: "bool",
    total_supply_after: "u64",
  },
  MigrationAllocationPaid: {
    launch_id: "id",
    channel_id: "u64",
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
    revoked_metadata_cap_id: "optionId",
    metadata_cap_id: "id",
    recipient: "address",
  },
  MigrationWitnessAllowed: { pos0: "typeName" },
  MigrationWitnessDisallowed: { pos0: "typeName" },
  PreShareBought: {
    launch_id: "id",
    quote_in: "u64",
    meme_out_gross: "u64",
    ...tradeFeeDeltas,
    post_meme_reserve: "u64",
    post_real_quote_reserve: "u64",
    meme_out_net: "u64",
    quote_refund: "u64",
  },
  ProtectionConfigured: {
    launch_id: "id",
    window_ms: "u64",
    cumulative_sender_bps: "u64",
    cumulative_atomic_limit: "u64",
    per_transaction_bps: "u64",
    per_transaction_atomic_limit: "u64",
  },
  ProtocolAllocationConfigured: {
    channel_id: "u64",
    destination: "address",
    meme_bps: "u64",
    quote_bps: "u64",
  },
  ProtocolFeesClaimed: {
    launch_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  ProtocolFeeShareChanged: { pos0: "u64" },
  QuoteAllowed: {
    quote: "typeName",
    virtual_quote: "u64",
  },
  QuoteDisallowed: { pos0: "typeName" },
  Sold: {
    launch_id: "id",
    meme_in_gross: "u64",
    pending_burn_delta: "u64",
    pending_burn_total: "u64",
    quote_out_gross: "u64",
    ...tradeFeeDeltas,
    meme_reserve: "u64",
    real_quote_reserve: "u64",
  },
  CreatorClaimSignerRevoked: { dummy_field: "bool" },
  CreatorClaimSignerSet: { pos0: "bytes" },
} as const satisfies Record<string, Record<string, EventFieldDescriptor>>;

export type LaunchpadEventKind = keyof typeof launchpadEventSpecs;

type DescriptorOutputs = {
  id: string;
  typeName: string;
  address: string;
  u64: bigint;
  u128: bigint;
  u32: number;
  u8: number;
  bool: boolean;
  bytes: Uint8Array;
  string: string;
  u64Vector: bigint[];
  optionAddress: string | null;
  optionBytes: Uint8Array | null;
  optionId: string | null;
  optionU64: bigint | null;
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
const U128Bcs = bcs.u128().transform({
  input: (value: bigint) => requireU128("event u128", value),
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

const EVENT_FIELD_BCS: Record<
  EventFieldDescriptor,
  BcsType<unknown, unknown>
> = {
  id: suiObjectIdBcs as BcsType<unknown, unknown>,
  typeName: moveTypeNameBcs as BcsType<unknown, unknown>,
  address: AddressBcs as BcsType<unknown, unknown>,
  u64: U64Bcs as BcsType<unknown, unknown>,
  u128: U128Bcs as BcsType<unknown, unknown>,
  u32: bcs.u32() as BcsType<unknown, unknown>,
  u8: bcs.u8() as BcsType<unknown, unknown>,
  bool: bcs.bool() as BcsType<unknown, unknown>,
  bytes: BytesBcs as BcsType<unknown, unknown>,
  string: bcs.string() as BcsType<unknown, unknown>,
  u64Vector: bcs.vector(U64Bcs) as BcsType<unknown, unknown>,
  optionAddress: bcs.option(AddressBcs) as BcsType<unknown, unknown>,
  optionBytes: bcs.option(BytesBcs) as BcsType<unknown, unknown>,
  optionId: bcs.option(suiObjectIdBcs) as BcsType<unknown, unknown>,
  optionU64: bcs.option(U64Bcs) as BcsType<unknown, unknown>,
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
