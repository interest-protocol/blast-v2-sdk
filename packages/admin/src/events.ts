import {
  addressBcs,
  moveTypeNameBcs,
  suiObjectIdBcs,
  u64Bcs,
} from "@interest-protocol/blast-core/bcs";
import type { SuiEventPosition } from "@interest-protocol/blast-core/events";
import {
  normalizeSuiEventPosition,
  suiEventId,
} from "@interest-protocol/blast-core/events";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from "@mysten/sui/utils";

const roles = bcs.vector(moveTypeNameBcs);
const transfer = { recipient: addressBcs, execute_after_ms: u64Bcs };

/**
 * The `blast_admin::blast_admin_events` the ACL emits, in Move field order.
 * Generic custody and version facts use packageAdministrationEventBcs below.
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

/** Native custody and operational generation facts, authenticated by the consumer's package marker. */
export const packageAdministrationEventBcs = {
  OperationalVersionAdvanced: bcs.struct("OperationalVersionAdvanced", {
    container_id: suiObjectIdBcs,
    package_id: addressBcs,
    previous_generation: u64Bcs,
    new_generation: u64Bcs,
  }),
  UpgradeAuthorized: bcs.struct("UpgradeAuthorized", {
    custodian_id: suiObjectIdBcs,
    upgrade_cap_id: suiObjectIdBcs,
    package_id: suiObjectIdBcs,
    native_version: u64Bcs,
    policy: bcs.u8(),
    digest: bcs.vector(bcs.u8()),
  }),
  UpgradeCapDestroyed: bcs.struct("UpgradeCapDestroyed", {
    custodian_id: suiObjectIdBcs,
    upgrade_cap_id: suiObjectIdBcs,
    package_id: addressBcs,
    final_native_version: u64Bcs,
    final_policy: bcs.u8(),
  }),
  UpgradeCommitted: bcs.struct("UpgradeCommitted", {
    custodian_id: suiObjectIdBcs,
    upgrade_cap_id: suiObjectIdBcs,
    original_package_id: addressBcs,
    new_package_id: suiObjectIdBcs,
    previous_native_version: u64Bcs,
    new_native_version: u64Bcs,
  }),
  UpgradeCustodyCreated: bcs.struct("UpgradeCustodyCreated", {
    custodian_id: suiObjectIdBcs,
    publisher_id: suiObjectIdBcs,
    upgrade_cap_id: suiObjectIdBcs,
    package_id: suiObjectIdBcs,
    native_version: u64Bcs,
    policy: bcs.u8(),
  }),
  UpgradePolicyRestricted: bcs.struct("UpgradePolicyRestricted", {
    custodian_id: suiObjectIdBcs,
    upgrade_cap_id: suiObjectIdBcs,
    package_id: addressBcs,
    native_version: u64Bcs,
    previous_policy: bcs.u8(),
    new_policy: bcs.u8(),
  }),
};
export type PackageAdministrationEventKind =
  keyof typeof packageAdministrationEventBcs;
export type DecodedPackageAdministrationEvent = {
  [Kind in PackageAdministrationEventKind]: {
    source: "package-administration";
    kind: Kind;
    packageMarker: string;
    payload: ReturnType<(typeof packageAdministrationEventBcs)[Kind]["parse"]>;
    sender: string;
    position: SuiEventPosition;
  };
}[PackageAdministrationEventKind];

export function decodePackageAdministrationEvent(
  event: SuiClientTypes.EventEntry,
  identity: { adminPackageId: string; packageMarker: string },
): DecodedPackageAdministrationEvent {
  const tag = parseStructTag(event.eventType);
  if (
    tag.address !== normalizeSuiAddress(identity.adminPackageId) ||
    tag.module !== "blast_admin_events" ||
    tag.typeParams.length !== 1 ||
    normalizeStructTag(tag.typeParams[0]!) !==
      normalizeStructTag(identity.packageMarker) ||
    !Object.hasOwn(packageAdministrationEventBcs, tag.name)
  )
    throw new TypeError("unexpected package administration event identity");
  const kind = tag.name as PackageAdministrationEventKind;
  return {
    source: "package-administration",
    kind,
    packageMarker: normalizeStructTag(identity.packageMarker),
    payload: packageAdministrationEventBcs[kind].parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedPackageAdministrationEvent;
}
