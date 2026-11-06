import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_ABORTS,
  adminAbortName,
} from "@interest-protocol/blast-admin-sdk/aborts";
import type {
  AclEventKind,
  AclEventPayloads,
  PackageAdministrationEventKind,
} from "@interest-protocol/blast-admin-sdk/events";
import {
  aclDelayedKeys,
  aclEventBcs,
  DELAYED_EVENT_KINDS,
  decodeAclDelayedEvent,
  decodeAclEvent,
  decodePackageAdministrationEvent,
  decodeUpgradeDelayedEvent,
  delayedEventBcs,
  packageAdministrationEventBcs,
  upgradeDelayedKey,
} from "@interest-protocol/blast-admin-sdk/events";
import {
  createAclProjection,
  createPackageAdministrationProjection,
  reduceAclEvent,
  reducePackageAdministrationEvent,
} from "@interest-protocol/blast-admin-sdk/reducer";
import {
  aclBcs,
  decodeAclObject,
  decodePackageAdminObject,
  decodePackageVersionObject,
  packageAdminBcs,
  packageVersionBcs,
} from "@interest-protocol/blast-admin-sdk/state";
import {
  AdminCalls,
  AdminTransactions,
  PACKAGE_ROLES,
  packageRoleType,
} from "@interest-protocol/blast-admin-sdk/transactions";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import { LaunchpadCalls } from "@interest-protocol/blast-launchpad-sdk/transactions";
import type { SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import {
  assertBuildersMatchAbi,
  moveCallArguments,
  moveCallTypeArguments,
  readAbi,
} from "./abi.ts";
import { LAUNCHPAD_DEPLOYMENT } from "./fixtures/launchpad-deployment.ts";

const id = (value: string) => normalizeSuiAddress(value);
const ADMIN_PACKAGE = id("0xad");
const deployment = {
  packageId: ADMIN_PACKAGE,
  acl: { objectId: "0xac", initialSharedVersion: "3" },
};
const abi = readAbi("production-admin-v1.json", "admin");
const CORE = { originalPackageId: "0xc0" };
const ROLE = coreRoleType(CORE, "FeeAdmin");

test("builds every blast_acl call against the frozen ABI", () => {
  const calls = new AdminCalls(deployment);
  const tx = new Transaction();
  const root = "0x5a";
  tx.add(calls.grantAdmin({ superAdminCap: root, recipient: "0xb0b" }));
  tx.add(
    calls.grantRole({ superAdminCap: root, adminCapId: "0xc1", role: ROLE }),
  );
  tx.add(
    calls.revokeRole({ superAdminCap: root, adminCapId: "0xc1", role: ROLE }),
  );
  tx.add(calls.revokeAdmin({ superAdminCap: root, adminCapId: "0xc1" }));
  tx.add(calls.destroyAdminCap({ adminCap: "0xc1" }));
  tx.add(
    calls.beginSuperAdminTransfer({ superAdminCap: root, recipient: "0xb0b" }),
  );
  tx.add(calls.cancelSuperAdminTransfer({ superAdminCap: root }));
  tx.add(calls.acceptSuperAdminTransfer());
  tx.add(calls.destroyRetiredSuperAdminCap({ superAdminCap: root }));
  tx.add(calls.signIn({ adminCap: "0xc2", role: ROLE }));

  assert.deepEqual(
    assertBuildersMatchAbi(tx, abi, ADMIN_PACKAGE).sort(),
    abi.blast_acl?.functions
      .filter((candidate) => candidate.sdk === "builder")
      .map((candidate) => `blast_acl::${candidate.name}`)
      .sort(),
  );
  const rootCall = ["shared-mut:0xac", "object:0x5a"];
  assert.deepEqual(moveCallArguments(tx, 0), [...rootCall, "pure"]);
  assert.deepEqual(moveCallArguments(tx, 1), [...rootCall, "pure"]);
  assert.deepEqual(moveCallArguments(tx, 4), [
    "shared-mut:0xac",
    "object:0xc1",
  ]);
  assert.deepEqual(moveCallArguments(tx, 5), [...rootCall, "pure", "clock"]);
  assert.deepEqual(moveCallArguments(tx, 7), ["shared-mut:0xac", "clock"]);
  assert.deepEqual(moveCallTypeArguments(tx)[1], [ROLE]);
  assert.deepEqual(moveCallTypeArguments(tx)[9], [ROLE]);

  // Read-only calls take the ACL immutably when nothing else mutates it.
  const reads = new Transaction();
  reads.add(calls.destroyRetiredSuperAdminCap({ superAdminCap: root }));
  reads.add(calls.signIn({ adminCap: "0xc2", role: ROLE }));
  assert.deepEqual(moveCallArguments(reads, 0), ["shared:0xac", "object:0x5a"]);
  assert.deepEqual(moveCallArguments(reads, 1), ["shared:0xac", "object:0xc2"]);
});

test("one-call transactions take object IDs", () => {
  const tx = new AdminTransactions(deployment).grantRole({
    superAdminCapId: "0x5a",
    adminCapId: "0xc1",
    role: ROLE,
  });
  assert.deepEqual(assertBuildersMatchAbi(tx, abi, ADMIN_PACKAGE), [
    "blast_acl::grant_role",
  ]);
});

test("a product signs in with a core blast_domain role", () => {
  const calls = new LaunchpadCalls({
    ...LAUNCHPAD_DEPLOYMENT,
    admin: deployment,
    core: { ...LAUNCHPAD_DEPLOYMENT.core, ...CORE },
  });
  assert.equal(ROLE, normalizeStructTag("0xc0::blast_domain::FeeAdmin"));
  const tx = new Transaction();
  tx.add(calls.signIn({ adminCap: "0xc2", role: "FeeAdmin" }));
  assert.deepEqual(assertBuildersMatchAbi(tx, abi, ADMIN_PACKAGE), [
    "blast_acl::sign_in",
  ]);
  assert.deepEqual(moveCallTypeArguments(tx), [[ROLE]]);
});

test("decodes the ACL from its BCS layout", () => {
  const acl = (pending: string | null, delay = false) =>
    decodeAclObject(
      {
        objectId: "0xac",
        initialSharedVersion: "3",
        type: `${ADMIN_PACKAGE}::blast_acl::ACL`,
        content: aclBcs
          .serialize({
            id: { id: { bytes: id("0xac") } },
            super_admin_cap_id: id("0x5a"),
            admins: { id: { id: { bytes: id("0x7a") } }, size: 1n },
            super_admin_transfer: transferSlot(pending, delay),
          })
          .toBytes(),
      },
      ADMIN_PACKAGE,
    );
  const idle = acl(null);
  assert.equal(idle.superAdminCapId, id("0x5a"));
  assert.equal(idle.adminsTableId, id("0x7a"));
  assert.equal(idle.adminCount, 1n);
  assert.equal(idle.pendingSuperAdmin, null);
  assert.deepEqual(acl("0xb0b").pendingSuperAdmin, {
    recipient: id("0xb0b"),
    readyAtMs: 99n,
  });
  // The slot's own notice is fixed; no other proposal names a recipient.
  assert.equal(acl("0xb0b", true).pendingSuperAdmin, null);
  assert.throws(
    () =>
      decodeAclObject(
        {
          objectId: "0xac",
          initialSharedVersion: "3",
          type: "0x99::blast_acl::ACL",
          content: new Uint8Array(),
        },
        ADMIN_PACKAGE,
      ),
    /not the Blast ACL/,
  );
});

test("replays the ACL from its events", () => {
  const events = [
    event("AdminGranted", { admin_cap_id: id("0xc1"), recipient: id("0xb0b") }),
    event("AdminRoleGranted", { admin_cap_id: id("0xc1"), role: ROLE }),
    event("AdminGranted", { admin_cap_id: id("0xc2"), recipient: id("0xb0b") }),
    event("AdminRoleGranted", {
      admin_cap_id: id("0xc2"),
      role: normalizeStructTag("0x122::blast_fun_domain::TreasuryAdmin"),
    }),
    event("AdminRoleRevoked", {
      admin_cap_id: id("0xc2"),
      role: normalizeStructTag("0x122::blast_fun_domain::TreasuryAdmin"),
    }),
    event("AdminRevoked", { admin_cap_id: id("0xc2"), roles: [] }),
    transfer("ActionScheduled", 7n),
    transfer("ActionApplied"),
    event("SuperAdminTransferred", {
      previous_super_admin_cap_id: id("0x5a"),
      new_super_admin_cap_id: id("0x5b"),
      recipient: id("0xb0b"),
    }),
    event("SuperAdminCapDestroyed", { super_admin_cap_id: id("0x5a") }),
  ];
  const state = [...events, ...events].reduce(
    reduceAclEvent,
    createAclProjection(),
  );
  assert.deepEqual(state.admins, { [id("0xc1")]: [ROLE] });
  assert.equal(state.superAdminCapId, id("0x5b"));
  assert.equal(state.pendingSuperAdmin, null);
  assert.equal(state.eventCounts.AdminGranted, 2);

  const scheduled = reduceAclEvent(state, transfer("ActionScheduled", 9n));
  assert.deepEqual(scheduled.pendingSuperAdmin, {
    recipient: id("0xb0b"),
    readyAtMs: 9n,
  });
  const cancelled = [
    transfer("ActionCancelled", 9n),
    event("AdminDestroyed", {
      admin_cap_id: id("0xc1"),
      roles: [ROLE],
      was_active: true,
    }),
  ].reduce(reduceAclEvent, scheduled);
  assert.equal(cancelled.pendingSuperAdmin, null);
  assert.deepEqual(cancelled.admins, {});
});

test("the ACL and its events follow the frozen Move field order", () => {
  const acl = abi.blast_acl?.structs.find((struct) => struct.name === "ACL");
  assert.deepEqual(
    Object.keys(
      aclBcs.parse(
        aclBcs
          .serialize({
            id: { id: { bytes: id("0xac") } },
            super_admin_cap_id: id("0x5a"),
            admins: { id: { id: { bytes: id("0x7a") } }, size: 0n },
            super_admin_transfer: transferSlot(null),
          })
          .toBytes(),
      ),
    ),
    acl?.fields.map((field) => field.name),
  );
  const decoded = (abi.blast_admin_events?.events ?? []).filter(
    (candidate) => !(candidate.name in packageAdministrationEventBcs),
  );
  assert.deepEqual(
    decoded.map((candidate) => candidate.name).sort(),
    Object.keys(aclEventBcs).sort(),
  );
  for (const { name, fields } of decoded) {
    const kind = name as AclEventKind;
    assert.deepEqual(
      Object.keys(SAMPLES[kind]),
      fields.map((field) => field.name),
      name,
    );
  }
  assert.throws(
    () =>
      decodeAclEvent(
        {
          ...entry("AdminGranted", SAMPLES.AdminGranted),
          eventType: "0x1::x::AdminGranted",
        },
        ADMIN_PACKAGE,
      ),
    /unexpected ACL event type/,
  );
});

const SAMPLES: { [Kind in AclEventKind]: AclEventPayloads[Kind] } = {
  AdminGranted: { admin_cap_id: id("0xc1"), recipient: id("0xb0b") },
  AdminRevoked: { admin_cap_id: id("0xc1"), roles: [ROLE] },
  AdminRoleGranted: { admin_cap_id: id("0xc1"), role: ROLE },
  AdminRoleRevoked: { admin_cap_id: id("0xc1"), role: ROLE },
  AdminDestroyed: { admin_cap_id: id("0xc1"), roles: [], was_active: false },
  SuperAdminTransferred: {
    previous_super_admin_cap_id: id("0x5a"),
    new_super_admin_cap_id: id("0x5b"),
    recipient: id("0xb0b"),
  },
  SuperAdminCapDestroyed: { super_admin_cap_id: id("0x5a") },
};

let eventIndex = 0;
function entry<Kind extends AclEventKind>(
  kind: Kind,
  payload: AclEventPayloads[Kind],
): SuiClientTypes.EventEntry {
  eventIndex += 1;
  return {
    packageId: ADMIN_PACKAGE,
    module: "blast_acl",
    sender: id("0x5e"),
    eventType: `${ADMIN_PACKAGE}::blast_admin_events::${kind}`,
    bcs: (aclEventBcs[kind] as (typeof aclEventBcs)["AdminGranted"])
      .serialize(payload as never)
      .toBytes(),
    json: null,
    checkpoint: "9",
    transactionDigest: `tx-${eventIndex}`,
    eventIndex,
  };
}

function event<Kind extends AclEventKind>(
  kind: Kind,
  payload: AclEventPayloads[Kind],
) {
  const decoded = decodeAclEvent(entry(kind, payload), ADMIN_PACKAGE);
  assert.equal(decoded.kind, kind);
  assert.deepEqual(decoded.payload, payload);
  return decoded;
}

function shared(objectId: string) {
  return { objectId, initialSharedVersion: "1", mutable: false as const };
}

function transferSlot(recipient: string | null, delay = false) {
  return {
    parent: id("0xac"),
    key: null,
    delay_ms: 604_800_000n,
    pending:
      recipient === null && !delay
        ? null
        : {
            value: delay
              ? ({ kind: "Delay" } as const)
              : ({ kind: "Action", action: recipient ?? "" } as const),
            delay_ms: 604_800_000n,
            ready_at_ms: 99n,
          },
  };
}

/** One super admin transfer lifecycle event, emitted by `delayed`. */
function transfer(
  kind: "ActionScheduled" | "ActionCancelled" | "ActionApplied",
  readyAtMs = 0n,
) {
  eventIndex += 1;
  const change = { kind: "Action", action: id("0xb0b") } as const;
  const payload = {
    parent: id("0xac"),
    key: null,
    change,
    delay_ms: 604_800_000n,
    ...(kind === "ActionApplied" ? {} : { ready_at_ms: readyAtMs }),
  };
  return decodeAclDelayedEvent(
    {
      packageId: ADMIN_PACKAGE,
      module: "blast_acl",
      sender: id("0x5e"),
      eventType: `${ADMIN_PACKAGE}::delayed_action::${kind}<${ADMIN_PACKAGE}::blast_acl::SuperAdminTransfer, address>`,
      bcs: delayedEventBcs(kind, aclDelayedKeys.SuperAdminTransfer)
        .serialize(payload as never)
        .toBytes(),
      json: null,
      checkpoint: "9",
      transactionDigest: `tx-${eventIndex}`,
      eventIndex,
    },
    ADMIN_PACKAGE,
  );
}

const OTW = normalizeStructTag("0x5a1e::blast_fun::BLAST_FUN");
const VERSION = { objectId: "0x9a", initialSharedVersion: "4" };
const PACKAGE_ADMIN = { objectId: "0x9b", initialSharedVersion: "4" };

test("generic package_admin builders take the OTW and Move's arity", () => {
  const calls = new AdminCalls(deployment);
  const tx = new Transaction();
  tx.add(
    calls.pause({
      otw: OTW,
      packageVersion: VERSION,
      adminWitness: "0xa1",
      bits: 3,
    }),
  );
  tx.add(
    calls.scheduleUpgrade({
      otw: OTW,
      packageAdmin: PACKAGE_ADMIN,
      adminWitness: "0xa1",
      digest: new Uint8Array(32).fill(7),
    }),
  );
  tx.add(
    calls.scheduleMakeImmutable({
      otw: OTW,
      packageAdmin: PACKAGE_ADMIN,
      adminWitness: "0xa1",
    }),
  );
  tx.add(
    calls.cancelUpgradeAction({
      otw: OTW,
      packageAdmin: PACKAGE_ADMIN,
      adminWitness: "0xa1",
    }),
  );
  tx.add(
    calls.scheduleUpgradeDelay({
      otw: OTW,
      packageAdmin: PACKAGE_ADMIN,
      adminWitness: "0xa1",
      delayMs: 172_800_000n,
    }),
  );
  tx.add(calls.applyUpgradeDelay({ otw: OTW, packageAdmin: PACKAGE_ADMIN }));
  const moveCalls = tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall] : [],
    );
  assert.deepEqual(
    moveCalls.map((call) => `${call.module}::${call.function}`),
    [
      "package_admin::pause",
      "package_admin::schedule_upgrade",
      "package_admin::schedule_make_immutable",
      "package_admin::cancel_upgrade_action",
      "package_admin::schedule_upgrade_delay",
      "package_admin::apply_upgrade_delay",
    ],
  );
  assert.deepEqual(
    moveCallTypeArguments(tx),
    moveCalls.map(() => [OTW]),
  );
  assert.deepEqual(moveCallArguments(tx, 0), [
    "shared-mut:0x9a",
    "object:0xa1",
    "pure",
  ]);
  assert.deepEqual(moveCallArguments(tx, 1), [
    "shared-mut:0x9b",
    "object:0xa1",
    "pure",
    "clock",
  ]);
  assert.deepEqual(moveCallArguments(tx, 2), [
    "shared-mut:0x9b",
    "object:0xa1",
    "clock",
  ]);
  assert.deepEqual(moveCallArguments(tx, 3), [
    "shared-mut:0x9b",
    "object:0xa1",
  ]);
  assert.deepEqual(moveCallArguments(tx, 4), [
    "shared-mut:0x9b",
    "object:0xa1",
    "pure",
    "clock",
  ]);
  assert.deepEqual(moveCallArguments(tx, 5), ["shared-mut:0x9b", "clock"]);
  assert.throws(() =>
    calls.scheduleUpgrade({
      otw: OTW,
      packageAdmin: PACKAGE_ADMIN,
      adminWitness: "0xa1",
      digest: new Uint8Array(31),
    }),
  );
  assert.throws(() =>
    calls.pause({
      otw: OTW,
      packageVersion: VERSION,
      adminWitness: "0xa1",
      bits: 0,
    }),
  );
  assert.equal(
    packageRoleType(deployment, OTW, "UnpauseAdmin"),
    normalizeStructTag(`${ADMIN_PACKAGE}::package_admin::UnpauseAdmin<${OTW}>`),
  );
  assert.deepEqual(
    [...PACKAGE_ROLES],
    ["UpgradeAdmin", "PauseAdmin", "UnpauseAdmin", "CancelAdmin"],
  );
});

