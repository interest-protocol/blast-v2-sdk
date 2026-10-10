import assert from "node:assert/strict";
import test from "node:test";

import type { SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { BoostsClient } from "../src/boosts/client.ts";
import {
  assertBoostsTransactionShape,
  BoostsTransactions,
  buildBoostsIconUpdateTransaction,
  deriveBoostsExecutionLimits,
  inspectBoostsTransactionShape,
  normalizeBoostsSimulation,
  parseBoostsCollateralAmount,
  parseBoostsShareAmount,
  resolveBoostsRedeemAmount,
} from "../src/boosts/transactions.ts";
import type {
  BoostsProductKey,
  BoostsProductSnapshotV1,
  BoostsTransport,
} from "../src/boosts/types.ts";
import {
  BOOSTS_FIXTURE_MANIFEST,
  fixtureEvent,
  fixtureRead,
} from "./boosts-fixtures.ts";

const NOW_MS = Date.parse("2026-09-21T00:00:10.000Z");
const SENDER = "0xbeef";

test("builds an issuer-authorized icon-only metadata update", () => {
  const transaction = buildBoostsIconUpdateTransaction(
    BOOSTS_FIXTURE_MANIFEST,
    {
      productKey: "nvda-2x-bull",
      sender: SENDER,
      adminPackageId: "0xa1",
      corePackageId: "0xc0",
      authorityId: "0xa2",
      adminCapId: "0xa3",
      currencyId: "0xc1",
      currentName: "NVDA 2x Bull",
      currentDescription: "NVDA 2x Bull",
      iconUrl: "https://assets.example/coins/nvda-2x-bull.png",
    },
  );
  const calls = transaction
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall] : [],
    );

  assert.equal(transaction.getData().sender, normalizeSuiAddress(SENDER));
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => `${call.package}::${call.module}::${call.function}`),
    [
      `${normalizeSuiAddress("0xa1")}::acl::sign_in`,
      `${BOOSTS_FIXTURE_MANIFEST.adapterPackage.packageId}::vault::update_metadata`,
    ],
  );
  assert.deepEqual(calls[0]?.typeArguments, [
    `${normalizeSuiAddress("0xc0")}::blast_boosts_core::BLAST_BOOSTS_CORE`,
  ]);
  assert.deepEqual(calls[1]?.typeArguments, [
    BOOSTS_FIXTURE_MANIFEST.products[1].productType,
    BOOSTS_FIXTURE_MANIFEST.products[1].collateralType,
  ]);
  assert.equal(calls[1]?.arguments.length, 7);
  assert.equal(
    calls[1]?.arguments[2]?.$kind,
    "Result",
    "the metadata update must consume the admin witness",
  );
  assert.equal(
    calls[1]?.arguments[2]?.$kind === "Result"
      ? calls[1].arguments[2].Result
      : null,
    0,
  );

  assert.throws(
    () =>
      buildBoostsIconUpdateTransaction(BOOSTS_FIXTURE_MANIFEST, {
        productKey: "nvda-2x-bull",
        sender: SENDER,
        adminPackageId: "0xa1",
        corePackageId: "0xc0",
        authorityId: "0xa2",
        adminCapId: "0xa3",
        currencyId: "0xc1",
        currentName: "Wrong coin",
        currentDescription: "NVDA 2x Bull",
        iconUrl: "http://assets.example/coins/nvda-2x-bull.png",
      }),
    /current coin name does not match/,
  );
  assert.throws(
    () =>
      buildBoostsIconUpdateTransaction(BOOSTS_FIXTURE_MANIFEST, {
        productKey: "nvda-2x-bull",
        sender: SENDER,
        adminPackageId: "0xa1",
        corePackageId: "0xc0",
        authorityId: "0xa2",
        adminCapId: "0xa3",
        currencyId: "0xc1",
        currentName: "NVDA 2x Bull",
        currentDescription: "NVDA 2x Bull",
        iconUrl: "http://assets.example/coins/nvda-2x-bull.png",
      }),
    /valid HTTPS URL/,
  );
});

