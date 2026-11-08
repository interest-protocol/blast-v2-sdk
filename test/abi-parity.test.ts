import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const contractsDirectory =
  process.env.BLAST_CONTRACTS_DIR ?? "../blast-v2-contracts";
const contractsWorkspace = join(contractsDirectory, "sui/README.md");
/** Artifact file → package key → event count. */
const expectedEvents = {
  "production-admin-v1.json": { admin: 36 },
  "production-partners-v1.json": { partners: 5 },
  "production-core-v1.json": { core: 1 },
  "production-vault-v1.json": { vault: 10 },
  "production-migrators-v1.json": { migrators: 2 },
  "production-launchpad-v1.json": {
    launchpad: 18,
    launchTicketTemplate: 0,
    coinTemplate: 0,
  },
  "production-presale-v1.json": { presale: 11, presaleCoinTemplate: 0 },
  "production-aftermath-dao-presale-v1.json": { aftermathDaoPresale: 2 },
  "production-blast-sui-v1.json": { blastSui: 13 },
  "production-boosts-v1.json": {
    boostsCore: 0,
    boostsProducts: 0,
    boostsAftermath: 21,
  },
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
          events: Array<{ sdk: string; typeParameters: unknown[] }>;
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
  skip: existsSync(contractsWorkspace)
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
  assert.deepEqual(
    readdirSync(new URL("../abi/", import.meta.url)).sort(),
    Object.keys(expectedEvents).sort(),
  );
  for (const [file, packages] of Object.entries(expectedEvents)) {
    const artifact = readArtifact(file);
    assert.deepEqual(Object.keys(artifact.packages), Object.keys(packages));
    for (const [packageName, events] of Object.entries(packages)) {
      assert.equal(countEvents(artifact, packageName), events, packageName);
    }
    assertEveryOperationIsClassified(artifact, file);
  }
  const eventWrapper = readArtifact("production-blast-sui-v1.json").packages
    .blastSui?.modules.blast_events;
  assert.ok(eventWrapper);
  assert.ok(eventWrapper.structs.some(({ name }) => name === "Event"));
});

test("rejects unknown Boosts adapter functions", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/check-contract-abi.mjs",
      "--classify-function",
      "blast_boosts_aftermath",
      "operations",
      "future_operation",
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /unclassified function blast_boosts_aftermath::operations::future_operation/,
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

test("rejects unknown blast_admin function classifications", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/check-contract-abi.mjs",
      "--classify-function",
      "blast_admin",
      "blast_acl",
      "future_operation",
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /unclassified function blast_admin::blast_acl::future_operation/,
  );
});

test("rejects unknown blast_aftermath_dao_presale function classifications", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/check-contract-abi.mjs",
      "--classify-function",
      "blast_aftermath_dao_presale",
      "blast_aftermath_dao_presale",
      "future_operation",
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /unclassified function blast_aftermath_dao_presale::blast_aftermath_dao_presale::future_operation/,
  );
});

test("rejects unknown blast_presale function classifications", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/check-contract-abi.mjs",
      "--classify-function",
      "blast_presale",
      "blast_presale",
      "future_operation",
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /unclassified function blast_presale::blast_presale::future_operation/,
  );
});

test("rejects unknown launch-stack function classifications", () => {
  for (const [packageName, moduleName] of [
    ["blast_core", "blast_treasury"],
    ["blast_partners", "blast_partners"],
    ["blast_vault", "vault"],
    ["blast_migrators", "cetus"],
    ["blast_fun", "creator_authority"],
    ["launch_ticket_template", "meme"],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/check-contract-abi.mjs",
        "--classify-function",
        packageName,
        moduleName,
        "future_operation",
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, `${packageName}::${moduleName}`);
    assert.match(
      result.stderr,
      new RegExp(
        `unclassified function ${packageName}::${moduleName}::future_operation`,
      ),
    );
  }
});

function assertEveryOperationIsClassified(artifact: Artifact, file: string) {
  for (const packageArtifact of Object.values(artifact.packages)) {
    for (const moduleArtifact of Object.values(packageArtifact.modules)) {
      for (const operation of moduleArtifact.functions) {
        assert.ok(operation.sdk.length > 0);
      }
      for (const event of moduleArtifact.events) {
        if (file === "production-boosts-v1.json") {
          assert.ok(
            ["decoder", "intentional-operator-exclusion"].includes(event.sdk),
          );
        } else {
          assert.equal(event.sdk, "decoder-reducer");
        }
      }
    }
  }
}
