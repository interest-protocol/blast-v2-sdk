import type {
  Delayed,
  DelayedAction,
  PendingDelay,
} from "@interest-protocol/blast-core/bcs";
import {
  addressBcs,
  admission,
  balanceBcs,
  delayedActionBcs,
  delayedBcs,
  delayedSetBcs,
  moveTypeNameBcs,
  suiObjectIdBcs,
  suiUidBcs,
  u64Bcs,
  unitKeyBcs,
  vecSetBcs,
} from "@interest-protocol/blast-core/bcs";
import { bpsBcs } from "@interest-protocol/blast-core/bps";
import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import { feeSplitBcs } from "@interest-protocol/blast-core/fee-split";
import { normalizePositiveU64 } from "@interest-protocol/blast-core/integers";
import type { Ledger } from "@interest-protocol/blast-core/protocol-fees";
import { ledgerBcs } from "@interest-protocol/blast-core/protocol-fees";
import type {
  SharedObjectIdentity,
  SharedObjectReference,
} from "@interest-protocol/blast-core/sui";
import type { PartnerList } from "@interest-protocol/blast-partners-sdk/state";
import { partnerListBcs } from "@interest-protocol/blast-partners-sdk/state";
import { vaultId } from "@interest-protocol/blast-vault-sdk/state";
import type { VaultDeployment } from "@interest-protocol/blast-vault-sdk/transactions";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  deriveObjectID,
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
  toHex,
} from "@mysten/sui/utils";
import type { AllocationPlan, ProtocolAllocation } from "./allocation.ts";
import { allocationPlanBcs, protocolAllocationBcs } from "./allocation.ts";
import type { CurveState } from "./curve.ts";

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

/** BCS layout of `blast_fun::launch::Launch<Meme, Quote>`. */
export const launchBcs = bcs.struct("Launch", {
  id: suiUidBcs,
  lifecycle: LifecycleBcs,
  public_start_ms: bcs.option(u64Bcs),
  opening_round_ms: u64Bcs,
  opening_round_bids: u64Bcs,
  opening_round_quote: balanceBcs,
  opening_round_meme: balanceBcs,
  sell_burn_bps: bpsBcs,
  virtual_quote: u64Bcs,
  graduation_target: u64Bcs,
  quote_fee_bps: bpsBcs,
  meme_fee_bps: bpsBcs,
  venue: moveTypeNameBcs,
  lp_fee_split: feeSplitBcs,
  atomic_supply: u64Bcs,
  meme_reserve: balanceBcs,
  real_quote_reserve: balanceBcs,
  pending_burn: balanceBcs,
  allocation_plan: allocationPlanBcs,
  allocated_meme: balanceBcs,
  protocol_fees: ledgerBcs,
  creator_meme_fees: balanceBcs,
  creator_quote_fees: balanceBcs,
  metadata_cap: MetadataCapBcs,
  curve_fee_cap_reassignment: delayedActionBcs(unitKeyBcs, addressBcs),
  creator_metadata_cap_reassignment: delayedActionBcs(unitKeyBcs, addressBcs),
  creator: bcs.option(creatorRecipientBcs),
  curve_fee_cap_id: bcs.option(suiObjectIdBcs),
  creator_metadata_cap_id: bcs.option(suiObjectIdBcs),
  partner_id: bcs.option(suiObjectIdBcs),
});

/** BCS layout of `blast_fun::launch_ticket::LaunchTicket<Meme>`. */
export const launchTicketBcs = bcs.struct("LaunchTicket", {
  id: suiUidBcs,
  meme: balanceBcs,
  metadata_cap: MetadataCapBcs,
  creator: creatorRecipientBcs,
  decimals: bcs.u8(),
  burnable: bcs.bool(),
  sell_burn_bps: bpsBcs,
});

/**
 * `launch::Lifecycle`. A launch with an opening round starts in
 * `OpeningRound`; settling it, or finalizing without one, makes it `Live`.
 */
export type LaunchLifecycle =
  | "OpeningRound"
  | "Live"
  | "MigrationReady"
  | "Migrated";

export type CreatorRecipient =
  | { kind: "address"; address: string }
  | { kind: "account"; accountCommitment: Uint8Array }
  | null;

/** A proposed cap reassignment to an address, or a proposed delay change. */
export type CapReassignmentProposal = NonNullable<
  DelayedAction<null, string>["pending"]
