import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const contractsDirectory = process.env.BLAST_CONTRACTS_DIR ?? "../contracts";
const contractsManifest = join(contractsDirectory, "sui/launchpad/Move.toml");
const expectedEvents = {
  launchpad: 29,
  migrators: 8,
  vesting: 8,
  blastSui: 24,
};

type Artifact = {
  packages: Record<
    string,
    {
      modules: Record<
        string,
        {
          functions: Array<{ sdk: string }>;
          structs: Array<{ name: string }>;
          events: unknown[];
        }
      >;
    }
  >;
};

function readArtifact(name: string): Artifact {
  return JSON.parse(
    readFileSync(new URL(`../abi/${name}`, import.meta.url), "utf8"),
  ) as Artifact;
}

function countEvents(artifact: Artifact, packageName: string): number {
  const packageArtifact = artifact.packages[packageName];
  assert.ok(packageArtifact);
  return Object.values(packageArtifact.modules).reduce(
    (count, moduleArtifact) => count + moduleArtifact.events.length,
    0,
  );
}

test("matches the frozen production Move ABI", {
  skip: existsSync(contractsManifest)
    ? false
    : "requires the sibling blast-v2 contracts checkout",
}, () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-contract-abi.mjs", contractsDirectory],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("rejects a Sui CLI version that differs from the frozen artifacts", () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "blast-wrong-sui-cli-"));
  try {
    const fakeSui = join(fakeBin, "sui");
    writeFileSync(fakeSui, "#!/bin/sh\nprintf '%s\\n' 'sui 9.9.9-test'\n");
    chmodSync(fakeSui, 0o755);
    const result = spawnSync(
      process.execPath,
      ["scripts/check-contract-abi.mjs", contractsDirectory],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, PATH: fakeBin },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Sui CLI 9\.9\.9-test does not match .*1\.77\.2-51d177ad7d65/,
    );
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("freezes every production package and event", () => {
  const launchpad = readArtifact("production-launchpad-v1.json");
  const vesting = readArtifact("production-vesting-v1.json");
  const blastSui = readArtifact("production-blast-sui-v1.json");

  assert.deepEqual(Object.keys(launchpad.packages).sort(), [
    "launchpad",
    "memeTemplate",
    "migrators",
  ]);
  assert.deepEqual(Object.keys(vesting.packages), ["vesting"]);
  assert.deepEqual(Object.keys(blastSui.packages), ["blastSui"]);
  assert.equal(countEvents(launchpad, "launchpad"), expectedEvents.launchpad);
  assert.equal(countEvents(launchpad, "migrators"), expectedEvents.migrators);
  assert.equal(countEvents(vesting, "vesting"), expectedEvents.vesting);
  assert.equal(countEvents(blastSui, "blastSui"), expectedEvents.blastSui);
  const eventWrapper = blastSui.packages.blastSui?.modules.events_wrapper;
  assert.ok(eventWrapper);
  assert.ok(eventWrapper.structs.some(({ name }) => name === "Event"));

  for (const artifact of [launchpad, vesting, blastSui]) {
    assertEveryOperationIsClassified(artifact);
  }
});

test("rejects unknown blast_sui function classifications", () => {
  for (const moduleName of ["math", "acl", "package_admin"]) {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/check-contract-abi.mjs",
        "--classify-function",
        "blast_sui",
        moduleName,
        "future_operation",
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(
        `unclassified function blast_sui::${moduleName}::future_operation`,
      ),
    );
  }
});

function assertEveryOperationIsClassified(artifact: Artifact) {
  for (const packageArtifact of Object.values(artifact.packages)) {
    for (const moduleArtifact of Object.values(packageArtifact.modules)) {
      for (const operation of moduleArtifact.functions) {
        assert.ok(operation.sdk.length > 0);
      }
      for (const event of moduleArtifact.events) {
        assert.match(JSON.stringify(event), /"sdk":"decoder-reducer"/);
      }
    }
  }
}
