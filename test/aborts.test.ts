import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ADMIN_ABORTS } from "@interest-protocol/blast-admin-sdk/aborts";
import { CORE_ABORTS } from "@interest-protocol/blast-core/aborts";
import { LAUNCHPAD_ABORTS } from "@interest-protocol/blast-launchpad-sdk/aborts";
import { MIGRATORS_ABORTS } from "@interest-protocol/blast-migrators-sdk/aborts";
import { PRESALE_ABORTS } from "@interest-protocol/blast-presale-sdk/aborts";
import { VAULT_ABORTS } from "@interest-protocol/blast-vault-sdk/aborts";

const configured = process.env.BLAST_CONTRACTS_DIR;
const contracts = configured ?? "../blast-v2-contracts";
// A configured checkout must hold the sources; only an absent default skips.
const skip =
  configured === undefined && !existsSync(contracts)
    ? `requires BLAST_CONTRACTS_DIR or ${contracts}`
    : false;

/** `const E<Name>: u64 = <code>;` declarations, each code its index. */
function numericRegistry(directory: string): string[] {
  const sui = join(contracts, "sui");
  // CI also checks the release commit, which predates the purpose folders.
  const group = directory === "admin" ? "governance" : "launch";
  const packageRoot = existsSync(join(sui, "launch")) ? join(sui, group) : sui;
  const source = readFileSync(
    join(packageRoot, directory, "sources/lib/errors.move"),
    "utf8",
  );
  return [...source.matchAll(/const (E\w+): u64 = (\d+);/g)].map(
    ([, name, code], index) => {
      assert.equal(Number(code), index, `${directory}: ${name} is ${index}`);
      return name as string;
    },
  );
}

test("every abort table is its package's errors.move registry", {
  skip,
}, () => {
  for (const [directory, table] of [
    ["core", CORE_ABORTS],
    ["admin", ADMIN_ABORTS],
    ["vault", VAULT_ABORTS],
    ["migrators", MIGRATORS_ABORTS],
    ["launchpad", LAUNCHPAD_ABORTS],
    ["presale", PRESALE_ABORTS],
  ] as const) {
    assert.deepEqual(numericRegistry(directory), [...table], directory);
  }
});
