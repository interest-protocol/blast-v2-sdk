import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import { suiBalanceBcs, suiUidBcs } from "../lib/bcs.ts";
import { normalizePositiveU64, requireU64 } from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";
import { OTC_MODULE } from "./transactions.ts";

/** BCS layout of `blast_fun_otc::blast_fun_otc::Offer<Offered, Wanted>`. */
export const offerBcs = bcs.struct("Offer", {
  id: suiUidBcs,
  balance: suiBalanceBcs,
  maker: bcs.Address,
  taker: bcs.option(bcs.Address),
  partial_fills: bcs.bool(),
  offered_amount: bcs.u64(),
  wanted_amount: bcs.u64(),
});

export type OfferState = SharedObjectReference<true> & {
  originalPackageId: string;
  offeredType: string;
  wantedType: string;
  /** Escrow still for sale; zero once fully taken, until the maker cancels. */
  balance: bigint;
  maker: string;
  taker: string | null;
  partialFills: boolean;
  offeredAmount: bigint;
  wantedAmount: bigint;
  /** Escrow already bought: `offeredAmount - balance`. */
  filled: bigint;
};

export type OfferObject = SharedObjectReference<true> & {
  type: string;
  content: Uint8Array;
};

/** Decodes one shared OTC offer. */
export function decodeOfferObject(
  object: OfferObject,
  originalPackageId?: string,
): OfferState {
  const tag = parseStructTag(object.type);
  if (tag.module !== OTC_MODULE || tag.name !== "Offer") {
    throw new TypeError(`object ${object.objectId} is not an OTC offer`);
  }
  if (tag.typeParams.length !== 2) {
    throw new TypeError(
      `OTC offer ${object.objectId} must have two type arguments`,
    );
  }
  const typePackageId = normalizeSuiAddress(tag.address);
  if (
    originalPackageId !== undefined &&
    typePackageId !== normalizeSuiAddress(originalPackageId)
  ) {
    throw new TypeError(
      `OTC offer ${object.objectId} has an unexpected package`,
    );
  }
  if (object.mutable !== true) {
    throw new TypeError(`OTC offer ${object.objectId} must be mutable`);
  }

  const objectId = normalizeSuiObjectId(object.objectId);
  const parsed = offerBcs.parse(object.content);
  if (normalizeSuiObjectId(parsed.id.id.bytes) !== objectId) {
    throw new TypeError(`OTC offer ${objectId} has a mismatched UID`);
  }
  const balance = BigInt(parsed.balance.value);
  const offeredAmount = BigInt(parsed.offered_amount);
  if (balance > offeredAmount) {
    throw new RangeError("offer balance must not exceed its offered amount");
  }
  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    mutable: true,
    originalPackageId: typePackageId,
    offeredType: normalizeTypeParameter(tag.typeParams[0]),
    wantedType: normalizeTypeParameter(tag.typeParams[1]),
    balance,
    maker: normalizeSuiAddress(parsed.maker),
    taker: parsed.taker === null ? null : normalizeSuiAddress(parsed.taker),
    partialFills: parsed.partial_fills,
    offeredAmount,
    wantedAmount: requireU64("wantedAmount", BigInt(parsed.wanted_amount)),
    filled: offeredAmount - balance,
  };
}

/** Reads and decodes one shared OTC offer through the Sui Core API. */
export async function getOffer(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId?: string,
): Promise<OfferState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`OTC offer ${object.objectId} is not a shared object`);
  }
  return decodeOfferObject(
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

function normalizeTypeParameter(
  type: ReturnType<typeof parseStructTag>["typeParams"][number] | undefined,
): string {
  if (type === undefined) throw new TypeError("missing OTC type argument");
  return typeof type === "string" ? type : normalizeStructTag(type);
}
