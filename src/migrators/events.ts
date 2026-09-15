import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";
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
  | "u16"
  | "u32"
  | "optionId";

export const migratorEventSpecs = {
  AftermathMigrationCompleted: {
    launch_id: "id",
    vault_id: "id",
    inner_pool_id: "id",
    dao_fee_pool_id: "id",
    venue: "typeName",
    lp: "typeName",
    meme: "typeName",
    quote: "typeName",
    meme_amount: "u64",
    quote_amount: "u64",
    locked_lp_amount: "u64",
    meme_weight: "u64",
    quote_weight: "u64",
    flatness: "u64",
    swap_in_fee: "u64",
    dao_fee_bps: "u16",
  },
  AftermathPolicyUpdated: {
    old_meme_weight: "u64",
    old_quote_weight: "u64",
    old_dao_fee_bps: "u16",
    new_meme_weight: "u64",
    new_quote_weight: "u64",
    new_dao_fee_bps: "u16",
  },
  AftermathDaoFeeUpdated: {
    vault_id: "id",
    dao_fee_pool_id: "id",
    old_dao_fee_bps: "u16",
    new_dao_fee_bps: "u16",
  },
  CreatorFeesClaimed: {
    vault_id: "id",
    meme: "typeName",
    quote: "typeName",
    claimant: "address",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  LpFeeCapClaimed: {
    vault_id: "id",
    meme: "typeName",
    quote: "typeName",
    lp_fee_cap_id: "id",
    claimant: "address",
  },
  LpFeeCapIssued: {
    vault_id: "id",
    meme: "typeName",
    quote: "typeName",
    revoked_lp_fee_cap_id: "optionId",
    lp_fee_cap_id: "id",
    recipient: "address",
  },
  LpFeesLocked: {
    vault_id: "id",
    meme: "typeName",
    quote: "typeName",
    lp_fee_cap_id: "optionId",
    custodian_id: "id",
  },
  LpProtocolFeeShareChanged: { pos0: "u64" },
  ProjectLpProtocolFeeShareCleared: { pos0: "typeName" },
  ProjectLpProtocolFeeShareSet: {
    meme: "typeName",
    protocol_fee_share_bps: "u64",
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
    principal_liquidity: "u128",
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
    : Descriptor extends "u16" | "u32"
      ? number
      : Descriptor extends "optionId"
        ? string | null
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
const MIGRATOR_EVENT_FIELD_BCS: Record<
  MigratorEventFieldDescriptor,
  BcsType<unknown, unknown>
> = {
  id: suiObjectIdBcs as BcsType<unknown, unknown>,
  typeName: moveTypeNameBcs as BcsType<unknown, unknown>,
  address: AddressBcs as BcsType<unknown, unknown>,
  u64: U64Bcs as BcsType<unknown, unknown>,
  u128: U128Bcs as BcsType<unknown, unknown>,
  u16: bcs.u16() as BcsType<unknown, unknown>,
  u32: bcs.u32() as BcsType<unknown, unknown>,
  optionId: bcs.option(suiObjectIdBcs) as BcsType<unknown, unknown>,
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
  const kind = tag.name as MigratorEventKind;
  return {
    source: "migrators",
    kind,
    payload: migratorEventBcs[kind].parse(event.bcs),
    emitterPackageId: currentPackageId,
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedMigratorEvent;
}

export function migratorEventId(event: DecodedMigratorEvent): string {
  return suiEventId(event.position);
}
