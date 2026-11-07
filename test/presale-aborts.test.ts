import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { CoreAbortName } from "@interest-protocol/blast-core/aborts";
import { CORE_ABORTS } from "@interest-protocol/blast-core/aborts";
import type { PresaleAbortName } from "@interest-protocol/blast-presale-sdk/aborts";
import {
  AFTERMATH_DAO_PRESALE_ABORTS,
  aftermathDaoPresaleAbortName,
  PRESALE_ABORTS,
  presaleAbortName,
} from "@interest-protocol/blast-presale-sdk/aborts";
import type { PresaleAbortCode } from "@interest-protocol/blast-presale-sdk/math";

const configured = process.env.BLAST_CONTRACTS_DIR;
const contracts = configured ?? "../blast-v2-contracts";
// A configured checkout must hold the sources; only an absent default skips.
const skip =
  configured === undefined && !existsSync(contracts)
    ? `requires BLAST_CONTRACTS_DIR or ${contracts}`
    : false;

// Typechecks only while every abort a preview throws is a presale or core name.
const previewAbortName = (
  code: PresaleAbortCode,
): PresaleAbortName | CoreAbortName => code;

test("names a presale abort by its package-wide code", () => {
  assert.equal(presaleAbortName(0), "EUnguardedDelay");
  assert.equal(presaleAbortName(3), "EVenueNotAllowed");
  assert.equal(presaleAbortName(29), "EPresaleFilled");
  assert.equal(presaleAbortName(38), "EProtocolFeesIncreased");
  assert.equal(presaleAbortName(39), null);
  assert.equal(presaleAbortName(-1), null);
  assert.equal(presaleAbortName(1.5), null);
  assert.equal(PRESALE_ABORTS.length, 39);
  assert.equal(previewAbortName("EInvalidBps"), "EInvalidBps");
});

test("names a vendor abort by its code", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(aftermathDaoPresaleAbortName), [
    "EPoolMismatch",
    "EDaoFeePoolMismatch",
    "EInvalidPackageWitness",
    "EWrongPackageWitness",
    null,
  ]);
});

test("previews raise only names the contracts define", () => {
  for (const name of [
    "EInvalidBps",
    "EInvalidVestingTerms",
    "EInvalidRecipient",
    "EInvalidRoute",
    "EInvalidFeeSplit",
  ] as const) {
    assert.ok((CORE_ABORTS as readonly string[]).includes(name), name);
  }
});

test("AFTERMATH_DAO_PRESALE_ABORTS matches the vendor's error constants", {
  skip,
}, () => {
  const sui = join(contracts, "sui");
  const group = existsSync(join(sui, "launch")) ? "launch" : "";
  const source = readFileSync(
    join(
      sui,
      group,
      "vendors/aftermath_dao_presale/sources/blast_aftermath_dao_presale.move",
    ),
    "utf8",
  );
  const declared = [
    ...source.matchAll(/#\[error\(code = (\d+)\)\]\s*const (E\w+)/g),
  ].map(([, code, name], index) => {
    assert.equal(Number(code), index, `${name} is code ${index}`);
    return name;
  });
  assert.deepEqual(declared, [...AFTERMATH_DAO_PRESALE_ABORTS]);
});
