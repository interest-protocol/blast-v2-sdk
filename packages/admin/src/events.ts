import type { DelayedChange } from "@interest-protocol/blast-core/bcs";
import {
  addressBcs,
  delayedChangeBcs,
  moveTypeNameBcs,
  suiObjectIdBcs,
  u64Bcs,
  unitKeyBcs,
} from "@interest-protocol/blast-core/bcs";
import type { SuiEventPosition } from "@interest-protocol/blast-core/events";
import {
  normalizeSuiEventPosition,
  suiEventId,
} from "@interest-protocol/blast-core/events";
import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from "@mysten/sui/utils";
import { upgradeActionBcs } from "./state.ts";

const roles = bcs.vector(moveTypeNameBcs);

/**
 * The `blast_admin::blast_admin_events` the ACL emits, in Move field order.
 * Generic custody and version facts use packageAdministrationEventBcs below;
 * the super admin transfer's lifecycle uses the `delayed` events under
 * `aclDelayedKeys`.
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

export function aclEventId(event: { position: SuiEventPosition }): string {
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

/** Every lifecycle event `blast_admin::delayed` emits, generic in `<K, T>`. */
export const DELAYED_EVENT_KINDS = [
  "DelayedCreated",
  "DelayedScheduled",
  "DelayedCancelled",
  "DelayedApplied",
  "DelayedDestroyed",
  "ActionCreated",
  "ActionScheduled",
  "ActionCancelled",
  "ActionApplied",
  "ActionDestroyed",
  "MemberRemoved",
] as const;
export type DelayedEventKind = (typeof DELAYED_EVENT_KINDS)[number];

/**
 * Which value a key's events carry: a `Delayed<K, T>` setting, a
 * `DelayedAction<K, A>` slot or a `DelayedSet<K, E>` allowlist.
 */
export type DelayedFamily = "setting" | "action" | "set";

type FamilyKinds = {
  setting: Extract<DelayedEventKind, `Delayed${string}`>;
  action: Extract<DelayedEventKind, `Action${string}`>;
  set: FamilyKinds["action"] | "MemberRemoved";
};

const FAMILY_KINDS: {
  [Family in DelayedFamily]: readonly FamilyKinds[Family][];
} = {
  setting: [
    "DelayedCreated",
    "DelayedScheduled",
    "DelayedCancelled",
    "DelayedApplied",
    "DelayedDestroyed",
  ],
  action: [
    "ActionCreated",
    "ActionScheduled",
    "ActionCancelled",
    "ActionApplied",
    "ActionDestroyed",
  ],
  set: [
    "ActionCreated",
    "ActionScheduled",
    "ActionCancelled",
    "ActionApplied",
    "ActionDestroyed",
    "MemberRemoved",
  ],
};

/** Any `BcsType` decoding `T`, whatever it serializes from. */
type BcsDecoder<T> = Pick<BcsType<T, never>, "parse">;

/**
 * One consumer key `K`. Owners never expose `K`'s constructor, so its type
 * authenticates every event emitted under it; `valueType` is checked too.
 */
export type DelayedKeySpec<Key = unknown, Value = unknown> = {
  /** `<module>::<Struct>` of `K` in the consumer's original package. */
  key: string;
  family: DelayedFamily;
  keyBcs: BcsDecoder<Key>;
  /** BCS of the second type argument: `T`, `A` or `E`. */
  valueBcs: BcsDecoder<Value>;
  /** The second type argument; `{package}` stands for the consumer's original package. */
  valueType: string;
};
export type DelayedKeySpecs = Readonly<Record<string, DelayedKeySpec>>;

