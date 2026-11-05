import type { DelayedChange } from "@interest-protocol/blast-core/bcs";
import { suiEventId } from "@interest-protocol/blast-core/events";
import type {
  AclEventKind,
  DecodedAclDelayedEvent,
  DecodedAclEvent,
  DecodedPackageAdministrationEvent,
  DecodedUpgradeDelayedEvent,
} from "./events.ts";
import { aclEventBcs, aclEventId } from "./events.ts";
import type { PendingSuperAdmin, UpgradeAction } from "./state.ts";

/**
 * The ACL rebuilt from its events. Its `init` emits nothing, so
 * `superAdminCapId` stays null until the first accepted transfer; the publish
 * effects name the first root. `admins` matches `getAcl(...).admins` once every
 * event is applied.
 */
export type AclProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  /** ACL events by kind; super admin transfer lifecycle events are not counted. */
  eventCounts: Readonly<Record<AclEventKind, number>>;
  superAdminCapId: string | null;
  admins: Readonly<Record<string, readonly string[]>>;
  pendingSuperAdmin: PendingSuperAdmin | null;
};

export function createAclProjection(): AclProjection {
  return {
    appliedEventIds: {},
    eventCounts: Object.fromEntries(
      Object.keys(aclEventBcs).map((kind) => [kind, 0]),
    ) as Record<AclEventKind, number>,
    superAdminCapId: null,
    admins: {},
    pendingSuperAdmin: null,
  };
}

/**
 * Applies one event once; replaying an applied event returns `state` unchanged.
 * The transfer's `delayed` events come from `decodeAclDelayedEvent`.
 */
export function reduceAclEvent(
  state: AclProjection,
  event: DecodedAclEvent | DecodedAclDelayedEvent,
): AclProjection {
  const eventId = aclEventId(event);
  if (state.appliedEventIds[eventId]) return state;
  if (event.source === "delayed") {
    const applied = {
      ...state,
      appliedEventIds: { ...state.appliedEventIds, [eventId]: true as const },
    };
    if (
      event.kind === "ActionScheduled" &&
      event.payload.change.kind === "Action"
    )
      return {
        ...applied,
        pendingSuperAdmin: {
          recipient: event.payload.change.action,
          readyAtMs: event.payload.ready_at_ms,
        },
      };
    if (event.kind === "ActionCancelled" || event.kind === "ActionApplied")
      return { ...applied, pendingSuperAdmin: null };
    return applied;
  }
  const next: AclProjection = {
    ...state,
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
    eventCounts: {
      ...state.eventCounts,
      [event.kind]: state.eventCounts[event.kind] + 1,
    },
  };
  switch (event.kind) {
    case "AdminGranted":
      return withRoles(next, event.payload.admin_cap_id, []);
    case "AdminRevoked":
    case "AdminDestroyed":
      return withRoles(next, event.payload.admin_cap_id, null);
    case "AdminRoleGranted": {
      const { admin_cap_id, role } = event.payload;
      const roles = next.admins[admin_cap_id] ?? [];
      return withRoles(next, admin_cap_id, [...roles, role]);
    }
    case "AdminRoleRevoked": {
      const { admin_cap_id, role } = event.payload;
      const roles = next.admins[admin_cap_id] ?? [];
      return withRoles(
        next,
        admin_cap_id,
        roles.filter((held) => held !== role),
      );
    }
    case "SuperAdminTransferred":
      return {
        ...next,
        superAdminCapId: event.payload.new_super_admin_cap_id,
        pendingSuperAdmin: null,
      };
    case "SuperAdminCapDestroyed":
      return next;
  }
}

function withRoles(
  state: AclProjection,
  adminCapId: string,
  roles: readonly string[] | null,
): AclProjection {
  const { [adminCapId]: _, ...admins } = state.admins;
  return {
    ...state,
    admins: roles === null ? admins : { ...admins, [adminCapId]: roles },
  };
}

