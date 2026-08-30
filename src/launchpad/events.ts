import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import { moveTypeNameBcs, suiIdBcs } from "../lib/bcs.ts";
import type { SuiEventPosition } from "../lib/events.ts";
import { normalizeSuiEventPosition, suiEventId } from "../lib/events.ts";
import { requireU64 } from "../lib/integers.ts";

type EventFieldDescriptor =
  | "id"
  | "typeName"
  | "address"
  | "u64"
  | "u8"
  | "bool"
  | "bytes"
  | "optionAddress"
  | "optionBytes"
  | "optionU64";

export const launchpadEventSpecs = {
  AdminDestroyed: { admin_cap_id: "id", was_active: "bool" },
  AdminGranted: { admin_cap_id: "id", recipient: "address" },
  AdminRevoked: { admin_cap_id: "id" },
  Bought: {
    launch_id: "id",
    meme: "typeName",
    quote: "typeName",
    buyer: "address",
    quote_supplied: "u64",
    quote_in_gross: "u64",
    quote_refund: "u64",
    quote_fee: "u64",
    quote_in_net: "u64",
    meme_out_gross: "u64",
    meme_fee: "u64",
    meme_out_net: "u64",
    protocol_fee_share_bps: "u64",
    protocol_meme_fee_delta: "u64",
    creator_meme_fee_delta: "u64",
    protocol_quote_fee_delta: "u64",
    creator_quote_fee_delta: "u64",
    protocol_meme_fee_total: "u64",
    creator_meme_fee_total: "u64",
    protocol_quote_fee_total: "u64",
    creator_quote_fee_total: "u64",
    meme_reserve: "u64",
    real_quote_reserve: "u64",
    crossed_threshold: "bool",
  },
  CreatorCapClaimed: {
    meme: "typeName",
    x_identity_hash: "optionBytes",
    creator: "address",
    x_claim_expiry_ms: "optionU64",
  },
  CreatorFeesClaimed: {
    launch_id: "id",
    meme: "typeName",
    quote: "typeName",
    claimant: "address",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  GraduationDefaultsChanged: {
    old_quote_migration_fee_bps: "u64",
    old_protocol_meme_graduation_fee_bps: "u64",
    old_meme_liquidity_provision_bps: "u64",
    new_quote_migration_fee_bps: "u64",
    new_protocol_meme_graduation_fee_bps: "u64",
    new_meme_liquidity_provision_bps: "u64",
  },
  LaunchCreated: {
    launch_id: "id",
    ticket_id: "id",
    meme: "typeName",
    quote: "typeName",
    migration_witness: "typeName",
    launcher: "address",
    metadata_cap_id: "id",
    sell_burn_bps: "u64",
    initial_meme_supply: "u64",
    meme_reserve: "u64",
    real_quote_reserve: "u64",
    pending_burn: "u64",
    protocol_meme_graduation_fee: "u64",
    meme_liquidity_provision: "u64",
    protocol_meme_trade_fees: "u64",
    creator_meme_trade_fees: "u64",
    protocol_quote_trade_fees: "u64",
    creator_quote_trade_fees: "u64",
    virtual_quote: "u64",
    migration_quote_target: "u64",
    quote_fee_bps: "u64",
    meme_fee_bps: "u64",
    quote_migration_fee_bps: "u64",
    protocol_meme_graduation_fee_bps: "u64",
    meme_liquidity_provision_bps: "u64",
  },
  LaunchTicketCreated: {
    ticket_id: "id",
    meme: "typeName",
    initial_supply: "u64",
    metadata_cap_id: "id",
    launcher: "address",
    creator: "optionAddress",
    x_identity_hash: "optionBytes",
    burnable: "bool",
    sell_burn_bps: "u64",
  },
  LaunchTradeFeesChanged: {
    old_quote_fee_bps: "u64",
    old_meme_fee_bps: "u64",
    new_quote_fee_bps: "u64",
    new_meme_fee_bps: "u64",
  },
  Migrated: {
    launch_id: "id",
    meme: "typeName",
    quote: "typeName",
    migration_witness: "typeName",
    migrator: "address",
    migration_meme: "u64",
    migration_quote: "u64",
    disposed_meme: "u64",
    native_supply_burned: "bool",
    total_supply_after: "u64",
    protocol_meme_graduation_fee: "u64",
    quote_migration_fee: "u64",
    protocol_meme_fee_total: "u64",
    protocol_quote_fee_total: "u64",
  },
  MigrationWitnessAllowed: { migration_witness: "typeName" },
  MigrationWitnessDisallowed: { migration_witness: "typeName" },
  PackageAdminCreated: {
    package_admin_id: "id",
    publisher_id: "id",
    upgrade_cap_id: "id",
    package_id: "id",
    package_version: "u64",
    policy: "u8",
  },
  PackageVersionAdvanced: {
    previous_version: "u64",
    new_version: "u64",
  },
  ProtocolFeesClaimed: {
    launch_id: "id",
    meme: "typeName",
    quote: "typeName",
    claimant: "address",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  ProtocolFeeShareChanged: {
    old_protocol_fee_share_bps: "u64",
    new_protocol_fee_share_bps: "u64",
  },
  ProtocolTreasuryChanged: {
    old_protocol_treasury: "address",
    new_protocol_treasury: "address",
  },
  QuoteAllowed: {
    quote: "typeName",
    virtual_quote: "u64",
    migration_quote_target: "u64",
  },
  QuoteDisallowed: {
    quote: "typeName",
    previous_virtual_quote: "u64",
    previous_migration_quote_target: "u64",
  },
  QuoteParametersChanged: {
    quote: "typeName",
    old_virtual_quote: "u64",
    old_migration_quote_target: "u64",
    new_virtual_quote: "u64",
    new_migration_quote_target: "u64",
  },
  Sold: {
    launch_id: "id",
    meme: "typeName",
    quote: "typeName",
    seller: "address",
    meme_in_gross: "u64",
    meme_fee: "u64",
    meme_in_after_fee: "u64",
    progress_bps: "u64",
    burn_bps: "u64",
    pending_burn_delta: "u64",
    pending_burn_total: "u64",
    meme_in_effective: "u64",
    quote_out_gross: "u64",
    quote_fee: "u64",
    quote_out_net: "u64",
    protocol_fee_share_bps: "u64",
    protocol_meme_fee_delta: "u64",
    creator_meme_fee_delta: "u64",
    protocol_quote_fee_delta: "u64",
    creator_quote_fee_delta: "u64",
    protocol_meme_fee_total: "u64",
    creator_meme_fee_total: "u64",
    protocol_quote_fee_total: "u64",
    creator_quote_fee_total: "u64",
    meme_reserve: "u64",
    real_quote_reserve: "u64",
  },
  SuperAdminTransferCancelled: { recipient: "address" },
  SuperAdminTransferred: {
    previous_super_admin_cap_id: "id",
    new_super_admin_cap_id: "id",
    recipient: "address",
  },
  SuperAdminTransferStarted: {
    recipient: "address",
    execute_after_ms: "u64",
  },
  UpgradeAuthorized: {
    package_id: "id",
    package_version: "u64",
    policy: "u8",
    digest: "bytes",
  },
  UpgradeCommitted: {
    new_package_id: "id",
    previous_version: "u64",
    new_version: "u64",
  },
  UpgradePolicyRestricted: {
    previous_policy: "u8",
    new_policy: "u8",
  },
  XClaimSignerRevoked: { previous_public_key: "bytes" },
  XClaimSignerSet: {
    previous_public_key: "bytes",
    signer_public_key: "bytes",
  },
} as const satisfies Record<string, Record<string, EventFieldDescriptor>>;

export type LaunchpadEventKind = keyof typeof launchpadEventSpecs;

type DescriptorOutput<Descriptor extends EventFieldDescriptor> =
  Descriptor extends "u64" | "optionU64"
    ? Descriptor extends "optionU64"
      ? bigint | null
      : bigint
    : Descriptor extends "u8"
      ? number
      : Descriptor extends "bool"
        ? boolean
        : Descriptor extends "bytes" | "optionBytes"
          ? Descriptor extends "optionBytes"
            ? Uint8Array | null
            : Uint8Array
          : Descriptor extends "optionAddress"
            ? string | null
            : string;

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

const EVENT_FIELD_BCS: Record<
  EventFieldDescriptor,
  BcsType<unknown, unknown>
> = {
  id: suiIdBcs as BcsType<unknown, unknown>,
  typeName: moveTypeNameBcs as BcsType<unknown, unknown>,
  address: AddressBcs as BcsType<unknown, unknown>,
  u64: U64Bcs as BcsType<unknown, unknown>,
  u8: bcs.u8() as BcsType<unknown, unknown>,
  bool: bcs.bool() as BcsType<unknown, unknown>,
  bytes: BytesBcs as BcsType<unknown, unknown>,
  optionAddress: bcs.option(AddressBcs) as BcsType<unknown, unknown>,
  optionBytes: bcs.option(BytesBcs) as BcsType<unknown, unknown>,
  optionU64: bcs.option(U64Bcs) as BcsType<unknown, unknown>,
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

export type LaunchpadEventPackageIdentity = {
  packageId: string;
  originalPackageId: string;
};

export type LaunchpadEventPosition = SuiEventPosition;

type DecodedLaunchpadEventBase = {
  source: "launchpad";
  emitterPackageId: string;
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
  const currentPackageId = normalizeSuiObjectId(packages.packageId);
  if (normalizeSuiObjectId(event.packageId) !== currentPackageId) {
    throw new TypeError("launchpad event has an unexpected emitter package");
  }
  if (event.module !== "events_wrapper") {
    throw new TypeError("launchpad event has an unexpected emitter module");
  }

  const originalPackageId = normalizeSuiAddress(packages.originalPackageId);
  const envelope = parseStructTag(event.eventType);
  if (
    envelope.address !== originalPackageId ||
    envelope.module !== "events_wrapper" ||
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
    emitterPackageId: currentPackageId,
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedLaunchpadEvent;
}

export function launchpadEventId(event: DecodedLaunchpadEvent): string {
  return suiEventId(event.position);
}