test("decodes one package's PackageVersion and PackageAdmin by OTW", () => {
  const identity = { admin: deployment, otw: OTW };
  const version = decodePackageVersionObject(
    {
      ...VERSION,
      type: `${ADMIN_PACKAGE}::package_version::PackageVersion<${OTW}>`,
      content: packageVersionBcs
        .serialize({
          id: { id: { bytes: id("0x9a") } },
          valid_pause_bits: 7,
          paused: 5,
          package_witness: `${"0".repeat(60)}5a1e::blast_fun::PackageWitness`,
          version: 2n,
        })
        .toBytes(),
    },
    identity,
  );
  assert.deepEqual(version, {
    objectId: id("0x9a"),
    initialSharedVersion: "4",
    otw: OTW,
    validPauseBits: 7,
    paused: 5,
    packageWitness: normalizeStructTag("0x5a1e::blast_fun::PackageWitness"),
    version: 2n,
  });
  assert.throws(
    () =>
      decodePackageVersionObject(
        {
          ...VERSION,
          type: `${ADMIN_PACKAGE}::package_version::PackageVersion<0x77::other::OTHER>`,
          content: new Uint8Array(),
        },
        identity,
      ),
    /unexpected administration object/,
  );
  const adminObject = {
    ...PACKAGE_ADMIN,
    type: `${ADMIN_PACKAGE}::package_admin::PackageAdmin<${OTW}>`,
    content: packageAdminBcs
      .serialize({
        id: { id: { bytes: id("0x9b") } },
        publisher: {
          id: { id: { bytes: id("0x9c") } },
          package: `${"0".repeat(60)}5a1e`,
          module_name: "blast_fun",
        },
        upgrade_cap: {
          id: { id: { bytes: id("0x9d") } },
          package: id("0x5a1e"),
          version: 1n,
          policy: 0,
        },
        upgrade: {
          parent: id("0x9b"),
          key: null,
          delay_ms: 172_800_000n,
          pending: null,
        },
      })
      .toBytes(),
  };
  assert.deepEqual(decodePackageAdminObject(adminObject, identity), {
    objectId: id("0x9b"),
    initialSharedVersion: "4",
    otw: OTW,
    publisherId: id("0x9c"),
    upgradeCap: {
      id: id("0x9d"),
      package: id("0x5a1e"),
      version: 1n,
      policy: 0,
    },
    delayMs: 172_800_000n,
    pending: null,
  });
  assert.throws(
    () =>
      decodePackageAdminObject({ ...adminObject, objectId: "0x9e" }, identity),
    /UID mismatch/,
  );
});

