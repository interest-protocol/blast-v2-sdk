import assert from "node:assert/strict";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";

import { BlastSuiClient } from "../src/blast-sui/client.ts";
import { BlastSuiTransactions } from "../src/blast-sui/transactions.ts";
import type { BlastSuiDeployment } from "../src/blast-sui/types.ts";
import { LaunchpadClient } from "../src/launchpad/client.ts";
import type { LaunchpadDeployment } from "../src/launchpad/transactions.ts";
import { LaunchpadTransactions } from "../src/launchpad/transactions.ts";
import type { CoinSourceOptions } from "../src/lib/coins.ts";
import type { SharedObjectReference } from "../src/lib/sui.ts";
import { MigratorsClient } from "../src/migrators/client.ts";
import type { MigratorsDeployment } from "../src/migrators/transactions.ts";
import { MigratorTransactions } from "../src/migrators/transactions.ts";
import { PresaleClient } from "../src/presale/client.ts";
import type { PresaleDeployment } from "../src/presale/transactions.ts";
import { PresaleTransactions } from "../src/presale/transactions.ts";

function shared<const Mutable extends boolean>(
  objectId: string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion: "3", mutable };
}

const SUI = normalizeStructTag("0x2::sui::SUI");
const USDC = normalizeStructTag("0xdba::usdc::USDC");
const SENDER = `0x${"a1".repeat(32)}`;
const SPONSOR = `0x${"5b".repeat(32)}`;
const admin = { packageId: "0xad", acl: shared("0xac", false) };
const launchpad: LaunchpadDeployment = {
  packageId: "0x123",
  originalPackageId: "0x122",
  partnersPackageId: "0xae",
  timelockPackageId: "0xaf",
  packageVersion: shared("0x2", false),
  launchConfig: shared("0x3", false),
  runtimeConfig: shared("0x4", false),
  admin,
};
const blastSui: BlastSuiDeployment = {
  packageId: "0x223",
  originalPackageId: "0x222",
  packageVersion: shared("0x10", false),
  vault: shared("0x11", true),
  admin,
};
const migrators: MigratorsDeployment = {
  packageId: "0x321",
  originalPackageId: "0x320",
  launchpad,
  migratorsVersion: shared("0x61", false),
  lpFeePolicy: shared("0x40", false),
  venueConfig: shared("0x60", false),
};
const presale: PresaleDeployment = {
  packageId: "0x5f",
  originalPackageId: "0x5e",
  venueConfig: shared("0x60", false),
  feePolicy: shared("0x61", false),
  creationPolicy: shared("0x62", false),
  admin,
};

const launchSettings = {
  memeType: "0xa::meme::MEME",
  virtualQuote: 1_000n,
  graduationTarget: 3_000n,
  creationFee: 1_001n,
  allocationPlan: {
    curveMemeBps: 8_000n,
    lpMemeBps: 1_900n,
    lpQuoteBps: 9_900n,
    recipients: [],
  },
  lpFeeSplit: {
    creatorBps: 5_000n,
    autoLpBps: 2_000n,
    rewardsBps: 1_000n,
    burnBps: 1_000n,
    recipients: [{ destination: "0xf", bps: 1_000n }],
  },
  ticket: "0xb",
  memeCurrency: shared("0xd", true),
  tickSpacing: 200,
};
const bluefinMigration = {
  memeType: "0xa::meme::MEME",
  memeCurrency: shared("0xd", true),
  quoteCurrency: shared("0xe", false),
  bluefinConfig: shared("0x80", true),
  creationFee: 5_000_000n,
};

