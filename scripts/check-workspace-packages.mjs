import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);
const packages = manifest.workspaces.map((directory) => ({
  directory,
  ...JSON.parse(
    readFileSync(new URL(`${directory}/package.json`, root), "utf8"),
  ),
}));
const names = new Set(packages.map((pkg) => pkg.name));
const built = new Set();
for (const pkg of packages) {
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    if (names.has(dependency)) {
      assert(
        built.has(dependency),
        `${pkg.name} must build after ${dependency}`,
      );
    }
  }
  verifySourceImports(pkg);
  built.add(pkg.name);
}

// Install the tarballs outside the workspace so workspace links cannot hide a
// missing file, dependency, or export in a published package.
const directory = mkdtempSync(join(tmpdir(), "blast-sdk-packages-"));
try {
  const tarballs = packages.map((pkg) => {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
        { cwd: new URL(pkg.directory, root), encoding: "utf8" },
      ),
    );
    const result = Array.isArray(packed) ? packed[0] : packed[pkg.name];
    assert(result, `Missing pack result for ${pkg.name}`);
    assert(result.files.some((file) => file.path === "dist/index.d.ts"));
    return join(directory, result.filename);
  });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
    { cwd: directory, stdio: "pipe" },
  );
  writeFileSync(
    join(directory, "exports.json"),
    readFileSync(new URL("test/fixtures/legacy-exports.json", root)),
  );
  const smoke = new URL(
    "../test/fixtures/package-consumer.mjs",
    import.meta.url,
  );
  writeFileSync(join(directory, "consumer.mjs"), readFileSync(smoke));
  execFileSync(process.execPath, ["consumer.mjs"], {
    cwd: directory,
    stdio: "inherit",
  });
  writeFileSync(
    join(directory, "consumer.ts"),
    readFileSync(new URL("test/fixtures/package-consumer.ts", root)),
  );
  writeFileSync(
    join(directory, "legacy-types.ts"),
    readFileSync(new URL("test/fixtures/legacy-types.ts", root)),
  );
  execFileSync(
    new URL("node_modules/.bin/tsc", root).pathname,
    [
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "es2023",
      "--module",
      "nodenext",
      "consumer.ts",
      "legacy-types.ts",
    ],
    { cwd: directory, stdio: "inherit" },
  );
  console.log(
    `Packed consumer passed for ${packages.length} workspace packages.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function verifySourceImports(pkg) {
  const source = new URL(`${pkg.directory}/src/`, root);
  for (const file of readdirSync(source, { recursive: true })) {
    if (!file.endsWith(".ts")) continue;
    const filename = new URL(file, source);
    const body = readFileSync(filename, "utf8");
    const imports = body.matchAll(/(?:from\s+|import\()["']([^"']+)["']/g);
    for (const [, specifier] of imports) {
      if (specifier.startsWith(".")) {
        assert(
          new URL(specifier, filename).pathname.startsWith(source.pathname),
          `${filename.pathname} imports another package's source`,
        );
        continue;
      }
      const dependency = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      assert(
        dependency === pkg.name ||
          pkg.dependencies?.[dependency] ||
          pkg.peerDependencies?.[dependency],
        `${pkg.name} must declare ${dependency}`,
      );
    }
  }
}