test("builds the exact public mint redeem and rebalance ABI for every Bull product", async () => {
  const transactions = new BoostsTransactions(BOOSTS_FIXTURE_MANIFEST);

  for (const productKey of [
    "sui-2x-bull",
    "nvda-2x-bull",
    "zec-2x-bull",
  ] as const) {
    const snapshot = await snapshotFor(productKey);
    const mint = transactions.mint({
      productKey,
      sender: SENDER,
      snapshot,
      nowMs: NOW_MS,
      amountAtoms: 1_000_000n,
      availableAtoms: 2_000_000n,
      minimumSharesAtoms: 900_000_000n,
      deadlineMs: BigInt(NOW_MS + 50_000),
    });
    const redeem = transactions.redeem({
      productKey,
      sender: SENDER,
      snapshot,
      nowMs: NOW_MS,
      sharesAtoms: 1_000_000_000n,
      availableAtoms: 2_000_000_000n,
      minimumCollateralAtoms: 900_000n,
      deadlineMs: BigInt(NOW_MS + 50_000),
    });
    const rebalance = transactions.rebalance({
      productKey,
      sender: SENDER,
      snapshot: needed(snapshot),
      nowMs: NOW_MS,
      suiBalanceAtoms: 1n,
    });

    for (const [transaction, operation, argumentCount, transfers] of [
      [mint, "mint", 11, 1],
      [redeem, "redeem", 11, 1],
      [rebalance, "rebalance", 8, 0],
    ] as const) {
      const shape = inspectBoostsTransactionShape(transaction);
      assert.equal(shape.operation, operation);
      assert.equal(shape.sender, normalizeSuiAddress(SENDER));
      assert.equal(shape.transfers, transfers);
      assert.deepEqual(shape.moveTargets, [
        `${BOOSTS_FIXTURE_MANIFEST.adapterPackage.packageId}::operations::${operation}`,
      ]);
      const call = transaction
        .getData()
        .commands.find((command) => command.$kind === "MoveCall");
      assert.equal(call?.$kind, "MoveCall");
      if (call?.$kind === "MoveCall") {
        assert.equal(call.MoveCall.arguments.length, argumentCount);
      }
    }
  }
});

test("parses exact amounts Max and holder-safe execution limits without floats", () => {
  assert.equal(parseBoostsCollateralAmount("1.000001"), 1_000_001n);
  assert.equal(parseBoostsShareAmount("2.000000001"), 2_000_000_001n);
  assert.equal(resolveBoostsRedeemAmount("max", 9n), 9n);
  assert.equal(resolveBoostsRedeemAmount("0.000000008", 9n), 8n);
  assert.throws(
    () => parseBoostsCollateralAmount("1.0000001"),
    /at most 6 decimals/,
  );
  assert.throws(() => parseBoostsShareAmount("0"), /positive u64/);
  assert.throws(() => resolveBoostsRedeemAmount("max", 0n), /positive u64/);
  assert.throws(
    () => resolveBoostsRedeemAmount("0.000000010", 9n),
    /exceeds balance/,
  );

  assert.deepEqual(
    deriveBoostsExecutionLimits({
      expectedOutputAtoms: 1_001n,
      observedAtMs: 1_000n,
      nowMs: 2_000n,
    }),
    {
      expectedOutputAtoms: 1_001n,
      toleranceBps: 100n,
      minimumOutputAtoms: 990n,
      deadlineMs: 61_000n,
      expiresAtMs: 61_000n,
    },
  );
  for (const toleranceBps of [9n, 501n]) {
    assert.throws(
      () =>
        deriveBoostsExecutionLimits({
          expectedOutputAtoms: 1n,
          observedAtMs: 1_000n,
          nowMs: 2_000n,
          toleranceBps,
        }),
      /between 10 and 500 bps/,
    );
  }
  assert.throws(
    () =>
      deriveBoostsExecutionLimits({
        expectedOutputAtoms: 1n,
        observedAtMs: 1_000n,
        nowMs: 61_001n,
      }),
    /expired/,
  );
});

