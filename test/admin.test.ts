import assert from "node:assert/strict";
import test from "node:test";
import type {
  AclEventKind,
  AclEventPayloads,
} from "@interest-protocol/blast-admin-sdk/events";
import {
  aclEventBcs,
  decodeAclEvent,
} from "@interest-protocol/blast-admin-sdk/events";
import {
  createAclProjection,
  reduceAclEvent,
} from "@interest-protocol/blast-admin-sdk/reducer";
import {
  aclBcs,
  decodeAclObject,
} from "@interest-protocol/blast-admin-sdk/state";
import {
  AdminCalls,
  AdminTransactions,
} from "@interest-protocol/blast-admin-sdk/transactions";
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

const id = (value: string) => normalizeSuiAddress(value);
const ADMIN_PACKAGE = id("0xad");
const deployment = {
  packageId: ADMIN_PACKAGE,
  acl: { objectId: "0xac", initialSharedVersion: "3" },
};
const abi = readAbi("production-admin-v1.json", "admin");
const ROLE = normalizeStructTag("0x122::blast_fun_domain::FeeAdmin");

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

test("a product signs in with its own typed role", () => {
  const calls = new LaunchpadCalls({
    packageId: "0x123",
    originalPackageId: "0x122",
    admin: deployment,
    partnersPackageId: "0xae",
    timelockPackageId: "0xaf",
    packageVersion: shared("0x2"),
    launchConfig: shared("0x3"),
    runtimeConfig: shared("0x4"),
  });
  assert.equal(calls.roleType("FeeAdmin"), ROLE);
  const tx = new Transaction();
  tx.add(calls.signIn({ adminCap: "0xc2", role: "FeeAdmin" }));
  assert.deepEqual(assertBuildersMatchAbi(tx, abi, ADMIN_PACKAGE), [
    "blast_acl::sign_in",
  ]);
  assert.deepEqual(moveCallTypeArguments(tx), [[ROLE]]);
});

test("decodes the ACL from its BCS layout", () => {
  const acl = (pending: string | null) =>
    decodeAclObject(
      {
        objectId: "0xac",
        initialSharedVersion: "3",
        type: `${ADMIN_PACKAGE}::blast_acl::ACL`,
        content: aclBcs
          .serialize({
            id: { id: { bytes: id("0xac") } },
            super_admin_cap_id: id("0x5a"),
            admins: [{ key: id("0xc1"), value: [ROLE] }],
            pending_super_admin: {
              before: null,
              after: pending,
              atMs: 99n,
              delayMs: 604_800_000n,
            },
          })
          .toBytes(),
      },
      ADMIN_PACKAGE,
    );
  const idle = acl(null);
  assert.equal(idle.superAdminCapId, id("0x5a"));
  assert.deepEqual(idle.admins, { [id("0xc1")]: [ROLE] });
  assert.equal(idle.pendingSuperAdmin, null);
  assert.deepEqual(acl("0xb0b").pendingSuperAdmin, {
    recipient: id("0xb0b"),
    executeAfterMs: 99n,
  });
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
    event("SuperAdminTransferStarted", {
      recipient: id("0xb0b"),
      execute_after_ms: 7n,
    }),
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

  const cancelled = [
    event("SuperAdminTransferStarted", {
      recipient: id("0xb0b"),
      execute_after_ms: 7n,
    }),
    event("SuperAdminTransferCancelled", {
      recipient: id("0xb0b"),
      execute_after_ms: 7n,
    }),
    event("AdminDestroyed", {
      admin_cap_id: id("0xc1"),
      roles: [ROLE],
      was_active: true,
    }),
  ].reduce(reduceAclEvent, state);
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
            admins: [],
            pending_super_admin: {
              before: null,
              after: null,
              atMs: 0n,
              delayMs: 1n,
            },
          })
          .toBytes(),
      ),
    ),
    acl?.fields.map((field) => field.name),
  );
  const decoded = (abi.blast_admin_events?.events ?? []).filter(
    (candidate) => candidate.sdk === "decoder-reducer",
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
  SuperAdminTransferStarted: { recipient: id("0xb0b"), execute_after_ms: 1n },
  SuperAdminTransferCancelled: { recipient: id("0xb0b"), execute_after_ms: 1n },
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
