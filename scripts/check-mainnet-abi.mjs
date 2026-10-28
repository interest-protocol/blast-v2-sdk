import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CANONICAL_MAINNET_PACKAGES,
  CANONICAL_MAINNET_SHARED_OBJECTS,
  resolveMainnetDeployments,
} from "@interest-protocol/blast-deployments-sdk";
import { SuiGrpcClient } from "@mysten/sui/grpc";

// Compare the frozen SDK interfaces to published code, including BCS field order.
// https://docs.sui.io/develop/accessing-data/graphql/graphql-migration-cookbook
const endpoint = "https://graphql.mainnet.sui.io/graphql";
const targets = [
  ["admin", "production-admin-v1.json"],
  ["partners", "production-partners-v1.json"],
  ["launchpad", "production-launchpad-v1.json"],
  ["migrators", "production-launchpad-v1.json"],
  ["presale", "production-presale-v1.json"],
];
const aliases = {
  std: "0x1",
  sui: "0x2",
  blast_admin: CANONICAL_MAINNET_PACKAGES.admin.originalPackageId,
  blast_partners: CANONICAL_MAINNET_PACKAGES.partners.originalPackageId,
  blast_fun: CANONICAL_MAINNET_PACKAGES.launchpad.originalPackageId,
  blast_fun_migrators: CANONICAL_MAINNET_PACKAGES.migrators.originalPackageId,
  blast_presale: CANONICAL_MAINNET_PACKAGES.presale.originalPackageId,
  blast_fun_timelock: CANONICAL_MAINNET_PACKAGES.timelock.originalPackageId,
  cetus_clmm:
    "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
  lp_burn: "0x12d73de9a6bc3cb658ec9dc0fe7de2662be1cea5c76c092fcc3606048cdbac27",
  bluefin_spot:
    "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267",
  amm: "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c",
  dao_fee_amm:
    "0x6f60a091637054e23915b8745c0c0d47b1d49618ee3435b5f68eccf6a44fb53d",
};

function moveType(type, parameters) {
  if (typeof type === "string") return type;
  if (type.Reference) {
    const [mutable, inner] = type.Reference;
    return `${mutable ? "&mut " : "&"}${moveType(inner, parameters)}`;
  }
  if (type.vector) return `vector<${moveType(type.vector, parameters)}>`;
  if (type.NamedTypeParameter) {
    const index = parameters.findIndex(
      (p) => p.name === type.NamedTypeParameter,
    );
    assert.ok(index >= 0, `unknown type parameter ${type.NamedTypeParameter}`);
    return `$${index}`;
  }
  const datatype = type.Datatype;
  assert.ok(datatype, `unknown ABI type ${JSON.stringify(type)}`);
  const address = aliases[datatype.module.address] ?? datatype.module.address;
  assert.match(address, /^0x[0-9a-f]+$/);
  const args = datatype.type_arguments.map((p) =>
    moveType(p.argument, parameters),
  );
  return `${address}::${datatype.module.name}::${datatype.name}${args.length ? `<${args.join(", ")}>` : ""}`;
}

const normalized = (type) => type.replace(/0x0*([0-9a-f]+)/g, "0x$1");
const abilities = (values) => values.map((v) => v.toUpperCase()).sort();
function typeParameters(frozen, live, phantom = true) {
  assert.deepEqual(
    live.map((p) => abilities(p.constraints)),
    frozen.map((p) => abilities(p.constraints)),
  );
  if (phantom)
    assert.deepEqual(
      live.map((p) => p.isPhantom),
      frozen.map((p) => p.phantom),
    );
}
function fields(frozen, live, parameters) {
  assert.deepEqual(
    live.map((f) => [f.name, normalized(f.type.repr)]),
    frozen.map((f) => [f.name, normalized(moveType(f.type, parameters))]),
  );
}
function allNodes(connection) {
  assert.equal(
    connection.pageInfo.hasNextPage,
    false,
    "ABI exceeds one page; increase pagination support before releasing",
  );
  return connection.nodes;
}

async function graphql(query) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.ok, true, `mainnet GraphQL HTTP ${response.status}`);
  const result = await response.json();
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return result.data;
}

async function moduleFunctions(packageId, module) {
  const nodes = [...module.functions.nodes];
  let page = module.functions.pageInfo;
  while (page.hasNextPage) {
    const result =
      await graphql(`{ package(address: "${packageId}") { module(name: "${module.name}") {
      functions(first: 50, after: ${JSON.stringify(page.endCursor)}) {
        pageInfo { hasNextPage endCursor }
        nodes { name visibility isEntry typeParameters { constraints } parameters { repr } return { repr } }
      }
    } } }`);
    const connection = result.package.module.functions;
    nodes.push(...connection.nodes);
    assert.notEqual(
      connection.pageInfo.endCursor,
      page.endCursor,
      "function pagination must advance",
    );
    page = connection.pageInfo;
  }
  return nodes;
}

