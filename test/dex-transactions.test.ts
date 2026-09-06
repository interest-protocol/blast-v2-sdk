import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiObjectId } from "@mysten/sui/utils";
import {
  AutoLpCalls,
  AutoLpTransactions,
} from "../src/auto-lp/transactions.ts";
import { DexCalls, DexTransactions } from "../src/dex/transactions.ts";

const deployment = {
  packageId: "0xd",
  originalPackageId: "0xc",
  factory: { objectId: "0xf", initialSharedVersion: "7" },
};
const auto = {
  packageId: "0xa",
  originalPackageId: "0xb",
  control: { objectId: "0x10", initialSharedVersion: "8" },
  dex: deployment,
};
const pair = { memeType: "0x3::m::M", quoteType: "0x2::sui::SUI" };
const trade = {
  ...pair,
  pool: "0x20",
  minimumOutput: 1n,
  maximumFeeBps: 210n,
  deadlineMs: 10_000n,
  recipient: "0x99",
};

test("DEX buy routes net output and refund and binds immutable factory plus signed limits", () => {
  const tx = new DexTransactions(deployment).buy({
    ...trade,
    quoteAmount: 1_022n,
  });
  const calls = tx
    .getData()
    .commands.filter((c) => c.$kind === "MoveCall")
    .map((c) => c.MoveCall);
  assert.equal(calls[0]?.function, "buy");
  assert.equal(calls[0]?.arguments.length, 7);
  assert.equal(tx.getData().commands.at(-1)?.$kind, "TransferObjects");
  assert.ok(
    tx
      .getData()
      .inputs.some(
        (i) =>
          i.Object?.SharedObject?.objectId === normalizeSuiObjectId("0xf") &&
          i.Object.SharedObject.mutable === false,
      ),
  );
  const transfer = tx.getData().commands.at(-1);
  assert.equal(transfer?.TransferObjects?.objects.length, 2);
});

test("DEX burn swap uses Currency and native migration writes the factory", () => {
  const tx = new DexTransactions(deployment).sell({
    ...trade,
    memeAmount: 500n,
    currency: "0x21",
  });
  const call = tx
    .getData()
    .commands.find((c) => c.$kind === "MoveCall")?.MoveCall;
  assert.equal(call?.function, "sell_and_burn");
  assert.equal(call?.arguments.length, 8);
  const migration = new Transaction();
  migration.add(
    new DexCalls(deployment).migrate({
      ...pair,
      launch: "0x22",
      packageVersion: "0x23",
      currency: "0x21",
    }),
  );
  assert.equal(migration.getData().commands[0]?.MoveCall?.module, "migration");
  assert.ok(
    migration
      .getData()
      .inputs.some((i) => i.Object?.SharedObject?.mutable === true),
  );
});

test("AutoLP enrollment composes CreatorCap custody and share with immutable executor", () => {
  const tx = new AutoLpTransactions(auto).enroll({
    ...pair,
    creatorCap: "0x30",
    pool: "0x20",
    executor: "0x99",
  });
  const calls = tx.getData().commands.map((c) => c.MoveCall);
  assert.deepEqual(
    calls.map((c) => c?.function),
    ["new", "share"],
  );
  assert.equal(calls[0]?.arguments.length, 5);
  assert.equal(
    tx.getData().commands.some((c) => c.$kind === "TransferObjects"),
    false,
  );
  assert.throws(
    () =>
      new AutoLpTransactions(auto).enroll({
        ...pair,
        creatorCap: "0x30",
        pool: "0x20",
        executor: "0x0",
      }),
    /zero/,
  );
});

test("AutoLP compound requires caller-supplied limits and performs no swaps or payouts", () => {
  const tx = new AutoLpTransactions(auto).compound({
    ...pair,
    vault: "0x40",
    pool: "0x20",
    maximumMeme: 10n,
    maximumQuote: 20n,
    minimumShares: 5n,
    deadlineMs: 1_000n,
  });
  assert.deepEqual(
    tx.getData().commands.map((c) => c.MoveCall?.function),
    ["compound"],
  );
  assert.equal(tx.getData().commands[0]?.MoveCall?.arguments.length, 9);
  const data = tx.getData();
  const args = data.commands[0]?.MoveCall?.arguments.slice(4, 8);
  assert.ok(args);
  const signed = args.map((arg, index) => {
    assert.ok("Input" in arg);
    const input = data.inputs[arg.Input];
    assert.ok(input?.Pure);
    return BigInt(
      (index === 2 ? bcs.u128() : bcs.u64()).parse(
        fromBase64(input.Pure.bytes),
      ),
    );
  });
  assert.deepEqual(signed, [10n, 20n, 5n, 1_000n]);
  const calls = new AutoLpCalls(auto);
  const collect = new Transaction();
  collect.add(
    calls.collectCurve({
      ...pair,
      vault: "0x40",
      launch: "0x22",
      packageVersion: "0x23",
    }),
  );
  collect.add(
    calls.collectNativeLp({ ...pair, vault: "0x40", source: "0x41" }),
  );
  assert.deepEqual(
    collect.getData().commands.map((c) => c.MoveCall?.function),
    ["collect_curve", "collect_native_lp"],
  );
});

test("short coin types select canonical coin intents for pool creation and liquidity deposits", () => {
  const builders = new DexTransactions(deployment);
  const transactions = [
    builders.create({
      ...pair,
      creatorCap: "0x30",
      launch: "0x31",
      currency: "0x32",
      memeAmount: 10_000n,
      quoteAmount: 20_000n,
      burnBps: 0n,
      recipient: "0x99",
    }),
    builders.addLiquidity({
      ...pair,
      pool: "0x20",
      position: "0x21",
      memeMaximum: 10_000n,
      quoteMaximum: 20_000n,
      minimumShares: 1n,
      deadlineMs: 1_000n,
      recipient: "0x99",
    }),
  ];
  for (const tx of transactions) {
    const intents = tx
      .getData()
      .commands.flatMap((c) => (c.$Intent ? [c.$Intent.data.type] : []));
    assert.deepEqual(intents, [`${normalizeSuiObjectId("0x3")}::m::M`, "gas"]);
  }
});
