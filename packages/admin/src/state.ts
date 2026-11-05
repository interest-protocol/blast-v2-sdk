import type { DelayedAction } from "@interest-protocol/blast-core/bcs";
import {
  addressBcs,
  delayedActionBcs,
  moveTypeNameBcs,
  suiObjectIdBcs,
  suiUidBcs,
  u64Bcs,
  unitKeyBcs,
} from "@interest-protocol/blast-core/bcs";
import { normalizePositiveU64 } from "@interest-protocol/blast-core/integers";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";
import type { AdminDeployment } from "./transactions.ts";

/** BCS layout of `blast_admin::blast_acl::ACL`. */
export const aclBcs = bcs.struct("ACL", {
  id: suiUidBcs,
  super_admin_cap_id: suiObjectIdBcs,
  admins: bcs.struct("Table", { id: suiUidBcs, size: u64Bcs }),
  super_admin_transfer: delayedActionBcs(unitKeyBcs, addressBcs),
});

/** A nominated super admin, who may accept from `readyAtMs`. */
export type PendingSuperAdmin = { recipient: string; readyAtMs: bigint };

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
  if (
    normalizeSuiObjectId(parsed.id.id.bytes) !== objectId ||
    parsed.super_admin_transfer.owner !== objectId
  ) {
    throw new TypeError(`ACL ${object.objectId} has a mismatched UID`);
  }
  const proposal = parsed.super_admin_transfer.pending;
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
      proposal?.value.kind === "Action"
        ? { recipient: proposal.value.action, readyAtMs: proposal.ready_at_ms }
        : null,
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

const asciiBytesBcs = bcs.vector(bcs.u8()).transform({
  input: (value: string) => Array.from(new TextEncoder().encode(value)),
  output: (bytes) => new TextDecoder().decode(Uint8Array.from(bytes)),
});

/** `0x2::package::Publisher`; `package` and `module_name` are ASCII strings. */
export const publisherBcs = bcs.struct("Publisher", {
  id: suiUidBcs,
  package: asciiBytesBcs,
  module_name: asciiBytesBcs,
});

/** `0x2::package::UpgradeCap`. */
export const upgradeCapBcs = bcs.struct("UpgradeCap", {
  id: suiUidBcs,
  package: suiObjectIdBcs,
  version: u64Bcs,
  policy: bcs.u8(),
});

/** `blast_admin::package_admin::UpgradeAction`. */
export const upgradeActionBcs = bcs.enum("UpgradeAction", {
  Upgrade: bcs.vector(bcs.u8()),
  MakeImmutable: null,
});
export type UpgradeAction = ReturnType<typeof upgradeActionBcs.parse>;

/**
 * `blast_admin::package_version::PackageVersion<OTW>`: one package's
 * version and pause bits. The `OTW` is phantom: only the object type names it.
 */
export const packageVersionBcs = bcs.struct("PackageVersion", {
  id: suiUidBcs,
  valid_pause_bits: bcs.u8(),
  paused: bcs.u8(),
  package_witness: moveTypeNameBcs,
  version: u64Bcs,
});

/**
 * `blast_admin::package_admin::PackageAdmin<OTW>`: the sealed Publisher and
 * UpgradeCap and the delayed upgrade slot keyed by `UpgradeKey<OTW>`.
 */
export const packageAdminBcs = bcs.struct("PackageAdmin", {
  id: suiUidBcs,
  publisher: publisherBcs,
  upgrade_cap: bcs.option(upgradeCapBcs),
  upgrade: delayedActionBcs(unitKeyBcs, upgradeActionBcs),
});

/** `blast_admin::package_version::Publication<OTW>`: the deployer's owned proof before `wrap`. */
export const publicationBcs = bcs.struct("Publication", {
  id: suiUidBcs,
  publisher: publisherBcs,
  valid_pause_bits: bcs.u8(),
  package_witness: moveTypeNameBcs,
});

/** The package an administration object belongs to, by its one-time witness type. */
export type PackageIdentity = {
  admin: Pick<AdminDeployment, "packageId">;
  /** The package's OTW type, original package ID form. */
  otw: string;
};

export type PackageVersionState = SharedObjectIdentity & {
  otw: string;
  validPauseBits: number;
  paused: number;
  /** The package witness type, defining-ID form, pinned at publication. */
  packageWitness: string;
  version: bigint;
};

export type PackageAdminState = SharedObjectIdentity & {
  otw: string;
  publisherId: string;
  /** Null once the package is immutable. */
  upgradeCap: {
    id: string;
    package: string;
    version: bigint;
    policy: number;
  } | null;
  /** The applied delay of upgrade actions and delay changes. */
  delayMs: bigint;
  /** The proposed upgrade action or delay change, if any. */
  pending: DelayedAction<null, UpgradeAction>["pending"];
};

/** Decodes a `PackageVersion<otw>`; any other package's version is rejected. */
export function decodePackageVersionObject(
  object: AclObject,
  identity: PackageIdentity,
): PackageVersionState {
  const otw = assertPackageObjectType(
    object,
    identity,
    "package_version",
    "PackageVersion",
  );
  const parsed = packageVersionBcs.parse(object.content);
  return {
    ...adminIdentity(object, parsed.id.id.bytes),
    otw,
    validPauseBits: parsed.valid_pause_bits,
    paused: parsed.paused,
    packageWitness: parsed.package_witness,
    version: parsed.version,
  };
}

/** Decodes a `PackageAdmin<otw>`; any other package's administration is rejected. */
export function decodePackageAdminObject(
  object: AclObject,
  identity: PackageIdentity,
): PackageAdminState {
  const otw = assertPackageObjectType(
    object,
    identity,
    "package_admin",
    "PackageAdmin",
  );
  const parsed = packageAdminBcs.parse(object.content);
  if (parsed.upgrade.owner !== normalizeSuiObjectId(parsed.id.id.bytes))
    throw new TypeError("administration object UID mismatch");
  const cap = parsed.upgrade_cap;
  return {
    ...adminIdentity(object, parsed.id.id.bytes),
    otw,
    publisherId: normalizeSuiObjectId(parsed.publisher.id.id.bytes),
    upgradeCap: cap && {
      id: normalizeSuiObjectId(cap.id.id.bytes),
      package: cap.package,
      version: cap.version,
      policy: cap.policy,
    },
    delayMs: parsed.upgrade.delay_ms,
    pending: parsed.upgrade.pending,
  };
}

function assertPackageObjectType(
  object: AclObject,
  identity: PackageIdentity,
  module: string,
  name: string,
): string {
  const otw = normalizeStructTag(identity.otw);
  if (
    normalizeStructTag(object.type) !==
    normalizeStructTag(
      `${normalizeSuiObjectId(identity.admin.packageId)}::${module}::${name}<${otw}>`,
    )
  )
    throw new TypeError(`unexpected administration object ${object.objectId}`);
  return otw;
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
  identity: PackageIdentity,
): Promise<PackageVersionState> {
  return decodePackageVersionObject(
    await readAdministrationObject(client, objectId),
    identity,
  );
}

export async function getPackageAdmin(
  client: ClientWithCoreApi,
  objectId: string,
  identity: PackageIdentity,
): Promise<PackageAdminState> {
  return decodePackageAdminObject(
    await readAdministrationObject(client, objectId),
    identity,
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
