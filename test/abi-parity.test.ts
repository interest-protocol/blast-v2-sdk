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

import { LAUNCHPAD_ADMIN_ROLES } from "../src/launchpad/transactions.ts";

const contractsDirectory = process.env.BLAST_CONTRACTS_DIR ?? "../contracts";
const REVIEWED_CONTRACTS_COMMIT = "442116a0a1b82c6b4a64dc55fa0de430322f4bb7";
const PRESALE_CONTRACTS_COMMIT = "55e1ac0841535e708554cb45f9c67ab20f6e979a";
const expectedEvents = {
  launchpad: 27,
  migrators: 13,
  blastSui: 13,
  presale: 24,
  admin: 15,
  partners: 2,
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
  skip:
    hasCommit(contractsDirectory, REVIEWED_CONTRACTS_COMMIT) &&
    hasCommit(contractsDirectory, PRESALE_CONTRACTS_COMMIT)
      ? false
      : `requires a contracts repository containing ${REVIEWED_CONTRACTS_COMMIT} and ${PRESALE_CONTRACTS_COMMIT}`,
}, () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-contract-abi.mjs", contractsDirectory],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("freezes every artifact at its reviewed contracts commit", () => {
  for (const name of [
    "production-launchpad-v1.json",
    "production-blast-sui-v1.json",
    "production-partners-v1.json",
  ]) {
    assert.equal(
      readArtifact(name).baseline.contractsCommit,
      REVIEWED_CONTRACTS_COMMIT,
    );
  }
  // The presale package and the shared ACL's review amendments land together.
  for (const name of [
    "production-presale-v1.json",
    "production-admin-v1.json",
  ]) {
    assert.equal(
      readArtifact(name).baseline.contractsCommit,
      PRESALE_CONTRACTS_COMMIT,
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
  const presale = readArtifact("production-presale-v1.json");
  const admin = readArtifact("production-admin-v1.json");
  const partners = readArtifact("production-partners-v1.json");

  assert.deepEqual(Object.keys(launchpad.packages).sort(), [
    "launchpad",
    "memeTemplate",
    "migrators",
  ]);
  assert.deepEqual(Object.keys(blastSui.packages), ["blastSui"]);
  assert.deepEqual(Object.keys(presale.packages), ["presale"]);
  assert.deepEqual(Object.keys(admin.packages), ["admin"]);
  assert.deepEqual(Object.keys(partners.packages), ["partners"]);
  assert.equal(countEvents(launchpad, "launchpad"), expectedEvents.launchpad);
  assert.equal(countEvents(launchpad, "migrators"), expectedEvents.migrators);
  assert.equal(countEvents(blastSui, "blastSui"), expectedEvents.blastSui);
  assert.equal(countEvents(presale, "presale"), expectedEvents.presale);
  assert.equal(countEvents(admin, "admin"), expectedEvents.admin);
  assert.equal(countEvents(partners, "partners"), expectedEvents.partners);
  const eventWrapper = blastSui.packages.blastSui?.modules.blast_events;
  assert.ok(eventWrapper);
  assert.ok(eventWrapper.structs.some(({ name }) => name === "Event"));

  for (const artifact of [launchpad, blastSui, presale, admin, partners]) {
    assertEveryOperationIsClassified(artifact, artifact === admin);
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

test("names exactly the frozen blast_fun_domain admin roles", () => {
  const domain = readArtifact("production-launchpad-v1.json").packages.launchpad
    ?.modules.blast_fun_domain;
  assert.ok(domain);
  assert.deepEqual(
    [...LAUNCHPAD_ADMIN_ROLES].sort(),
    domain.structs.map(({ name }) => name).sort(),
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

for (const [packageName, moduleName] of [
  ["blast_admin", "blast_acl"],
  ["blast_presale", "blast_presale"],
] as const) {
  test(`rejects unknown ${packageName} function classifications`, () => {
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

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(
        `unclassified function ${packageName}::${moduleName}::future_operation`,
      ),
    );
  });
}

function hasCommit(directory: string, commit: string): boolean {
  return (
    spawnSync(
      "git",
      ["-C", directory, "cat-file", "-e", `${commit}^{commit}`],
      {
        encoding: "utf8",
      },
    ).status === 0
  );
}

function assertEveryOperationIsClassified(
  artifact: Artifact,
  isAdmin: boolean,
) {
  for (const packageArtifact of Object.values(artifact.packages)) {
    for (const moduleArtifact of Object.values(packageArtifact.modules)) {
      for (const operation of moduleArtifact.functions) {
        assert.ok(operation.sdk.length > 0);
      }
      for (const event of moduleArtifact.events) {
        // Only blast_admin's generic upgrade events are left to publish tooling.
        assert.equal(
          event.sdk,
          isAdmin && event.typeParameters.length > 0
            ? "intentional-upgrade-exclusion"
            : "decoder-reducer",
        );
      }
    }
  }
}
