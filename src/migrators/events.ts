import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";
import type { FeeSplit } from "../launchpad/allocation.ts";
import { feeSplitBcs } from "../launchpad/allocation.ts";
import { moveTypeNameBcs, suiObjectIdBcs } from "../lib/bcs.ts";
import type { SuiEventPosition } from "../lib/events.ts";
import { normalizeSuiEventPosition, suiEventId } from "../lib/events.ts";
import { requireU64, requireU128 } from "../lib/integers.ts";

type MigratorEventFieldDescriptor =
  | "id"
  | "typeName"
  | "address"
  | "u64"
  | "u128"
  | "u32"
  | "bytes"
  | "u64Vector"
  | "optionTypeName"
  | "optionU64"
  | "feeSplit";

export const migratorEventSpecs = {
  AutoLiquidityAdded: {
    vault_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
    meme_pending: "u64",
    quote_pending: "u64",
  },
  AutoLpPositionOpened: {
    vault_id: "id",
    position_id: "id",
  },
  CetusPoolReserved: {
    meme: "typeName",
    quote: "typeName",
    pool_creation_cap_id: "id",
    tick_spacing: "u32",
  },
  CreatorFeesClaimed: {
    vault_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  FeeSplitChanged: {
    vault_id: "id",
    old_generation: "u64",
    new_generation: "u64",
    old_fee_split: "feeSplit",
    new_fee_split: "feeSplit",
  },
  FeesCollected: {
    vault_id: "id",
    generation: "u64",
    gross_meme: "u64",
    gross_quote: "u64",
    protocol_destination: "address",
    protocol_meme: "u64",
    protocol_quote: "u64",
    creator_meme: "u64",
    creator_quote: "u64",
    auto_lp_meme: "u64",
    auto_lp_quote: "u64",
    rewards_meme: "u64",
    rewards_quote: "u64",
    recipient_meme: "u64Vector",
    recipient_quote: "u64Vector",
  },
  LpFeeDestinationChanged: {
    old_destination: "address",
    new_destination: "address",
  },
  LpFeePolicyChanged: {
    meme: "optionTypeName",
    old_meme_bps: "optionU64",
    old_quote_bps: "optionU64",
    new_meme_bps: "optionU64",
    new_quote_bps: "optionU64",
  },
  ProtocolFeesClaimed: {
    vault_id: "id",
    meme: "typeName",
    quote: "typeName",
    claimant: "address",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  RewardPaid: {
    round_id: "id",
    index: "u64",
    beneficiary: "address",
    meme_amount: "u64",
    quote_amount: "u64",
    meme_remaining: "u64",
    quote_remaining: "u64",
  },
  RoundPublished: {
    vault_id: "id",
    round_id: "id",
    number: "u64",
    start_checkpoint: "u64",
    end_checkpoint: "u64",
    root: "bytes",
    manifest_digest: "bytes",
    leaf_count: "u64",
    meme_amount: "u64",
    quote_amount: "u64",
    meme_unallocated: "u64",
    quote_unallocated: "u64",
  },
  VaultCreated: {
    vault_id: "id",
    pool_id: "id",
    position_id: "id",
    venue: "typeName",
    meme: "typeName",
    quote: "typeName",
    residual_meme: "u64",
    residual_quote: "u64",
    liquidity: "u128",
    fee_split: "feeSplit",
  },
} as const satisfies Record<
  string,
  Record<string, MigratorEventFieldDescriptor>
>;

export type MigratorEventKind = keyof typeof migratorEventSpecs;

type DescriptorOutputs = {
  id: string;
  typeName: string;
  address: string;
  u64: bigint;
  u128: bigint;
  u32: number;
  bytes: Uint8Array;
  u64Vector: bigint[];
  optionTypeName: string | null;
  optionU64: bigint | null;
  feeSplit: FeeSplit;
};

export type MigratorEventPayloads = {
  [Kind in MigratorEventKind]: {
    [Field in keyof (typeof migratorEventSpecs)[Kind]]: DescriptorOutputs[Extract<
      (typeof migratorEventSpecs)[Kind][Field],
      MigratorEventFieldDescriptor
    >];
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
const BytesBcs = bcs.vector(bcs.u8()).transform({
  input: (value: Uint8Array) => Array.from(value),
  output: (value) => Uint8Array.from(value),
});
const AddressBcs = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});
const MIGRATOR_EVENT_FIELD_BCS: Record<
  MigratorEventFieldDescriptor,
  BcsType<unknown, unknown>
> = {
  id: suiObjectIdBcs as BcsType<unknown, unknown>,
  typeName: moveTypeNameBcs as BcsType<unknown, unknown>,
  address: AddressBcs as BcsType<unknown, unknown>,
  u64: U64Bcs as BcsType<unknown, unknown>,
  u128: U128Bcs as BcsType<unknown, unknown>,
  u32: bcs.u32() as BcsType<unknown, unknown>,
  bytes: BytesBcs as BcsType<unknown, unknown>,
  u64Vector: bcs.vector(U64Bcs) as BcsType<unknown, unknown>,
  optionTypeName: bcs.option(moveTypeNameBcs) as BcsType<unknown, unknown>,
  optionU64: bcs.option(U64Bcs) as BcsType<unknown, unknown>,
  feeSplit: feeSplitBcs as BcsType<unknown, unknown>,
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

/**
 * Migrator events are authenticated by their type, which names the original
 * package's `blast_events` module; Sui records only the transaction's called
 * package and module on each event.
 */
export type MigratorEventPackageIdentity = {
  originalPackageId: string;
};

type DecodedMigratorEventBase = {
  source: "migrators";
  sender: string;
  position: SuiEventPosition;
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
  const originalPackageId = normalizeSuiAddress(packages.originalPackageId);
  const tag = parseStructTag(event.eventType);
  if (
    tag.address !== originalPackageId ||
    tag.module !== "blast_events" ||
    tag.typeParams.length !== 0 ||
    !Object.hasOwn(migratorEventSpecs, tag.name)
  ) {
    throw new TypeError("migrator event has an unexpected event package");
  }
  const kind = tag.name as MigratorEventKind;
  return {
    source: "migrators",
    kind,
    payload: migratorEventBcs[kind].parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedMigratorEvent;
}

export function migratorEventId(event: DecodedMigratorEvent): string {
  return suiEventId(event.position);
}
