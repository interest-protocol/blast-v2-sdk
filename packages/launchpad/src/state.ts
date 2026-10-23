import {
  moveTypeNameBcs,
  suiBalanceBcs,
  suiIdBcs,
  suiUidBcs,
} from "@interest-protocol/blast-core/bcs";
import {
  BASIS_POINTS_DENOMINATOR,
  normalizePositiveU64,
  requireBasisPoints,
  requireU64,
} from "@interest-protocol/blast-core/integers";
import type { SharedObjectReference } from "@interest-protocol/blast-core/sui";
import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";
import type { AllocationPlan, FeeSplit } from "./allocation.ts";
import { allocationPlanBcs, bpsBcs, feeSplitBcs } from "./allocation.ts";
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

const TreasuryCapBcs = bcs.struct("TreasuryCap", {
  id: suiUidBcs,
  total_supply: bcs.struct("Supply", { value: bcs.u64() }),
});

/** BCS layout of `blast_fun::launch_ticket::LaunchTicket<Meme>`. */
export const launchTicketBcs = bcs.struct("LaunchTicket", {
  id: suiUidBcs,
  meme: suiBalanceBcs,
  treasury_cap: TreasuryCapBcs,
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
    /** Blast's unclaimed Meme: trade fees plus the one-time migration fee. */
    protocolMemeFees: bigint;
    creatorMemeFees: bigint;
    /** Blast's unclaimed Quote: trade fees plus the one-time migration fee. */
    protocolQuoteFees: bigint;
    creatorQuoteFees: bigint;
    /** Unclaimed creation fee, in MIST whatever the Quote. */
    protocolSuiFees: bigint;
    metadataCapId: string;
    creatorRecipient: CreatorRecipient;
    /** The `CurveFeeCap` the launch honors; null until claimed or reassigned. */
    curveFeeCapId: string | null;
    blastMetadataCapId: string | null;
    /** The Blast partner named at creation, for good; null when none. */
    partnerId: string | null;
  };

/** Decoded `launch_ticket::LaunchTicket<Meme>`, owned by its publisher. */
export type LaunchTicketState = {
  objectId: string;
  memeType: string;
  /** The whole atomic supply, held until finalization. */
  meme: bigint;
  treasuryCapId: string;
  totalSupply: bigint;
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
    protocolMemeFees: BigInt(parsed.fee_ledger.protocol_meme.value),
    creatorMemeFees: BigInt(parsed.fee_ledger.creator_meme.value),
    protocolQuoteFees: BigInt(parsed.fee_ledger.protocol_quote.value),
    creatorQuoteFees: BigInt(parsed.fee_ledger.creator_quote.value),
    protocolSuiFees: BigInt(parsed.fee_ledger.protocol_sui.value),
    metadataCapId: normalizeSuiObjectId(parsed.metadata_cap.id.id.bytes),
    creatorRecipient: decodeCreatorRecipient(parsed.creator),
    curveFeeCapId: optionalId(parsed.curve_fee_cap_id),
    blastMetadataCapId: optionalId(parsed.blast_metadata_cap_id),
    partnerId: optionalId(parsed.partner_id),
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
    meme: BigInt(parsed.meme.value),
    treasuryCapId: normalizeSuiObjectId(parsed.treasury_cap.id.id.bytes),
    totalSupply: BigInt(parsed.treasury_cap.total_supply.value),
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

function optionalBigInt(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function optionalId(value: { bytes: string } | null): string | null {
  return value === null ? null : normalizeSuiObjectId(value.bytes);
}

const TableBcs = bcs.struct("Table", { id: suiUidBcs, size: bcs.u64() });

/** BCS layout of `blast_fun::launch_config::LaunchConfig`. */
export const launchConfigBcs = bcs.struct("LaunchConfig", {
  id: suiUidBcs,
  meme_decimals: bcs.vector(bcs.u8()),
  quotes: TableBcs,
  quote_fee_bps: bpsBcs,
  meme_fee_bps: bpsBcs,
  migration_witnesses: bcs.vector(moveTypeNameBcs),
  // Snake-case keys, as the vendored integration SDK decoded them.
  protocol_allocation: bcs.struct("ProtocolAllocation", {
    meme_bps: bpsBcs,
    quote_bps: bpsBcs,
  }),
  creation_fee: bcs.u64(),
});

/** BCS layout of `blast_fun::runtime_config::RuntimeConfig`. */
export const runtimeConfigBcs = bcs.struct("RuntimeConfig", {
  id: suiUidBcs,
  creator_claim_signer_public_key: bcs.vector(bcs.u8()),
  protocol_fee_share_bps: bpsBcs,
});

/** `blast_fun_timelock::Timelocked<T>`: `before` until `atMs`, then `after`. */
export type Timelocked<T> = {
  before: T;
  after: T;
  atMs: bigint;
  delayMs: bigint;
};

const timelockedBcs = <Input, Output>(
  name: string,
  value: BcsType<Output, Input>,
) =>
  bcs.struct(name, {
    before: value,
    after: value,
    at_ms: bcs.u64(),
    delay_ms: bcs.u64(),
  });

/** BCS layout of `blast_partners::blast_partners::Partner`. */
export const partnerBcs = bcs.struct("Partner", {
  id: suiUidBcs,
  recipient: bcs.Address,
  share_bps: timelockedBcs("Timelocked<u64>", bcs.u64()),
  cap_id: timelockedBcs("Timelocked<ID>", suiIdBcs),
});

/** Decoded shared `launch_config::LaunchConfig`, the admission policy for new launches. */
export type LaunchConfigState = {
  objectId: string;
  initialSharedVersion: string;
  memeDecimals: number[];
  /** `Table<TypeName, bool>` of admitted Quotes; read entries by dynamic field. */
  quotesTableId: string;
  quoteCount: bigint;
  quoteFeeBps: bigint;
  memeFeeBps: bigint;
  migrationWitnessTypes: string[];
  protocolAllocation: { memeBps: bigint; quoteBps: bigint };
  /** The exact SUI, in MIST, `launch::finalize` requires. */
  creationFee: bigint;
};

export type RuntimeConfigState = {
  objectId: string;
  initialSharedVersion: string;
  /** Empty when account claims are revoked. */
  creatorClaimSignerPublicKey: Uint8Array;
  /** Blast's share of each trade fee, rounded up to Blast. */
  protocolFeeShareBps: bigint;
};

/** Decoded shared `blast_partners::Partner`. */
export type PartnerState = {
  objectId: string;
  initialSharedVersion: string;
  recipient: string;
  /** The partner's share of Blast's fee, in basis points. */
  shareBps: Timelocked<bigint>;
  capId: Timelocked<string>;
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
  return {
    ...sharedIdentity(object, parsed.id.id.bytes),
    memeDecimals: [...parsed.meme_decimals],
    quotesTableId: normalizeSuiObjectId(parsed.quotes.id.id.bytes),
    quoteCount: BigInt(parsed.quotes.size),
    quoteFeeBps: parsed.quote_fee_bps,
    memeFeeBps: parsed.meme_fee_bps,
    migrationWitnessTypes: [...parsed.migration_witnesses],
    protocolAllocation: {
      memeBps: parsed.protocol_allocation.meme_bps,
      quoteBps: parsed.protocol_allocation.quote_bps,
    },
    creationFee: BigInt(parsed.creation_fee),
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
  return {
    ...sharedIdentity(object, parsed.id.id.bytes),
    creatorClaimSignerPublicKey: Uint8Array.from(
      parsed.creator_claim_signer_public_key,
    ),
    protocolFeeShareBps: parsed.protocol_fee_share_bps,
  };
}

export function decodePartnerObject(
  object: SharedObjectContent,
  partnersPackageId?: string,
): PartnerState {
  requireObjectType(object, "blast_partners", "Partner", partnersPackageId);
  const parsed = partnerBcs.parse(object.content);
  return {
    ...sharedIdentity(object, parsed.id.id.bytes),
    recipient: normalizeSuiAddress(parsed.recipient),
    shareBps: {
      before: BigInt(parsed.share_bps.before),
      after: BigInt(parsed.share_bps.after),
      atMs: BigInt(parsed.share_bps.at_ms),
      delayMs: BigInt(parsed.share_bps.delay_ms),
    },
    capId: {
      before: normalizeSuiObjectId(parsed.cap_id.before.bytes),
      after: normalizeSuiObjectId(parsed.cap_id.after.bytes),
      atMs: BigInt(parsed.cap_id.at_ms),
      delayMs: BigInt(parsed.cap_id.delay_ms),
    },
  };
}

/** Mirrors `Timelocked::value`: `after` from `atMs` on, `before` until then. */
export function timelockedValue<T>(value: Timelocked<T>, nowMs: bigint): T {
  return nowMs >= value.atMs ? value.after : value.before;
}

export type ProtocolFeeClaimPreview = {
  /** Returned to Blast's treasury admin. */
  meme: bigint;
  quote: bigint;
  sui: bigint;
  /** Paid to the partner's address balance in the same call. */
  partnerMeme: bigint;
  partnerQuote: bigint;
  partnerSui: bigint;
};

/**
 * Mirrors `launch::claim_protocol_fees_with_partner` over the launch's
 * protocol ledger (`protocolMemeFees`, `protocolQuoteFees`, `protocolSuiFees`):
 * each partner amount is `floor(amount * shareBps / 10,000)` in atomic units,
 * and Blast keeps the remainder. A zero share previews `claim_protocol_fees`.
 */
export function previewProtocolFeeClaim(input: {
  meme: bigint;
  quote: bigint;
  sui: bigint;
  partnerShareBps: bigint;
}): ProtocolFeeClaimPreview {
  const share = requireBasisPoints("partnerShareBps", input.partnerShareBps);
  const partner = (name: string, amount: bigint) =>
    (requireU64(name, amount) * share) / BASIS_POINTS_DENOMINATOR;
  const partnerMeme = partner("meme", input.meme);
  const partnerQuote = partner("quote", input.quote);
  const partnerSui = partner("sui", input.sui);
  return {
    meme: input.meme - partnerMeme,
    quote: input.quote - partnerQuote,
    sui: input.sui - partnerSui,
    partnerMeme,
    partnerQuote,
    partnerSui,
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

/** Reads and decodes the shared `LaunchConfig` through the Core API. */
export async function getLaunchConfig(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId?: string,
): Promise<LaunchConfigState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`launch config ${object.objectId} is not shared`);
  }
  return decodeLaunchConfigObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      type: object.type,
      content: object.content,
    },
    originalPackageId,
  );
}