>;

export type LaunchState = CurveState &
  SharedObjectReference<true> & {
    memeType: string;
    quoteType: string;
    lifecycle: LaunchLifecycle;
    /** Clock time `launch::share` ran; null before the launch is shared. */
    publicStartMs: bigint | null;
    /** Opening-round length after share; zero means no opening round. */
    openingRoundMs: bigint;
    /** Quote of the opening-round bids not yet delivered. */
    openingRoundBids: bigint;
    /** The pot until settlement, then the Quote it left to refund. */
    openingRoundQuote: bigint;
    /** Meme the settled pot bought, held for delivery. */
    openingRoundMeme: bigint;
    sellBurnBps: bigint;
    /** The venue witness type the liquidity migrates to (`launch::Launch.venue`). */
    venue: string;
    /** The creator's LP-fee split the vault starts with at migration. */
    lpFeeSplit: FeeSplit;
    atomicSupply: bigint;
    pendingBurn: bigint;
    allocationPlan: AllocationPlan;
    /** Pooled non-curve Meme allocations paid out when migration begins. */
    allocatedMeme: bigint;
    /**
     * Blast's unclaimed fees: trade fees, the SUI creation fee and the
     * one-time migration fee, paid by `claimProtocolFees`.
     */
    protocolFees: Ledger;
    creatorMemeFees: bigint;
    creatorQuoteFees: bigint;
    /** The applied delay of a `CurveFeeCap` reassignment. */
    curveFeeCapDelayMs: bigint;
    /** A proposed reassignment, or a proposed delay when `value.kind` is `Delay`. */
    pendingCurveFeeCapReassignment: CapReassignmentProposal | null;
    creatorMetadataCapDelayMs: bigint;
    pendingCreatorMetadataCapReassignment: CapReassignmentProposal | null;
    /** The Coin Registry `MetadataCap<Meme>` the launch holds. */
    metadataCapId: string;
    creatorRecipient: CreatorRecipient;
    /** The `CurveFeeCap` the launch honors; null until claimed or reassigned. */
    curveFeeCapId: string | null;
    /** The `CreatorMetadataCap` the launch honors; null until claimed or reassigned. */
    creatorMetadataCapId: string | null;
    /** The Blast partner named at creation, for good; null when none. */
    partnerId: string | null;
  };

/** Decoded `launch_ticket::LaunchTicket<Meme>`, owned by its publisher. */
export type LaunchTicketState = {
  objectId: string;
  memeType: string;
  /** The whole atomic supply, held until finalization. */
  meme: bigint;
  metadataCapId: string;
  creatorRecipient: CreatorRecipient;
  decimals: number;
  burnable: boolean;
  sellBurnBps: bigint;
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
    publicStartMs: parsed.public_start_ms,
    openingRoundMs: parsed.opening_round_ms,
    openingRoundBids: parsed.opening_round_bids,
    openingRoundQuote: parsed.opening_round_quote,
    openingRoundMeme: parsed.opening_round_meme,
    sellBurnBps: parsed.sell_burn_bps,
    virtualQuote: parsed.virtual_quote,
    graduationTarget: parsed.graduation_target,
    quoteFeeBps: parsed.quote_fee_bps,
    memeFeeBps: parsed.meme_fee_bps,
    venue: parsed.venue,
    lpFeeSplit: parsed.lp_fee_split,
    atomicSupply: parsed.atomic_supply,
    memeReserve: parsed.meme_reserve,
    realQuoteReserve: parsed.real_quote_reserve,
    pendingBurn: parsed.pending_burn,
    allocationPlan: parsed.allocation_plan,
    allocatedMeme: parsed.allocated_meme,
    protocolFees: parsed.protocol_fees,
    creatorMemeFees: parsed.creator_meme_fees,
    creatorQuoteFees: parsed.creator_quote_fees,
    curveFeeCapDelayMs: parsed.curve_fee_cap_reassignment.delay_ms,
    pendingCurveFeeCapReassignment: parsed.curve_fee_cap_reassignment.pending,
    creatorMetadataCapDelayMs:
      parsed.creator_metadata_cap_reassignment.delay_ms,
    pendingCreatorMetadataCapReassignment:
      parsed.creator_metadata_cap_reassignment.pending,
    metadataCapId: normalizeSuiObjectId(parsed.metadata_cap.id.id.bytes),
    creatorRecipient: decodeCreatorRecipient(parsed.creator),
    curveFeeCapId: parsed.curve_fee_cap_id,
    creatorMetadataCapId: parsed.creator_metadata_cap_id,
    partnerId: parsed.partner_id,
  };
}

