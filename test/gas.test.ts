import assert from "node:assert/strict";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

import { grossGasBudget } from "../src/lib/gas.ts";
import { newTransaction } from "../src/lib/ptb.ts";

const SENDER = `0x${"a1".repeat(32)}`;
const PRICE = 1_000n;
/** 50M MIST of storage, 40M rebated: net 11M, gross 51M. */
const GAS_USED = {
  computationCost: "1000000",
  storageCost: "50000000",
  storageRebate: "40000000",
  nonRefundableStorageFee: "0",
};
const GROSS_BUDGET = 51_000_000n + 51_000_000n / 5n + 10_000n * PRICE;
/** `@mysten/sui`'s own budget: net cost plus 1,000 gas units. */
const DEFAULT_BUDGET = 1_000_000n + 1_000n * PRICE + 50_000_000n - 40_000_000n;

type FakeOptions = {
  addressBalance?: bigint;
  coinBalance?: bigint;
  fails?: boolean;
};

/** A client whose node prices every transaction at `GAS_USED`. */
function fakeClient(options: FakeOptions = {}) {
  const calls = { simulate: 0 };
  const addressBalance = options.addressBalance ?? 1_000_000_000n;
  const coinBalance = options.coinBalance ?? 0n;
  const core = {
    // No node-side resolution: `@mysten/sui` falls back to its own resolver.
    resolveTransactionPlugin: () => undefined,
    getCurrentSystemState: async () => ({
      systemState: { referenceGasPrice: String(PRICE), epoch: "900" },
    }),
    getChainIdentifier: async () => ({
      chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
    }),
    getBalance: async () => ({
      balance: {
        coinType: "0x2::sui::SUI",
        balance: String(addressBalance + coinBalance),
        coinBalance: String(coinBalance),
        addressBalance: String(addressBalance),
      },
    }),
    listCoins: async () => ({
      objects:
        coinBalance > 0n
          ? [
              {
                objectId: `0x${"c0".repeat(32)}`,
                version: "1",
                digest: "11111111111111111111111111111111",
                balance: String(coinBalance),
              },
            ]
          : [],
    }),
    simulateTransaction: async () => {
      calls.simulate += 1;
      return options.fails
        ? {
            $kind: "FailedTransaction",
            FailedTransaction: {
              status: { success: false, error: { message: "MoveAbort" } },
              effects: { gasUsed: GAS_USED },
            },
          }
        : {
            $kind: "Transaction",
            Transaction: { effects: { gasUsed: GAS_USED } },
          };
    },
  };
  return { client: { core } as unknown as ClientWithCoreApi, calls };
}

function transfer(tx: Transaction = newTransaction()): Transaction {
  tx.setSender(SENDER);
  const [coin] = tx.moveCall({
    target: "0x2::coin::zero",
    typeArguments: ["0x2::sui::SUI"],
  });
  tx.transferObjects([coin as never], SENDER);
  return tx;
}

async function builtBudget(tx: Transaction, client: ClientWithCoreApi) {
  const bytes = await tx.build({ client });
  return BigInt(Transaction.from(bytes).getData().gasData.budget ?? 0);
}

test("SDK transactions budget gross cost plus headroom", async () => {
  const { client } = fakeClient();
  assert.equal(await builtBudget(transfer(), client), GROSS_BUDGET);
});

test("without the plugin the budget is @mysten/sui's net estimate", async () => {
  const { client } = fakeClient();
  assert.equal(
    await builtBudget(transfer(new Transaction()), client),
    DEFAULT_BUDGET,
  );
});

test("a budget the caller set is kept and nothing is probed", async () => {
  const { client, calls } = fakeClient();
  const tx = transfer();
  tx.setGasBudget(7_000_000n);
  assert.equal(await builtBudget(tx, client), 7_000_000n);
  assert.equal(calls.simulate, 0);
});

test("a payer that cannot cover the gross budget keeps the default one", async () => {
  const { client } = fakeClient({ addressBalance: GROSS_BUDGET - 1n });
  assert.equal(await builtBudget(transfer(), client), DEFAULT_BUDGET);
});

test("coins alone may cover the gross budget when gas never moves", async () => {
  const { client } = fakeClient({
    addressBalance: 0n,
    coinBalance: GROSS_BUDGET,
  });
  assert.equal(await builtBudget(transfer(), client), GROSS_BUDGET);
});

test("SUI split from gas is set aside before the gross budget", async () => {
  const split = (amount: bigint) => {
    const tx = transfer();
    const [coin] = tx.splitCoins(tx.gas, [amount]);
    tx.transferObjects([coin as never], SENDER);
    return tx;
  };
  const balances = { addressBalance: GROSS_BUDGET, coinBalance: 10n };
  assert.equal(
    await builtBudget(split(10n), fakeClient(balances).client),
    GROSS_BUDGET,
  );
  assert.equal(
    await builtBudget(split(11n), fakeClient(balances).client),
    DEFAULT_BUDGET,
  );
});

test("a failing transaction keeps the default resolver's error", async () => {
  const { client } = fakeClient({ fails: true });
  await assert.rejects(
    transfer().build({ client }),
    /Transaction resolution failed: MoveAbort/,
  );
});

test("a transaction-kind build is untouched", async () => {
  const { client, calls } = fakeClient();
  await transfer().build({ client, onlyTransactionKind: true });
  assert.equal(calls.simulate, 0);
});

test("the plugin is exported for transactions built outside the SDK", async () => {
  const { client } = fakeClient();
  const tx = transfer(new Transaction());
  tx.addBuildPlugin(grossGasBudget());
  assert.equal(await builtBudget(tx, client), GROSS_BUDGET);
});
