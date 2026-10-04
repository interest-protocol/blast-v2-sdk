/**
 * E2E-027: an uncapped phase open to anyone under a hard cap, on Bluefin with
 * real SUI as the Quote (the launch configuration). Sale M uses an open
 * policy; sale N an allowlist. In each, the phase admits new wallets at its
 * own minimum, the commit that fills the raise is partly accepted with the
 * excess returned, and the next commit is refused.
 */
import { Transaction } from "@mysten/sui/transactions";

import { buildAllowlist } from "../../../src/presale/index.ts";
import {
  balanceChange,
  equal,
  event,
  exec,
  expectAbort,
  waitUntil,
} from "../chain.ts";
import { SUI, wallets } from "../env.ts";
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
  recordMigration,
  saveSale,
  u64,
} from "../sale.ts";

const SALE_TOKENS = (coins(1_000_000_000) * 6_000n) / 10_000n;

export async function e027(): Promise<void> {
  await openPolicySale();
  await allowlistSale();
}

async function openPolicySale(): Promise<void> {
  const w = wallets();
  const { record, executed } = await createSale({
    scenario: "E2E-027 open policy",
    letter: "M",
    creator: w.creator,
    venue: "bluefin",
    quoteType: SUI,
    terms: defaultTerms({
      raiseTarget: coins(0.03),
      durationMs: 4n * 60_000n,
      eligibility: {
        kind: "open",
        walletCap: coins(0.012),
        maxParticipants: 3n,
        minCommitment: coins(0.01),
      },
      uncapped: {
        startsAfterMs: 2n * 60_000n,
        access: {
          kind: "anyone",
          maxParticipants: 5n,
          minCommitment: coins(0.01),
        },
        hardCap: true,
      },
    }),
  });
  saveSale("e027-open", record);
  const opened = event(executed, "PresaleOpened");

  await commit("p1 commits its 0.012 cap", record, w.p1, coins(0.012), "open");
  await commit("p2 commits 0.01", record, w.p2, coins(0.01), "open");
  await expectAbort(
    "p4 uses the anyone route before the phase",
    w.p4,
    commitTx(record, w.p4, coins(0.02), "uncapped"),
    { module: "blast_presale", code: 24 },
  );

  await waitUntil(u64(opened.uncapped_from_ms), "the open-to-anyone phase");
  await expectAbort(
    "p4 below the phase minimum without filling the raise",
    w.p4,
    commitTx(record, w.p4, coins(0.005), "uncapped"),
    { module: "blast_presale", code: 20 },
  );
  const fill = await commit(
    "p4 offers 0.02 when 0.008 remains",
    record,
    w.p4,
    coins(0.02),
    "uncapped",
  );
  equal(
    "only 0.008 accepted",
    u64(event(fill, "Committed").quote),
    coins(0.008),
  );
  await expectAbort(
    "p5 after the hard cap filled",
    w.p5,
    commitTx(record, w.p5, coins(0.01), "uncapped"),
    { module: "blast_presale", code: 25 },
  );
  await expectAbort(
    "p1 through the open route after the hard cap filled",
    w.p1,
    commitTx(record, w.p1, coins(0.001), "open"),
    { module: "blast_presale", code: 25 },
  );

  await settleMigrateAndClaim(record, u64(opened.end_ms), [
    [w.p1, coins(0.012)],
    [w.p2, coins(0.01)],
    [w.p4, coins(0.008)],
  ]);
}

