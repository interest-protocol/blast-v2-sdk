import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [openapiPath, gatePath, registryPath] = process.argv.slice(2);
assert(
  openapiPath && gatePath && registryPath,
  "Usage: node scripts/verify-contract.mjs OPENAPI_JSON RELEASE_GATE_JSON ROUTE_REGISTRY_TS",
);
const api = JSON.parse(readFileSync(openapiPath, "utf8"));
const gate = JSON.parse(readFileSync(gatePath, "utf8"));
const pinned = JSON.parse(readFileSync(new URL("../contracts/partner-v1.json", import.meta.url)));
const provenance = JSON.parse(
  readFileSync(new URL("../contracts/provenance.json", import.meta.url)),
);
const annotations = new Set(["description", "title", "example", "examples", "$schema", "$id"]);

function wire(value, preserveKeys = false) {
  if (Array.isArray(value)) {
    return value.map((child) => wire(child));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => preserveKeys || !annotations.has(key))
        .map(([key, child]) => [
          key,
          wire(child, ["properties", "patternProperties", "$defs", "definitions"].includes(key)),
        ]),
    );
  }
  return value;
}

for (const [name, operation] of Object.entries(pinned.operations)) {
  const live = api.paths[operation.path]?.get;
  assert(live, `Missing documented operation: ${name}`);
  assert.deepEqual(
    wire(live.responses[200].content["application/json"].schema),
    wire(operation.schema),
    `Response contract drift: ${name}`,
  );
  assert.deepEqual(
    wire(live.parameters ?? []),
    wire(operation.parameters),
    `Query/path contract drift: ${name}`,
  );
  assert.deepEqual(
    gate.operations[name],
    { path: operation.path, schema: operation.schema },
    `Release gate drift: ${name}`,
  );
}
for (const [name, schema] of Object.entries(pinned.components.schemas)) {
  assert.deepEqual(
    wire(api.components.schemas[name]),
    wire(schema),
    `Deployed schema drift: ${name}`,
  );
  assert.deepEqual(gate.components.schemas[name], schema, `Release gate schema drift: ${name}`);
}
assert.equal(gate.sourceCommit, provenance.releaseGateSourceCommit);
assert.equal(
  createHash("sha256").update(readFileSync(registryPath)).digest("hex"),
  provenance.routeRegistrySha256,
  "Route registry changed; review availability and allowlist before updating provenance",
);
console.log(
  "Six operations, queries and pinned response schemas agree; route registry matches the reviewed snapshot.",
);
