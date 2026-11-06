import type {
  DelayedChange,
  DelayedMapChange,
  DelayedSetChange,
} from "@interest-protocol/blast-core/bcs";
import {
  addressBcs,
  delayedChangeBcs,
  delayedMapChangeBcs,
  delayedSetChangeBcs,
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
 * Package version and administration facts use packageAdministrationEventBcs;
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

/**
 * Decodes one `<adminPackageId>::blast_admin_events::<Kind>` ACL event. Its
 * `role` names are `type_name::with_defining_ids` in Move; for the immutable
 * v1 `blast_admin` and `blast_core` they equal the original-ID names.
 */
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

/**
 * The eight `blast_admin_events` structs generic over a package's OTW, in
 * Move field order. The OTW is only in the event type.
 */
export const packageAdministrationEventBcs = {
  VersionAdvanced: bcs.struct("VersionAdvanced", {
    container_id: suiObjectIdBcs,
    original_package_id: addressBcs,
    previous_version: u64Bcs,
    new_version: u64Bcs,
  }),
  PackageVersionCreated: bcs.struct("PackageVersionCreated", {
    package_version_id: suiObjectIdBcs,
    package_admin_id: suiObjectIdBcs,
    valid_pause_bits: bcs.u8(),
    paused: bcs.u8(),
    package_witness: moveTypeNameBcs,
    version: u64Bcs,
  }),
  PackageAdminCreated: bcs.struct("PackageAdminCreated", {
    package_admin_id: suiObjectIdBcs,
    publisher_id: suiObjectIdBcs,
    upgrade_cap_id: suiObjectIdBcs,
    original_package_id: suiObjectIdBcs,
    upgrade_cap_version: u64Bcs,
    policy: bcs.u8(),
  }),
  UpgradeAuthorized: bcs.struct("UpgradeAuthorized", {
    package_admin_id: suiObjectIdBcs,
    upgrade_cap_id: suiObjectIdBcs,
    current_package_id: suiObjectIdBcs,
    upgrade_cap_version: u64Bcs,
    policy: bcs.u8(),
    digest: bcs.vector(bcs.u8()),
  }),
  UpgradeCommitted: bcs.struct("UpgradeCommitted", {
    package_admin_id: suiObjectIdBcs,
    upgrade_cap_id: suiObjectIdBcs,
    original_package_id: addressBcs,
    new_package_id: suiObjectIdBcs,
    previous_upgrade_cap_version: u64Bcs,
    new_upgrade_cap_version: u64Bcs,
  }),
  UpgradeCapDestroyed: bcs.struct("UpgradeCapDestroyed", {
    package_admin_id: suiObjectIdBcs,
    upgrade_cap_id: suiObjectIdBcs,
    original_package_id: addressBcs,
    final_upgrade_cap_version: u64Bcs,
    final_policy: bcs.u8(),
  }),
  Paused: bcs.struct("Paused", {
    package_version_id: suiObjectIdBcs,
    bits: bcs.u8(),
    paused: bcs.u8(),
  }),
  Unpaused: bcs.struct("Unpaused", {
    package_version_id: suiObjectIdBcs,
    bits: bcs.u8(),
    paused: bcs.u8(),
  }),
};
export type PackageAdministrationEventKind =
  keyof typeof packageAdministrationEventBcs;
export type DecodedPackageAdministrationEvent = {
  [Kind in PackageAdministrationEventKind]: {
    source: "package-administration";
    kind: Kind;
    /** The package's OTW type, from the event type. */
    otw: string;
    payload: ReturnType<(typeof packageAdministrationEventBcs)[Kind]["parse"]>;
    sender: string;
    position: SuiEventPosition;
  };
}[PackageAdministrationEventKind];

/**
 * Decodes one `<adminPackageId>::blast_admin_events::<Kind><OTW>` of any package.
 * Move records `package_witness` with `type_name::with_defining_ids`; each
 * product defines its `PackageWitness` in its first version, so the defining
 * ID is the original ID the SDK compares against. The event type names the
 * original v1 `blast_admin`.
 */
export function decodePackageAdministrationEvent(
  event: SuiClientTypes.EventEntry,
  adminPackageId: string,
): DecodedPackageAdministrationEvent {
  const tag = parseStructTag(event.eventType);
  const otw = tag.typeParams[0];
  if (
    tag.address !== normalizeSuiAddress(adminPackageId) ||
    tag.module !== "blast_admin_events" ||
    tag.typeParams.length !== 1 ||
    otw === undefined ||
    typeof otw === "string" ||
    !Object.hasOwn(packageAdministrationEventBcs, tag.name)
  )
    throw new TypeError(
      `unexpected package administration event ${event.eventType}`,
    );
  const kind = tag.name as PackageAdministrationEventKind;
  return {
    source: "package-administration",
    kind,
    otw: normalizeStructTag(otw),
    payload: packageAdministrationEventBcs[kind].parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedPackageAdministrationEvent;
}

/**
 * Every lifecycle event the `blast_admin` delayed modules emit, generic in the
 * parent's key `K` and the value types: `delayed` (`Delayed*`),
 * `delayed_action` (`Action*`), `delayed_set` (`Set*`, `MemberRemoved`) and
 * `delayed_map` (`Map*`): 21 kinds.
 */
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
  "SetCreated",
  "SetScheduled",
  "SetCancelled",
  "SetApplied",
  "SetDestroyed",
  "MemberRemoved",
  "MapCreated",
  "MapScheduled",
  "MapCancelled",
  "MapApplied",
  "MapDestroyed",
] as const;
export type DelayedEventKind = (typeof DELAYED_EVENT_KINDS)[number];

/**
 * Which primitive a key names: a `Delayed<K, T>` setting, a
 * `DelayedAction<K, A>` slot, a `DelayedSet<K, E>` allowlist or a
 * `DelayedMap<K, E, V>` of entries.
 */
export type DelayedFamily = "setting" | "action" | "set" | "map";

type FamilyKinds = {
  setting: Extract<DelayedEventKind, `Delayed${string}`>;
  action: Extract<DelayedEventKind, `Action${string}`>;
  set: Extract<DelayedEventKind, `Set${string}`> | "MemberRemoved";
  map: Extract<DelayedEventKind, `Map${string}`>;
};

const FAMILY_MODULES: Record<DelayedFamily, string> = {
  setting: "delayed",
  action: "delayed_action",
  set: "delayed_set",
  map: "delayed_map",
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
    "SetCreated",
    "SetScheduled",
    "SetCancelled",
    "SetApplied",
    "SetDestroyed",
    "MemberRemoved",
  ],
  map: [
    "MapCreated",
    "MapScheduled",
    "MapCancelled",
    "MapApplied",
    "MapDestroyed",
  ],
};

