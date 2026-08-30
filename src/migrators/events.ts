import { bcs } from "@mysten/sui/bcs";
import type { BcsType } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import { requireU64 } from "../lib/integers.ts";
import type { LaunchpadEventPosition } from "../launchpad/events.ts";

type MigratorEventFieldDescriptor =
  | "id"
  | "typeName"
  | "address"
  | "u64"
  | "u128"
  | "u32";

export const migratorEventSpecs = {
  CreatorFeesClaimed: {
    vault_id: "id",
    meme: "typeName",
    quote: "typeName",
    claimant: "address",
    meme_amount: "u64",
    quote_amount: "u64",
    protocol_meme_fee_total: "u64",
    creator_meme_fee_total: "u64",
    protocol_quote_fee_total: "u64",
    creator_quote_fee_total: "u64",
  },
  LpFeesCollected: {
    vault_id: "id",
    pool_id: "id",
    position_id: "id",
    venue: "typeName",
    meme: "typeName",
    quote: "typeName",
    collector: "address",
    gross_meme_fee: "u64",
    gross_quote_fee: "u64",
    protocol_fee_share_bps: "u64",
    protocol_meme_fee_delta: "u64",
    creator_meme_fee_delta: "u64",
    protocol_quote_fee_delta: "u64",
    creator_quote_fee_delta: "u64",
    protocol_meme_fee_total: "u64",
    creator_meme_fee_total: "u64",
    protocol_quote_fee_total: "u64",
    creator_quote_fee_total: "u64",
    principal_liquidity_before: "u128",
    principal_liquidity_after: "u128",
  },
  MigrationCompleted: {
    launch_id: "id",
    vault_id: "id",
    pool_id: "id",
    venue: "typeName",
    meme: "typeName",
    quote: "typeName",
    source_meme_amount: "u64",
    source_quote_amount: "u64",
    used_meme_amount: "u64",
    used_quote_amount: "u64",
    residual_meme_amount: "u64",
    residual_quote_amount: "u64",
    residual_treasury: "address",
    sqrt_price_x64: "u128",
    lower_tick_bits: "u32",
    upper_tick_bits: "u32",
    tick_spacing: "u32",
    fee_rate: "u64",
  },
  ProtocolFeesClaimed: {
    vault_id: "id",
    meme: "typeName",
    quote: "typeName",
    claimant: "address",
    meme_amount: "u64",
    quote_amount: "u64",
    protocol_meme_fee_total: "u64",
    creator_meme_fee_total: "u64",
    protocol_quote_fee_total: "u64",
    creator_quote_fee_total: "u64",
  },
  VaultCreated: {
    vault_id: "id",
    pool_id: "id",
    position_id: "id",
    venue: "typeName",
    meme: "typeName",
    quote: "typeName",
  },
  VenueTierUpdated: {
    venue: "typeName",
    old_tick_spacing: "u32",
    new_tick_spacing: "u32",
    old_fee_rate: "u64",
    new_fee_rate: "u64",
  },
} as const satisfies Record<
  string,
  Record<string, MigratorEventFieldDescriptor>
>;

export type MigratorEventKind = keyof typeof migratorEventSpecs;

type DescriptorOutput<Descriptor extends MigratorEventFieldDescriptor> =
  Descriptor extends "u64" | "u128"
    ? bigint
    : Descriptor extends "u32"
      ? number
      : string;

export type MigratorEventPayloads = {
  [Kind in MigratorEventKind]: {
    [Field in keyof (typeof migratorEventSpecs)[Kind]]: DescriptorOutput<
      Extract<
        (typeof migratorEventSpecs)[Kind][Field],
        MigratorEventFieldDescriptor
      >
    >;
  };
};

const U64Bcs = bcs.u64().transform({
  input: (value: bigint) => {
    requireU64("event u64", value);
    return value;
  },
  output: (value) => BigInt(value),
});
const U128Bcs = bcs.u128().transform({
  input: (value: bigint) => {
    if (value < 0n || value >= 1n << 128n) {
      throw new RangeError("event u128 must be a u128");
    }
    return value;
  },
  output: (value) => BigInt(value),
});
const AddressBcs = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});
const IdBcs = bcs.struct("ID", { bytes: bcs.Address }).transform({
  input: (value: string) => ({ bytes: normalizeSuiObjectId(value) }),
  output: (value) => normalizeSuiObjectId(value.bytes),
});
const TypeNameBcs = bcs
  .struct("TypeName", {
    name: bcs.struct("AsciiString", { bytes: bcs.vector(bcs.u8()) }),
  })
  .transform({
    input: (value: string) => ({
      name: { bytes: Array.from(new TextEncoder().encode(value)) },
    }),
    output: (value) =>
      normalizeStructTag(new TextDecoder().decode(Uint8Array.from(value.name.bytes))),
  });

