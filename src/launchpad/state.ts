import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import { normalizePositiveU64 } from "../lib/integers.ts";
import type { CurveState } from "./curve.ts";
import type { SharedObjectReference } from "./transactions.ts";

const IdBcs = bcs.struct("ID", { bytes: bcs.Address });
const UidBcs = bcs.struct("UID", { id: IdBcs });
const BpsBcs = bcs.struct("Bps", { value: bcs.u64() });
const BalanceBcs = bcs.struct("Balance", { value: bcs.u64() });
const AsciiStringBcs = bcs.struct("AsciiString", {
  bytes: bcs.vector(bcs.u8()),
});
const TypeNameBcs = bcs.struct("TypeName", { name: AsciiStringBcs });
const LifecycleBcs = bcs.enum("Lifecycle", {
  Live: null,
  MigrationReady: null,
  Migrated: null,
});
const CreatorIdentityBcs = bcs.enum("CreatorIdentity", {
  Address: bcs.Address,
  X: bcs.vector(bcs.u8()),
});
const CreatorAuthorityBcs = bcs.struct("CreatorAuthority", {
  identity: CreatorIdentityBcs,
});
const MetadataCapBcs = bcs.struct("MetadataCap", { id: UidBcs });
const FeeLedgerBcs = bcs.struct("FeeLedger", {
  protocol_meme: BalanceBcs,
  creator_meme: BalanceBcs,
  protocol_quote: BalanceBcs,
  creator_quote: BalanceBcs,
});

/** BCS layout of `blast_fun::launch::Launch<Meme, Quote>`. */
export const launchBcs = bcs.struct("Launch", {
  id: UidBcs,
  lifecycle: LifecycleBcs,
  sell_burn_bps: BpsBcs,
  virtual_quote: bcs.u64(),
  migration_quote_target: bcs.u64(),
  quote_fee_bps: BpsBcs,
  meme_fee_bps: BpsBcs,
  quote_migration_fee_bps: BpsBcs,
  protocol_meme_graduation_fee_bps: BpsBcs,
  meme_liquidity_provision_bps: BpsBcs,
  migration_witness: TypeNameBcs,
  meme_reserve: BalanceBcs,
  real_quote_reserve: BalanceBcs,
  pending_burn: BalanceBcs,
  protocol_meme_graduation_fee: BalanceBcs,
  meme_liquidity_provision: BalanceBcs,
  fee_ledger: FeeLedgerBcs,
  metadata_cap: bcs.option(MetadataCapBcs),
  creator_authority: bcs.option(CreatorAuthorityBcs),
});

export type LaunchLifecycle = "Live" | "MigrationReady" | "Migrated";

export type CreatorIdentity =
  | { kind: "address"; address: string }
  | { kind: "x"; identityHash: Uint8Array }
  | null;

export type LaunchState = CurveState &
  SharedObjectReference<true> & {
    memeType: string;
    quoteType: string;
    lifecycle: LaunchLifecycle;
    sellBurnBps: bigint;
    quoteMigrationFeeBps: bigint;
    protocolMemeGraduationFeeBps: bigint;
    memeLiquidityProvisionBps: bigint;
    migrationWitnessType: string;
    pendingBurn: bigint;
    protocolMemeGraduationFee: bigint;
    memeLiquidityProvision: bigint;
    protocolMemeTradeFees: bigint;
    creatorMemeTradeFees: bigint;
    protocolQuoteTradeFees: bigint;
    creatorQuoteTradeFees: bigint;
    metadataCapId: string | null;
    creatorIdentity: CreatorIdentity;
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
  const metadataCapId = parsed.metadata_cap
    ? normalizeSuiObjectId(parsed.metadata_cap.id.id.bytes)
    : null;

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
    quoteMigrationFeeBps: toBigInt(parsed.quote_migration_fee_bps.value),
    protocolMemeGraduationFeeBps: toBigInt(
      parsed.protocol_meme_graduation_fee_bps.value,
    ),
    memeLiquidityProvisionBps: toBigInt(
      parsed.meme_liquidity_provision_bps.value,
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
    creatorIdentity: decodeCreatorIdentity(parsed.creator_authority),
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

function decodeCreatorIdentity(
  authority: ReturnType<typeof launchBcs.parse>["creator_authority"],
): CreatorIdentity {
  if (!authority) return null;
  if (authority.identity.$kind === "Address") {
    return {
      kind: "address",
      address: normalizeSuiAddress(authority.identity.Address),
    };
  }
  return {
    kind: "x",
    identityHash: Uint8Array.from(authority.identity.X),
  };
}

function decodeTypeName(bytes: readonly number[]): string {
  return new TextDecoder("ascii", { fatal: true }).decode(
    Uint8Array.from(bytes),
  );
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
