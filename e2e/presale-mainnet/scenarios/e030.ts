/**
 * E2E-030: teardown. Delists TEST_SUI so nobody can raise the free test coin on
 * the production package, and checks every global setting is back to its
 * launch state. SUI and both migrators stay listed (DEPLOYING.md step 6).
 */
import { normalizeStructTag } from "@mysten/sui/utils";

import { equal, exec, single } from "../chain.ts";
import { ADMIN_CAP, deployer, presale, SUI, TEST_SUI } from "../env.ts";

export async function e030(): Promise<void> {
  const admin = deployer();
  const policy = await presale.getCreationPolicy();
  if (
    policy.allowedQuotes
      .map((q) => normalizeStructTag(q))
      .includes(normalizeStructTag(TEST_SUI))
  ) {
    await exec(
      "delist TEST_SUI",
      admin,
      single((tx) =>
        tx.add(
          presale.call.setQuoteAllowed({
            adminCap: ADMIN_CAP,
            quoteType: TEST_SUI,
            allowed: false,
          }),
        ),
      ),
    );
  }
  const after = await presale.getCreationPolicy();
  equal(
    "only SUI listed",
    after.allowedQuotes.map((q) => normalizeStructTag(q)).join(","),
    normalizeStructTag(SUI),
  );
  equal("both migrators listed", after.allowedMigrationWitnesses.length, 2);
  const fees = await presale.getFeePolicy();
  equal(
    "fee destination is the deployer",
    fees.destination,
    admin.toSuiAddress(),
  );
  equal(
    "all global rates zero",
    [
      fees.fees.raiseBps,
      fees.fees.tokenBps,
      fees.fees.lpFeeMemeBps,
      fees.fees.lpFeeQuoteBps,
    ].join(","),
    "0,0,0,0",
  );
  const registry = await presale.getAdminRegistry();
  equal(
    "AdminCap unchanged",
    registry.adminCapId,
    "0x7a9174aa9f7658ed29a91b4b732a965c19ef4683d5b47d30cc0320315d82e9be",
  );
}
