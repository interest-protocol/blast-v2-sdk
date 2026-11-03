import assert from "node:assert/strict";
import test from "node:test";
import {
  aclAdminFieldName,
  aclBcs,
  decodeAclAdminRolesField,
  decodePackageAdministrationObject,
  decodePackageVersionObject,
  getAcl,
  getAclAdminRoles,
  migratorsVersionBcs,
  packageAdminBcs,
  packageVersionBcs,
} from "@interest-protocol/blast-admin-sdk/state";
import { moveTypeNameBcs } from "@interest-protocol/blast-core/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const id = normalizeSuiAddress;
const uid = (value: string) => ({ id: { bytes: id(value) } });
const role = "0x15::blast_fun_domain::BuybackAdmin";
const field = (cap: string, roles = [role]) => ({
  name: aclAdminFieldName(cap),
  value: {
    type: "0x2::vec_set::VecSet<0x1::type_name::TypeName>",
    bcs: bcs.vector(moveTypeNameBcs).serialize(roles).toBytes(),
  },
});
const absent = () =>
  new ObjectError("NOT_FOUND", "missing", { reason: "notFound" });
const client = (core: object) => ({ core }) as ClientWithCoreApi;

function aclClient(
  count: bigint,
  listDynamicFields: (options: { cursor: string | null }) => unknown,
  getDynamicField: (options: { name: { bcs: Uint8Array } }) => unknown,
) {
  return client({
    getObject: async () => ({
      object: {
        objectId: id("0xac"),
        owner: { $kind: "Shared", Shared: { initialSharedVersion: "3" } },
        type: "0xad::blast_acl::ACL",
        content: aclBcs
          .serialize({
            id: uid("0xac"),
            super_admin_cap_id: id("0xca"),
            admins: { id: uid("0x7a"), size: count },
            super_admin_transfer: {
              owner: id("0xac"),
              key: null,
              delay_ms: 604_800_000n,
              pending: null,
            },
          })
          .toBytes(),
      },
    }),
    listDynamicFields,
    getDynamicField,
  });
}

test("Table ACL reads target the cap and distinguish revocation from transport or malformed data", async () => {
  const controller = new AbortController();
  let request: unknown;
  const reader = client({
    getDynamicField: async (options: unknown) => {
      request = options;
      return { dynamicField: field("0xca") };
    },
  });
  assert.deepEqual(
    await getAclAdminRoles(reader, "0x7a", "0xca", {
      signal: controller.signal,
    }),
    [id("0x15") + "::blast_fun_domain::BuybackAdmin"],
  );
  assert.deepEqual(request, {
    parentId: id("0x7a"),
    name: aclAdminFieldName("0xca"),
    signal: controller.signal,
  });
  assert.equal(
    await getAclAdminRoles(
      client({
        getDynamicField: async () => {
          throw absent();
        },
      }),
      "0x7a",
      "0xca",
    ),
    null,
  );
  const outage = new Error("offline");
  await assert.rejects(
    getAclAdminRoles(
      client({
        getDynamicField: async () => {
          throw outage;
        },
      }),
      "0x7a",
      "0xca",
    ),
    (error) => error === outage,
  );
  assert.throws(
    () => decodeAclAdminRolesField(field("0xcb"), "0xca"),
    /cap ID/,
  );
  assert.throws(
    () =>
      decodeAclAdminRolesField(
        {
          ...field("0xca"),
          value: {
            type: "0x2::vec_set::VecSet<0x2::object::ID>",
            bcs: new Uint8Array(),
          },
        },
        "0xca",
      ),
    /value type/,
  );
  assert.throws(() =>
    decodeAclAdminRolesField(
      {
        ...field("0xca"),
        value: { type: field("0xca").value.type, bcs: new Uint8Array() },
      },
      "0xca",
    ),
  );
});

