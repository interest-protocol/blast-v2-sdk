import type {
  AclEventKind,
  DecodedAclDelayedEvent,
  DecodedAclEvent,
} from "./events.ts";
import { aclEventBcs, aclEventId } from "./events.ts";
import type { PendingSuperAdmin } from "./state.ts";

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
