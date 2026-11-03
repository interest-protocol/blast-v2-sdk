import type {
  DecodedDelayedEvent,
  DelayedKeySpecs,
} from "@interest-protocol/blast-admin-sdk/events";
import {
  decodeDelayedEvent,
  upgradeDelayedKey,
} from "@interest-protocol/blast-admin-sdk/events";
import {
  addressBcs,
  moveTypeNameBcs,
  suiObjectIdBcs,
  unitKeyBcs,
} from "@interest-protocol/blast-core/bcs";
import type { SuiEventPosition } from "@interest-protocol/blast-core/events";
import {
  normalizeSuiEventPosition,
  suiEventId,
} from "@interest-protocol/blast-core/events";
import {
  requireU64,
  requireU128,
} from "@interest-protocol/blast-core/integers";
import type { FeeSplit } from "@interest-protocol/blast-launchpad-sdk/allocation";
import { feeSplitBcs } from "@interest-protocol/blast-launchpad-sdk/allocation";
import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";
import { lpFeeSharePairBcs } from "./state.ts";

type MigratorEventFieldDescriptor =
  | "id"
  | "typeName"
  | "address"
  | "u64"
  | "u128"
  | "u32"
  | "bytes"
  | "u64Vector"
  | "optionAddress"
  | "feeSplit";

export const migratorEventSpecs = {
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
  FeesCollected: {
    vault_id: "id",
    gross_meme: "u64",
    gross_quote: "u64",
    protocol_destination: "optionAddress",
    protocol_meme: "u64",
    protocol_quote: "u64",
    creator_meme: "u64",
    creator_quote: "u64",
    auto_lp_meme: "u64",
    auto_lp_quote: "u64",
    rewards_meme: "u64",
    rewards_quote: "u64",
    burn_meme: "u64",
    burn_quote: "u64",
    recipient_meme: "u64Vector",
    recipient_quote: "u64Vector",
  },
  AutoLiquidityAdded: {
    vault_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
    meme_pending: "u64",
    quote_pending: "u64",
  },
  BuybackBurned: {
    vault_id: "id",
    quote_spent: "u64",
    meme_burned: "u64",
    quote_pending: "u64",
  },
  AutoLpPositionOpened: {
    vault_id: "id",
    position_id: "id",
  },
  CreatorFeesClaimed: {
    vault_id: "id",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  RoundPublished: {
    vault_id: "id",
    round_id: "id",
    number: "u64",
    start_checkpoint: "u64",
    end_checkpoint: "u64",
    claim_deadline_at_ms: "u64",
    root: "bytes",
    manifest_digest: "bytes",
    leaf_count: "u64",
    meme_amount: "u64",
    quote_amount: "u64",
    meme_unallocated: "u64",
    quote_unallocated: "u64",
    treasury: "address",
    gas_reserve_amount: "u64",
  },
  GasReserveSettled: {
    vault_id: "id",
    round_id: "id",
    number: "u64",
    treasury: "address",
    reimbursement_amount: "u64",
    reserve_returned: "u64",
    quote_unallocated: "u64",
  },
  RoundClosed: {
    vault_id: "id",
    round_id: "id",
    number: "u64",
    meme_returned: "u64",
    quote_returned: "u64",
    gas_reserve_returned: "u64",
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
  ProtocolFeesClaimed: {
    vault_id: "id",
    meme: "typeName",
    quote: "typeName",
    claimant: "address",
    meme_amount: "u64",
    quote_amount: "u64",
  },
  ProtocolLpFeesClaimed: {
    vault_id: "id",
    protocol_destination: "address",
    protocol_meme: "u64",
    protocol_quote: "u64",
    partner_meme: "u64",
    partner_quote: "u64",
  },
  CetusPoolReserved: {
    meme: "typeName",
    quote: "typeName",
    pool_creation_cap_id: "id",
    tick_spacing: "u32",
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
  /** Null when a partnered vault holds Blast's share for the partner claim. */
  optionAddress: string | null;
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
  optionAddress: bcs.option(AddressBcs) as BcsType<unknown, unknown>,
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

export function migratorEventId(event: { position: SuiEventPosition }): string {
  return suiEventId(event.position);
}

/**
 * Migrators keys of `blast_admin::delayed` values. `owner` names the
 * `LpFeePolicy`, `LpVault` or `PackageAdmin` storing the value. In a
 * `valueType`, `{launchpad}` stands for the launchpad's original package.
 */
export const migratorsDelayedKeys = {
  ProtocolDestination: {
    key: "lp_fee_policy::ProtocolDestinationKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: addressBcs,
    valueType: "address",
  },
  DefaultShares: {
    key: "lp_fee_policy::DefaultSharesKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: lpFeeSharePairBcs,
    valueType: "{package}::lp_fee_policy::SharePair",
  },
  /** Per-coin overrides, one entry per original Meme type, under one notice. */
  CoinShares: {
    key: "lp_fee_policy::CoinSharesKey",
    family: "map",
    keyBcs: unitKeyBcs,
    entryBcs: moveTypeNameBcs,
    entryType: "0x1::type_name::TypeName",
    valueBcs: lpFeeSharePairBcs,
    valueType: "{package}::lp_fee_policy::SharePair",
  },
  FeeSplit: {
    key: "vault::FeeSplitKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: feeSplitBcs,
    valueType: "{launchpad}::allocation::FeeSplit",
  },
  Upgrade: upgradeDelayedKey,
} as const satisfies DelayedKeySpecs;

/**
 * `product` tells it apart from a launchpad `delayed` event: both packages
 * key an `Upgrade` slot.
 */
export type DecodedMigratorsDelayedEvent = DecodedDelayedEvent<
  typeof migratorsDelayedKeys
> & { product: "migrators" };

/**
 * Decodes a `<adminPackageId>::delayed` event keyed by the migrators
 * package. A vault's fee split is the launchpad's `FeeSplit`, so the
 * launchpad's original package is part of its identity.
 */
export function decodeMigratorsDelayedEvent(
  event: SuiClientTypes.EventEntry,
  packages: MigratorEventPackageIdentity & {
    adminPackageId: string;
    launchpadOriginalPackageId: string;
  },
): DecodedMigratorsDelayedEvent {
  const launchpad = normalizeSuiAddress(packages.launchpadOriginalPackageId);
  const keys = Object.fromEntries(
    Object.entries(migratorsDelayedKeys).map(([name, spec]) => [
      name,
      {
        ...spec,
        valueType: spec.valueType.replaceAll("{launchpad}", launchpad),
      },
    ]),
  ) as typeof migratorsDelayedKeys;
  const decoded = decodeDelayedEvent(event, {
    adminPackageId: packages.adminPackageId,
    packageId: packages.originalPackageId,
    keys,
  });
  return { ...decoded, product: "migrators" };
}
