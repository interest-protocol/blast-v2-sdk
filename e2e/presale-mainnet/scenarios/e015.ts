/**
 * E2E-015: global fee rates and the payout destination. A sale created before
 * `set_fees` keeps its zero snapshot; one created after takes the new rates.
 * Both pay the new destination at migration. Rates and destination are
 * restored at the end so later scenarios run at zero rates.
 */
import { Transaction } from "@mysten/sui/transactions";

import {
  balanceChange,
  equal,
  event,
  exec,
  expectAbort,
  single,
  waitUntil,
} from "../chain.ts";
import { ADMIN_CAP, deployer, presale, wallets } from "../env.ts";
import {
  addMigrate,
  addSettle,
  coins,
  commit,
  createSale,
  defaultTerms,
  recordMigration,
  saveSale,
  u64,
} from "../sale.ts";

const SUPPLY = coins(1_000_000_000);
const RATES = {
  raiseBps: 300n,
  tokenBps: 200n,
  lpFeeMemeBps: 500n,
  lpFeeQuoteBps: 500n,
};
const ZERO = {
  raiseBps: 0n,
  tokenBps: 0n,
  lpFeeMemeBps: 0n,
  lpFeeQuoteBps: 0n,
};

export async function e015(): Promise<void> {
  const w = wallets();
  const admin = deployer();
  const terms = {
    raiseTarget: coins(50),
    durationMs: 4n * 60_000n,
  };
  const before = await createSale({
    scenario: "E2E-015 before",
    letter: "F",
    creator: w.creator,
    venue: "bluefin",
    terms: defaultTerms(terms),
  });
  saveSale("e015-before", before.record);

  const setFees = (fees: typeof RATES) =>
    single((tx) =>
      tx.add(presale.call.setProtocolFees({ adminCap: ADMIN_CAP, fees })),
    );
  const changed = await exec("admin sets global rates", admin, setFees(RATES));
  equal(
    "FeesChanged raise",
    u64(event(changed, "FeesChanged").raise_bps),
    300n,
  );
  await expectAbort("the same global rates", admin, setFees(RATES), {
    module: "fee_policy",
    code: 1,
  });
  await expectAbort(
    "a 100% raise share",
    admin,
    setFees({ ...RATES, raiseBps: 10_000n }),
    {
      module: "fee_policy",
      code: 0,
    },
  );
  await expectAbort(
    "a 99.99% token share",
    admin,
    setFees({ ...RATES, tokenBps: 9_999n }),
    {
      module: "fee_policy",
      code: 0,
    },
  );

  const after = await createSale({
    scenario: "E2E-015 after",
    letter: "G",
    creator: w.creator,
    venue: "bluefin",
    terms: defaultTerms({ ...terms, tokenAllocationBps: 5_800n }),
  });
  saveSale("e015-after", after.record);
  const created = event(after.executed, "PresaleCreated");
  equal("new sale snapshots raise rate", u64(created.protocol_raise_bps), 300n);
  equal("new sale snapshots token rate", u64(created.protocol_token_bps), 200n);
  equal(
    "old sale kept zero",
    u64(event(before.executed, "PresaleCreated").protocol_raise_bps),
    0n,
  );

  const setDestination = (destination: string) =>
    single((tx) =>
      tx.add(
        presale.call.setProtocolDestination({
          adminCap: ADMIN_CAP,
          destination,
        }),
      ),
    );
  const fees = w.fees.toSuiAddress();
  await exec(
    "admin redirects payouts to the fee wallet",
    admin,
    setDestination(fees),
  );
  await expectAbort("the same destination", admin, setDestination(fees), {
    module: "fee_policy",
    code: 2,
  });
  await expectAbort("the zero address", admin, setDestination("0x0"), {
    module: "fee_policy",
    code: 2,
  });

  await commit(
    "p1 commits 30 to the old sale",
    before.record,
    w.p1,
    coins(30),
    "open",
  );
  await commit(
    "p2 commits 30 to the old sale",
    before.record,
    w.p2,
    coins(30),
    "open",
  );
  await commit(
    "p3 commits 30 to the new sale",
    after.record,
    w.p3,
    coins(30),
    "open",
  );
  await commit(
    "p4 commits 30 to the new sale",
    after.record,
    w.p4,
    coins(30),
    "open",
  );

  await waitUntil(
    u64(event(after.executed, "PresaleOpened").end_ms),
    "both windows end",
  );
  for (const [name, sale] of [
    ["old", before],
    ["new", after],
  ] as const) {
    const keeper = new Transaction();
    addSettle(keeper, sale.record);
    addMigrate(keeper, sale.record);
    const migrated = await exec(
      `relayer migrates the ${name} sale`,
      w.relayer,
      keeper,
    );
    const paid = event(migrated, "ProtocolFeesPaid");
    equal(`${name} sale pays the new destination`, paid.destination, fees);
    const quote = name === "old" ? 0n : (coins(50) * 300n) / 10_000n;
    const tokens = name === "old" ? 0n : (SUPPLY * 200n) / 10_000n;
    equal(`${name} sale Blast Quote`, u64(paid.quote), quote);
    equal(`${name} sale Blast tokens`, u64(paid.tokens), tokens);
    equal(
      `fee wallet received the ${name} sale's Quote`,
      balanceChange(migrated, fees, sale.record.quoteType),
      quote,
    );
    saveSale(
      `e015-${name === "old" ? "before" : "after"}`,
      recordMigration(sale.record, migrated),
    );
  }

  await exec("restore zero rates", admin, setFees(ZERO));
  await exec(
    "restore the deployer destination",
    admin,
    setDestination(admin.toSuiAddress()),
  );
  const policy = await presale.getFeePolicy();
  equal("destination restored", policy.destination, admin.toSuiAddress());
}
