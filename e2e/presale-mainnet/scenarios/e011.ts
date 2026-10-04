/**
 * E2E-011: an open sale that overflows, raising tiny SUI amounts and migrating
 * to Cetus. Claims pay pro-rata tokens and refund the overflow.
 */
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { cetusMemeSide } from "../../../src/presale/index.ts";
import {
  balanceChange,
  equal,
  event,
  exec,
  expectAbort,
  single,
  waitUntil,
} from "../chain.ts";
import {
  BLUEFIN,
  CETUS,
  DEPLOYMENT,
  presale,
  SUI,
  TEST_SUI,
  wallets,
} from "../env.ts";
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
  mut,
  quoteCurrency,
  recordMigration,
  sale,
  saveSale,
  types,
  u64,
} from "../sale.ts";
import { assertSealed, residualChecks } from "./shared.ts";

const SUPPLY = coins(1_000_000_000);
const SALE_TOKENS = (SUPPLY * 6_000n) / 10_000n;
const RAISE = coins(0.02);
const EACH = coins(0.01);

export async function e011(phase?: string): Promise<void> {
  const w = wallets();
  if (phase === "residuals") {
    return residualChecks(sale("e011"), sale("e010").capId);
  }
  const participants = [w.p1, w.p2, w.p3, w.p4, w.p5];
  const { record, executed } = await createSale({
    scenario: "E2E-011",
    letter: "B",
    creator: w.creator,
    venue: "cetus",
    terms: defaultTerms({
      raiseTarget: RAISE,
      durationMs: 3n * 60_000n,
      eligibility: {
        kind: "open",
        walletCap: EACH,
        maxParticipants: 6n,
        minCommitment: coins(0.004),
      },
      feeRecipients: [
        { recipient: w.creator.toSuiAddress(), bps: 5_000n },
        { recipient: w.r1.toSuiAddress(), bps: 3_000n },
      ],
      holderRewardsBps: 2_000n,
    }),
  });
  saveSale("e011", record);
  await assertSealed(record, "Fixed");
  const end = u64(event(executed, "PresaleOpened").end_ms);

  for (const [i, key] of participants.entries()) {
    await commit(`p${i + 1} commits 0.01 SUI`, record, key, EACH, "open");
  }

  await waitUntil(end, "E2E-011 window end");
  await expectAbort(
    "commit after the window",
    w.p6,
    commitTx(record, w.p6, EACH, "open"),
    { module: "blast_presale", code: 6 },
  );
  const settled = await exec(
    "relayer settles",
    w.relayer,
    single((tx) => addSettle(tx, record)),
  );
  equal(
    "overflow refundable",
    u64(event(settled, "PresaleFunded").refundable_quote),
    5n * EACH - RAISE,
  );

  // Wrong venue and wrong Cetus type arguments, all before the real migration.
  await expectAbort(
    "Bluefin migrates a Cetus sale",
    w.relayer,
    single((tx) => {
      const [fee] = tx.splitCoins(tx.gas, [0n]);
      tx.add(
        presale.call.migrateBluefin({
          ...types(record),
          presale: mut(record.presale),
          memeCurrency: imm(record.currency),
          quoteCurrency: imm(quoteCurrency(record)),
          bluefinConfig: mut(BLUEFIN.config),
          creationFee: fee as TransactionArgument,
        }),
      );
    }),
    { module: "blast_presale", code: 19 },
  );
  const memeIsA = cetusMemeSide(record.memeType, SUI) === "a";
  const [coinA, coinB] = memeIsA
    ? [record.memeType, SUI]
    : [SUI, record.memeType];
  await expectAbort(
    "Cetus migrate with coins out of order",
    w.relayer,
    rawCetusMigrate(record, [coinB, coinA]),
    { module: "cetus", code: 0, package: DEPLOYMENT.packageId },
  );
  const otherA =
    cetusMemeSide(TEST_SUI, SUI) === "a" ? [TEST_SUI, SUI] : [SUI, TEST_SUI];
  await expectAbort(
    "Cetus migrate with another pair",
    w.relayer,
    rawCetusMigrate(record, otherA as [string, string]),
    { module: "cetus", code: 2, package: DEPLOYMENT.packageId },
  );

  const migrate = new Transaction();
  addMigrate(migrate, record);
  const migrated = await exec("relayer migrates to Cetus", w.relayer, migrate);
  equal(
    "Cetus LP takes the whole raise",
    u64(event(migrated, "PresaleMigrated").liquidity_quote),
    RAISE,
  );
  const done = recordMigration(record, migrated);
  saveSale("e011", done);
  equal("Cetus pool recorded", Boolean(done.pool), true);

  const claimed = await exec(
    "relayer claims for all five",
    w.relayer,
    claimTx(
      done,
      participants.map((key) => key.toSuiAddress()),
    ),
  );
  let tokens = 0n;
  let refunds = 0n;
  for (const [i, key] of participants.entries()) {
    const got = balanceChange(claimed, key.toSuiAddress(), done.memeType);
    const refund = balanceChange(claimed, key.toSuiAddress(), SUI);
    tokens += got;
    refunds += refund;
    if (i < participants.length - 1) {
      equal(`p${i + 1} tokens`, got, SALE_TOKENS / 5n);
      equal(`p${i + 1} overflow refund`, refund, (5n * EACH - RAISE) / 5n);
    }
  }
  equal("all sale tokens delivered", tokens, SALE_TOKENS);
  equal("all overflow refunded", refunds, 5n * EACH - RAISE);
  await residualChecks(done, sale("e010").capId);
}

/** `cetus::migrate` with explicit coin type arguments, bypassing the SDK's ordering. */
function rawCetusMigrate(
  record: ReturnType<typeof sale>,
  [coinA, coinB]: [string, string],
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${DEPLOYMENT.packageId}::cetus::migrate`,
    typeArguments: [record.memeType, record.quoteType, coinA, coinB],
    arguments: [
      tx.sharedObjectRef({ ...record.presale, mutable: true }),
      tx.sharedObjectRef({ ...DEPLOYMENT.feePolicy, mutable: false }),
      tx.sharedObjectRef({ ...DEPLOYMENT.venueConfig, mutable: false }),
      tx.sharedObjectRef({ ...CETUS.config, mutable: false }),
      tx.sharedObjectRef({ ...CETUS.pools, mutable: true }),
      tx.sharedObjectRef({ ...CETUS.burnManager, mutable: true }),
      tx.object.clock(),
    ],
  });
  return tx;
}
