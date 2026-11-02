import {
  addressBcs,
  moveTypeNameBcs,
  pendingBcs,
  suiObjectIdBcs,
  suiUidBcs,
  u64Bcs,
} from "@interest-protocol/blast-core/bcs";
import { normalizePositiveU64 } from "@interest-protocol/blast-core/integers";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import { timelockedBcs } from "@interest-protocol/blast-core/timelock";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

/** BCS layout of `blast_admin::blast_acl::ACL`. */
export const aclBcs = bcs.struct("ACL", {
  id: suiUidBcs,
  super_admin_cap_id: suiObjectIdBcs,
  admins: bcs.struct("Table", { id: suiUidBcs, size: u64Bcs }),
  pending_super_admin: timelockedBcs(bcs.option(addressBcs)),
});

/** A nominated super admin, who may accept from `executeAfterMs`. */
export type PendingSuperAdmin = { recipient: string; executeAfterMs: bigint };

export type AclState = SharedObjectIdentity & {
  /** The one live `SuperAdminCap`. */
  superAdminCapId: string;
  adminsTableId: string;
  adminCount: bigint;
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
    tag.name !== "ACL" ||
    tag.typeParams.length !== 0
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
    adminsTableId: normalizeSuiObjectId(parsed.admins.id.id.bytes),
    adminCount: parsed.admins.size,
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
): Promise<AclState & { admins: Readonly<Record<string, readonly string[]>> }> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`ACL ${object.objectId} is not a shared object`);
  }
  const state = decodeAclObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      type: object.type,
      content: object.content,
    },
    adminPackageId,
  );
  const admins: Record<string, readonly string[]> = {};
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const response = await client.core.listDynamicFields({
      parentId: state.adminsTableId,
      cursor,
      limit: 50,
    });
    await appendAclAdmins(
      client,
      state.adminsTableId,
      response.dynamicFields,
      admins,
    );
    if (!response.hasNextPage) {
      if (BigInt(Object.keys(admins).length) !== state.adminCount)
        throw new TypeError("ACL changed during enumeration; retry the read");
      return { ...state, admins };
    }
    if (!response.cursor || seen.has(response.cursor))
      throw new TypeError("ACL pagination did not advance");
    seen.add(response.cursor);
    cursor = response.cursor;
  }
  throw new RangeError(
    "ACL enumeration exceeds 100 pages; use getAclAdminRoles for targeted reads",
  );
}

async function appendAclAdmins(
  client: ClientWithCoreApi,
  adminsTableId: string,
  fields: readonly { $kind: string; name: { type: string; bcs: Uint8Array } }[],
  admins: Record<string, readonly string[]>,
): Promise<void> {
  for (const field of fields) {
    if (
      field.$kind !== "DynamicField" ||
      normalizeStructTag(field.name.type) !==
        normalizeStructTag("0x2::object::ID")
    )
      throw new TypeError("ACL contains an unexpected dynamic field");
    const id = suiObjectIdBcs.parse(field.name.bcs);
    if (id in admins) throw new TypeError("duplicate ACL administrator");
    const roles = await getAclAdminRoles(client, adminsTableId, id);
    if (roles === null)
      throw new TypeError("ACL changed during enumeration; retry the read");
    admins[id] = roles;
  }
}

/** Reads one Table entry. Only an absent field means the cap has no roles. */
export async function getAclAdminRoles(
  client: ClientWithCoreApi,
  adminsTableId: string,
  adminCapId: string,
  options: { signal?: AbortSignal } = {},
): Promise<readonly string[] | null> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      ...options,
      parentId: normalizeSuiObjectId(adminsTableId),
      name: aclAdminFieldName(adminCapId),
    });
    return decodeAclAdminRolesField(dynamicField, adminCapId);
  } catch (error) {
    if (error instanceof ObjectError && error.reason === "notFound")
      return null;
    throw error;
  }
}

/** Launchpad and presale pause containers. Migrators hold only a generation. */
export const packageVersionBcs = bcs.struct("PackageVersion", {
  id: suiUidBcs,
  paused: bcs.u8(),
  generation: bcs.struct("OperationalVersion", { generation: u64Bcs }),
});

export const upgradeActionBcs = bcs.enum("UpgradeAction", {
  Upgrade: bcs.vector(bcs.u8()),
  MakeImmutable: null,
  DelayOnly: null,
});

/** Sealed native custody remains readable without exposing its capabilities. */
export const packageAdminBcs = bcs.struct("PackageAdmin", {
  id: suiUidBcs,
  custody: bcs.struct("UpgradeCustody", {
    publisher: bcs.struct("Publisher", {
      id: suiUidBcs,
      package: bcs.vector(bcs.u8()),
      module_name: bcs.vector(bcs.u8()),
    }),
    upgrade_cap: bcs.option(
      bcs.struct("UpgradeCap", {
        id: suiUidBcs,
        package: suiObjectIdBcs,
        version: u64Bcs,
        policy: bcs.u8(),
      }),
    ),
  }),
  delay_ms: u64Bcs,
  pending: bcs.option(pendingBcs(upgradeActionBcs)),
});

