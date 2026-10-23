import {
  addressBcs,
  suiObjectIdBcs,
  suiUidBcs,
  u64Bcs,
} from "@interest-protocol/blast-core/bcs";
import {
  BASIS_POINTS_DENOMINATOR,
  mulDivDown,
  normalizePositiveU64,
} from "@interest-protocol/blast-core/integers";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import type { Timelocked } from "@interest-protocol/blast-core/timelock";
import {
  timelockedBcs,
  timelockedValue,
} from "@interest-protocol/blast-core/timelock";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeSuiObjectId, parseStructTag } from "@mysten/sui/utils";

/** `blast_partners::delay_ms`: every change Blast makes to a partner waits this long. */
export const PARTNER_DELAY_MS = 604_800_000n;

/** The partner's recipient, scheduled share, and managing cap, as Move stores them. */
export type PartnerTerms = {
  recipient: string;
  /** Basis points of Blast's fee on each trade naming the partner. */
  shareBps: Timelocked<bigint>;
  /** The only `PartnerCap` that may set `recipient`. */
  capId: Timelocked<string>;
};

export const partnerTermsBcs = {
  recipient: addressBcs,
  share_bps: timelockedBcs(u64Bcs),
  cap_id: timelockedBcs(suiObjectIdBcs),
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
  if (normalizeSuiObjectId(parsed.id.id.bytes) !== objectId) {
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
 * Mirrors `blast_partners::pay`: the partner's share of `fee` (Blast's fee on
 * one trade, in that coin's atoms) at `nowMs`, rounded down; Blast keeps the
 * remainder.
 */
export function partnerPayment(
  partner: Pick<PartnerTerms, "shareBps">,
  fee: bigint,
  nowMs: bigint,
): bigint {
  return mulDivDown(
    fee,
    timelockedValue(partner.shareBps, nowMs),
    BASIS_POINTS_DENOMINATOR,
  );
}
