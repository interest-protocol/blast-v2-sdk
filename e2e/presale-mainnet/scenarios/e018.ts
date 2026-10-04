/**
 * E2E-018: vested and unvested token and raise recipients. Migration pays the
 * unvested shares at once and locks each vested share in its own shared,
 * irrevocable schedule; beneficiaries claim it step by step.
 */
import { Transaction } from "@mysten/sui/transactions";
import type { Executed } from "../chain.ts";
import {
  balanceChange,
  check,
  createdAll,
  equal,
  event,
  events,
  exec,
  expectAbort,
  sharedVersion,
  single,
  waitUntil,
} from "../chain.ts";
import { DEPLOYMENT, wallets } from "../env.ts";
import {
  addMigrate,
  addSettle,
  claimTx,
  coins,
  commit,
  createSale,
  defaultTerms,
  recordMigration,
  saveSale,
  u64,
} from "../sale.ts";

/** blast_fun_vesting as linked by the presale package (deployment record). */
const VESTING =
  "0x85fdb7e3d28162b99e0df758069a3d23cff874c400b2160fc0d4618aefd3ec5c";
const SUPPLY = coins(1_000_000_000);

type Schedule = {
  id: string;
  initialSharedVersion: string;
  coinType: string;
  beneficiary: string;
  total: bigint;
  startMs: bigint;
  cliffMs: bigint;
  periodMs: bigint;
  periods: bigint;
};