/** One package's administration, rebuilt from its `blast_admin` events. */
export type PackageAdministration = {
  packageVersionId: string | null;
  packageAdminId: string | null;
  /** The package witness, defining-ID form, pinned at publication. */
  packageWitness: string | null;
  version: bigint | null;
  validPauseBits: number | null;
  paused: number | null;
  upgradeCapId: string | null;
  upgradeCapVersion: bigint | null;
  policy: number | null;
  /** True once `make_immutable` destroyed the UpgradeCap. */
  immutable: boolean;
  /** The applied delay of upgrade actions; null before `ActionCreated`. */
  upgradeDelayMs: bigint | null;
  /** The scheduled upgrade action or delay change, if any. */
  pendingUpgrade: {
    change: DelayedChange<UpgradeAction>;
    delayMs: bigint;
    readyAtMs: bigint;
  } | null;
};

/** Every package's administration by OTW type, from version, pause, upgrade and upgrade-slot events. */
export type PackageAdministrationProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  packages: Readonly<Record<string, PackageAdministration>>;
};

export function createPackageAdministrationProjection(): PackageAdministrationProjection {
  return { appliedEventIds: {}, packages: {} };
}

const EMPTY_ADMINISTRATION: PackageAdministration = {
  packageVersionId: null,
  packageAdminId: null,
  packageWitness: null,
  version: null,
  validPauseBits: null,
  paused: null,
  upgradeCapId: null,
  upgradeCapVersion: null,
  policy: null,
  immutable: false,
  upgradeDelayMs: null,
  pendingUpgrade: null,
};

/** Applies one event once; replaying an applied event returns `state` unchanged. */
export function reducePackageAdministrationEvent(
  state: PackageAdministrationProjection,
  event: DecodedPackageAdministrationEvent | DecodedUpgradeDelayedEvent,
): PackageAdministrationProjection {
  const eventId = suiEventId(event.position);
  if (state.appliedEventIds[eventId]) return state;
  const current = state.packages[event.otw] ?? EMPTY_ADMINISTRATION;
  return {
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
    packages: {
      ...state.packages,
      [event.otw]: { ...current, ...administrationChange(event) },
    },
  };
}

function administrationChange(
  event: DecodedPackageAdministrationEvent | DecodedUpgradeDelayedEvent,
): Partial<PackageAdministration> {
  if (event.source === "delayed") {
    switch (event.kind) {
      case "ActionCreated":
        return { upgradeDelayMs: event.payload.delay_ms };
      case "ActionScheduled":
        return {
          pendingUpgrade: {
            change: event.payload.change,
            delayMs: event.payload.delay_ms,
            readyAtMs: event.payload.ready_at_ms,
          },
        };
      case "ActionCancelled":
        return { pendingUpgrade: null };
      case "ActionApplied":
        return { pendingUpgrade: null, upgradeDelayMs: event.payload.delay_ms };
      case "ActionDestroyed":
        return {};
    }
  }
  switch (event.kind) {
    case "PackageVersionCreated":
      return {
        packageVersionId: event.payload.package_version_id,
        packageAdminId: event.payload.package_admin_id,
        packageWitness: event.payload.package_witness,
        version: event.payload.version,
        validPauseBits: event.payload.valid_pause_bits,
        paused: event.payload.paused,
      };
    case "PackageAdminCreated":
      return {
        packageAdminId: event.payload.package_admin_id,
        upgradeCapId: event.payload.upgrade_cap_id,
        upgradeCapVersion: event.payload.upgrade_cap_version,
        policy: event.payload.policy,
      };
    case "VersionAdvanced":
      return { version: event.payload.new_version };
    case "Paused":
    case "Unpaused":
      return { paused: event.payload.paused };
    case "UpgradeAuthorized":
      return {};
    case "UpgradeCommitted":
      return { upgradeCapVersion: event.payload.new_upgrade_cap_version };
    case "UpgradeCapDestroyed":
      return { immutable: true, upgradeCapId: null };
  }
}