/**
 * First millisecond the opening round has ended (`public_start_ms +
 * opening_round_ms`), when `settle_opening_round` may run; null before share
 * or without an opening round.
 */
export function openingRoundEndMs(
  launch: Pick<LaunchState, "publicStartMs" | "openingRoundMs">,
): bigint | null {
  if (launch.publicStartMs === null || launch.openingRoundMs === 0n) {
    return null;
  }
  return launch.publicStartMs + launch.openingRoundMs;
}

/** Decodes one owned `launch_ticket::LaunchTicket<Meme>` from its BCS content. */
export function decodeLaunchTicketObject(
  object: { objectId: string; type: string; content: Uint8Array },
  originalPackageId?: string,
): LaunchTicketState {
  const tag = parseStructTag(object.type);
  if (tag.module !== "launch_ticket" || tag.name !== "LaunchTicket") {
    throw new TypeError(`object ${object.objectId} is not a launch ticket`);
  }
  if (tag.typeParams.length !== 1) {
    throw new TypeError(
      `launch ticket ${object.objectId} must have one type argument`,
    );
  }
  if (
    originalPackageId !== undefined &&
    tag.address !== normalizeSuiAddress(originalPackageId)
  ) {
    throw new TypeError(
      `launch ticket ${object.objectId} has an unexpected package`,
    );
  }
  const parsed = launchTicketBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (normalizeSuiObjectId(parsed.id.id.bytes) !== objectId) {
    throw new TypeError(
      `launch ticket ${object.objectId} has a mismatched UID`,
    );
  }
  return {
    objectId,
    memeType: normalizeTypeParameter(tag.typeParams[0]),
    meme: parsed.meme,
    metadataCapId: normalizeSuiObjectId(parsed.metadata_cap.id.id.bytes),
    creatorRecipient: decodeCreatorRecipient(parsed.creator),
    decimals: parsed.decimals,
    burnable: parsed.burnable,
    sellBurnBps: parsed.sell_burn_bps,
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

/** Reads the one launch of `memeType`, at its derived ID (`launchId`). */
export async function getLaunchByMeme(
  client: ClientWithCoreApi,
  launchpad: {
    originalPackageId: string;
    launchRegistry: SharedObjectIdentity;
  },
  memeType: string,
): Promise<LaunchState> {
  return getLaunch(
    client,
    launchId(launchpad, memeType),
    launchpad.originalPackageId,
  );
}

/**
 * Reads `bidder`'s undelivered opening-round Quote (the
 * `launch::OpeningRoundBidKey(address)` dynamic field); zero without a bid or
 * after delivery.
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

/** `launch_config::TradeFees`. */
export const tradeFeesBcs = bcs.struct("TradeFees", {
  quote_fee_bps: bpsBcs,
  meme_fee_bps: bpsBcs,
});

/** `launch_config::ProtocolLpFees`: Blast's share of each asset in a new vault's LP fees. */
export const protocolLpFeesBcs = bcs.struct("ProtocolLpFees", {
  meme_bps: bpsBcs,
  quote_bps: bpsBcs,
});

/** BCS layout of `blast_fun::launch_config::LaunchConfig`. */
export const launchConfigBcs = bcs.struct("LaunchConfig", {
  id: suiUidBcs,
  meme_decimals: vecSetBcs(bcs.u8()),
  quotes: vecSetBcs(moveTypeNameBcs),
  trade_fees: delayedBcs(unitKeyBcs, tradeFeesBcs),
  venues: delayedSetBcs(unitKeyBcs, moveTypeNameBcs),
  protocol_allocation: delayedBcs(unitKeyBcs, protocolAllocationBcs),
  protocol_lp_fees: delayedBcs(unitKeyBcs, protocolLpFeesBcs),
  creation_fee: delayedBcs(unitKeyBcs, u64Bcs),
  partners: partnerListBcs,
});

/**
 * One account-claim signer: a 32-byte Ed25519 public key, as Move's
 * `vector<u8>`, decoded to lowercase hex without a prefix.
 */
export const claimSignerKeyBcs = bcs.byteVector().transform({
  input: (hex: string) => fromHex(hex),
  output: (bytes) => toHex(bytes),
});

/** BCS layout of `blast_fun::runtime_config::RuntimeConfig`. */
export const runtimeConfigBcs = bcs.struct("RuntimeConfig", {
  id: suiUidBcs,
  creator_claim_signers: delayedSetBcs(unitKeyBcs, claimSignerKeyBcs),
  protocol_fee_share_bps: delayedBcs(unitKeyBcs, bpsBcs),
});

/** Decoded shared `launch_config::LaunchConfig`, the admission policy for new launches. */
export type LaunchConfigState = {
  objectId: string;
  initialSharedVersion: string;
  memeDecimals: number[];
  /** Admitted Quote types, as `type_name::with_original_ids` names them. */
  quotes: string[];
  quoteFeeBps: bigint;
  memeFeeBps: bigint;
  tradeFeesPolicy: Delayed<
    null,
    { quote_fee_bps: bigint; meme_fee_bps: bigint }
  >;
  /** Admitted venue witness types. */
  venues: string[];
  /** The applied delay for new venue admissions. */
  venueDelayMs: bigint;
  /** A proposed next admission delay. */
  pendingVenueDelay: PendingDelay | null;
  /** Pending admissions; each keeps the delay it was scheduled under. */
  pendingVenues: Readonly<Record<string, PendingDelay>>;
  protocolAllocation: ProtocolAllocation;
  protocolAllocationPolicy: Delayed<null, ProtocolAllocation>;
  /** Blast's share of each asset in the LP fees of vaults created afterward. */
  protocolLpFees: { memeBps: bigint; quoteBps: bigint };
  protocolLpFeesPolicy: Delayed<null, { meme_bps: bigint; quote_bps: bigint }>;
  /** The exact SUI, in MIST, `launch::finalize` requires. */
  creationFee: bigint;
  creationFeePolicy: Delayed<null, bigint>;
  /**
   * Partners new launches may name: `owner` is this config; read one entry
   * with `getPartnerAcceptance(client, partners.acceptance_ends_at_ms.id, partnerId)`.
   */
  partners: PartnerList;
};

export type RuntimeConfigState = {
  objectId: string;
  initialSharedVersion: string;
  /**
   * Hex Ed25519 keys that may sign account claims; any one verifies. Empty
   * when account claims are disabled.
   */
  creatorClaimSigners: string[];
  /** The applied delay for new signer admissions. */
  claimSignerDelayMs: bigint;
  /** A proposed next signer delay. */
  pendingClaimSignerDelay: PendingDelay | null;
  /** Pending signer admissions by hex key; each keeps the delay it was scheduled under. */
  pendingClaimSigners: Readonly<Record<string, PendingDelay>>;
  /** Blast's share of each trade fee, rounded up to Blast. */
  protocolFeeShareBps: bigint;
  protocolFeeSharePolicy: Delayed<null, bigint>;
};

type SharedObjectContent = {
  objectId: string;
  initialSharedVersion: number | string;
  type: string;
  content: Uint8Array;
};

export function decodeLaunchConfigObject(
  object: SharedObjectContent,
  originalPackageId?: string,
): LaunchConfigState {
  requireObjectType(object, "launch_config", "LaunchConfig", originalPackageId);
  const parsed = launchConfigBcs.parse(object.content);
  const venues = admission(parsed.venues);
  return {
    ...sharedIdentity(object, parsed.id.id.bytes),
    memeDecimals: parsed.meme_decimals,
    quotes: parsed.quotes,
    quoteFeeBps: parsed.trade_fees.value.quote_fee_bps,
    memeFeeBps: parsed.trade_fees.value.meme_fee_bps,
    tradeFeesPolicy: parsed.trade_fees,
    venues: venues.members,
    venueDelayMs: venues.delayMs,
    pendingVenueDelay: venues.pendingDelay,
    pendingVenues: venues.pendingMembers,
    protocolAllocation: { ...parsed.protocol_allocation.value },
    protocolAllocationPolicy: parsed.protocol_allocation,
    protocolLpFees: {
      memeBps: parsed.protocol_lp_fees.value.meme_bps,
      quoteBps: parsed.protocol_lp_fees.value.quote_bps,
    },
    protocolLpFeesPolicy: parsed.protocol_lp_fees,
    creationFee: parsed.creation_fee.value,
    creationFeePolicy: parsed.creation_fee,
    partners: parsed.partners,
  };
}

export function decodeRuntimeConfigObject(
  object: SharedObjectContent,
  originalPackageId?: string,
): RuntimeConfigState {
  requireObjectType(
    object,
    "runtime_config",
    "RuntimeConfig",
    originalPackageId,
  );
  const parsed = runtimeConfigBcs.parse(object.content);
  const signers = admission(parsed.creator_claim_signers);
  return {
    ...sharedIdentity(object, parsed.id.id.bytes),
    creatorClaimSigners: signers.members,
    claimSignerDelayMs: signers.delayMs,
    pendingClaimSignerDelay: signers.pendingDelay,
    pendingClaimSigners: signers.pendingMembers,
    protocolFeeShareBps: parsed.protocol_fee_share_bps.value,
    protocolFeeSharePolicy: parsed.protocol_fee_share_bps,
  };
}

function requireObjectType(
  object: SharedObjectContent,
  module: string,
  name: string,
  packageId: string | undefined,
): void {
  const tag = parseStructTag(object.type);
  if (tag.module !== module || tag.name !== name) {
    throw new TypeError(`object ${object.objectId} is not a ${name}`);
  }
  if (
    packageId !== undefined &&
    tag.address !== normalizeSuiAddress(packageId)
  ) {
    throw new TypeError(`${name} ${object.objectId} has an unexpected package`);
  }
}

function sharedIdentity(
  object: SharedObjectContent,
  uid: string,
): { objectId: string; initialSharedVersion: string } {
  const objectId = normalizeSuiObjectId(object.objectId);
  if (normalizeSuiObjectId(uid) !== objectId) {
    throw new TypeError(`object ${object.objectId} has a mismatched UID`);
  }
  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
  };
}

/** Reads and decodes a shared configuration object through the Core API. */
async function getSharedContent(
  client: ClientWithCoreApi,
  objectId: string,
): Promise<SharedObjectContent> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`object ${object.objectId} is not shared`);
  }
  return {
    objectId: object.objectId,
    initialSharedVersion: object.owner.Shared.initialSharedVersion,
    type: object.type,
    content: object.content,
  };
}

