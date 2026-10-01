import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeSuiObjectId, parseStructTag } from "@mysten/sui/utils";

import {
  addressBcs,
  moveTypeNameBcs,
  suiObjectIdBcs,
  suiUidBcs,
} from "../lib/bcs.ts";
import { normalizePositiveU64 } from "../lib/integers.ts";
import type { SharedObjectIdentity } from "../lib/sui.ts";
import { timelockedBcs } from "../lib/timelock.ts";

/** BCS layout of `blast_admin::blast_acl::ACL`. */
export const aclBcs = bcs.struct("ACL", {
  id: suiUidBcs,
  super_admin_cap_id: suiObjectIdBcs,
  admins: bcs.vector(
    bcs.struct("Entry", {
      key: suiObjectIdBcs,
      value: bcs.vector(moveTypeNameBcs),
    }),
  ),
  pending_super_admin: timelockedBcs(bcs.option(addressBcs)),
});

/** A nominated super admin, who may accept from `executeAfterMs`. */
export type PendingSuperAdmin = { recipient: string; executeAfterMs: bigint };

export type AclState = SharedObjectIdentity & {
  /** The one live `SuperAdminCap`. */
  superAdminCapId: string;
  /** Every live `AdminCap` and the role types it holds. */
  admins: Readonly<Record<string, readonly string[]>>;
  pendingSuperAdmin: PendingSuperAdmin | null;
};

export type AclObject = SharedObjectIdentity & {
  type: string;
  content: Uint8Array;
};

export function decodeAclObject(
  object: AclObject,
  adminPackageId: string,
): AclState {
  const tag = parseStructTag(object.type);
  if (
    tag.address !== normalizeSuiObjectId(adminPackageId) ||
    tag.module !== "blast_acl" ||
    tag.name !== "ACL"
  ) {
    throw new TypeError(`object ${object.objectId} is not the Blast ACL`);
  }
  const parsed = aclBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (normalizeSuiObjectId(parsed.id.id.bytes) !== objectId) {
    throw new TypeError(`ACL ${object.objectId} has a mismatched UID`);
  }
  const nominee = parsed.pending_super_admin.after;
  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    superAdminCapId: parsed.super_admin_cap_id,
    admins: Object.fromEntries(
      parsed.admins.map(({ key, value }) => [key, value]),
    ),
    pendingSuperAdmin:
      nominee == null
        ? null
        : {
            recipient: nominee,
            executeAfterMs: parsed.pending_super_admin.atMs,
          },
  };
}

export async function getAcl(
  client: ClientWithCoreApi,
  objectId: string,
  adminPackageId: string,
): Promise<AclState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`ACL ${object.objectId} is not a shared object`);
  }
  return decodeAclObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      type: object.type,
      content: object.content,
    },
    adminPackageId,
  );
}
