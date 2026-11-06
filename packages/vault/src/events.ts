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
import { normalizeSuiEventPosition } from "@interest-protocol/blast-core/events";
import { feeSplitBcs } from "@interest-protocol/blast-core/fee-split";
import { vaultTermsBcs } from "@interest-protocol/blast-core/migration";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
  toHex,
} from "@mysten/sui/utils";
import { protocolBpsBcs, roundTermsBcs } from "./state.ts";
import type { VaultDeployment } from "./transactions.ts";

const u128Bcs = bcs.u128().transform({
  input: (value: bigint) => value,
  output: (value) => BigInt(value),
});
const hexBytesBcs = bcs.byteVector().transform({
  input: (hex: string) => fromHex(hex),
  output: (bytes) => toHex(bytes),
});

/**
 * The 10 `blast_vault::blast_vault_events` structs, in Move field order. Every
 * event is typed `<Meme, Quote>`; `VaultCreated` adds `<Venue>`, the venue
 * witness that created the vault. `ProtocolFeesPaid` is core's
 * (`decodeProtocolFeesPaid`, origin = vault ID); `Paused`/`Unpaused` are the
 * admin package's.
 */
export const vaultEventBcs = {
  VaultCreated: bcs.struct("VaultCreated", {
    vault_id: suiObjectIdBcs,
    pool_id: suiObjectIdBcs,
    position_id: suiObjectIdBcs,
    liquidity: u128Bcs,
    terms: vaultTermsBcs,
    residual_meme_amount: u64Bcs,
    residual_quote_amount: u64Bcs,
  }),
  /** Route amounts follow the applied split's route order. */
  FeesCollected: bcs.struct("FeesCollected", {
    vault_id: suiObjectIdBcs,
    gross_meme_amount: u64Bcs,
    gross_quote_amount: u64Bcs,
    protocol_meme_amount: u64Bcs,
    protocol_quote_amount: u64Bcs,
    route_meme_amounts: bcs.vector(u64Bcs),
    route_quote_amounts: bcs.vector(u64Bcs),
  }),
  AutoLpPositionOpened: bcs.struct("AutoLpPositionOpened", {
    vault_id: suiObjectIdBcs,
    position_id: suiObjectIdBcs,
  }),
  AutoLiquidityAdded: bcs.struct("AutoLiquidityAdded", {
    vault_id: suiObjectIdBcs,
    meme_amount: u64Bcs,
    quote_amount: u64Bcs,
    auto_lp_meme_pending: u64Bcs,
    auto_lp_quote_pending: u64Bcs,
  }),
  BuybackBurned: bcs.struct("BuybackBurned", {
    vault_id: suiObjectIdBcs,
    quote_spent: u64Bcs,
    meme_burned: u64Bcs,
    burn_quote_pending: u64Bcs,
  }),
  OwnerBalancesClaimed: bcs.struct("OwnerBalancesClaimed", {
    vault_id: suiObjectIdBcs,
    meme_amount: u64Bcs,
    quote_amount: u64Bcs,
  }),
  RoundPublished: bcs.struct("RoundPublished", {
    vault_id: suiObjectIdBcs,
    round_id: suiObjectIdBcs,
    number: u64Bcs,
    start_checkpoint: u64Bcs,
    end_checkpoint: u64Bcs,
    claim_deadline_at_ms: u64Bcs,
    root: hexBytesBcs,
    manifest_digest: hexBytesBcs,
    leaf_count: u64Bcs,
    meme_amount: u64Bcs,
    quote_amount: u64Bcs,
    meme_unallocated: u64Bcs,
    quote_unallocated: u64Bcs,
    treasury: addressBcs,
    gas_reserve_amount: u64Bcs,
  }),
  RewardClaimed: bcs.struct("RewardClaimed", {
    round_id: suiObjectIdBcs,
    index: u64Bcs,
    beneficiary: addressBcs,
    meme_amount: u64Bcs,
    quote_amount: u64Bcs,
    meme_remaining: u64Bcs,
    quote_remaining: u64Bcs,
  }),
  GasReserveSettled: bcs.struct("GasReserveSettled", {
    vault_id: suiObjectIdBcs,
    round_id: suiObjectIdBcs,
    number: u64Bcs,
    treasury: addressBcs,
    reimbursement_amount: u64Bcs,
    reserve_returned: u64Bcs,
    quote_unallocated: u64Bcs,
  }),
  RoundClosed: bcs.struct("RoundClosed", {
    vault_id: suiObjectIdBcs,
    round_id: suiObjectIdBcs,
    number: u64Bcs,
    meme_returned: u64Bcs,
    quote_returned: u64Bcs,
    gas_reserve_returned: u64Bcs,
  }),
};