test("fails closed on stale identity lifecycle balance deadline and extra-call shapes", async () => {
  const transactions = new BoostsTransactions(BOOSTS_FIXTURE_MANIFEST);
  const snapshot = await snapshotFor("sui-2x-bull");
  const mint = (overrides: Record<string, unknown> = {}) =>
    transactions.mint({
      productKey: "sui-2x-bull",
      sender: SENDER,
      snapshot,
      nowMs: NOW_MS,
      amountAtoms: 1n,
      availableAtoms: 1n,
      minimumSharesAtoms: 0n,
      deadlineMs: BigInt(NOW_MS),
      ...overrides,
    });

  assert.throws(
    () => mint({ nowMs: NOW_MS + 5_001 }),
    /observation is not fresh/,
  );
  assert.throws(() => mint({ amountAtoms: 2n }), /amount exceeds balance/);
  assert.throws(
    () => mint({ deadlineMs: BigInt(NOW_MS - 1) }),
    /deadline has expired/,
  );
  assert.throws(
    () => mint({ deadlineMs: BigInt(NOW_MS + 50_001) }),
    /deadline exceeds the quote expiry/,
  );
  assert.throws(
    () =>
      mint({
        snapshot: {
          ...snapshot,
          lifecycle: "unwinding",
          availability: { ...snapshot.availability, mint: false },
        },
      }),
    /mint is not available/,
  );
  assert.throws(
    () => mint({ productKey: "nvda-2x-bull" }),
    /does not match the product manifest/,
  );

  const transaction = mint();
  transaction.moveCall({
    target: `${BOOSTS_FIXTURE_MANIFEST.adapterPackage.packageId}::operations::rebalance`,
    typeArguments: [
      BOOSTS_FIXTURE_MANIFEST.products[0].productType,
      BOOSTS_FIXTURE_MANIFEST.products[0].collateralType,
    ],
    arguments: [],
  });
  assert.throws(
    () =>
      assertBoostsTransactionShape(transaction, BOOSTS_FIXTURE_MANIFEST, {
        operation: "mint",
        productKey: "sui-2x-bull",
        sender: SENDER,
      }),
    /exactly one Move call/,
  );

  const product = BOOSTS_FIXTURE_MANIFEST.products[0];
  const missingArguments = new Transaction();
  missingArguments.setSender(SENDER);
  missingArguments.moveCall({
    target: `${BOOSTS_FIXTURE_MANIFEST.adapterPackage.packageId}::operations::rebalance`,
    typeArguments: [product.productType, product.collateralType],
  });
  assert.throws(
    () =>
      assertBoostsTransactionShape(missingArguments, BOOSTS_FIXTURE_MANIFEST, {
        operation: "rebalance",
        productKey: "sui-2x-bull",
        sender: SENDER,
      }),
    /wrong Move argument count/,
  );
});

test("normalizes the exact operation event emitted by simulation", () => {
  for (const [operation, eventKind, outputAtoms, feeAtoms] of [
    ["mint", "Minted", 1_000_000_000n, 3_000n],
    ["redeem", "Redeemed", 996_000n, 4_000n],
    ["rebalance", "Rebalanced", null, null],
  ] as const) {
    const result = {
      $kind: "Transaction",
      Transaction: {
        status: { success: true, error: null },
        events: [fixtureEvent("sui-2x-bull", eventKind)],
      },
    } as unknown as SuiClientTypes.SimulateTransactionResult<{ events: true }>;
    const simulation = normalizeBoostsSimulation(
      result,
      BOOSTS_FIXTURE_MANIFEST,
      "sui-2x-bull",
      operation,
    );
    assert.equal(simulation.operation, operation);
    assert.equal(simulation.outputAtoms, outputAtoms);
    assert.equal(simulation.feeAtoms, feeAtoms);
  }
});

async function snapshotFor(
  productKey: BoostsProductKey,
): Promise<BoostsProductSnapshotV1> {
  const transport: BoostsTransport = {
    readProduct: async (product) => fixtureRead(product.productKey),
    getChainIdentifier: async () => "fixture-chain",
    getBalance: async () => "0",
    listEvents: async () => ({
      events: [],
      hasNextPage: false,
      startCursor: null,
      endCursor: null,
    }),
    getIndexedTransaction: async () => null,
  };
  const result = await new BoostsClient(
    transport,
    BOOSTS_FIXTURE_MANIFEST,
  ).getProduct(productKey);
  if (!result.ok) throw new Error(`fixture failed: ${result.code}`);
  return result.snapshot;
}

function needed(snapshot: BoostsProductSnapshotV1): BoostsProductSnapshotV1 {
  return {
    ...snapshot,
    availability: { ...snapshot.availability, rebalance: true },
    economics: { ...snapshot.economics, health: "rebalance_needed" },
    rebalance: { ...snapshot.rebalance, needed: true },
  };
}