/** Any `BcsType` decoding `T`, whatever it serializes from. */
type BcsDecoder<T> = Pick<BcsType<T, never>, "parse">;

/**
 * One consumer key `K`. Owners never expose `K`'s constructor, so its type
 * authenticates every event emitted under it; the value types are checked
 * too. A map key also names its entry type `E`.
 */
export type DelayedKeySpec<Key = unknown, Value = unknown, Entry = unknown> = {
  /** `<module>::<Struct>` of `K` in the consumer's original package. */
  key: string;
  family: DelayedFamily;
  keyBcs: BcsDecoder<Key>;
  /** BCS of the last type argument: `T`, `A`, `E` of a set, or `V` of a map. */
  valueBcs: BcsDecoder<Value>;
  /** The last type argument; `{package}` stands for the consumer's original package. */
  valueType: string;
  /** A map's entry type `E`, its BCS and its type tag. */
  entryBcs?: BcsDecoder<Entry>;
  entryType?: string;
};
export type DelayedKeySpecs = Readonly<Record<string, DelayedKeySpec>>;

/** Move field order of each event; `Value` is `T`, `A`, `E` or `V`. */
export type DelayedEventPayloads<Key, Value, Entry> = {
  DelayedCreated: { parent: string; key: Key; value: Value; delay_ms: bigint };
  DelayedScheduled: {
    parent: string;
    key: Key;
    value: Value;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  DelayedCancelled: {
    parent: string;
    key: Key;
    value: Value;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  DelayedApplied: {
    parent: string;
    key: Key;
    previous_value: Value;
    value: Value;
    delay_ms: bigint;
  };
  DelayedDestroyed: { parent: string; key: Key };
  ActionCreated: { parent: string; key: Key; delay_ms: bigint };
  ActionScheduled: {
    parent: string;
    key: Key;
    change: DelayedChange<Value>;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  ActionCancelled: {
    parent: string;
    key: Key;
    change: DelayedChange<Value>;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  ActionApplied: {
    parent: string;
    key: Key;
    change: DelayedChange<Value>;
    delay_ms: bigint;
  };
  ActionDestroyed: { parent: string; key: Key };
  SetCreated: { parent: string; key: Key; delay_ms: bigint };
  SetScheduled: {
    parent: string;
    key: Key;
    change: DelayedSetChange<Value>;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  SetCancelled: {
    parent: string;
    key: Key;
    change: DelayedSetChange<Value>;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  SetApplied: {
    parent: string;
    key: Key;
    change: DelayedSetChange<Value>;
    delay_ms: bigint;
  };
  SetDestroyed: { parent: string; key: Key };
  MemberRemoved: { parent: string; key: Key; member: Value };
  MapCreated: { parent: string; key: Key; delay_ms: bigint };
  MapScheduled: {
    parent: string;
    key: Key;
    change: DelayedMapChange<Entry, Value>;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  MapCancelled: {
    parent: string;
    key: Key;
    change: DelayedMapChange<Entry, Value>;
    delay_ms: bigint;
    ready_at_ms: bigint;
  };
  MapApplied: {
    parent: string;
    key: Key;
    change: DelayedMapChange<Entry, Value>;
    delay_ms: bigint;
  };
  MapDestroyed: { parent: string; key: Key };
};

type SpecKey<Spec> =
  Spec extends DelayedKeySpec<infer Key, unknown, unknown> ? Key : never;
type SpecValue<Spec> =
  Spec extends DelayedKeySpec<unknown, infer Value, unknown> ? Value : never;
type SpecEntry<Spec> = Spec extends { entryBcs: BcsDecoder<infer Entry> }
  ? Entry
  : never;

/**
 * A decoded delayed event. `name` is the consumer's registry name for `K`;
 * `parent` is the ID of the object storing the value.
 */
export type DecodedDelayedEvent<Specs extends DelayedKeySpecs> = {
  [Name in keyof Specs & string]: {
    [Kind in FamilyKinds[Specs[Name]["family"]]]: {
      source: "delayed";
      kind: Kind;
      name: Name;
      payload: DelayedEventPayloads<
        SpecKey<Specs[Name]>,
        SpecValue<Specs[Name]>,
        SpecEntry<Specs[Name]>
      >[Kind];
      sender: string;
      position: SuiEventPosition;
    };
  }[FamilyKinds[Specs[Name]["family"]]];
}[keyof Specs & string];

/** The `blast_admin` module that emits `kind`. */
export function delayedEventModule(kind: DelayedEventKind): string {
  const family = (Object.keys(FAMILY_KINDS) as DelayedFamily[]).find(
    (candidate) =>
      (FAMILY_KINDS[candidate] as readonly string[]).includes(kind),
  );
  if (family === undefined)
    throw new TypeError(`unknown delayed event ${kind}`);
  return FAMILY_MODULES[family];
}

/** Whether `eventType` is a lifecycle event of `adminPackageId`'s delayed modules. */
export function isDelayedEventType(
  eventType: string,
  adminPackageId: string,
): boolean {
  const tag = parseStructTag(eventType);
  return (
    tag.address === normalizeSuiAddress(adminPackageId) &&
    Object.values(FAMILY_MODULES).includes(tag.module)
  );
}

/**
 * Decodes one `blast_admin` delayed event whose key belongs to `packageId`
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
    !DELAYED_EVENT_KINDS.includes(kind) ||
    keyTag === undefined ||
    typeof keyTag === "string"
  )
    throw new TypeError(`unexpected delayed event type ${event.eventType}`);
  const packageId = normalizeSuiAddress(identity.packageId);
  const keyType = normalizeStructTag(keyTag);
  const entry = Object.entries(identity.keys).find(
    ([, spec]) => normalizeStructTag(`${packageId}::${spec.key}`) === keyType,
  );
  if (entry === undefined)
    throw new TypeError(`unexpected delayed event key ${event.eventType}`);
  const [name, spec] = entry;
  const local = (type: string) => type.replaceAll("{package}", packageId);
  const valueTypes =
    spec.family === "map"
      ? [local(spec.entryType ?? ""), local(spec.valueType)]
      : [local(spec.valueType)];
  if (
    !(FAMILY_KINDS[spec.family] as readonly string[]).includes(kind) ||
    normalizeStructTag(event.eventType) !==
      normalizeStructTag(
        `${tag.address}::${FAMILY_MODULES[spec.family]}::${kind}<${[keyType, ...valueTypes].join(", ")}>`,
      )
  )
    throw new TypeError(`unexpected delayed event key ${event.eventType}`);
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
  spec: Pick<DelayedKeySpec, "keyBcs" | "valueBcs" | "entryBcs">,
): BcsType<Record<string, unknown>, Record<string, unknown>> {
  // Every decoder in a spec is a full BcsType; the spec only promises `parse`.
  const value = spec.valueBcs as BcsType<unknown, unknown>;
  const head = {
    parent: suiObjectIdBcs,
    key: spec.keyBcs as BcsType<unknown, unknown>,
  };
  const timing = { delay_ms: u64Bcs, ready_at_ms: u64Bcs };
  const change = delayedChangeBcs(value);
  const setChange = delayedSetChangeBcs(value);
  const mapChange = spec.entryBcs
    ? delayedMapChangeBcs(spec.entryBcs as BcsType<unknown, unknown>, value)
    : change;
  const fields = {
    DelayedCreated: { value, delay_ms: u64Bcs },
    DelayedScheduled: { value, ...timing },
    DelayedCancelled: { value, ...timing },
    DelayedApplied: { previous_value: value, value, delay_ms: u64Bcs },
    DelayedDestroyed: {},
    ActionCreated: { delay_ms: u64Bcs },
    ActionScheduled: { change, ...timing },
    ActionCancelled: { change, ...timing },
    ActionApplied: { change, delay_ms: u64Bcs },
    ActionDestroyed: {},
    SetCreated: { delay_ms: u64Bcs },
    SetScheduled: { change: setChange, ...timing },
    SetCancelled: { change: setChange, ...timing },
    SetApplied: { change: setChange, delay_ms: u64Bcs },
    SetDestroyed: {},
    MemberRemoved: { member: value },
    MapCreated: { delay_ms: u64Bcs },
    MapScheduled: { change: mapChange, ...timing },
    MapCancelled: { change: mapChange, ...timing },
    MapApplied: { change: mapChange, delay_ms: u64Bcs },
    MapDestroyed: {},
  }[kind];
  return bcs.struct(kind, { ...head, ...fields }) as unknown as BcsType<
    Record<string, unknown>,
    Record<string, unknown>
  >;
}

/**
 * `package_admin::UpgradeKey<otw>`: one package's upgrade and immutability
 * slot, `DelayedAction<UpgradeKey<OTW>, UpgradeAction>`. The key lives in the
 * admin package, so decode with `packageId` = the admin package ID.
 */
export function upgradeDelayedKey(otw: string) {
  return {
    key: `package_admin::UpgradeKey<${normalizeStructTag(otw)}>`,
    family: "action",
    keyBcs: unitKeyBcs,
    valueBcs: upgradeActionBcs,
    valueType: "{package}::package_admin::UpgradeAction",
  } as const satisfies DelayedKeySpec;
}

export type DecodedUpgradeDelayedEvent = DecodedDelayedEvent<{
  Upgrade: ReturnType<typeof upgradeDelayedKey>;
}> & { otw: string };

/** Decodes a `delayed_action` event keyed by any package's `UpgradeKey<OTW>`. */
export function decodeUpgradeDelayedEvent(
  event: SuiClientTypes.EventEntry,
  adminPackageId: string,
): DecodedUpgradeDelayedEvent {
  const keyTag = parseStructTag(event.eventType).typeParams[0];
  const otw =
    keyTag !== undefined && typeof keyTag !== "string"
      ? keyTag.typeParams[0]
      : undefined;
  if (
    keyTag === undefined ||
    typeof keyTag === "string" ||
    keyTag.address !== normalizeSuiAddress(adminPackageId) ||
    keyTag.module !== "package_admin" ||
    keyTag.name !== "UpgradeKey" ||
    otw === undefined ||
    typeof otw === "string"
  )
    throw new TypeError(`unexpected upgrade delayed event ${event.eventType}`);
  const type = normalizeStructTag(otw);
  const decoded = decodeDelayedEvent(event, {
    adminPackageId,
    packageId: adminPackageId,
    keys: { Upgrade: upgradeDelayedKey(type) },
  });
  return { ...decoded, otw: type };
}

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