/** Reads and decodes the shared `LaunchConfig` through the Core API. */
export async function getLaunchConfig(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId?: string,
): Promise<LaunchConfigState> {
  return decodeLaunchConfigObject(
    await getSharedContent(client, objectId),
    originalPackageId,
  );
}

/** Reads and decodes the shared `RuntimeConfig` through the Core API. */
export async function getRuntimeConfig(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId?: string,
): Promise<RuntimeConfigState> {
  return decodeRuntimeConfigObject(
    await getSharedContent(client, objectId),
    originalPackageId,
  );
}

/**
 * The ID of the `Launch<Meme, Quote>` for `memeType`:
 * `derived_object::derive_address(launch_registry, LaunchKey<Meme>())`. The
 * key has no fields (one `dummy_field: bool` byte); pass original package
 * IDs, as `type_name::with_original_ids` would name them.
 */
export function launchId(
  launchpad: {
    originalPackageId: string;
    launchRegistry: SharedObjectIdentity;
  },
  memeType: string,
): string {
  return deriveObjectID(
    normalizeSuiObjectId(launchpad.launchRegistry.objectId),
    `${normalizeSuiObjectId(launchpad.originalPackageId)}::launch::LaunchKey<${normalizeStructTag(memeType)}>`,
    unitKeyBcs.serialize(null).toBytes(),
  );
}

/**
 * The ID of the vault a migrated launch's venue creates: `vaultId` keyed by
 * the launchpad's `blast_fun::PackageWitness` and the launch's ID.
 */
export function launchVaultId(
  launchpad: {
    originalPackageId: string;
    vault: Pick<VaultDeployment, "originalPackageId" | "registry">;
  },
  launchId: string,
): string {
  return vaultId(
    launchpad.vault,
    `${normalizeSuiObjectId(launchpad.originalPackageId)}::blast_fun::PackageWitness`,
    launchId,
  );
}