test("Table ACL enumerates pages and rejects concurrent mutation or broken pagination", async () => {
  const entry = (cap: string) => ({
    $kind: "DynamicField",
    name: aclAdminFieldName(cap),
  });
  const read = (cap: string) => ({ dynamicField: field(cap) });
  const two = aclClient(
    2n,
    ({ cursor }) =>
      cursor === null
        ? { dynamicFields: [entry("0xca")], hasNextPage: true, cursor: "page2" }
        : { dynamicFields: [entry("0xcb")], hasNextPage: false, cursor: null },
    ({ name }) => read(bcs.Address.parse(name.bcs)),
  );
  const acl = await getAcl(two, "0xac", "0xad");
  assert.equal(acl.adminsTableId, id("0x7a"));
  assert.equal(acl.adminCount, 2n);
  assert.deepEqual(Object.keys(acl.admins), [id("0xca"), id("0xcb")]);
  const emptyPage = { dynamicFields: [], hasNextPage: false, cursor: null };
  await assert.rejects(
    getAcl(
      aclClient(
        1n,
        () => emptyPage,
        () => read("0xca"),
      ),
      "0xac",
      "0xad",
    ),
    /changed during enumeration/,
  );
  await assert.rejects(
    getAcl(
      aclClient(
        1n,
        () => ({ ...emptyPage, dynamicFields: [entry("0xca")] }),
        () => {
          throw absent();
        },
      ),
      "0xac",
      "0xad",
    ),
    /changed during enumeration/,
  );
  await assert.rejects(
    getAcl(
      aclClient(
        0n,
        () => ({ ...emptyPage, hasNextPage: true, cursor: "same" }),
        () => read("0xca"),
      ),
      "0xac",
      "0xad",
    ),
    /did not advance/,
  );
  await assert.rejects(
    getAcl(
      aclClient(
        1n,
        () => ({ ...emptyPage, dynamicFields: [entry("0xca"), entry("0xca")] }),
        () => read("0xca"),
      ),
      "0xac",
      "0xad",
    ),
    /duplicate/,
  );
  let page = 0;
  await assert.rejects(
    getAcl(
      aclClient(
        0n,
        () => ({ ...emptyPage, hasNextPage: true, cursor: String(++page) }),
        () => read("0xca"),
      ),
      "0xac",
      "0xad",
    ),
    /100 pages/,
  );
});

test("fresh package administration readers preserve custody, delayed actions and pause generations", () => {
  const value = {
    id: uid("0xaa"),
    custody: {
      publisher: { id: uid("0xbb"), package: [49, 53], module_name: [109] },
      upgrade_cap: {
        id: uid("0xcc"),
        package: id("0x15"),
        version: 2n,
        policy: 0,
      },
    },
    upgrade: {
      owner: id("0xaa"),
      key: null,
      delay_ms: 172_800_000n,
      pending: {
        value: { kind: "Delay" as const },
        delay_ms: 259_200_000n,
        ready_at_ms: 100n,
      },
    },
  };
  const object = {
    objectId: id("0xaa"),
    initialSharedVersion: "4",
    type: "0x15::package_admin::PackageAdmin",
    content: packageAdminBcs.serialize(value).toBytes(),
  };
  const state = decodePackageAdministrationObject(object, "0x15");
  assert.equal(
    state.delayMs,
    172_800_000n,
    "a ready proposal still needs an apply transaction",
  );
  assert.equal(state.pending?.delay_ms, 259_200_000n);
  assert.deepEqual(state.pending?.value, { kind: "Delay" });
  // The slot must belong to this PackageAdmin.
  assert.throws(
    () =>
      decodePackageAdministrationObject(
        {
          ...object,
          content: packageAdminBcs
            .serialize({
              ...value,
              upgrade: { ...value.upgrade, owner: id("0x1") },
            })
            .toBytes(),
        },
        "0x15",
      ),
    /UID/,
  );
  assert.equal(state.custody.upgrade_cap?.version, 2n);
  assert.throws(
    () =>
      decodePackageAdministrationObject({ ...object, objectId: "0x1" }, "0x15"),
    /UID/,
  );
  assert.throws(
    () => decodePackageAdministrationObject(object, "0x16"),
    /unexpected/,
  );
  for (const [product, module] of [
    ["launchpad", "blast_fun"],
    ["presale", "blast_presale_package"],
    ["migrators", "blast_fun_migrators"],
  ] as const) {
    const content =
      product === "migrators"
        ? migratorsVersionBcs
            .serialize({ id: uid("0xaa"), generation: { generation: 7n } })
            .toBytes()
        : packageVersionBcs
            .serialize({
              id: uid("0xaa"),
              paused: 3,
              generation: { generation: 7n },
            })
            .toBytes();
    const state = decodePackageVersionObject(
      { ...object, type: `0x15::${module}::PackageVersion`, content },
      "0x15",
      product,
    );
    assert.equal(state.generation, 7n);
    assert.equal(state.paused, product === "migrators" ? null : 3);
  }
});
