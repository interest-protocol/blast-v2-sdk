/**
 * E2E-019: Bluefin-specific gates. Creation rejects a long symbol and bad
 * tiers; a Bluefin sale refuses the Cetus migrator and a wrong creation fee;
 * fee collection refuses any pool but the vault's own.
 */
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { cetusMemeSide } from "../../../src/presale/index.ts";
import {
  created,
  equal,
  event,
  exec,
  expectAbort,
  sharedVersion,
  single,
  waitUntil,
} from "../chain.ts";
import {
  BLUEFIN,
  CETUS,
  DEPLOYMENT,
  presale,
  TEST_SUI,
  wallets,
} from "../env.ts";
import {
  addMigrate,
  addSettle,
  coins,
  commit,
  createSale,
  defaultTerms,
  imm,
  mut,
  newSaleToken,
  recordMigration,
  saveSale,
  types,
  u64,
} from "../sale.ts";

export async function e019(): Promise<void> {
  const w = wallets();
  const create =
    (letter: string, tickSpacing: number, feeRate: bigint) => async () => {
      const token = await newSaleToken(letter, w.creator);
      return presale.tx.createBluefinPresale({
        ...defaultTerms({}),
        memeType: token.memeType,
        quoteType: TEST_SUI,
        treasuryCap: token.treasuryCap,
        memeCurrency: mut(token.currency),
        startMs: 0n,
        capRecipient: w.creator.toSuiAddress(),
        tickSpacing,
        feeRate,
      });
    };
  await expectAbort(
    "a 33-byte symbol",
    w.creator,
    await create("LONG_SYMBOL", 200, 10_000n)(),
    {
      module: "bluefin",
      code: 2,
    },
  );
  for (const [tick, fee] of [
    [0, 10_000n],
    [401, 10_000n],
    [200, 0n],
    [200, 20_001n],
  ] as const) {
    await expectAbort(
      `tier ${tick}/${fee}`,
      w.creator,
      await create("O", tick, fee)(),
      {
        module: "bluefin",
        code: 1,
      },
    );
  }

  const { record, executed } = await createSale({
    scenario: "E2E-019",
    letter: "K",
    creator: w.creator,
    venue: "bluefin",
    terms: defaultTerms({ raiseTarget: coins(50), durationMs: 3n * 60_000n }),
  });
  saveSale("e019", record);
  await commit("p1 commits 50", record, w.p1, coins(50), "open");
  await waitUntil(
    u64(event(executed, "PresaleOpened").end_ms),
    "E2E-019 window end",
  );
  await exec(
    "relayer settles",
    w.relayer,
    single((tx) => addSettle(tx, record)),
  );

  const memeIsA = cetusMemeSide(record.memeType, TEST_SUI) === "a";
  await expectAbort(
    "the Cetus migrator on a Bluefin sale",
    w.relayer,
    single((tx) =>
      tx.moveCall({
        target: `${DEPLOYMENT.packageId}::cetus::migrate`,
        typeArguments: [
          record.memeType,
          record.quoteType,
          ...(memeIsA
            ? [record.memeType, TEST_SUI]
            : [TEST_SUI, record.memeType]),
        ],
        arguments: [
          tx.sharedObjectRef({ ...record.presale, mutable: true }),
          tx.sharedObjectRef({ ...DEPLOYMENT.feePolicy, mutable: false }),
          tx.sharedObjectRef({ ...DEPLOYMENT.venueConfig, mutable: false }),
          tx.sharedObjectRef({ ...CETUS.config, mutable: false }),
          tx.sharedObjectRef({ ...CETUS.pools, mutable: true }),
          tx.sharedObjectRef({ ...CETUS.burnManager, mutable: true }),
          tx.object.clock(),
        ],
      }),
    ),
    { module: "blast_presale", code: 19 },
  );
  const wrongFee = new Transaction();
  addMigrate(wrongFee, record, 1n);
  await expectAbort(
    "a creation fee Bluefin does not charge",
    w.relayer,
    wrongFee,
    {
      message: /MoveAbort/,
    },
  );

  const migrate = new Transaction();
  addMigrate(migrate, record);
  const migrated = await exec(
    "relayer migrates with the exact fee",
    w.relayer,
    migrate,
  );
  const done = recordMigration(record, migrated);
  saveSale("e019", done);

  // A second pool for the same pair, which Bluefin allows; the vault must refuse it.
  const other = await exec(
    "relayer opens a second pool for the same pair",
    w.relayer,
    single((tx) => {
      const [fee] = tx.splitCoins(tx.gas, [0n]);
      tx.moveCall({
        target: `${BLUEFIN.packageId}::gateway::create_pool_v2`,
        typeArguments: [record.memeType, record.quoteType, "0x2::sui::SUI"],
        arguments: [
          tx.object.clock(),
          tx.sharedObjectRef({ ...BLUEFIN.config, mutable: true }),
          tx.pure.vector("u8", [...new TextEncoder().encode("BPTK-TSUI-2")]),
          tx.pure.vector("u8", []),
          tx.pure.vector("u8", [...new TextEncoder().encode("BPTK")]),
          tx.pure.u8(9),
          tx.pure.vector("u8", []),
          tx.pure.vector("u8", [...new TextEncoder().encode("TSUI")]),
          tx.pure.u8(9),
          tx.pure.vector("u8", []),
          tx.pure.u32(60),
          tx.pure.u64(3_000),
          tx.pure.u128(1n << 64n),
          fee as TransactionArgument,
        ],
      });
    }),
  );
  const secondPool = created(other, /::pool::Pool</);
  await expectAbort(
    "collect from a pool that is not the vault's",
    w.relayer,
    single((tx) =>
      tx.add(
        presale.call.collectBluefinFees({
          ...types(done),
          vault: mut(done.vault as NonNullable<typeof done.vault>),
          bluefinConfig: imm(BLUEFIN.config),
          pool: {
            objectId: secondPool,
            initialSharedVersion: sharedVersion(other, secondPool),
            mutable: true,
          },
        }),
      ),
    ),
    { module: "bluefin", code: 0, package: DEPLOYMENT.packageId },
  );
  equal(
    "the vault's own pool differs",
    secondPool !== done.pool?.objectId,
    true,
  );
}
