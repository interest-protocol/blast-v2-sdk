import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const baseline = JSON.parse(
  readFileSync(new URL("exports.json", import.meta.url)),
);
const require = createRequire(import.meta.url);
const products = {
  admin: "blast-admin-sdk",
  "blast-sui": "blast-sui-sdk",
  boosts: "blast-boosts-sdk",
  coin: "blast-coin-sdk",
  cctp: "blast-cctp-sdk",
  deployments: "blast-deployments-sdk",
  "holder-rewards": "blast-holder-rewards-sdk",
  launchpad: "blast-launchpad-sdk",
  "launchpad/template": "blast-launchpad-sdk/template",
  partners: "blast-partners-sdk",
  presale: "blast-presale-sdk",
};
for (const [subpath, expected] of Object.entries(baseline)) {
  const specifier = `@interest-protocol/blast-sdk${subpath === "." ? "" : subpath.slice(1)}`;
  const actual = await import(specifier);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(expected).map((key) => [key, typeof actual[key]]),
    ),
    expected,
    `${specifier} changed its legacy exports`,
  );
  const commonjs = require(specifier);
  for (const [name, value] of Object.entries(actual)) {
    assert.equal(
      commonjs[name],
      value,
      `${specifier} require() differs for ${name}`,
    );
  }
  if (subpath === ".") continue;
  const product = products[subpath.slice(2)];
  const canonical = product
    ? await import(`@interest-protocol/${product}`)
    : {
        ...(await import("@interest-protocol/blast-migrators-sdk")),
        ...(await import(
          "@interest-protocol/blast-deployments-sdk/bluefin-venue"
        )),
        ...(await import(
          "@interest-protocol/blast-deployments-sdk/cetus-venue"
        )),
      };
  for (const [name, value] of Object.entries(actual)) {
    assert.equal(value, canonical[name], `${specifier} duplicates ${name}`);
  }
}
const metadata = require("@interest-protocol/blast-sdk/package.json");
assert.equal(metadata.name, "@interest-protocol/blast-sdk");
assert.equal(metadata.private, undefined);
console.log(
  `Legacy import compatibility passed for ${Object.keys(baseline).length} entry points (ESM and require).`,
);