const MIGRATOR_EVENT_FIELD_BCS: Record<
  MigratorEventFieldDescriptor,
  BcsType<unknown, unknown>
> = {
  id: IdBcs as BcsType<unknown, unknown>,
  typeName: TypeNameBcs as BcsType<unknown, unknown>,
  address: AddressBcs as BcsType<unknown, unknown>,
  u64: U64Bcs as BcsType<unknown, unknown>,
  u128: U128Bcs as BcsType<unknown, unknown>,
  u32: bcs.u32() as BcsType<unknown, unknown>,
};

type MigratorEventBcsMap = {
  [Kind in MigratorEventKind]: BcsType<
    MigratorEventPayloads[Kind],
    MigratorEventPayloads[Kind]
  >;
};

export const migratorEventBcs = Object.fromEntries(
  Object.entries(migratorEventSpecs).map(([name, spec]) => [
    name,
    bcs.struct(
      name,
      Object.fromEntries(
        Object.entries(spec).map(([field, descriptor]) => [
          field,
          MIGRATOR_EVENT_FIELD_BCS[descriptor],
        ]),
      ),
    ),
  ]),
) as unknown as MigratorEventBcsMap;

export type MigratorEventPackageIdentity = {
  packageId: string;
  originalPackageId: string;
};

type DecodedMigratorEventBase = {
  source: "migrators";
  emitterPackageId: string;
  sender: string;
  position: LaunchpadEventPosition;
};

export type DecodedMigratorEvent = {
  [Kind in MigratorEventKind]: DecodedMigratorEventBase & {
    kind: Kind;
    payload: MigratorEventPayloads[Kind];
  };
}[MigratorEventKind];

export function decodeMigratorEvent(
  event: SuiClientTypes.EventEntry,
  packages: MigratorEventPackageIdentity,
): DecodedMigratorEvent {
  const currentPackageId = normalizeSuiObjectId(packages.packageId);
  if (normalizeSuiObjectId(event.packageId) !== currentPackageId) {
    throw new TypeError("migrator event has an unexpected emitter package");
  }
  if (event.module !== "events") {
    throw new TypeError("migrator event has an unexpected emitter module");
  }

  const originalPackageId = normalizeSuiAddress(packages.originalPackageId);
  const tag = parseStructTag(event.eventType);
  if (
    tag.address !== originalPackageId ||
    tag.module !== "events" ||
    tag.typeParams.length !== 0 ||
    !Object.hasOwn(migratorEventSpecs, tag.name)
  ) {
    throw new TypeError("migrator event has an unexpected event package");
  }
  if (event.checkpoint === null) {
    throw new TypeError("migrator event requires checkpoint metadata");
  }
  let checkpoint: bigint;
  try {
    checkpoint = BigInt(event.checkpoint);
  } catch {
    throw new TypeError("migrator event checkpoint must be a u64");
  }
  requireU64("migrator event checkpoint", checkpoint);
  if (!Number.isSafeInteger(event.eventIndex) || event.eventIndex < 0) {
    throw new RangeError("migrator event index must be a non-negative integer");
  }
  if (!event.transactionDigest) {
    throw new TypeError("migrator event transaction digest is required");
  }

  const kind = tag.name as MigratorEventKind;
  return {
    source: "migrators",
    kind,
    payload: migratorEventBcs[kind].parse(event.bcs),
    emitterPackageId: currentPackageId,
    sender: normalizeSuiAddress(event.sender),
    position: {
      checkpoint,
      transactionDigest: event.transactionDigest,
      eventIndex: event.eventIndex,
    },
  } as DecodedMigratorEvent;
}

export function migratorEventId(event: DecodedMigratorEvent): string {
  const { transactionDigest, eventIndex } = event.position;
  return `${transactionDigest}:${eventIndex}`;
}
