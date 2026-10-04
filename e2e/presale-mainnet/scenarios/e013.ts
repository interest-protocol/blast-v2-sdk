/**
 * E2E-013 and E2E-025: an allowlist sale that opens to any wallet after a
 * deadline and overflows. TEST_SUI is delisted while it runs; the live sale
 * still commits, settles, migrates, and pays claims, while new TEST_SUI sales
 * are refused until it is listed again.
 */
import { Transaction } from "@mysten/sui/transactions";

import { buildAllowlist } from "../../../src/presale/index.ts";
import {
  balanceChange,
  equal,
  event,
  exec,
  expectAbort,
  single,
  waitUntil,
} from "../chain.ts";
import { ADMIN_CAP, deployer, presale, TEST_SUI, wallets } from "../env.ts";
import {
  addMigrate,
  addSettle,
  BLUEFIN_TIER,
  claimTx,
  coins,
  commit,
  commitTx,
  createSale,
  defaultTerms,
  mut,
  newSaleToken,
  recordMigration,
  saveSale,
  u64,
} from "../sale.ts";

const SALE_TOKENS = (coins(1_000_000_000) * 6_000n) / 10_000n;

export async function e013(): Promise<void> {
  const w = wallets();
  const allowlist = buildAllowlist([
    { wallet: w.p1.toSuiAddress(), walletCap: coins(20) },
    { wallet: w.p2.toSuiAddress(), walletCap: coins(20) },
  ]);
  const leaf = (index: number) => ({
    allowlist: allowlist.proofs[index] as (typeof allowlist.proofs)[number],
  });
  const { record, executed } = await createSale({
    scenario: "E2E-013",
    letter: "D",
    creator: w.creator,
    venue: "bluefin",
    terms: defaultTerms({
      raiseTarget: coins(100),
      durationMs: 6n * 60_000n,
      eligibility: {
        kind: "allowlisted",
        root: allowlist.root,
        leafCount: allowlist.leafCount,
      },
      uncapped: {
        startsAfterMs: 3n * 60_000n,
        access: {
          kind: "anyone",
          maxParticipants: 5n,
          minCommitment: coins(40),
        },
        hardCap: false,
      },
    }),
  });
  saveSale("e013", record);
  const opened = event(executed, "PresaleOpened");

  await commit(
    "p1 commits 20 from the allowlist",
    record,
    w.p1,
    coins(20),
    leaf(0),
  );
  await expectAbort(
    "unlisted p3 before the open phase",
    w.p3,
    commitTx(record, w.p3, coins(40), "uncapped"),
    { module: "blast_presale", code: 24 },
  );

  // E2E-025: delist TEST_SUI while this sale is open.
  const setTestSui = (allowed: boolean) =>
    single((tx) =>
      tx.add(
        presale.call.setQuoteAllowed({
          adminCap: ADMIN_CAP,
          quoteType: TEST_SUI,
          allowed,
        }),
      ),
    );
  await exec("delist TEST_SUI", deployer(), setTestSui(false));
  const token = await newSaleToken("O", w.creator);
  await expectAbort(
    "a new TEST_SUI sale while delisted",
    w.creator,
    presale.tx.createBluefinPresale({
      ...defaultTerms({}),
      memeType: token.memeType,
      quoteType: TEST_SUI,
      treasuryCap: token.treasuryCap,
      memeCurrency: mut(token.currency),
      startMs: 0n,
      capRecipient: w.creator.toSuiAddress(),
      ...BLUEFIN_TIER,
    }),
    { module: "creation_policy", code: 1 },
  );

  await waitUntil(u64(opened.uncapped_from_ms), "the open-to-anyone phase");
  await expectAbort(
    "p3 below the phase minimum",
    w.p3,
    commitTx(record, w.p3, coins(30), "uncapped"),
    { module: "blast_presale", code: 20 },
  );
  await commit("p3 commits 40 unlisted", record, w.p3, coins(40), "uncapped");
  await commit("p4 commits 50 unlisted", record, w.p4, coins(50), "uncapped");
  await commit("p5 commits 40 unlisted", record, w.p5, coins(40), "uncapped");
  const topUp = await commit(
    "p1 adds 25 through the open route",
    record,
    w.p1,
    coins(25),
    "uncapped",
  );
  equal(
    "p1 total 45",
    u64(event(topUp, "Committed").wallet_commitment),
    coins(45),
  );
  await commit(
    "p2 commits 20 from the allowlist",
    record,
    w.p2,
    coins(20),
    leaf(1),
  );
  await expectAbort(
    "a sixth wallet past the phase bound",
    w.p6,
    commitTx(record, w.p6, coins(40), "uncapped"),
    { module: "blast_presale", code: 10 },
  );
  await expectAbort(
    "p2 adds 10 through the open route, ending under its minimum",
    w.p2,
    commitTx(record, w.p2, coins(10), "uncapped"),
    { module: "blast_presale", code: 20 },
  );

  await waitUntil(u64(opened.end_ms), "E2E-013 window end");
  const keeper = new Transaction();
  addSettle(keeper, record);
  addMigrate(keeper, record);
  const migrated = await exec(
    "relayer settles and migrates the delisted-Quote sale",
    w.relayer,
    keeper,
  );
  const total = coins(195);
  equal(
    "overflow 95",
    u64(event(migrated, "PresaleFunded").refundable_quote),
    total - coins(100),
  );
  const done = recordMigration(record, migrated);
  saveSale("e013", done);

  const commitments: [typeof w.p1, bigint][] = [
    [w.p1, coins(45)],
    [w.p3, coins(40)],
    [w.p4, coins(50)],
    [w.p5, coins(40)],
    [w.p2, coins(20)],
  ];
  const claimed = await exec(
    "relayer claims for all five",
    w.relayer,
    claimTx(
      done,
      commitments.map(([key]) => key.toSuiAddress()),
    ),
  );
  let tokens = 0n;
  let refunds = 0n;
  for (const [i, [key, amount]] of commitments.entries()) {
    const got = balanceChange(claimed, key.toSuiAddress(), done.memeType);
    const refund = balanceChange(claimed, key.toSuiAddress(), done.quoteType);
    tokens += got;
    refunds += refund;
    if (i < commitments.length - 1) {
      equal(`wallet ${i} tokens`, got, (SALE_TOKENS * amount) / total);
      equal(
        `wallet ${i} refund`,
        refund,
        ((total - coins(100)) * amount) / total,
      );
    }
  }
  equal("one common fill rate delivers every token", tokens, SALE_TOKENS);
  equal("every overflow unit refunded", refunds, total - coins(100));

  await exec("list TEST_SUI again", deployer(), setTestSui(true));
}