async function allowlistSale(): Promise<void> {
  const w = wallets();
  const allowlist = buildAllowlist([
    { wallet: w.p1.toSuiAddress(), walletCap: coins(0.01) },
    { wallet: w.p2.toSuiAddress(), walletCap: coins(0.01) },
  ]);
  const leaf = (index: number) => ({
    allowlist: allowlist.proofs[index] as (typeof allowlist.proofs)[number],
  });
  const { record, executed } = await createSale({
    scenario: "E2E-027 allowlist",
    letter: "N",
    creator: w.creator,
    venue: "bluefin",
    quoteType: SUI,
    terms: defaultTerms({
      raiseTarget: coins(0.03),
      durationMs: 4n * 60_000n,
      eligibility: {
        kind: "allowlisted",
        root: allowlist.root,
        leafCount: allowlist.leafCount,
      },
      uncapped: {
        startsAfterMs: 2n * 60_000n,
        access: {
          kind: "anyone",
          maxParticipants: 4n,
          minCommitment: coins(0.015),
        },
        hardCap: true,
      },
    }),
  });
  saveSale("e027-allowlist", record);
  const opened = event(executed, "PresaleOpened");

  await commit("p1 commits its 0.01 leaf", record, w.p1, coins(0.01), leaf(0));
  await expectAbort(
    "unlisted p3 before the phase",
    w.p3,
    commitTx(record, w.p3, coins(0.015), "uncapped"),
    { module: "blast_presale", code: 24 },
  );

  await waitUntil(u64(opened.uncapped_from_ms), "the open-to-anyone phase");
  await expectAbort(
    "unlisted p3 below the phase minimum",
    w.p3,
    commitTx(record, w.p3, coins(0.01), "uncapped"),
    { module: "blast_presale", code: 20 },
  );
  await commit(
    "unlisted p3 commits 0.015",
    record,
    w.p3,
    coins(0.015),
    "uncapped",
  );
  const fill = await commit(
    "listed p2 offers 0.01 when 0.005 remains",
    record,
    w.p2,
    coins(0.01),
    leaf(1),
  );
  equal(
    "only 0.005 accepted",
    u64(event(fill, "Committed").quote),
    coins(0.005),
  );
  equal(
    "p2 pays only 0.005",
    balanceChange(fill, w.p2.toSuiAddress(), SUI) <= -coins(0.005),
    true,
  );
  await expectAbort(
    "p4 after the hard cap filled",
    w.p4,
    commitTx(record, w.p4, coins(0.015), "uncapped"),
    { module: "blast_presale", code: 25 },
  );

  await settleMigrateAndClaim(record, u64(opened.end_ms), [
    [w.p1, coins(0.01)],
    [w.p3, coins(0.015)],
    [w.p2, coins(0.005)],
  ]);
}

async function settleMigrateAndClaim(
  record: SaleRecord,
  endMs: bigint,
  commitments: [ReturnType<typeof wallets>["p1"], bigint][],
): Promise<void> {
  const w = wallets();
  await waitUntil(endMs, `${record.scenario} window end`);
  const keeper = new Transaction();
  addSettle(keeper, record);
  addMigrate(keeper, record);
  const migrated = await exec(
    `relayer settles and migrates ${record.scenario} to Bluefin`,
    w.relayer,
    keeper,
  );
  equal(
    "exactly the raise, no overflow",
    u64(event(migrated, "PresaleFunded").refundable_quote),
    0n,
  );
  equal(
    "Bluefin LP takes the SUI raise",
    u64(event(migrated, "PresaleMigrated").liquidity_quote),
    coins(0.03),
  );
  const done = recordMigration(record, migrated);
  saveSale(
    record.scenario === "E2E-027 open policy" ? "e027-open" : "e027-allowlist",
    done,
  );

  const claimed = await exec(
    "relayer claims for every participant",
    w.relayer,
    claimTx(
      done,
      commitments.map(([key]) => key.toSuiAddress()),
    ),
  );
  let total = 0n;
  for (const [i, [key, amount]] of commitments.entries()) {
    const got = balanceChange(claimed, key.toSuiAddress(), done.memeType);
    total += got;
    if (i < commitments.length - 1) {
      equal(
        `participant ${i} tokens`,
        got,
        (SALE_TOKENS * amount) / coins(0.03),
      );
    }
    equal(
      `participant ${i} no SUI refund`,
      balanceChange(claimed, key.toSuiAddress(), SUI),
      0n,
    );
  }
  equal("every sale token delivered", total, SALE_TOKENS);
}
