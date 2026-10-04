/**
 * E2E-017: a funded sale nobody migrates. Phase `start` funds and settles it;
 * phase `finish`, after the seven-day LP window, cancels it and refunds
 * everyone in full.
 */
import { Transaction } from "@mysten/sui/transactions";

import {
  balanceChange,
  check,
  equal,
  event,
  exec,
  expectAbort,
  single,
  waitUntil,
} from "../chain.ts";
import { presale, wallets } from "../env.ts";
import {
  addMigrate,
  addSettle,
  claimTx,
  coins,
  commit,
  createSale,
  defaultTerms,
  imm,
  mut,
  sale,
  saveSale,
  types,
  u64,
} from "../sale.ts";

export async function e017(phase = "start"): Promise<void> {
  const w = wallets();
  if (phase === "finish") return finish();

  const { record, executed } = await createSale({
    scenario: "E2E-017",
    letter: "I",
    creator: w.creator,
    venue: "bluefin",
    terms: defaultTerms({ raiseTarget: coins(50), durationMs: 3n * 60_000n }),
  });
  saveSale("e017", record);
  const opened = event(executed, "PresaleOpened");
  const endMs = u64(opened.end_ms);
  equal(
    "LP deadline is end + 7 days",
    u64(opened.liquidity_deadline_ms),
    endMs + 7n * 24n * 3_600_000n,
  );

  await commit("p1 commits 30", record, w.p1, coins(30), "open");
  await commit("p2 commits 30", record, w.p2, coins(30), "open");
  await expectAbort(
    "settle before the window ends",
    w.relayer,
    single((tx) => addSettle(tx, record)),
    { module: "blast_presale", code: 7 },
  );

  await waitUntil(endMs, "E2E-017 window end");
  const settled = await exec(
    "relayer settles",
    w.relayer,
    single((tx) => addSettle(tx, record)),
  );
  const funded = event(settled, "PresaleFunded");
  equal("total commitments", u64(funded.total_commitments), coins(60));
  equal("accepted quote", u64(funded.accepted_quote), coins(50));
  equal("refundable overflow", u64(funded.refundable_quote), coins(10));

  await expectAbort(
    "cancel before the LP deadline",
    w.relayer,
    single((tx) =>
      tx.add(
        presale.call.cancelUnlaunched({
          ...types(record),
          presale: mut(record.presale),
        }),
      ),
    ),
    { module: "blast_presale", code: 16 },
  );
  await expectAbort(
    "claim while funded",
    w.relayer,
    claimTx(record, [w.p1.toSuiAddress()]),
    { module: "blast_presale", code: 5 },
  );
  await expectAbort(
    "settle twice",
    w.relayer,
    single((tx) => addSettle(tx, record)),
    {
      module: "blast_presale",
      code: 5,
    },
  );
  console.log(
    `  phase finish runs after ${new Date(Number(u64(opened.liquidity_deadline_ms))).toISOString()}`,
  );
}

async function finish(): Promise<void> {
  const w = wallets();
  const record = sale("e017");
  const state = await presale.getPresale(record.presale.objectId);
  await waitUntil(BigInt(state.liquidityDeadlineMs), "E2E-017 LP deadline");

  const cancelled = await exec(
    "relayer cancels the unmigrated sale",
    w.relayer,
    single((tx) =>
      tx.add(
        presale.call.cancelUnlaunched({
          ...types(record),
          presale: mut(record.presale),
        }),
      ),
    ),
  );
  equal(
    "every commitment refundable",
    u64(event(cancelled, "PresaleCancelled").refundable_quote),
    coins(60),
  );

  const migrate = new Transaction();
  addMigrate(migrate, record);
  await expectAbort("migrate after cancellation", w.relayer, migrate, {
    module: "blast_presale",
    code: 5,
  });

  const claimed = await exec(
    "relayer claims for p1 and p2",
    w.relayer,
    claimTx(record, [w.p1.toSuiAddress(), w.p2.toSuiAddress()]),
  );
  for (const [name, key] of [
    ["p1", w.p1],
    ["p2", w.p2],
  ] as const) {
    equal(
      `${name} refunded in full`,
      balanceChange(claimed, key.toSuiAddress(), record.quoteType),
      coins(30),
    );
    equal(
      `${name} receives no tokens`,
      balanceChange(claimed, key.toSuiAddress(), record.memeType),
      0n,
    );
  }
  const after = await presale.getPresale(record.presale.objectId);
  check("custody holds no Quote", BigInt(after.quote) === 0n, after.quote);

  await exec(
    "creator destroys the cap",
    w.creator,
    presale.tx.destroyCap({
      ...types(record),
      presale: imm(record.presale),
      presaleCapId: record.capId,
    }),
  );
}
