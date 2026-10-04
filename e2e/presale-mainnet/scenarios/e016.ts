/**
 * E2E-016: a sale that misses its raise. Settling cancels it; everyone is
 * refunded in full with no tokens, the supply stays locked, and the creator
 * destroys the cap.
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
import { presale, wallets } from "../env.ts";
import {
  addMigrate,
  addSettle,
  claimTx,
  coins,
  commit,
  commitTx,
  createSale,
  defaultTerms,
  imm,
  sale,
  saveSale,
  types,
  u64,
} from "../sale.ts";
import { assertSealed } from "./shared.ts";

export async function e016(): Promise<void> {
  const w = wallets();
  const { record, executed } = await createSale({
    scenario: "E2E-016",
    letter: "H",
    creator: w.creator,
    venue: "bluefin",
    terms: defaultTerms({ raiseTarget: coins(100), durationMs: 3n * 60_000n }),
  });
  saveSale("e016", record);
  const destroy = (capId: string) =>
    presale.tx.destroyCap({
      ...types(record),
      presale: imm(record.presale),
      presaleCapId: capId,
    });

  await commit("p1 commits 30", record, w.p1, coins(30), "open");
  await commit("p2 commits 25", record, w.p2, coins(25), "open");
  await expectAbort(
    "destroy the cap of an open sale",
    w.creator,
    destroy(record.capId),
    {
      module: "blast_presale",
      code: 5,
    },
  );

  await waitUntil(
    u64(event(executed, "PresaleOpened").end_ms),
    "E2E-016 window end",
  );
  const settled = await exec(
    "relayer settles the underfunded sale",
    w.relayer,
    single((tx) => addSettle(tx, record)),
  );
  equal(
    "cancelled with everything refundable",
    u64(event(settled, "PresaleCancelled").refundable_quote),
    coins(55),
  );
  const migrate = new Transaction();
  addMigrate(migrate, record);
  await expectAbort("migrate a cancelled sale", w.relayer, migrate, {
    module: "blast_presale",
    code: 5,
  });
  await expectAbort(
    "commit to a cancelled sale",
    w.p3,
    commitTx(record, w.p3, coins(30), "open"),
    { module: "blast_presale", code: 5 },
  );

  const own = await exec(
    "p1 claims its refund",
    w.p1,
    claimTx(record, [w.p1.toSuiAddress()]),
  );
  equal(
    "p1 refunded 30",
    balanceChange(own, w.p1.toSuiAddress(), record.quoteType),
    coins(30),
  );
  const relayed = await exec(
    "relayer claims p2's refund",
    w.relayer,
    claimTx(record, [w.p2.toSuiAddress()]),
  );
  equal(
    "p2 refunded 25",
    balanceChange(relayed, w.p2.toSuiAddress(), record.quoteType),
    coins(25),
  );
  equal(
    "p2 no tokens",
    balanceChange(relayed, w.p2.toSuiAddress(), record.memeType),
    0n,
  );
  await expectAbort(
    "p2 claims again",
    w.p2,
    claimTx(record, [w.p2.toSuiAddress()]),
    {
      module: "blast_presale",
      code: 14,
    },
  );

  const state = await presale.getPresale(record.presale.objectId);
  equal("Quote custody empty", state.quote, 0n);
  equal(
    "sale tokens stay locked",
    state.saleTokens,
    (coins(1_000_000_000) * 6_000n) / 10_000n,
  );
  equal(
    "LP tokens stay locked",
    state.liquidityTokens,
    (coins(1_000_000_000) * 4_000n) / 10_000n,
  );
  await assertSealed(record, "Fixed");

  await expectAbort(
    "destroy with another sale's cap",
    w.creator,
    destroy(sale("e010").capId),
    {
      module: "blast_presale",
      code: 15,
    },
  );
  await exec("creator destroys the cap", w.creator, destroy(record.capId));
}