/** Builders of every SUI-spending SDK transaction, under one coin source. */
function builders(construct: CoinSourceOptions) {
  const sui = { quoteType: SUI };
  const blast = new BlastSuiTransactions(blastSui, construct);
  const launch = new LaunchpadTransactions(launchpad, construct);
  const migrator = new MigratorTransactions(migrators, construct);
  const sale = new PresaleTransactions(presale, construct);
  return {
    mintFunSui: (o: CoinSourceOptions) =>
      blast.mintFunSui({ amount: 1n, recipient: "0xe", ...o }),
    requestBlastSui: (o: CoinSourceOptions) =>
      blast.requestBlastSui({ amount: 1n, ...o }),
    donateSui: (o: CoinSourceOptions) => blast.donateSui({ amount: 1n, ...o }),
    buy: (o: CoinSourceOptions) =>
      launch.buy({
        ...sui,
        memeType: "0xa::meme::MEME",
        launch: shared("0xc", true),
        quoteAmount: 1n,
        minMemeOut: 0n,
        recipient: "0xe",
        ...o,
      }),
    joinOpeningRound: (o: CoinSourceOptions) =>
      launch.joinOpeningRound({
        ...sui,
        memeType: "0xa::meme::MEME",
        launch: shared("0xc", true),
        quoteAmount: 1n,
        ...o,
      }),
    createCetusLaunch: (o: CoinSourceOptions) =>
      migrator.createCetusLaunch({
        ...sui,
        ...launchSettings,
        cetusConfig: shared("0x70", false),
        cetusPools: shared("0x71", true),
        preShareBuy: { quoteAmount: 100n, minMemeOut: 1n, recipient: "0xe" },
        ...o,
      }),
    createBluefinLaunch: (o: CoinSourceOptions) =>
      migrator.createBluefinLaunch({
        ...sui,
        ...launchSettings,
        feeRate: 10_000n,
        ...o,
      }),
    migrateLaunchBluefin: (o: CoinSourceOptions) =>
      migrator.migrateBluefin({
        ...sui,
        ...bluefinMigration,
        launch: shared("0xc", true),
        ...o,
      }),
    commit: (o: CoinSourceOptions) =>
      sale.commit({
        ...sui,
        memeType: "0xa::meme::MEME",
        presale: shared("0xab", true),
        amount: 1n,
        recipient: "0xe",
        route: "open",
        ...o,
      }),
    migratePresaleBluefin: (o: CoinSourceOptions) =>
      sale.migrateBluefin({
        ...sui,
        ...bluefinMigration,
        memeCurrency: shared("0xd", false),
        presale: shared("0xab", true),
        ...o,
      }),
  };
}

/** The coin type of each `CoinWithBalance` intent: `"gas"` splits the gas coin. */
function coinSources(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "$Intent" && command.$Intent.name === "CoinWithBalance"
        ? [String(command.$Intent.data.type)]
        : [],
    );
}

const SUI_COIN_COUNTS = {
  mintFunSui: 1,
  requestBlastSui: 1,
  donateSui: 1,
  buy: 1,
  joinOpeningRound: 1,
  // The creation fee and the pre-share purchase.
  createCetusLaunch: 2,
  createBluefinLaunch: 1,
  migrateLaunchBluefin: 1,
  commit: 1,
  migratePresaleBluefin: 1,
};

test("by default SUI may come from the gas coin, as in @mysten/sui", () => {
  for (const [name, build] of Object.entries(builders({}))) {
    const count = SUI_COIN_COUNTS[name as keyof typeof SUI_COIN_COUNTS];
    assert.deepEqual(coinSources(build({})), Array(count).fill("gas"), name);
  }
});

test("useGasCoin: false at construction keeps every builder off the gas coin", () => {
  for (const [name, build] of Object.entries(builders({ useGasCoin: false }))) {
    const count = SUI_COIN_COUNTS[name as keyof typeof SUI_COIN_COUNTS];
    assert.deepEqual(coinSources(build({})), Array(count).fill(SUI), name);
  }
});

test("a per-call useGasCoin overrides the builder's", () => {
  const sponsored = builders({ useGasCoin: false });
  const selfPaid = builders({});
  for (const name of Object.keys(SUI_COIN_COUNTS)) {
    const key = name as keyof typeof SUI_COIN_COUNTS;
    const count = SUI_COIN_COUNTS[key];
    assert.deepEqual(
      coinSources(sponsored[key]({ useGasCoin: true })),
      Array(count).fill("gas"),
      name,
    );
    assert.deepEqual(
      coinSources(selfPaid[key]({ useGasCoin: false })),
      Array(count).fill(SUI),
      name,
    );
  }
});