test("replays one package's administration from its typed events", () => {
  let index = 0;
  const typed = <Kind extends PackageAdministrationEventKind>(
    kind: Kind,
    payload: Parameters<
      (typeof packageAdministrationEventBcs)[Kind]["serialize"]
    >[0],
  ) =>
    decodePackageAdministrationEvent(
      {
        packageId: ADMIN_PACKAGE,
        module: "package_admin",
        sender: id("0x5e"),
        eventType: `${ADMIN_PACKAGE}::blast_admin_events::${kind}<${OTW}>`,
        bcs: (
          packageAdministrationEventBcs[
            kind
          ] as (typeof packageAdministrationEventBcs)["Paused"]
        )
          .serialize(payload as never)
          .toBytes(),
        json: null,
        checkpoint: "11",
        transactionDigest: `admin-${index}`,
        eventIndex: index++,
      },
      ADMIN_PACKAGE,
    );
  const upgrade = (
    kind: "ActionCreated" | "ActionScheduled" | "ActionApplied",
    payload: Record<string, unknown>,
  ) =>
    decodeUpgradeDelayedEvent(
      {
        packageId: ADMIN_PACKAGE,
        module: "package_admin",
        sender: id("0x5e"),
        eventType: `${ADMIN_PACKAGE}::delayed_action::${kind}<${ADMIN_PACKAGE}::package_admin::UpgradeKey<${OTW}>, ${ADMIN_PACKAGE}::package_admin::UpgradeAction>`,
        bcs: delayedEventBcs(kind, upgradeDelayedKey(OTW))
          .serialize({ parent: id("0x9b"), key: null, ...payload } as never)
          .toBytes(),
        json: null,
        checkpoint: "11",
        transactionDigest: `admin-${index}`,
        eventIndex: index++,
      },
      ADMIN_PACKAGE,
    );
  const events = [
    upgrade("ActionCreated", { delay_ms: 172_800_000n }),
    typed("PackageAdminCreated", {
      package_admin_id: id("0x9b"),
      publisher_id: id("0x9c"),
      upgrade_cap_id: id("0x9d"),
      original_package_id: id("0x5a1e"),
      upgrade_cap_version: 1n,
      policy: 0,
    }),
    typed("PackageVersionCreated", {
      package_version_id: id("0x9a"),
      package_admin_id: id("0x9b"),
      valid_pause_bits: 7,
      paused: 7,
      package_witness: `${"0".repeat(60)}5a1e::blast_fun::PackageWitness`,
      version: 1n,
    }),
    typed("Unpaused", { package_version_id: id("0x9a"), bits: 3, paused: 4 }),
    upgrade("ActionScheduled", {
      change: { kind: "Action", action: { MakeImmutable: true } },
      delay_ms: 172_800_000n,
      ready_at_ms: 9n,
    }),
    upgrade("ActionApplied", {
      change: { kind: "Action", action: { MakeImmutable: true } },
      delay_ms: 172_800_000n,
    }),
    typed("UpgradeCapDestroyed", {
      package_admin_id: id("0x9b"),
      upgrade_cap_id: id("0x9d"),
      original_package_id: id("0x5a1e"),
      final_upgrade_cap_version: 1n,
      final_policy: 0,
    }),
  ];
  assert.ok(events.every((event) => event.otw === OTW));
  const state = events.reduce(
    reducePackageAdministrationEvent,
    createPackageAdministrationProjection(),
  );
  assert.equal(
    events.reduce(reducePackageAdministrationEvent, state),
    state,
    "replay is idempotent",
  );
  assert.deepEqual(state.packages[OTW], {
    packageVersionId: id("0x9a"),
    packageAdminId: id("0x9b"),
    packageWitness: normalizeStructTag("0x5a1e::blast_fun::PackageWitness"),
    version: 1n,
    validPauseBits: 7,
    paused: 4,
    upgradeCapId: null,
    upgradeCapVersion: 1n,
    policy: 0,
    immutable: true,
    upgradeDelayMs: 172_800_000n,
    pendingUpgrade: null,
  });
  assert.throws(
    () =>
      decodePackageAdministrationEvent(
        {
          packageId: ADMIN_PACKAGE,
          module: "package_admin",
          sender: id("0x5e"),
          eventType: `${id("0x1")}::blast_admin_events::Paused<${OTW}>`,
          bcs: new Uint8Array(),
          json: null,
          checkpoint: "11",
          transactionDigest: "x",
          eventIndex: 0,
        },
        ADMIN_PACKAGE,
      ),
    /unexpected package administration event/,
  );
});

test("delayed events cover all 21 kinds and admin aborts all 27 codes", () => {
  assert.equal(DELAYED_EVENT_KINDS.length, 21);
  assert.ok(DELAYED_EVENT_KINDS.includes("MapDestroyed"));
  assert.equal(ADMIN_ABORTS.length, 27);
  assert.equal(adminAbortName(9), "EVersionMismatch");
  assert.equal(adminAbortName(26), "EWrongPackageWitness");
  assert.equal(adminAbortName(27), null);
});
