import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
assert.equal(Object.keys(manifest.peerDependencies ?? {}).length, 0);
const directory = mkdtempSync(join(tmpdir(), "blast-partner-package-"));
try {
  const result = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
      encoding: "utf8",
    }),
  );
  const pack = Array.isArray(result) ? result[0] : result[manifest.name];
  assert(pack, "Missing npm pack metadata");
  assert(
    pack.files.every(({ path }) =>
      /^(dist\/|contracts\/|examples\/|README\.md$|package\.json$|LICENSE$)/.test(path),
    ),
  );
  assert(pack.files.some(({ path }) => path === "dist/index.d.ts"));
  assert(pack.files.every(({ path }) => !/env|test|node_modules|\.tgz$/.test(path)));
  writeFileSync(join(directory, "package.json"), '{"type":"module","private":true}');
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(directory, pack.filename),
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
  assert.equal(JSON.parse(readFileSync(installed, "utf8")).name, manifest.name);
  writeFileSync(
    join(directory, "consumer.mjs"),
    'import { createBlastPartnerClient, unavailableOperations } from "@interest-protocol/blast-partner-client"; if (typeof createBlastPartnerClient !== "function" || unavailableOperations.length !== 6) throw new Error("Broken exports");',
  );
  execFileSync(process.execPath, [join(directory, "consumer.mjs")], {
    cwd: directory,
    stdio: "pipe",
  });
  console.log(
    `Package smoke passed: ${pack.files.length} files, ${pack.size} compressed bytes, zero runtime/peer dependencies.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
