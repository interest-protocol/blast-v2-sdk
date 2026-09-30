import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import {
  moveTypeNameBcs,
  suiBalanceBcs,
  suiIdBcs,
  suiUidBcs,
} from "../lib/bcs.ts";
import { normalizePositiveU64 } from "../lib/integers.ts";
import type {
  AllocationPlan,
  FeeSplit,
  ProtocolAllocation,
} from "./allocation.ts";
import {
  allocationPlanBcs,
  bpsBcs,
  feeSplitBcs,
  protocolAllocationBcs,
} from "./allocation.ts";
import type { CurveState } from "./curve.ts";
import type { SharedObjectReference } from "./transactions.ts";

const LifecycleBcs = bcs.enum("Lifecycle", {
  OpeningRound: null,
  Live: null,
  MigrationReady: null,
  Migrated: null,
});
/** BCS layout of `blast_fun::creator_authority::CreatorRecipient`. */
export const creatorRecipientBcs = bcs.enum("CreatorRecipient", {
  Address: bcs.Address,
  Account: bcs.vector(bcs.u8()),
});
const MetadataCapBcs = bcs.struct("MetadataCap", { id: suiUidBcs });
const FeeLedgerBcs = bcs.struct("FeeLedger", {
  protocol_meme: suiBalanceBcs,
  creator_meme: suiBalanceBcs,
  protocol_quote: suiBalanceBcs,
  creator_quote: suiBalanceBcs,
  protocol_sui: suiBalanceBcs,
});

/** BCS layout of `blast_fun::launch::Launch<Meme, Quote>`. */
export const launchBcs = bcs.struct("Launch", {
  id: suiUidBcs,
  lifecycle: LifecycleBcs,
  public_start_ms: bcs.option(bcs.u64()),
  opening_round_ms: bcs.u64(),
  opening_round_bids: bcs.u64(),
  opening_round_quote: suiBalanceBcs,
  opening_round_meme: suiBalanceBcs,
  sell_burn_bps: bpsBcs,
  virtual_quote: bcs.u64(),
  graduation_target: bcs.u64(),
  quote_fee_bps: bpsBcs,
  meme_fee_bps: bpsBcs,
  migration_witness: moveTypeNameBcs,
  pool_tick_spacing: bcs.u32(),
  pool_fee_rate: bcs.u64(),
  lp_fee_split: feeSplitBcs,
  atomic_supply: bcs.u64(),
  meme_reserve: suiBalanceBcs,
  real_quote_reserve: suiBalanceBcs,
  pending_burn: suiBalanceBcs,
  allocation_plan: allocationPlanBcs,
  allocated_meme: suiBalanceBcs,
  fee_ledger: FeeLedgerBcs,
  metadata_cap: MetadataCapBcs,
  creator: bcs.option(creatorRecipientBcs),
  curve_fee_cap_id: bcs.option(suiIdBcs),
  blast_metadata_cap_id: bcs.option(suiIdBcs),
  partner_id: bcs.option(suiIdBcs),
});

/** BCS layout of `blast_fun::launch_config::LaunchConfig`. */
export const launchConfigBcs = bcs.struct("LaunchConfig", {
  id: suiUidBcs,
  meme_decimals: bcs.vector(bcs.u8()),
  quotes: bcs.struct("Table", { id: suiUidBcs, size: bcs.u64() }),
  quote_fee_bps: bpsBcs,
  meme_fee_bps: bpsBcs,
  migration_witnesses: bcs.vector(moveTypeNameBcs),
  protocol_allocation: protocolAllocationBcs,
  creation_fee: bcs.u64(),
});

export type LaunchLifecycle =
  | "OpeningRound"
  | "Live"
  | "MigrationReady"
  | "Migrated";

export type CreatorRecipient =
  | { kind: "address"; address: string }
  | { kind: "account"; accountCommitment: Uint8Array }
  | null;

