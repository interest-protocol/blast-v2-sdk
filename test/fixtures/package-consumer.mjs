import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** Each `@interest-protocol/blast-sdk` subpath and the packages it re-exports. */
const subpaths = {
  admin: ["blast-admin-sdk"],
  "blast-sui": ["blast-sui-sdk"],
  boosts: ["blast-boosts-sdk"],
  coin: ["blast-coin-sdk"],
  cctp: ["blast-cctp-sdk"],
  deployments: ["blast-deployments-sdk"],
  "holder-rewards": ["blast-holder-rewards-sdk"],
  launchpad: ["blast-launchpad-sdk"],
  "launchpad/template": ["blast-launchpad-sdk/template"],
  migrators: [
    "blast-migrators-sdk",
    "blast-deployments-sdk/bluefin-venue",
    "blast-deployments-sdk/cetus-venue",
  ],
  partners: ["blast-partners-sdk"],
  presale: ["blast-presale-sdk"],
  vault: ["blast-vault-sdk"],
};

async function exportsOf(specifiers) {
  const modules = await Promise.all(
    specifiers.map((specifier) => import(`@interest-protocol/${specifier}`)),
  );
  return Object.assign({}, ...modules);
}

/** A subpath re-exports exactly its packages' values, under their own names. */
async function assertReexports(specifier, canonical) {
  const actual = await import(specifier);
  assert.deepEqual(
    Object.keys(actual).sort(),
    Object.keys(canonical).sort(),
    `${specifier} re-exports exactly its packages`,
  );
  const commonjs = require(specifier);
  for (const [name, value] of Object.entries(actual)) {
    assert.equal(value, canonical[name], `${specifier} duplicates ${name}`);
    assert.equal(
      commonjs[name],
      value,
      `${specifier} require() differs for ${name}`,
    );
  }
}

for (const [subpath, packages] of Object.entries(subpaths)) {
  await assertReexports(
    `@interest-protocol/blast-sdk/${subpath}`,
    await exportsOf(packages),
  );
}
await assertReexports(
  "@interest-protocol/blast-sdk",
  await exportsOf(["blast-core", ...new Set(Object.values(subpaths).flat())]),
);
const metadata = require("@interest-protocol/blast-sdk/package.json");
assert.equal(metadata.name, "@interest-protocol/blast-sdk");
assert.equal(metadata.private, undefined);
console.log(
  `blast-sdk re-exports passed for ${Object.keys(subpaths).length + 1} entry points (ESM and require).`,
);