export async function e018(): Promise<void> {
  const w = wallets();
  await expectAbort(
    "vesting terms with a zero period",
    w.creator,
    single((tx) =>
      tx.moveCall({
        target: `${DEPLOYMENT.packageId}::blast_presale::vesting_terms`,
        arguments: [tx.pure.u64(0), tx.pure.u64(0), tx.pure.u64(1)],
      }),
    ),
    { module: "blast_presale", code: 27 },
  );
  await expectAbort(
    "vesting terms with a cliff past the end",
    w.creator,
    single((tx) =>
      tx.moveCall({
        target: `${DEPLOYMENT.packageId}::blast_presale::vesting_terms`,
        arguments: [tx.pure.u64(100_000), tx.pure.u64(10_000), tx.pure.u64(2)],
      }),
    ),
    { module: "blast_presale", code: 27 },
  );

  const tokenVesting = { cliffMs: 30_000n, periodMs: 30_000n, periods: 4n };
  const raiseVesting = { cliffMs: 60_000n, periodMs: 20_000n, periods: 3n };
  const { record, executed } = await createSale({
    scenario: "E2E-018",
    letter: "J",
    creator: w.creator,
    venue: "bluefin",
    terms: defaultTerms({
      tokenAllocationBps: 5_000n,
      liquidityTokenAllocationBps: 4_000n,
      recipientAllocations: [
        { recipient: w.r1.toSuiAddress(), bps: 500n, vesting: tokenVesting },
        { recipient: w.r2.toSuiAddress(), bps: 500n },
      ],
      raiseTarget: coins(100),
      raiseAllocations: [
        { recipient: w.r3.toSuiAddress(), bps: 2_000n, vesting: raiseVesting },
        { recipient: w.r1.toSuiAddress(), bps: 1_000n },
      ],
      durationMs: 3n * 60_000n,
    }),
  });
  saveSale("e018", record);
  await commit("p1 commits 50", record, w.p1, coins(50), "open");
  await commit("p2 commits 50", record, w.p2, coins(50), "open");

  await waitUntil(
    u64(event(executed, "PresaleOpened").end_ms),
    "E2E-018 window end",
  );
  const keeper = new Transaction();
  addSettle(keeper, record);
  addMigrate(keeper, record);
  const migrated = await exec(
    "relayer settles and migrates",
    w.relayer,
    keeper,
  );
  saveSale("e018", recordMigration(record, migrated));

  const tokenShare = (SUPPLY * 500n) / 10_000n;
  equal(
    "r2 paid its tokens at once",
    balanceChange(migrated, w.r2.toSuiAddress(), record.memeType),
    tokenShare,
  );
  equal(
    "r1 paid its raise share at once",
    balanceChange(migrated, w.r1.toSuiAddress(), record.quoteType),
    coins(10),
  );
  equal(
    "r1 tokens not paid out",
    balanceChange(migrated, w.r1.toSuiAddress(), record.memeType),
    0n,
  );
  equal(
    "r3 Quote not paid out",
    balanceChange(migrated, w.r3.toSuiAddress(), record.quoteType),
    0n,
  );
  const allocated = events(migrated, "RecipientAllocated");
  const raised = events(migrated, "RaiseAllocated");
  check(
    "r1 token share names a schedule",
    allocated.some((e) => e.recipient === w.r1.toSuiAddress() && e.vesting_id),
  );
  check(
    "r2 token share has none",
    allocated.some((e) => e.recipient === w.r2.toSuiAddress() && !e.vesting_id),
  );
  check(
    "r3 raise share names a schedule",
    raised.some((e) => e.recipient === w.r3.toSuiAddress() && e.vesting_id),
  );
  equal(
    "LP Quote after recipients",
    u64(event(migrated, "PresaleMigrated").liquidity_quote),
    coins(70),
  );

  const schedules = vestingSchedules(migrated);
  equal("two schedules created", schedules.length, 2);
  const tokens = schedules.find(
    (s) => s.beneficiary === w.r1.toSuiAddress(),
  ) as Schedule;
  const quote = schedules.find(
    (s) => s.beneficiary === w.r3.toSuiAddress(),
  ) as Schedule;
  equal("token schedule holds r1's share", tokens.total, tokenShare);
  equal("raise schedule holds r3's 20", quote.total, coins(20));
  equal(
    "token schedule terms",
    `${tokens.cliffMs}/${tokens.periodMs}/${tokens.periods}`,
    "30000/30000/4",
  );

  await expectAbort("r1 claims before the cliff", w.r1, claim(tokens), {
    module: "blast_fun_linear_vesting",
    code: 7,
  });
  await waitUntil(tokens.startMs + 30_000n, "the token cliff");
  const first = event(
    await exec("r1 claims after the cliff", w.r1, claim(tokens)),
    "VestingClaimed",
  );
  const steps = [1n, 2n, 3n].map((k) => (tokens.total * k) / 4n);
  check(
    "first claim is a whole number of steps",
    steps.includes(u64(first.released_total)),
    first,
  );
  await expectAbort(
    "r3 claims before its cliff, which is the end",
    w.r3,
    claim(quote),
    {
      module: "blast_fun_linear_vesting",
      code: 7,
    },
  );

  await waitUntil(quote.startMs + 60_000n, "the raise schedule end");
  const all = event(
    await exec("r3 claims everything at its cliff", w.r3, claim(quote)),
    "VestingClaimed",
  );
  equal("r3 released all 20", u64(all.released_total), coins(20));

  await waitUntil(tokens.startMs + 120_000n, "the token schedule end");
  const last = event(
    await exec("r1 claims the rest", w.r1, claim(tokens)),
    "VestingClaimed",
  );
  equal("r1 released its whole share", u64(last.released_total), tokens.total);
  await expectAbort("r1 claims a drained schedule", w.r1, claim(tokens), {
    module: "blast_fun_linear_vesting",
    code: 7,
  });
  await exec(
    "anyone closes the drained schedule",
    w.relayer,
    single((tx) =>
      tx.moveCall({
        target: `${VESTING}::blast_fun_linear_vesting::close_irrevocable`,
        typeArguments: [tokens.coinType],
        arguments: [
          tx.sharedObjectRef({
            objectId: tokens.id,
            initialSharedVersion: tokens.initialSharedVersion,
            mutable: true,
          }),
        ],
      }),
    ),
  );

  const claimed = await exec(
    "relayer claims p1 and p2",
    w.relayer,
    claimTx(record, [w.p1.toSuiAddress(), w.p2.toSuiAddress()]),
  );
  equal(
    "buyers share 50% of supply",
    balanceChange(claimed, w.p1.toSuiAddress(), record.memeType) +
      balanceChange(claimed, w.p2.toSuiAddress(), record.memeType),
    (SUPPLY * 5_000n) / 10_000n,
  );
}

function vestingSchedules(executed: Executed): Schedule[] {
  const created = events(executed, "VestingCreated");
  const ids = createdAll(executed, /::blast_fun_linear_vesting::Vesting</);
  return created.map((entry) => {
    const id = String(entry.vesting_id);
    if (!ids.includes(id)) throw new Error(`schedule ${id} not created here`);
    const type = executed.objectTypes?.[id] ?? "";
    return {
      id,
      initialSharedVersion: sharedVersion(executed, id),
      coinType: type.slice(type.indexOf("<") + 1, -1),
      beneficiary: String(entry.beneficiary),
      total: u64(entry.total_amount),
      startMs: u64(entry.start_ms),
      cliffMs: u64(entry.cliff_ms),
      periodMs: u64(entry.period_ms),
      periods: u64(entry.periods),
    };
  });
}

function claim(schedule: Schedule): Transaction {
  return single((tx) =>
    tx.moveCall({
      target: `${VESTING}::blast_fun_linear_vesting::claim`,
      typeArguments: [schedule.coinType],
      arguments: [
        tx.sharedObjectRef({
          objectId: schedule.id,
          initialSharedVersion: schedule.initialSharedVersion,
          mutable: true,
        }),
        tx.object.clock(),
      ],
    }),
  );
}