let functions = 0;
let layouts = 0;
for (const [name, artifact] of targets) {
  const frozen = JSON.parse(
    readFileSync(new URL(`../abi/${artifact}`, import.meta.url)),
  ).packages[name].modules;
  const query = `query { package(address: "${CANONICAL_MAINNET_PACKAGES[name].packageId}") {
    modules(first: 50) { pageInfo { hasNextPage } nodes { name
      functions(first: 50) { pageInfo { hasNextPage endCursor } nodes { name visibility isEntry typeParameters { constraints } parameters { repr } return { repr } } }
      structs(first: 50) { pageInfo { hasNextPage } nodes { name abilities typeParameters { constraints isPhantom } fields { name type { repr } } } }
      enums(first: 50) { pageInfo { hasNextPage } nodes { name abilities typeParameters { constraints isPhantom } variants { name fields { name type { repr } } } } }
    } }
  } }`;
  const result = { data: await graphql(query) };
  assert.ok(result.data.package, `${name} exists on mainnet`);
  const modules = allNodes(result.data.package.modules);
  assert.deepEqual(
    modules.map((m) => m.name).sort(),
    Object.keys(frozen).sort(),
    name,
  );
  for (const module of modules) {
    const expected = frozen[module.name];
    const publicFunctions = (
      await moduleFunctions(CANONICAL_MAINNET_PACKAGES[name].packageId, module)
    ).filter((f) => f.visibility === "PUBLIC");
    assert.deepEqual(
      publicFunctions.map((f) => f.name).sort(),
      expected.functions.map((f) => f.name).sort(),
      `${name}::${module.name} public functions`,
    );
    for (const f of expected.functions) {
      const actual = publicFunctions.find((a) => a.name === f.name);
      try {
        assert.equal(actual.isEntry, f.entry);
        typeParameters(f.typeParameters, actual.typeParameters, false);
        assert.deepEqual(
          actual.parameters.map((p) => normalized(p.repr)),
          f.parameters.map((p) => normalized(moveType(p, f.typeParameters))),
        );
        assert.deepEqual(
          actual.return.map((p) => normalized(p.repr)),
          f.returns.map((p) => normalized(moveType(p, f.typeParameters))),
        );
      } catch (error) {
        throw new Error(
          `${name}::${module.name}::${f.name}: ${error.message}`,
          { cause: error },
        );
      }
      functions++;
    }
    const structs = allNodes(module.structs);
    const expectedStructs = [...expected.structs, ...expected.events];
    assert.deepEqual(
      structs.map((s) => s.name).sort(),
      expectedStructs.map((s) => s.name).sort(),
      `${name}::${module.name} structs`,
    );
    for (const s of expectedStructs) {
      const actual = structs.find((a) => a.name === s.name);
      try {
        assert.deepEqual(abilities(actual.abilities), abilities(s.abilities));
        typeParameters(s.typeParameters, actual.typeParameters);
        fields(s.fields, actual.fields, s.typeParameters);
      } catch (error) {
        throw new Error(
          `${name}::${module.name}::${s.name}: ${error.message}`,
          { cause: error },
        );
      }
      layouts++;
    }
    const enums = allNodes(module.enums);
    assert.deepEqual(
      enums.map((e) => e.name).sort(),
      expected.enums.map((e) => e.name).sort(),
    );
    for (const e of expected.enums) {
      const actual = enums.find((a) => a.name === e.name);
      assert.deepEqual(abilities(actual.abilities), abilities(e.abilities));
      typeParameters(e.typeParameters, actual.typeParameters);
      assert.deepEqual(
        actual.variants.map((v) => v.name),
        e.variants.map((v) => v.name),
      );
      e.variants.forEach((v, i) => {
        fields(v.fields, actual.variants[i].fields, e.typeParameters);
      });
      layouts++;
    }
  }
  console.log(
    `${name}: published public signatures, structs, events and enums match ${artifact}`,
  );
}
console.log(
  `Verified ${targets.length} mainnet packages, ${functions} public functions and ${layouts} layouts.`,
);

const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io:443",
});
await resolveMainnetDeployments(client);
console.log("Verified all five pinned @blastpackages MVR resolutions.");
const { chainIdentifier } = await client.core.getChainIdentifier();
assert.equal(chainIdentifier, "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S");
const shared = Object.entries(CANONICAL_MAINNET_SHARED_OBJECTS).flatMap(
  ([group, objects]) =>
    Object.entries(objects).map(([name, identity]) => ({
      group,
      name,
      identity,
    })),
);
const { objects } = await client.core.getObjects({
  objectIds: shared.map(({ identity }) => identity.objectId),
  include: { json: true },
});
assert.equal(objects.length, shared.length);
const modules = {
  admin: "blast_acl",
  launchpad: "blast_fun",
  migrators: "blast_fun_migrators",
  presale: "blast_presale_package",
};
for (const [i, { group, name, identity }] of shared.entries()) {
  const object = objects[i];
  assert.ok(object && !(object instanceof Error), `${group}.${name} exists`);
  assert.equal(object.objectId, identity.objectId);
  assert.equal(object.owner.$kind, "Shared");
  assert.equal(
    object.owner.Shared.initialSharedVersion,
    identity.initialSharedVersion,
  );
  const module =
    name === "acl" || name === "packageVersion"
      ? modules[group]
      : name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const type =
    name === "acl" ? "ACL" : `${name[0].toUpperCase()}${name.slice(1)}`;
  assert.equal(
    object.type,
    `${CANONICAL_MAINNET_PACKAGES[group].originalPackageId}::${module}::${type}`,
  );
  if (name === "packageVersion")
    assert.equal(
      object.json.generation.generation,
      "1",
      `${group} canonical generation`,
    );
}
console.log(
  `Verified mainnet chain identity and ${shared.length} shared objects, including all three activated version singletons.`,
);