export type LaunchState = CurveState &
  SharedObjectReference<true> & {
    memeType: string;
    quoteType: string;
    lifecycle: LaunchLifecycle;
    /** When the launch was shared; null only before the key-only launch is shared. */
    publicStartMs: bigint | null;
    /** Opening-round length after share; zero when trading starts at share. */
    openingRoundMs: bigint;
    /** Quote of the opening-round bids not yet delivered. */
    openingRoundBids: bigint;
    /** The pot until settlement, then the Quote it left to refund. */
    openingRoundQuote: bigint;
    /** Meme the settled pot bought, awaiting delivery. */
    openingRoundMeme: bigint;
    sellBurnBps: bigint;
    migrationWitnessType: string;
    /** Creator-chosen `(tick_spacing, fee_rate)` in the bound venue's native units. */
    poolTickSpacing: number;
    poolFeeRate: bigint;
    /** Creator LP-fee split the adapter installs at migration; never changes on the launch. */
    lpFeeSplit: FeeSplit;
    atomicSupply: bigint;
    pendingBurn: bigint;
    allocationPlan: AllocationPlan;
    /** Pooled non-curve Meme allocations paid out when migration begins. */
    allocatedMeme: bigint;
    protocolMemeTradeFees: bigint;
    creatorMemeTradeFees: bigint;
    protocolQuoteTradeFees: bigint;
    creatorQuoteTradeFees: bigint;
    /** Blast's SUI creation fee, held until Blast claims its fees. */
    protocolSuiFees: bigint;
    metadataCapId: string;
    creatorRecipient: CreatorRecipient;
    /** The `CurveFeeCap` the launch honors; null until claimed or reassigned. */
    curveFeeCapId: string | null;
    blastMetadataCapId: string | null;
    /** The partner named at creation, paid at Blast's claim; it never changes. */
    partnerId: string | null;
  };

export type LaunchObject = SharedObjectReference<true> & {
  type: string;
  content: Uint8Array;
};

/** Decodes one canonical launch object from its BCS content. */
export function decodeLaunchObject(
  object: LaunchObject,
  originalPackageId?: string,
): LaunchState {
  const tag = parseStructTag(object.type);
  if (tag.module !== "launch" || tag.name !== "Launch") {
    throw new TypeError(`object ${object.objectId} is not a launch`);
  }
  if (tag.typeParams.length !== 2) {
    throw new TypeError(
      `launch ${object.objectId} must have two type arguments`,
    );
  }
  if (
    originalPackageId !== undefined &&
    tag.address !== normalizeSuiAddress(originalPackageId)
  ) {
    throw new TypeError(`launch ${object.objectId} has an unexpected package`);
  }

  const parsed = launchBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  const initialSharedVersion = normalizePositiveU64(
    "initialSharedVersion",
    object.initialSharedVersion,
  );
  if (object.mutable !== true) {
    throw new TypeError(`launch ${object.objectId} must be mutable`);
  }
  if (normalizeSuiObjectId(parsed.id.id.bytes) !== objectId) {
    throw new TypeError(`launch ${object.objectId} has a mismatched UID`);
  }

  return {
    objectId,
    initialSharedVersion,
    mutable: true,
    memeType: normalizeTypeParameter(tag.typeParams[0]),
    quoteType: normalizeTypeParameter(tag.typeParams[1]),
    lifecycle: parsed.lifecycle.$kind,
    publicStartMs: optionalBigInt(parsed.public_start_ms),
    openingRoundMs: BigInt(parsed.opening_round_ms),
    openingRoundBids: BigInt(parsed.opening_round_bids),
    openingRoundQuote: BigInt(parsed.opening_round_quote.value),
    openingRoundMeme: BigInt(parsed.opening_round_meme.value),
    sellBurnBps: parsed.sell_burn_bps,
    virtualQuote: BigInt(parsed.virtual_quote),
    graduationTarget: BigInt(parsed.graduation_target),
    quoteFeeBps: parsed.quote_fee_bps,
    memeFeeBps: parsed.meme_fee_bps,
    migrationWitnessType: parsed.migration_witness,
    poolTickSpacing: parsed.pool_tick_spacing,
    poolFeeRate: BigInt(parsed.pool_fee_rate),
    lpFeeSplit: parsed.lp_fee_split,
    atomicSupply: BigInt(parsed.atomic_supply),
    memeReserve: BigInt(parsed.meme_reserve.value),
    realQuoteReserve: BigInt(parsed.real_quote_reserve.value),
    pendingBurn: BigInt(parsed.pending_burn.value),
    allocationPlan: parsed.allocation_plan,
    allocatedMeme: BigInt(parsed.allocated_meme.value),
    protocolMemeTradeFees: BigInt(parsed.fee_ledger.protocol_meme.value),
    creatorMemeTradeFees: BigInt(parsed.fee_ledger.creator_meme.value),
    protocolQuoteTradeFees: BigInt(parsed.fee_ledger.protocol_quote.value),
    creatorQuoteTradeFees: BigInt(parsed.fee_ledger.creator_quote.value),
    protocolSuiFees: BigInt(parsed.fee_ledger.protocol_sui.value),
    metadataCapId: normalizeSuiObjectId(parsed.metadata_cap.id.id.bytes),
    creatorRecipient: decodeCreatorRecipient(parsed.creator),
    curveFeeCapId: optionalId(parsed.curve_fee_cap_id),
    blastMetadataCapId: optionalId(parsed.blast_metadata_cap_id),
    partnerId: optionalId(parsed.partner_id),
  };
}

