import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PresaleAbortName } from "../src/presale/aborts.ts";
import { PRESALE_ABORTS, presaleAbortName } from "../src/presale/aborts.ts";
import type { PresaleAbortCode } from "../src/presale/math.ts";

// `check:abi` freezes the presale ABI at this commit and reads it with
// `git archive`, never from the working tree; so does this test.
const PRESALE_COMMIT = (
  JSON.parse(
    readFileSync(
      new URL("../abi/production-presale-v1.json", import.meta.url),
      "utf8",
    ),
  ) as { baseline: { contractsCommit: string } }
).baseline.contractsCommit;
const configured = process.env.BLAST_CONTRACTS_DIR;
const contracts = configured ?? "../contracts";

// Typechecks only while every abort a preview throws is a name the map knows.
const previewAbortName = (code: PresaleAbortCode): PresaleAbortName => code;

test("names a presale abort by its module and code", () => {
  assert.equal(presaleAbortName("blast_presale", 25), "EPresaleFilled");
  assert.equal(presaleAbortName("blast_presale", 0), "EInvalidAssetPair");
  assert.equal(presaleAbortName("blast_presale", 30), "EProtocolFeesUnchanged");
  assert.equal(presaleAbortName("blast_presale_admin", 0), "EInvalidAdminCap");
  assert.equal(
    presaleAbortName("presale_vault", 3),
    "EProtocolLpFeesUnchanged",
  );
  assert.equal(presaleAbortName("holder_rewards", 12), "EEmptyClaim");
  assert.equal(presaleAbortName("bps", 0), "EInvalidBps");
  assert.equal(presaleAbortName("bluefin", 1), "EInvalidTier");
  assert.equal(
    presaleAbortName("bluefin", 2),
    previewAbortName("ESymbolTooLong"),
  );
});

test("returns null for an unknown module or code", () => {
  assert.equal(presaleAbortName("blast_presale", 31), null);
  assert.equal(presaleAbortName("blast_presale", -1), null);
  assert.equal(presaleAbortName("blast_presale", 1.5), null);
  assert.equal(presaleAbortName("merkle_tree", 0), null);
  assert.equal(presaleAbortName("launch", 0), null);
  assert.equal(presaleAbortName("constructor", 0), null);
  // Untyped callers: an array key or numeric string is not a code.
  assert.equal(presaleAbortName("blast_presale", "length" as never), null);
  assert.equal(presaleAbortName("blast_presale", "25" as never), null);
});

test(`matches every #[error(code = N)] constant at contracts ${PRESALE_COMMIT}`, {
  // A configured repository must hold the pinned sources; only an absent
  // default checkout skips, as in `abi-parity.test.ts`.
  skip:
    configured === undefined && !existsSync(contracts)
      ? `requires BLAST_CONTRACTS_DIR or ${contracts}`
      : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "blast-presale-aborts-"));
  try {
    const archive = spawnSync(
      "git",
      [
        "-C",
        contracts,
        "archive",
        "--format=tar",
        PRESALE_COMMIT,
        "sui/presale/sources",
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(
      archive.status,
      0,
      `${contracts} must contain ${PRESALE_COMMIT}: ${archive.stderr}`,
    );
    const extract = spawnSync("tar", ["-x", "-C", root], {
      input: archive.stdout,
    });
    assert.equal(extract.status, 0, String(extract.stderr));
    assert.deepEqual(
      PRESALE_ABORTS,
      declaredAborts(join(root, "sui/presale/sources")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Every `#[error(code = N)]` constant name by module, indexed by code. */
function declaredAborts(sources: string): Record<string, string[]> {
  const declared: Record<string, string[]> = {};
  for (const file of readdirSync(sources).filter((name) =>
    name.endsWith(".move"),
  )) {
    const source = readFileSync(join(sources, file), "utf8");
    const module = /^module\s+\w+::(\w+);/m.exec(source)?.[1];
    assert.ok(module, `${file} declares a module`);
    const names: string[] = [];
    for (const [, code, name] of source.matchAll(
      /#\[error\(code\s*=\s*(\d+)\)\]\s*const\s+(\w+)\s*:/g,
    )) {
      assert.equal(
        names[Number(code)],
        undefined,
        `${module} reuses code ${code}`,
      );
      names[Number(code)] = name as string;
    }
    // A constant the pattern above misses would otherwise drop out silently.
    assert.equal(
      names.filter(Boolean).length,
      source.match(/^\s*const\s+E\w*\s*:/gm)?.length ?? 0,
      `${module} declares every error constant with #[error(code = N)]`,
    );
    if (names.length > 0) declared[module] = names;
  }
  return declared;
}