/** Move field order of each event; `Value` is `T`, `A` or `E`. */
export type DelayedEventPayloads<Key, Value> = {
  DelayedCreated: { owner: string; key: Key; value: Value; delay_ms: bigint };
  DelayedScheduled: {
    owner: string;
    key: Key;
    value: Value;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  DelayedCancelled: {
    owner: string;
    key: Key;
    value: Value;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  DelayedApplied: {
    owner: string;
    key: Key;
    previous_value: Value;
    value: Value;
    delay_ms: bigint;
  };
  DelayedDestroyed: { owner: string; key: Key };
  ActionCreated: { owner: string; key: Key; delay_ms: bigint };
  ActionScheduled: {
    owner: string;
    key: Key;
    change: DelayedChange<Value>;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  ActionCancelled: {
    owner: string;
    key: Key;
    change: DelayedChange<Value>;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  ActionApplied: {
    owner: string;
    key: Key;
    change: DelayedChange<Value>;
    delay_ms: bigint;
  };
  ActionDestroyed: { owner: string; key: Key };
  MemberRemoved: { owner: string; key: Key; member: Value };
};

/**
 * A decoded delayed event. `name` is the consumer's registry name for `K`;
 * `owner` is the ID of the object storing the value.
 */
export type DecodedDelayedEvent<Specs extends DelayedKeySpecs> = {
  [Name in keyof Specs & string]: {
    [Kind in FamilyKinds[Specs[Name]["family"]]]: {
      source: "delayed";
      kind: Kind;
      name: Name;
      payload: DelayedEventPayloads<
        Specs[Name] extends DelayedKeySpec<infer Key, unknown> ? Key : never,
        Specs[Name] extends DelayedKeySpec<unknown, infer Value> ? Value : never
      >[Kind];
      sender: string;
      position: SuiEventPosition;
    };
  }[FamilyKinds[Specs[Name]["family"]]];
}[keyof Specs & string];

/** Whether `eventType` is a `<adminPackageId>::delayed` lifecycle event. */
export function isDelayedEventType(
  eventType: string,
  adminPackageId: string,
): boolean {
  const tag = parseStructTag(eventType);
  return (
    tag.address === normalizeSuiAddress(adminPackageId) &&
    tag.module === "delayed"
  );
}

/**
 * Decodes one `blast_admin::delayed` event whose key belongs to `packageId`
 * (the consumer's original package) and is listed in `keys`.
 */
export function decodeDelayedEvent<const Specs extends DelayedKeySpecs>(
  event: SuiClientTypes.EventEntry,
  identity: { adminPackageId: string; packageId: string; keys: Specs },
): DecodedDelayedEvent<Specs> {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as DelayedEventKind;
  const keyTag = tag.typeParams[0];
  if (
    tag.address !== normalizeSuiAddress(identity.adminPackageId) ||
    tag.module !== "delayed" ||
    !DELAYED_EVENT_KINDS.includes(kind) ||
    tag.typeParams.length !== 2 ||
    keyTag === undefined ||
    typeof keyTag === "string"
  )
    throw new TypeError(`unexpected delayed event type ${event.eventType}`);
  const packageId = normalizeSuiAddress(identity.packageId);
  const keyType = normalizeStructTag(keyTag);
  const entry = Object.entries(identity.keys).find(
    ([, spec]) => normalizeStructTag(`${packageId}::${spec.key}`) === keyType,
  );
  if (
    entry === undefined ||
    !(FAMILY_KINDS[entry[1].family] as readonly string[]).includes(kind) ||
    normalizeStructTag(event.eventType) !==
      normalizeStructTag(
        `${tag.address}::delayed::${kind}<${keyType}, ${entry[1].valueType.replaceAll("{package}", packageId)}>`,
      )
  )
    throw new TypeError(`unexpected delayed event key ${event.eventType}`);
  const [name, spec] = entry;
  return {
    source: "delayed",
    kind,
    name,
    payload: delayedEventBcs(kind, spec).parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedDelayedEvent<Specs>;
}

/** BCS of one delayed event under `spec`, in Move field order. */
export function delayedEventBcs(
  kind: DelayedEventKind,
  spec: Pick<DelayedKeySpec, "keyBcs" | "valueBcs">,
): BcsType<Record<string, unknown>, Record<string, unknown>> {
  // Every decoder in a spec is a full BcsType; the spec only promises `parse`.
  const value = spec.valueBcs as BcsType<unknown, unknown>;
  const head = {
    owner: suiObjectIdBcs,
    key: spec.keyBcs as BcsType<unknown, unknown>,
  };
  const change = delayedChangeBcs(value);
  const fields = {
    DelayedCreated: { value, delay_ms: u64Bcs },
    DelayedScheduled: { value, delay_ms: u64Bcs, ready_at_ms: u64Bcs },
    DelayedCancelled: { value, delay_ms: u64Bcs, ready_at_ms: u64Bcs },
    DelayedApplied: { previous_value: value, value, delay_ms: u64Bcs },
    DelayedDestroyed: {},
    ActionCreated: { delay_ms: u64Bcs },
    ActionScheduled: { change, delay_ms: u64Bcs, ready_at_ms: u64Bcs },
    ActionCancelled: { change, delay_ms: u64Bcs, ready_at_ms: u64Bcs },
    ActionApplied: { change, delay_ms: u64Bcs },
    ActionDestroyed: {},
    MemberRemoved: { member: value },
  }[kind];
  return bcs.struct(kind, { ...head, ...fields }) as unknown as BcsType<
    Record<string, unknown>,
    Record<string, unknown>
  >;
}

/**
 * Each product's `package_admin::UpgradeKey`: its upgrade and make-immutable
 * slot, `DelayedAction<UpgradeKey, UpgradeAction>`.
 */
export const upgradeDelayedKey = {
  key: "package_admin::UpgradeKey",
  family: "action",
  keyBcs: unitKeyBcs,
  valueBcs: upgradeActionBcs,
  valueType: "{package}::package_admin::UpgradeAction",
} as const satisfies DelayedKeySpec;

/** The ACL's one key: the super admin transfer slot, `DelayedAction<SuperAdminTransfer, address>`. */
export const aclDelayedKeys = {
  SuperAdminTransfer: {
    key: "blast_acl::SuperAdminTransfer",
    family: "action",
    keyBcs: unitKeyBcs,
    valueBcs: addressBcs,
    valueType: "address",
  },
} as const satisfies DelayedKeySpecs;

export type DecodedAclDelayedEvent = DecodedDelayedEvent<typeof aclDelayedKeys>;

/** Decodes the ACL's super admin transfer lifecycle. */
export function decodeAclDelayedEvent(
  event: SuiClientTypes.EventEntry,
  adminPackageId: string,
): DecodedAclDelayedEvent {
  return decodeDelayedEvent(event, {
    adminPackageId,
    packageId: adminPackageId,
    keys: aclDelayedKeys,
  });
}