export type VaultEventKind = keyof typeof vaultEventBcs;

export type VaultEventPayloads = {
  [Kind in VaultEventKind]: ReturnType<(typeof vaultEventBcs)[Kind]["parse"]>;
};

export type DecodedVaultEvent = {
  [Kind in VaultEventKind]: {
    source: "vault";
    kind: Kind;
    memeType: string;
    quoteType: string;
    /** The venue witness type; set only on `VaultCreated`. */
    venue: Kind extends "VaultCreated" ? string : null;
    payload: VaultEventPayloads[Kind];
    sender: string;
    position: SuiEventPosition;
  };
}[VaultEventKind];

/** Decodes one `<vault original>::blast_vault_events::<Kind><Meme, Quote[, Venue]>`. */
export function decodeVaultEvent(
  event: SuiClientTypes.EventEntry,
  vault: Pick<VaultDeployment, "originalPackageId">,
): DecodedVaultEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as VaultEventKind;
  const [meme, quote, venue, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(vault.originalPackageId) ||
    tag.module !== "blast_vault_events" ||
    !Object.hasOwn(vaultEventBcs, kind) ||
    meme === undefined ||
    quote === undefined ||
    (kind === "VaultCreated") !== (venue !== undefined) ||
    extra.length > 0
  ) {
    throw new TypeError(`unexpected vault event type ${event.eventType}`);
  }
  return {
    source: "vault",
    kind,
    memeType: normalizeStructTag(meme),
    quoteType: normalizeStructTag(quote),
    venue: venue === undefined ? null : normalizeStructTag(venue),
    payload: vaultEventBcs[kind].parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedVaultEvent;
}

/**
 * The vault package's `blast_admin` delayed keys. `parent` is the `Vault` for
 * the three `vault::*` keys and the `VaultRegistry` for `WitnessesKey`.
 */
export const vaultDelayedKeys = {
  FeeSplit: {
    key: "vault::FeeSplitKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: feeSplitBcs,
    valueType: "{core}::fee_split::FeeSplit",
  },
  ProtocolBps: {
    key: "vault::ProtocolBpsKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: protocolBpsBcs,
    valueType: "{package}::vault::ProtocolBps",
  },
  /** One vault's holder-reward round slot; `ActionScheduled` carries the full terms. */
  RoundPublication: {
    key: "vault::RoundPublicationKey",
    family: "action",
    keyBcs: unitKeyBcs,
    valueBcs: roundTermsBcs,
    valueType: "{package}::vault::RoundTerms",
  },
  Witnesses: {
    key: "blast_vault_package::WitnessesKey",
    family: "set",
    keyBcs: unitKeyBcs,
    valueBcs: moveTypeNameBcs,
    valueType: "0x1::type_name::TypeName",
  },
} as const satisfies DelayedKeySpecs;

export type DecodedVaultDelayedEvent = DecodedDelayedEvent<
  typeof vaultDelayedKeys
>;

/** Decodes a `blast_admin` delayed event keyed by the vault package. */
export function decodeVaultDelayedEvent(
  event: SuiClientTypes.EventEntry,
  vault: Pick<VaultDeployment, "originalPackageId" | "admin" | "core">,
): DecodedVaultDelayedEvent {
  const core = normalizeSuiAddress(vault.core.originalPackageId);
  const keys = Object.fromEntries(
    Object.entries(vaultDelayedKeys).map(([name, spec]) => [
      name,
      { ...spec, valueType: spec.valueType.replaceAll("{core}", core) },
    ]),
  ) as typeof vaultDelayedKeys;
  return decodeDelayedEvent(event, {
    adminPackageId: vault.admin.packageId,
    packageId: vault.originalPackageId,
    keys,
  });
}
