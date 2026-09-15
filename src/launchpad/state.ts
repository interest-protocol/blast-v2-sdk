import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
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
import type { CurveState } from "./curve.ts";
import type { SharedObjectReference } from "./transactions.ts";

const BpsBcs = bcs.struct("Bps", { value: bcs.u64() });
const AsciiStringBcs = bcs.struct("AsciiString", {
  bytes: bcs.vector(bcs.u8()),
});
const TypeNameBcs = bcs.struct("TypeName", { name: AsciiStringBcs });
const LifecycleBcs = bcs.enum("Lifecycle", {
  Live: null,
  MigrationReady: null,
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
/** BCS layout of `blast_fun::launch::CurveFeeAuthority`. */
export const creatorFeeAuthorityBcs = bcs.enum("CreatorFeeAuthority", {
  Unassigned: null,
  Cap: suiIdBcs,
  Custodian: moveTypeNameBcs,
});
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
  sell_burn_bps: BpsBcs,
  virtual_quote: bcs.u64(),
  migration_quote_target: bcs.u64(),
  quote_fee_bps: BpsBcs,
  meme_fee_bps: BpsBcs,
  protocol_quote_migration_fee_bps: BpsBcs,
  migration_witness: TypeNameBcs,
  meme_reserve: suiBalanceBcs,
  real_quote_reserve: suiBalanceBcs,
  pending_burn: suiBalanceBcs,
  protocol_meme_graduation_fee: suiBalanceBcs,
  meme_liquidity_provision: suiBalanceBcs,
  fee_ledger: FeeLedgerBcs,
  metadata_cap: MetadataCapBcs,
  creator_authority: bcs.option(CreatorAuthorityBcs),
  curve_fee_authority: creatorFeeAuthorityBcs,
  blast_metadata_cap_id: bcs.option(suiIdBcs),
});

export type LaunchLifecycle = "Live" | "MigrationReady" | "Migrated";

export type CreatorRecipient =
  | { kind: "address"; address: string }
  | { kind: "account"; accountCommitment: Uint8Array }
  | null;

/**
 * Who may claim creator fees: nobody yet, the live capability object, or the
 * custodian module whose witness type the fees are permanently bound to.
 */
export type CreatorFeeAuthority =
  | { kind: "unassigned" }
  | { kind: "cap"; capId: string }
  | { kind: "custodian"; custodianType: string };

export type LaunchState = CurveState &
  SharedObjectReference<true> & {
    memeType: string;
    quoteType: string;
    lifecycle: LaunchLifecycle;
    sellBurnBps: bigint;
    protocolQuoteMigrationFeeBps: bigint;
    migrationWitnessType: string;
    pendingBurn: bigint;
    protocolMemeGraduationFee: bigint;
    memeLiquidityProvision: bigint;
    protocolMemeTradeFees: bigint;
    creatorMemeTradeFees: bigint;
    protocolQuoteTradeFees: bigint;
    creatorQuoteTradeFees: bigint;
    metadataCapId: string;
    creatorRecipient: CreatorRecipient;
    curveFeeAuthority: CreatorFeeAuthority;
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

  const memeType = normalizeTypeParameter(tag.typeParams[0]);
  const quoteType = normalizeTypeParameter(tag.typeParams[1]);
  const metadataCapId = normalizeSuiObjectId(parsed.metadata_cap.id.id.bytes);

  return {
    objectId,
    initialSharedVersion,
    mutable: true,
    memeType,
    quoteType,
    lifecycle: parsed.lifecycle.$kind,
    sellBurnBps: toBigInt(parsed.sell_burn_bps.value),
    virtualQuote: toBigInt(parsed.virtual_quote),
    migrationQuoteTarget: toBigInt(parsed.migration_quote_target),
    quoteFeeBps: toBigInt(parsed.quote_fee_bps.value),
    memeFeeBps: toBigInt(parsed.meme_fee_bps.value),
    protocolQuoteMigrationFeeBps: toBigInt(
      parsed.protocol_quote_migration_fee_bps.value,
    ),
    migrationWitnessType: normalizeStructTag(
      decodeTypeName(parsed.migration_witness.name.bytes),
    ),
    memeReserve: toBigInt(parsed.meme_reserve.value),
    realQuoteReserve: toBigInt(parsed.real_quote_reserve.value),
    pendingBurn: toBigInt(parsed.pending_burn.value),
    protocolMemeGraduationFee: toBigInt(
      parsed.protocol_meme_graduation_fee.value,
    ),
    memeLiquidityProvision: toBigInt(parsed.meme_liquidity_provision.value),
    protocolMemeTradeFees: toBigInt(parsed.fee_ledger.protocol_meme.value),
    creatorMemeTradeFees: toBigInt(parsed.fee_ledger.creator_meme.value),
    protocolQuoteTradeFees: toBigInt(parsed.fee_ledger.protocol_quote.value),
    creatorQuoteTradeFees: toBigInt(parsed.fee_ledger.creator_quote.value),
    metadataCapId,
    creatorRecipient: decodeCreatorRecipient(parsed.creator_authority),
    curveFeeAuthority: decodeCreatorFeeAuthority(parsed.curve_fee_authority),
    blastMetadataCapId: parsed.blast_metadata_cap_id
      ? normalizeSuiObjectId(parsed.blast_metadata_cap_id.bytes)
      : null,
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

/** Decodes a launch `CurveFeeAuthority` value. */
export function decodeCreatorFeeAuthority(
  authority: ReturnType<typeof creatorFeeAuthorityBcs.parse>,
): CreatorFeeAuthority {
  if (authority.$kind === "Cap") {
    return { kind: "cap", capId: normalizeSuiObjectId(authority.Cap.bytes) };
  }
  if (authority.$kind === "Custodian") {
    return { kind: "custodian", custodianType: authority.Custodian };
  }
  return { kind: "unassigned" };
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

function toBigInt(value: string): bigint {
  return BigInt(value);
}
function decodeTypeName(bytes: readonly number[]): string {
  return new TextDecoder("ascii", { fatal: true }).decode(
    Uint8Array.from(bytes),
  );
}
