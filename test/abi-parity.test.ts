import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const contractsDirectory = process.env.BLAST_CONTRACTS_DIR ?? "../contracts";
const REVIEWED_CONTRACTS_COMMIT = "442116a0a1b82c6b4a64dc55fa0de430322f4bb7";
const expectedEvents = {
  launchpad: 27,
  migrators: 13,
  blastSui: 13,
};

type Artifact = {
  baseline: { contractsCommit: string; suiCli: string };
  packages: Record<
    string,
    {
      modules: Record<
        string,
        {
          functions: Array<{ name: string; sdk: string }>;
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
  skip: hasReviewedCommit(contractsDirectory)
    ? false
    : `requires a contracts repository containing ${REVIEWED_CONTRACTS_COMMIT}`,
}, () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-contract-abi.mjs", contractsDirectory],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("freezes both artifacts at the reviewed contracts commit", () => {
  for (const name of [
    "production-launchpad-v1.json",
    "production-blast-sui-v1.json",
  ]) {
    assert.equal(
      readArtifact(name).baseline.contractsCommit,
      REVIEWED_CONTRACTS_COMMIT,
    );
  }
});

test("refuses a contracts repository without the reviewed commit", () => {
  const repository = mkdtempSync(join(tmpdir(), "blast-foreign-contracts-"));
  try {
    const init = spawnSync("git", ["init", "--quiet", repository], {
      encoding: "utf8",
    });
    assert.equal(init.status, 0, init.stderr);
    const result = spawnSync(
      process.execPath,
      ["scripts/check-contract-abi.mjs", repository],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(
        `does not contain contracts commit ${REVIEWED_CONTRACTS_COMMIT}`,
      ),
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
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
  const blastSui = readArtifact("production-blast-sui-v1.json");

  assert.deepEqual(Object.keys(launchpad.packages).sort(), [
    "launchpad",
    "memeTemplate",
    "migrators",
  ]);
  assert.deepEqual(Object.keys(blastSui.packages), ["blastSui"]);
  assert.equal(countEvents(launchpad, "launchpad"), expectedEvents.launchpad);
  assert.equal(countEvents(launchpad, "migrators"), expectedEvents.migrators);
  assert.equal(countEvents(blastSui, "blastSui"), expectedEvents.blastSui);
  const eventWrapper = blastSui.packages.blastSui?.modules.blast_events;
  assert.ok(eventWrapper);
  assert.ok(eventWrapper.structs.some(({ name }) => name === "Event"));

  for (const artifact of [launchpad, blastSui]) {
    assertEveryOperationIsClassified(artifact);
  }
});

test("builds the single generic Cetus route for every operation", () => {
  const cetus = readArtifact("production-launchpad-v1.json").packages.migrators
    ?.modules.cetus;
  assert.ok(cetus);
  assert.deepEqual(
    cetus.functions.map(({ name, sdk }) => [name, sdk]),
    [
      ["buyback_and_burn", "builder"],
      ["collect_fees", "builder"],
      ["migrate", "builder"],
      ["new", "builder"],
      ["settle_and_update_fee_split", "builder"],
    ],
  );
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

function hasReviewedCommit(directory: string): boolean {
  return (
    spawnSync(
      "git",
      [
        "-C",
        directory,
        "cat-file",
        "-e",
        `${REVIEWED_CONTRACTS_COMMIT}^{commit}`,
      ],
      { encoding: "utf8" },
    ).status === 0
  );
}

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
