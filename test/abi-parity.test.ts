import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const siblingContractsManifestUrl = new URL(
  "../../contracts/sui/launchpad/Move.toml",
  import.meta.url,
);
const expectedEvents = {
  launchpad: 30,
  migrators: 6,
  vesting: 8,
  blastSui: 20,
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
  skip: existsSync(siblingContractsManifestUrl)
    ? false
    : "requires the sibling blast-v2 contracts checkout",
}, () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-contract-abi.mjs", "../contracts"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
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
