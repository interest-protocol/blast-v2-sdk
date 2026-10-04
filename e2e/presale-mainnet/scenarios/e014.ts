/**
 * E2E-014: a sale shared ahead of its start. Before the start the AdminCap
 * replaces its Blast rates; migration then pays Blast exactly the new shares.
 * Its vault (nonzero Blast LP rates, three fee recipients) feeds E2E-020/021.
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
import type { SaleRecord } from "../sale.ts";
import {
  addMigrate,
  addSettle,
  claimTx,
  coins,
  commit,
  commitTx,
  createSale,
  defaultTerms,
  mut,
  recordMigration,
  saveSale,
  types,
  u64,
} from "../sale.ts";

const SUPPLY = coins(1_000_000_000);
const RAISE = coins(100);

export async function e014(): Promise<void> {
  const w = wallets();
  const admin = deployer();
  const startMs = BigInt(Date.now()) + 4n * 60_000n;
  const { record, executed } = await createSale({
    scenario: "E2E-014",
    letter: "E",
    creator: w.creator,
    venue: "bluefin",
    startMs,
    terms: defaultTerms({
      raiseTarget: RAISE,
      raiseAllocations: [{ recipient: w.r1.toSuiAddress(), bps: 3_000n }],
      durationMs: 3n * 60_000n,
      eligibility: {
        kind: "open",
        walletCap: coins(60),
        maxParticipants: 4n,
        minCommitment: coins(25),
      },
      feeRecipients: [
        { recipient: w.creator.toSuiAddress(), bps: 4_000n },
        { recipient: w.r2.toSuiAddress(), bps: 3_000n },
        { recipient: w.r3.toSuiAddress(), bps: 1_000n },
      ],
      holderRewardsBps: 2_000n,
    }),
  });
  saveSale("e014", record);
  const opened = event(executed, "PresaleOpened");
  equal("start is the scheduled time", u64(opened.start_ms), startMs);

  await expectAbort(
    "commit before the start",
    w.p1,
    commitTx(record, w.p1, coins(30), "open"),
    { module: "blast_presale", code: 28 },
  );
  const fees = {
    raiseBps: 500n,
    tokenBps: 300n,
    lpFeeMemeBps: 1_000n,
    lpFeeQuoteBps: 1_500n,
  };
  const setFees = (rates: typeof fees) =>
    single((tx) =>
      tx.add(
        presale.call.setPresaleProtocolFees({
          ...types(record),
          presale: mut(record.presale),
          adminCap: ADMIN_CAP,
          fees: rates,
        }),
      ),
    );
  const changed = event(
    await exec("admin sets the sale's rates", admin, setFees(fees)),
    "ProtocolFeesChanged",
  );
  equal("Blast Quote 5% of raise", u64(changed.protocol_quote), coins(5));
  equal(
    "Blast tokens 3% of supply",
    u64(changed.protocol_tokens),
    (SUPPLY * 300n) / 10_000n,
  );
  equal(
    "buyers' allocation shrinks by Blast's tokens",
    u64(changed.token_allocation),
    (SUPPLY * 6_000n) / 10_000n - (SUPPLY * 300n) / 10_000n,
  );
  await expectAbort("the same rates again", admin, setFees(fees), {
    module: "blast_presale",
    code: 30,
  });
  await expectAbort(
    "a raise share leaving the LP nothing",
    admin,
    setFees({ ...fees, raiseBps: 7_000n }),
    { module: "blast_presale", code: 26 },
  );
  await expectAbort(
    "a token share leaving buyers nothing",
    admin,
    setFees({ ...fees, tokenBps: 9_998n }),
    { module: "blast_presale", code: 2 },
  );
  await expectAbort(
    "a 100% raise share",
    admin,
    setFees({ ...fees, raiseBps: 10_000n }),
    { module: "fee_policy", code: 0 },
  );

  await waitUntil(startMs, "the scheduled start");
  await expectAbort(
    "rates after the start",
    admin,
    setFees({ ...fees, raiseBps: 600n }),
    { module: "blast_presale", code: 29 },
  );
  await commit("p1 commits 50", record, w.p1, coins(50), "open");
  await commit("p2 commits 50", record, w.p2, coins(50), "open");

  await waitUntil(u64(opened.end_ms), "E2E-014 window end");
  const keeper = new Transaction();
  addSettle(keeper, record);
  addMigrate(keeper, record);
  const migrated = await exec(
    "relayer settles and migrates",
    w.relayer,
    keeper,
  );
  await checkMigration(
    record,
    migrated,
    admin.toSuiAddress(),
    w.r1.toSuiAddress(),
  );
  const done = recordMigration(record, migrated);
  saveSale("e014", done);

  const vaultCreated = event(migrated, "PresaleVaultCreated");
  equal(
    "vault Blast meme rate",
    u64(vaultCreated.protocol_lp_fee_meme_bps),
    1_000n,
  );
  equal(
    "vault Blast quote rate",
    u64(vaultCreated.protocol_lp_fee_quote_bps),
    1_500n,
  );

  const claimed = await exec(
    "relayer claims for p1 and p2",
    w.relayer,
    claimTx(done, [w.p1.toSuiAddress(), w.p2.toSuiAddress()]),
  );
  const buyers = (SUPPLY * 5_700n) / 10_000n;
  equal(
    "p1 half of the reduced allocation",
    balanceChange(claimed, w.p1.toSuiAddress(), done.memeType),
    buyers / 2n,
  );
}

async function checkMigration(
  record: SaleRecord,
  migrated: Awaited<ReturnType<typeof exec>>,
  destination: string,
  raiseRecipient: string,
): Promise<void> {
  const paid = event(migrated, "ProtocolFeesPaid");
  equal("Blast paid to the policy destination", paid.destination, destination);
  equal("Blast Quote paid", u64(paid.quote), coins(5));
  equal("Blast tokens paid", u64(paid.tokens), (SUPPLY * 300n) / 10_000n);
  equal(
    "destination received Blast's tokens",
    balanceChange(migrated, destination, record.memeType),
    (SUPPLY * 300n) / 10_000n,
  );
  equal(
    "raise recipient paid 30",
    balanceChange(migrated, raiseRecipient, record.quoteType),
    coins(30),
  );
  equal(
    "LP Quote is the rest",
    u64(event(migrated, "PresaleMigrated").liquidity_quote),
    RAISE - coins(5) - coins(30),
  );
}
