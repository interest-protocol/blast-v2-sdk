import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
verifyReleaseMetadata(manifest);

const directory = mkdtempSync(join(tmpdir(), "blast-partner-package-"));
try {
  const result = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
      encoding: "utf8",
    }),
  );
  const pack = Array.isArray(result) ? result[0] : result[manifest.name];
  assert(pack, "Missing npm pack metadata");
  verifyPackedContents(pack.files);
  verifyInstalledPackage(directory, pack.filename, manifest.name);

  console.log(
    `Package smoke passed: ${pack.files.length} files, ${pack.size} compressed bytes, zero runtime/peer dependencies.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function verifyReleaseMetadata(manifest) {
  assert.notEqual(manifest.private, true, "Release package must be publishable");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org/");
  assert.equal(manifest.engines, undefined, "Node tooling constraints belong in devEngines");
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  assert.equal(Object.keys(manifest.peerDependencies ?? {}).length, 0);
}

function verifyPackedContents(files) {
  assert(
    files.every(({ path }) =>
      /^(dist\/|contracts\/|examples\/|README\.md$|CHANGELOG\.md$|package\.json$|LICENSE$)/.test(
        path,
      ),
    ),
  );
  assert(files.some(({ path }) => path === "dist/index.d.ts"));
  assert(files.some(({ path }) => path === "LICENSE"));
  assert(files.some(({ path }) => path === "CHANGELOG.md"));
  assert(files.every(({ path }) => !/env|test|node_modules|\.tgz$/.test(path)));
}

function verifyInstalledPackage(directory, filename, name) {
  writeFileSync(join(directory, "package.json"), '{"type":"module","private":true}');
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(directory, filename),
    ],
    { cwd: directory, stdio: "pipe" },
  );
  const installed = join(
    directory,
    "node_modules",
    "@interest-protocol",
    "blast-partner-client",
    "package.json",
  );
  assert.equal(JSON.parse(readFileSync(installed, "utf8")).name, name);
  writeFileSync(
    join(directory, "consumer.mjs"),
    `import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createBlastPartnerClient, unavailableOperations } from "@interest-protocol/blast-partner-client";
const partnerKey = "blast_pk_" + randomBytes(32).toString("base64url");
const expected = ${JSON.stringify(JSON.parse(readFileSync("test/examples.json", "utf8")).status)};

const client = createBlastPartnerClient({
  partnerKey,
  fetch: async (input, init) => {
    assert.equal(String(input), "https://www.blast.fun/api/v1/market/status");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert(new Headers(init.headers).get("X-Blast-Partner-Key") === partnerKey, "Missing credential header");
    return Response.json(expected);
  },
});
assert.equal(unavailableOperations.length, 6);
assert.deepEqual(await client.marketStatus(), expected);
`,
  );
  execFileSync(process.execPath, [join(directory, "consumer.mjs")], {
    cwd: directory,
    stdio: "pipe",
  });
}
