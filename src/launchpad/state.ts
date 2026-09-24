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
import type { AllocationPlan, FeeSplit } from "./allocation.ts";
import { allocationPlanBcs, bpsBcs, feeSplitBcs } from "./allocation.ts";
import type { CurveState } from "./curve.ts";
import type { SharedObjectReference } from "./transactions.ts";

const LifecycleBcs = bcs.enum("Lifecycle", {
  Live: null,
  MigrationReady: null,
  Migrating: null,
  Migrated: null,
});
const CreatorRecipientBcs = bcs.enum("CreatorRecipient", {
  Address: bcs.Address,
  Account: bcs.vector(bcs.u8()),
});
const CreatorAuthorityBcs = bcs.struct("CreatorAuthority", {
  recipient: CreatorRecipientBcs,
});
const MetadataCapBcs = bcs.struct("MetadataCap", { id: suiUidBcs });
const FeeLedgerBcs = bcs.struct("FeeLedger", {
  protocol_meme: suiBalanceBcs,
  creator_meme: suiBalanceBcs,
  protocol_quote: suiBalanceBcs,
  creator_quote: suiBalanceBcs,
});

/** BCS layout of `blast_fun::launch::Launch<Meme, Quote>`. */
export const launchBcs = bcs.struct("Launch", {
  id: suiUidBcs,
  lifecycle: LifecycleBcs,
  public_start_ms: bcs.option(bcs.u64()),
  protection_end_ms: bcs.option(bcs.u64()),
  pre_share_buy_completed: bcs.bool(),
  protection_window_ms: bcs.u64(),
  cumulative_sender_bps: bpsBcs,
  cumulative_atomic_limit: bcs.u64(),
  per_transaction_bps: bpsBcs,
  per_transaction_atomic_limit: bcs.u64(),
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
  creator_authority: bcs.option(CreatorAuthorityBcs),
  curve_fee_cap_id: bcs.option(suiIdBcs),
  blast_metadata_cap_id: bcs.option(suiIdBcs),
});

/** `Migrating` exists only inside a migration transaction; reads never observe it. */
export type LaunchLifecycle =
  | "Live"
  | "MigrationReady"
  | "Migrating"
  | "Migrated";

export type CreatorRecipient =
  | { kind: "address"; address: string }
  | { kind: "account"; accountCommitment: Uint8Array }
  | null;

/** Public curve-purchase protection, fixed at launch finalization. */
export type LaunchProtection = {
  windowMs: bigint;
  cumulativeSenderBps: bigint;
  cumulativeAtomicLimit: bigint;
  perTransactionBps: bigint;
  perTransactionAtomicLimit: bigint;
};

export type LaunchState = CurveState &
  SharedObjectReference<true> & {
    memeType: string;
    quoteType: string;
    lifecycle: LaunchLifecycle;
    /** Public opening time; null only before the key-only launch is shared. */
    publicStartMs: bigint | null;
    /** First millisecond public purchases are no longer protected. */
    protectionEndMs: bigint | null;
    preShareBuyCompleted: boolean;
    protection: LaunchProtection;
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
    /** Pooled non-curve Meme allocations paid out when migration completes. */
    allocatedMeme: bigint;
    protocolMemeTradeFees: bigint;
    creatorMemeTradeFees: bigint;
    protocolQuoteTradeFees: bigint;
    creatorQuoteTradeFees: bigint;
    metadataCapId: string;
    creatorRecipient: CreatorRecipient;
    /** The `CurveFeeCap` the launch honors; null until claimed or reassigned. */
    curveFeeCapId: string | null;
    blastMetadataCapId: string | null;
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
    protectionEndMs: optionalBigInt(parsed.protection_end_ms),
    preShareBuyCompleted: parsed.pre_share_buy_completed,
    protection: {
      windowMs: BigInt(parsed.protection_window_ms),
      cumulativeSenderBps: parsed.cumulative_sender_bps,
      cumulativeAtomicLimit: BigInt(parsed.cumulative_atomic_limit),
      perTransactionBps: parsed.per_transaction_bps,
      perTransactionAtomicLimit: BigInt(parsed.per_transaction_atomic_limit),
    },
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
    metadataCapId: normalizeSuiObjectId(parsed.metadata_cap.id.id.bytes),
    creatorRecipient: decodeCreatorRecipient(parsed.creator_authority),
    curveFeeCapId: optionalId(parsed.curve_fee_cap_id),
    blastMetadataCapId: optionalId(parsed.blast_metadata_cap_id),
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

/**
 * Reads the gross Meme `sender` bought from the curve while the launch was
 * protected (`launch::protected_purchases`); zero before the first purchase.
 */
export async function getProtectedPurchases(
  client: ClientWithCoreApi,
  launchId: string,
  sender: string,
  originalPackageId: string,
): Promise<bigint> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: normalizeSuiObjectId(launchId),
      name: {
        type: `${normalizeSuiAddress(originalPackageId)}::launch::ProtectedPurchasesKey`,
        bcs: bcs.Address.serialize(normalizeSuiAddress(sender)).toBytes(),
      },
    });
    return BigInt(bcs.u64().parse(dynamicField.value.bcs));
  } catch (error) {
    if (error instanceof ObjectError && error.reason === "notFound") return 0n;
    throw error;
  }
}

function decodeCreatorRecipient(
  authority: ReturnType<typeof launchBcs.parse>["creator_authority"],
): CreatorRecipient {
  if (!authority) return null;
  if (authority.recipient.$kind === "Address") {
    return {
      kind: "address",
      address: normalizeSuiAddress(authority.recipient.Address),
    };
  }
  return {
    kind: "account",
    accountCommitment: Uint8Array.from(authority.recipient.Account),
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
