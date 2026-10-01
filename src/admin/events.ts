import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import {
  addressBcs,
  moveTypeNameBcs,
  suiObjectIdBcs,
  u64Bcs,
} from "../lib/bcs.ts";
import type { SuiEventPosition } from "../lib/events.ts";
import { normalizeSuiEventPosition, suiEventId } from "../lib/events.ts";

const roles = bcs.vector(moveTypeNameBcs);
const transfer = { recipient: addressBcs, execute_after_ms: u64Bcs };

/**
 * The `blast_admin::blast_admin_events` the ACL emits, in Move field order.
 * The generic upgrade-custody and operational-version events belong to
 * package upgrades, which the SDK leaves to publish tooling.
 */
export const aclEventBcs = {
  AdminGranted: bcs.struct("AdminGranted", {
    admin_cap_id: suiObjectIdBcs,
    recipient: addressBcs,
  }),
  AdminRevoked: bcs.struct("AdminRevoked", {
    admin_cap_id: suiObjectIdBcs,
    roles,
  }),
  AdminRoleGranted: bcs.struct("AdminRoleGranted", {
    admin_cap_id: suiObjectIdBcs,
    role: moveTypeNameBcs,
  }),
  AdminRoleRevoked: bcs.struct("AdminRoleRevoked", {
    admin_cap_id: suiObjectIdBcs,
    role: moveTypeNameBcs,
  }),
  AdminDestroyed: bcs.struct("AdminDestroyed", {
    admin_cap_id: suiObjectIdBcs,
    roles,
    was_active: bcs.bool(),
  }),
  SuperAdminTransferStarted: bcs.struct("SuperAdminTransferStarted", transfer),
  SuperAdminTransferCancelled: bcs.struct(
    "SuperAdminTransferCancelled",
    transfer,
  ),
  SuperAdminTransferred: bcs.struct("SuperAdminTransferred", {
    previous_super_admin_cap_id: suiObjectIdBcs,
    new_super_admin_cap_id: suiObjectIdBcs,
    recipient: addressBcs,
  }),
  SuperAdminCapDestroyed: bcs.struct("SuperAdminCapDestroyed", {
    super_admin_cap_id: suiObjectIdBcs,
  }),
};

export type AclEventKind = keyof typeof aclEventBcs;

export type AclEventPayloads = {
  [Kind in AclEventKind]: ReturnType<(typeof aclEventBcs)[Kind]["parse"]>;
};

export type DecodedAclEvent = {
  [Kind in AclEventKind]: {
    source: "admin";
    kind: Kind;
    payload: AclEventPayloads[Kind];
    sender: string;
    position: SuiEventPosition;
  };
}[AclEventKind];

/** Decodes one `<adminPackageId>::blast_admin_events::<Kind>` ACL event. */
export function decodeAclEvent(
  event: SuiClientTypes.EventEntry,
  adminPackageId: string,
): DecodedAclEvent {
  const tag = parseStructTag(event.eventType);
  if (
    tag.address !== normalizeSuiAddress(adminPackageId) ||
    tag.module !== "blast_admin_events" ||
    tag.typeParams.length > 0 ||
    !Object.hasOwn(aclEventBcs, tag.name)
  ) {
    throw new TypeError(`unexpected ACL event type ${event.eventType}`);
  }
  const kind = tag.name as AclEventKind;
  return {
    source: "admin",
    kind,
    payload: aclEventBcs[kind].parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedAclEvent;
}

export function aclEventId(event: DecodedAclEvent): string {
  return suiEventId(event.position);
}
