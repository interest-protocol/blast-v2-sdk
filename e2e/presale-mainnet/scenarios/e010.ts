/**
 * E2E-010: an open sale whose closing phase lifts wallet caps under a hard cap.
 * Migrates to Bluefin; claims pay tokens only, with the rounding remainder on
 * the last claim.
 */
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";

import {
  balanceChange,
  check,
  equal,
  event,
  events,
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
  mut,
  recordMigration,
  sale,
  saveSale,
  types,
  u64,
} from "../sale.ts";
import { assertSealed, residualChecks } from "./shared.ts";

const SUPPLY = coins(1_000_000_000);
const SALE_TOKENS = (SUPPLY * 6_000n) / 10_000n;

export async function e010(): Promise<void> {
  const w = wallets();
  const { record, executed } = await createSale({
    scenario: "E2E-010",
    letter: "A",
    creator: w.creator,
    venue: "bluefin",
    terms: defaultTerms({
      burnable: true,
      raiseTarget: coins(100),
      durationMs: 6n * 60_000n,
      eligibility: {
        kind: "open",
        walletCap: coins(40),
        maxParticipants: 4n,
        minCommitment: coins(25),
      },
      uncapped: {
        startsAfterMs: 3n * 60_000n,
        access: { kind: "eligible" },
        hardCap: true,
      },
    }),
  });
  saveSale("e010", record);
  const opened = event(executed, "PresaleOpened");
  const uncappedFrom = u64(opened.uncapped_from_ms);
  const end = u64(opened.end_ms);
  equal(
    "uncapped phase starts 3 min in",
    uncappedFrom,
    u64(opened.start_ms) + 180_000n,
  );
  await assertSealed(record, "BurnOnly");

  // Capped phase.
  await commit("p1 commits its 40 cap", record, w.p1, coins(40), "open");
  await expectAbort(
    "p1 exceeds its cap",
    w.p1,
    commitTx(record, w.p1, coins(1), "open"),
    { module: "blast_presale", code: 9 },
  );
  await expectAbort(
    "p3 below the minimum",
    w.p3,
    commitTx(record, w.p3, coins(10), "open"),
    { module: "blast_presale", code: 20 },
  );
  await expectAbort("a zero commitment", w.p3, zeroCommit(record, w.p3), {
    module: "blast_presale",
    code: 8,
  });
  await expectAbort(
    "commit_allowlisted on an open sale",
    w.p3,
    commitTx(record, w.p3, coins(30), {
      allowlist: {
        index: 0n,
        wallet: w.p3.toSuiAddress(),
        walletCap: coins(30),
        proof: [],
      },
    }),
    { module: "blast_presale", code: 12 },
  );
  await expectAbort(
    "commit_uncapped before the phase",
    w.p3,
    commitTx(record, w.p3, coins(30), "uncapped"),
    { module: "blast_presale", code: 24 },
  );
  await commit("p2 commits 25", record, w.p2, coins(25), "open");

  // Uncapped, hard-capped phase.
  await waitUntil(uncappedFrom, "the uncapped phase");
  await expectAbort(
    "commit_uncapped in a phase only for eligible wallets",
    w.p3,
    commitTx(record, w.p3, coins(30), "uncapped"),
    { module: "blast_presale", code: 24 },
  );
  const over = await commit(
    "p1 commits 30 past its old cap",
    record,
    w.p1,
    coins(30),
    "open",
  );
  equal(
    "p1 wallet commitment",
    u64(event(over, "Committed").wallet_commitment),
    coins(70),
  );
  const fill = await commit(
    "p3 offers 10 when 5 remain",
    record,
    w.p3,
    coins(10),
    "open",
  );
  equal(
    "only the remaining 5 accepted",
    u64(event(fill, "Committed").quote),
    coins(5),
  );
  equal(
    "p3 pays only 5 (excess returned at once)",
    balanceChange(fill, w.p3.toSuiAddress(), record.quoteType),
    -coins(5),
  );
  await expectAbort(
    "p4 commits after the hard cap filled",
    w.p4,
    commitTx(record, w.p4, coins(25), "open"),
    { module: "blast_presale", code: 25 },
  );

  // Settle and migrate in one keeper transaction.
  await waitUntil(end, "E2E-010 window end");
  const keeper = new Transaction();
  addSettle(keeper, record);
  addMigrate(keeper, record);
  const migrated = await exec(
    "relayer settles and migrates to Bluefin",
    w.relayer,
    keeper,
  );
  equal(
    "no overflow",
    u64(event(migrated, "PresaleFunded").refundable_quote),
    0n,
  );
  const migration = event(migrated, "PresaleMigrated");
  equal("LP takes the whole raise", u64(migration.liquidity_quote), coins(100));
  equal(
    "LP takes 40% of supply",
    u64(migration.liquidity_tokens),
    (SUPPLY * 4_000n) / 10_000n,
  );
  check(
    "no protocol fees paid at zero rates",
    events(migrated, "ProtocolFeesPaid").every(
      (paid) => u64(paid.quote) === 0n && u64(paid.tokens) === 0n,
    ),
    events(migrated, "ProtocolFeesPaid"),
  );
  const done = recordMigration(record, migrated);
  saveSale("e010", done);

  // Claims: p2 claims itself; the relayer claims for p1 and p3 last.
  const own = await exec(
    "p2 claims",
    w.p2,
    claimTx(done, [w.p2.toSuiAddress()]),
  );
  const relayed = await exec(
    "relayer claims for p1 and p3",
    w.relayer,
    claimTx(done, [w.p1.toSuiAddress(), w.p3.toSuiAddress()]),
  );
  const tokens = (executed: typeof own, key: typeof w.p1) =>
    balanceChange(executed, key.toSuiAddress(), done.memeType);
  const p2Tokens = tokens(own, w.p2);
  const p1Tokens = tokens(relayed, w.p1);
  const p3Tokens = tokens(relayed, w.p3);
  equal("p2 pro-rata tokens", p2Tokens, (SALE_TOKENS * 25n) / 100n);
  equal("p1 pro-rata tokens", p1Tokens, (SALE_TOKENS * 70n) / 100n);
  equal(
    "last claim takes the remainder",
    p1Tokens + p2Tokens + p3Tokens,
    SALE_TOKENS,
  );
  check(
    "relayer received nothing",
    tokens(relayed, w.relayer) === 0n,
    tokens(relayed, w.relayer),
  );
  check(
    "no Quote refunds without overflow",
    [own, relayed].every((executed) =>
      events(executed, "Claimed").every(
        (claim) => u64(claim.quote_refund) === 0n,
      ),
    ),
  );
  await expectAbort(
    "p1 claims twice",
    w.p1,
    claimTx(done, [w.p1.toSuiAddress()]),
    { module: "blast_presale", code: 14 },
  );
  await expectAbort(
    "a wallet that never committed claims",
    w.p5,
    claimTx(done, [w.p5.toSuiAddress()]),
    { module: "blast_presale", code: 14 },
  );
  const after = await presale.getPresale(done.presale.objectId);
  equal("sale tokens fully delivered", after.saleTokens, 0n);
  equal("Quote custody empty", after.quote, 0n);

  await residualChecks(done, sale("e017").capId);
  await expectAbort(
    "commit after migration",
    w.p4,
    commitTx(done, w.p4, coins(25), "open"),
    { module: "blast_presale", code: 5 },
  );
}

function zeroCommit(
  record: ReturnType<typeof sale>,
  signer: ReturnType<typeof wallets>["p1"],
) {
  return single((tx: Transaction) => {
    const [zero] = tx.moveCall({
      target: "0x2::coin::zero",
      typeArguments: [record.quoteType],
    });
    const change = tx.add(
      presale.call.commitOpen({
        ...types(record),
        presale: mut(record.presale),
        quote: zero as TransactionArgument,
      }),
    );
    tx.transferObjects([change], signer.toSuiAddress());
  });
}
