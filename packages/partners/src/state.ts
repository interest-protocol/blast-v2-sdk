import type { Delayed } from "@interest-protocol/blast-core/bcs";
import {
  addressBcs,
  delayedBcs,
  suiObjectIdBcs,
  suiUidBcs,
  tableBcs,
  u64Bcs,
  unitKeyBcs,
} from "@interest-protocol/blast-core/bcs";
import {
  BASIS_POINTS_DENOMINATOR,
  mulDivDown,
  normalizePositiveU64,
} from "@interest-protocol/blast-core/integers";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import { normalizeSuiObjectId, parseStructTag } from "@mysten/sui/utils";

/**
 * `blast_partners::delay_ms`: the fixed notice before a share or cap Blast
 * proposes can be applied.
 */
export const PARTNER_DELAY_MS = 604_800_000n;

/**
 * The partner's recipient, share and managing cap, as Move stores them. A
 * share or cap proposal changes nothing until someone applies it.
 */
export type PartnerTerms = {
  recipient: string;
  /** Basis points of Blast's fee on each trade naming the partner. */
  shareBps: Delayed<null, bigint>;
  /** The only `PartnerCap` that may set `recipient`. */
  capId: Delayed<null, string>;
};

export const partnerTermsBcs = {
  recipient: addressBcs,
  share_bps: delayedBcs(unitKeyBcs, u64Bcs),
  cap_id: delayedBcs(unitKeyBcs, suiObjectIdBcs),
};

/** BCS layout of `blast_partners::blast_partners::Partner`. */
export const partnerBcs = bcs.struct("Partner", {
  id: suiUidBcs,
  ...partnerTermsBcs,
});

export type PartnerState = SharedObjectIdentity & PartnerTerms;

export type PartnerObject = SharedObjectIdentity & {
  type: string;
  content: Uint8Array;
};

export function decodePartnerObject(
  object: PartnerObject,
  partnersPackageId: string,
): PartnerState {
  const tag = parseStructTag(object.type);
  if (
    tag.address !== normalizeSuiObjectId(partnersPackageId) ||
    tag.module !== "blast_partners" ||
    tag.name !== "Partner"
  ) {
    throw new TypeError(`object ${object.objectId} is not a Blast partner`);
  }
  const parsed = partnerBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (
    normalizeSuiObjectId(parsed.id.id.bytes) !== objectId ||
    parsed.share_bps.owner !== objectId ||
    parsed.cap_id.owner !== objectId
  ) {
    throw new TypeError(`partner ${object.objectId} has a mismatched UID`);
  }
  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    recipient: parsed.recipient,
    shareBps: parsed.share_bps,
    capId: parsed.cap_id,
  };
}

export async function getPartner(
  client: ClientWithCoreApi,
  objectId: string,
  partnersPackageId: string,
): Promise<PartnerState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`partner ${object.objectId} is not a shared object`);
  }
  return decodePartnerObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      type: object.type,
      content: object.content,
    },
    partnersPackageId,
  );
}

/**
 * Mirrors `blast_partners::pay`: the partner's applied share of `fee`
 * (Blast's fee on one trade, in that coin's atoms), rounded down; Blast keeps
 * the remainder.
 */
export function partnerPayment(
  partner: Pick<PartnerTerms, "shareBps">,
  fee: bigint,
): bigint {
  return mulDivDown(fee, partner.shareBps.value, BASIS_POINTS_DENOMINATOR);
}

/**
 * BCS layout of `blast_partners::partner_list::PartnerList`, embedded in a
 * product's configuration (`LaunchConfig.partners`,
 * `CreationPolicy.partners`). `owner` is that configuration's ID; each
 * accepted partner is an entry of the `acceptance_ends_at_ms` table.
 */
export const partnerListBcs = bcs.struct("PartnerList", {
  owner: suiObjectIdBcs,
  acceptance_ends_at_ms: tableBcs,
});

export type PartnerList = ReturnType<typeof partnerListBcs.parse>;

/**
 * Reads one entry of a `PartnerList`'s `acceptance_ends_at_ms` table (its
 * `id`): the millisecond from which new sales stop naming `partnerId`, or
 * `U64_MAX` while it is accepted without end. Null when the list never
 * accepted the partner. A partner is accepted at `now` when `now` is before
 * the returned time (`partner_list::is_accepted`).
 */
export async function getPartnerAcceptance(
  client: ClientWithCoreApi,
  listTableId: string,
  partnerId: string,
): Promise<bigint | null> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: normalizeSuiObjectId(listTableId),
      name: {
        type: "0x2::object::ID",
        bcs: suiObjectIdBcs.serialize(partnerId).toBytes(),
      },
    });
    return u64Bcs.parse(dynamicField.value.bcs);
  } catch (error) {
    if (error instanceof ObjectError && error.reason === "notFound")
      return null;
    throw error;
  }
}