/** Reads and decodes one launch through the transport-neutral Sui Core API. */
export async function getLaunch(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId?: string,
): Promise<LaunchState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });

  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`launch ${object.objectId} is not a shared object`);
  }

  return decodeLaunchObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      mutable: true,
      type: object.type,
      content: object.content,
    },
    originalPackageId,
  );
}

export type LaunchConfigState = {
  objectId: string;
  /** Admitted Meme precisions. */
  memeDecimals: number[];
  /** Admitted Quote types live in this table, one key each. */
  quotesTableId: string;
  quoteCount: bigint;
  /** Trade fees a new launch snapshots. */
  quoteFeeBps: bigint;
  memeFeeBps: bigint;
  migrationWitnessTypes: string[];
  /** Blast's one-time migration fee a new launch snapshots. */
  protocolAllocation: ProtocolAllocation;
  /** SUI, in MIST, `launch::finalize` requires exactly. */
  creationFee: bigint;
};

/** Reads and decodes the `LaunchConfig` singleton that launch creation reads. */
export async function getLaunchConfig(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<LaunchConfigState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  const expected = normalizeStructTag(
    `${normalizeSuiAddress(originalPackageId)}::launch_config::LaunchConfig`,
  );
  if (normalizeStructTag(object.type) !== expected) {
    throw new TypeError(`object ${object.objectId} is not the launch config`);
  }
  const parsed = launchConfigBcs.parse(object.content);
  return {
    objectId: normalizeSuiObjectId(parsed.id.id.bytes),
    memeDecimals: parsed.meme_decimals,
    quotesTableId: normalizeSuiObjectId(parsed.quotes.id.id.bytes),
    quoteCount: BigInt(parsed.quotes.size),
    quoteFeeBps: parsed.quote_fee_bps,
    memeFeeBps: parsed.meme_fee_bps,
    migrationWitnessTypes: parsed.migration_witnesses,
    protocolAllocation: parsed.protocol_allocation,
    creationFee: BigInt(parsed.creation_fee),
  };
}

/**
 * Reads `bidder`'s undelivered opening-round Quote (the
 * `launch::OpeningRoundBidKey` dynamic field); zero without a bid or once
 * delivered.
 */
export async function getOpeningRoundBid(
  client: ClientWithCoreApi,
  launchId: string,
  bidder: string,
  originalPackageId: string,
): Promise<bigint> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: normalizeSuiObjectId(launchId),
      name: {
        type: `${normalizeSuiAddress(originalPackageId)}::launch::OpeningRoundBidKey`,
        bcs: bcs.Address.serialize(normalizeSuiAddress(bidder)).toBytes(),
      },
    });
    return BigInt(bcs.u64().parse(dynamicField.value.bcs));
  } catch (error) {
    if (error instanceof ObjectError && error.reason === "notFound") return 0n;
    throw error;
  }
}

/** Decodes a `creator_authority::CreatorRecipient`; null once claimed or reassigned. */
export function decodeCreatorRecipient(
  recipient: ReturnType<typeof creatorRecipientBcs.parse> | null,
): CreatorRecipient {
  if (!recipient) return null;
  if (recipient.$kind === "Address") {
    return { kind: "address", address: normalizeSuiAddress(recipient.Address) };
  }
  return {
    kind: "account",
    accountCommitment: Uint8Array.from(recipient.Account),
  };
}

function normalizeTypeParameter(
  type: ReturnType<typeof parseStructTag>["typeParams"][number] | undefined,
): string {
  if (type === undefined) throw new TypeError("missing launch type argument");
  return typeof type === "string" ? type : normalizeStructTag(type);
}

function optionalBigInt(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function optionalId(value: { bytes: string } | null): string | null {
  return value === null ? null : normalizeSuiObjectId(value.bytes);
}