export const migratorsVersionBcs = bcs.struct("PackageVersion", {
  id: suiUidBcs,
  generation: bcs.struct("OperationalVersion", { generation: u64Bcs }),
});

export type PackageVersionState = SharedObjectIdentity & {
  paused: number | null;
  generation: bigint;
};
export type PackageAdministrationState = SharedObjectIdentity & {
  custody: ReturnType<typeof packageAdminBcs.parse>["custody"];
  delayMs: bigint;
  pending: ReturnType<typeof packageAdminBcs.parse>["pending"];
};

/** Explicit product identity prevents a version object from another package being accepted. */
export function decodePackageVersionObject(
  object: AclObject,
  originalPackageId: string,
  product: "launchpad" | "presale" | "migrators",
): PackageVersionState {
  assertAdminObjectType(
    object,
    originalPackageId,
    {
      launchpad: "blast_fun",
      presale: "blast_presale_package",
      migrators: "blast_fun_migrators",
    }[product],
    "PackageVersion",
  );
  if (product === "migrators") {
    const parsed = migratorsVersionBcs.parse(object.content);
    return {
      ...adminIdentity(object, parsed.id.id.bytes),
      paused: null,
      generation: parsed.generation.generation,
    };
  }
  const parsed = packageVersionBcs.parse(object.content);
  return {
    ...adminIdentity(object, parsed.id.id.bytes),
    paused: parsed.paused,
    generation: parsed.generation.generation,
  };
}

export function decodePackageAdministrationObject(
  object: AclObject,
  originalPackageId: string,
): PackageAdministrationState {
  assertAdminObjectType(
    object,
    originalPackageId,
    "package_admin",
    "PackageAdmin",
  );
  const parsed = packageAdminBcs.parse(object.content);
  return {
    ...adminIdentity(object, parsed.id.id.bytes),
    custody: parsed.custody,
    delayMs: parsed.delay_ms,
    pending: parsed.pending,
  };
}

function assertAdminObjectType(
  object: AclObject,
  packageId: string,
  module: string,
  name: string,
): void {
  const tag = parseStructTag(object.type);
  if (
    tag.address !== normalizeSuiObjectId(packageId) ||
    tag.module !== module ||
    tag.name !== name ||
    tag.typeParams.length !== 0
  )
    throw new TypeError(`unexpected administration object ${object.objectId}`);
}

function adminIdentity(object: AclObject, id: string): SharedObjectIdentity {
  const objectId = normalizeSuiObjectId(object.objectId);
  if (normalizeSuiObjectId(id) !== objectId)
    throw new TypeError("administration object UID mismatch");
  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
  };
}

export function aclAdminFieldName(adminCapId: string) {
  return {
    type: normalizeStructTag("0x2::object::ID"),
    bcs: suiObjectIdBcs.serialize(adminCapId).toBytes(),
  };
}

/** Decodes the targeted Table read separately from transport/provider accounting. */
export function decodeAclAdminRolesField(
  dynamicField: {
    name: { type: string; bcs: Uint8Array };
    value: { type: string; bcs: Uint8Array };
  },
  adminCapId: string,
): readonly string[] {
  if (
    normalizeStructTag(dynamicField.name.type) !==
      normalizeStructTag("0x2::object::ID") ||
    suiObjectIdBcs.parse(dynamicField.name.bcs) !==
      normalizeSuiObjectId(adminCapId)
  )
    throw new TypeError("ACL role field has an unexpected cap ID");
  if (
    normalizeStructTag(dynamicField.value.type) !==
    normalizeStructTag("0x2::vec_set::VecSet<0x1::type_name::TypeName>")
  ) {
    throw new TypeError("ACL role field has an unexpected value type");
  }
  return bcs.vector(moveTypeNameBcs).parse(dynamicField.value.bcs);
}

export async function getPackageVersion(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
  product: "launchpad" | "presale" | "migrators",
): Promise<PackageVersionState> {
  return decodePackageVersionObject(
    await readAdministrationObject(client, objectId),
    originalPackageId,
    product,
  );
}

export async function getPackageAdministration(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<PackageAdministrationState> {
  return decodePackageAdministrationObject(
    await readAdministrationObject(client, objectId),
    originalPackageId,
  );
}

async function readAdministrationObject(
  client: ClientWithCoreApi,
  objectId: string,
): Promise<AclObject> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared")
    throw new TypeError(
      `administration object ${object.objectId} is not shared`,
    );
  return {
    objectId: object.objectId,
    initialSharedVersion: object.owner.Shared.initialSharedVersion,
    type: object.type,
    content: object.content,
  };
}