test("a non-SUI quote never touches the gas coin either way", () => {
  const launch = new LaunchpadTransactions(launchpad);
  const tx = launch.buy({
    memeType: "0xa::meme::MEME",
    quoteType: USDC,
    launch: shared("0xc", true),
    quoteAmount: 1n,
    minMemeOut: 0n,
    recipient: "0xe",
    useGasCoin: true,
  });
  assert.deepEqual(coinSources(tx), [USDC]);
});

test("each client passes its coin source to its builders", () => {
  const client = {} as ClientWithCoreApi;
  const off = { useGasCoin: false };
  const sui = { quoteType: SUI, memeType: "0xa::meme::MEME" };
  assert.deepEqual(
    coinSources(
      new BlastSuiClient(client, blastSui, off).tx.donateSui({ amount: 1n }),
    ),
    [SUI],
  );
  assert.deepEqual(
    coinSources(
      new LaunchpadClient(client, launchpad, off).tx.joinOpeningRound({
        ...sui,
        launch: shared("0xc", true),
        quoteAmount: 1n,
      }),
    ),
    [SUI],
  );
  assert.deepEqual(
    coinSources(
      new MigratorsClient(client, migrators, off).tx.migrateBluefin({
        ...sui,
        ...bluefinMigration,
        launch: shared("0xc", true),
      }),
    ),
    [SUI],
  );
  assert.deepEqual(
    coinSources(
      new PresaleClient(client, presale, off).tx.commit({
        ...sui,
        presale: shared("0xab", true),
        amount: 1n,
        recipient: "0xe",
        route: "open",
      }),
    ),
    [SUI],
  );
});

/** A node where the sender holds one SUI coin and no address balance. */
function senderWithOneCoin(): ClientWithCoreApi {
  const core = {
    resolveTransactionPlugin: () => undefined,
    getCurrentSystemState: async () => ({
      systemState: { referenceGasPrice: "1000", epoch: "900" },
    }),
    getChainIdentifier: async () => ({
      chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
    }),
    getBalance: async () => ({
      balance: {
        coinType: SUI,
        balance: "1000000000",
        coinBalance: "1000000000",
        addressBalance: "0",
      },
    }),
    listCoins: async () => ({
      objects: [
        {
          objectId: `0x${"c0".repeat(32)}`,
          version: "1",
          digest: "11111111111111111111111111111111",
          balance: "1000000000",
        },
      ],
      hasNextPage: false,
      cursor: null,
    }),
  };
  return { core } as unknown as ClientWithCoreApi;
}

/** Builds `tx` for `SENDER` with `SPONSOR`'s gas coin; returns its commands and inputs. */
async function sponsoredBuild(tx: Transaction) {
  tx.setSender(SENDER);
  tx.setGasOwner(SPONSOR);
  tx.setGasBudget(10_000_000n);
  tx.setGasPayment([
    {
      objectId: `0x${"5c".repeat(32)}`,
      version: "1",
      digest: "11111111111111111111111111111111",
    },
  ]);
  const bytes = await tx.build({ client: senderWithOneCoin() });
  const { commands, inputs } = Transaction.from(bytes).getData();
  return { commands: JSON.stringify(commands), inputs: JSON.stringify(inputs) };
}

test("a sponsored build pays SUI from the sender's coin, never the sponsor's gas", async () => {
  const commit = (useGasCoin: boolean) =>
    new PresaleTransactions(presale, { useGasCoin }).commit({
      memeType: "0xa::meme::MEME",
      quoteType: SUI,
      presale: shared("0xab", true),
      amount: 250n,
      recipient: SENDER,
      route: "open",
    });
  const sponsored = await sponsoredBuild(commit(false));
  assert.equal(sponsored.commands.includes('"$kind":"GasCoin"'), false);
  assert.ok(sponsored.inputs.includes("c0".repeat(32)));
  const selfPaid = await sponsoredBuild(commit(true));
  assert.ok(selfPaid.commands.includes('"$kind":"GasCoin"'));
});
