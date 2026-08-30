import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const artifactUrl = new URL(
  "../abi/production-launchpad-v1.json",
  import.meta.url,
);

test("matches the frozen production Move ABI", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-contract-abi.mjs", "../contracts"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("classifies every frozen function and event for SDK parity", () => {
  const artifact = JSON.parse(readFileSync(artifactUrl, "utf8")) as {
    packages: Record<
      string,
      { modules: Record<string, { functions: unknown[]; events: unknown[] }> }
    >;
  };

  for (const packageArtifact of Object.values(artifact.packages)) {
    for (const moduleArtifact of Object.values(packageArtifact.modules)) {
      for (const operation of moduleArtifact.functions) {
        assert.match(JSON.stringify(operation), /"sdk":"[^"]+"/);
      }
      for (const event of moduleArtifact.events) {
        assert.match(JSON.stringify(event), /"sdk":"decoder-reducer"/);
      }
    }
  }
});
