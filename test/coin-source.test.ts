import assert from "node:assert/strict";
import test from "node:test";
import type { CoinSourceOptions } from "@interest-protocol/blast-core/coins";
import type { SharedObjectReference } from "@interest-protocol/blast-core/sui";
import { LaunchpadClient } from "@interest-protocol/blast-launchpad-sdk/client";
import type { LaunchpadDeployment } from "@interest-protocol/blast-launchpad-sdk/transactions";
import { LaunchpadTransactions } from "@interest-protocol/blast-launchpad-sdk/transactions";
import { PresaleClient } from "@interest-protocol/blast-presale-sdk/client";
import { PresaleTransactions } from "@interest-protocol/blast-presale-sdk/transactions";
import { BlastSuiClient } from "@interest-protocol/blast-sui-sdk/client";
import { BlastSuiTransactions } from "@interest-protocol/blast-sui-sdk/transactions";
import type { BlastSuiDeployment } from "@interest-protocol/blast-sui-sdk/types";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";
import { LAUNCHPAD_DEPLOYMENT } from "./fixtures/launchpad-deployment.ts";
import { PRESALE_DEPLOYMENT } from "./fixtures/presale-deployment.ts";
import { stubVenueCalls } from "./fixtures/venue-stubs.ts";

stubVenueCalls();

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
  ...LAUNCHPAD_DEPLOYMENT,
  originalPackageId: "0x122",
};
const blastSui: BlastSuiDeployment = {
  packageId: "0x223",
  originalPackageId: "0x222",
  packageVersion: shared("0x10", false),
  vault: shared("0x11", true),
  admin,
};
const presale = PRESALE_DEPLOYMENT;

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
    createLaunch: (o: CoinSourceOptions) =>
      launch.createLaunch({
        ...sui,
        memeType: "0xa::meme::MEME",
        ticket: "0x7c",
        treasuryCap: "0x7d",
        venue: "bluefin",
        tier: { tickSpacing: 200, feeRate: 10_000n },
        currency: shared("0xd", true),
        virtualQuote: 1n,
        graduationTarget: 2n,
        allocationPlan: {
          curveMemeBps: 8_000n,
          lpMemeBps: 2_000n,
          lpQuoteBps: 10_000n,
          recipients: [],
        },
        lpFeeSplit: {
          routes: [{ destination: { kind: "Owner" }, bps: 10_000n }],
        },
        creationFee: 5n,
        preShareBuy: { quoteAmount: 1n, minMemeOut: 0n, recipient: "0xe" },
        ...o,
      }),
    migrateLaunchBluefin: (o: CoinSourceOptions) =>
      launch.migrate({
        ...sui,
        memeType: "0xa::meme::MEME",
        launch: shared("0xc", true),
        currency: shared("0xd", true),
        venue: "bluefin",
        quoteCurrency: shared("0xe", false),
        bluefinConfig: shared("0x80", true),
        creationFee: 5_000_000n,
        ...o,
      }),
    commit: (o: CoinSourceOptions) =>
      sale.commit({
        ...sui,
        saleTokenType: "0xa::meme::MEME",
        presale: shared("0xab", true),
        amount: 1n,
        recipient: "0xe",
        route: "open",
        ...o,
      }),
    migratePresaleBluefin: (o: CoinSourceOptions) =>
      sale.migrate({
        ...sui,
        saleTokenType: bluefinMigration.memeType,
        venue: "bluefin",
        currency: shared("0xd", false),
        quoteCurrency: bluefinMigration.quoteCurrency,
        bluefinConfig: bluefinMigration.bluefinConfig,
        creationFee: bluefinMigration.creationFee,
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
  // The creation fee and the creator's SUI purchase.
  createLaunch: 2,
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
      new PresaleClient(client, presale, off).tx.commit({
        quoteType: SUI,
        saleTokenType: "0xa::meme::MEME",
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
      saleTokenType: "0xa::meme::MEME",
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
