import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiObjectId } from "@mysten/sui/utils";

import { BoostsClient } from "../src/boosts/client.ts";
import { createBoostsGrpcTransport } from "../src/boosts/grpc.ts";
import { getBoostsProduct } from "../src/boosts/manifest.ts";
import { boostsCapturedSnapshotBcs } from "../src/boosts/state.ts";
import {
  BOOSTS_FIXTURE_MANIFEST,
  CHECKPOINT_BCS,
  fixtureRead,
} from "./boosts-fixtures.ts";

test("reads one authoritative product through unchecked gRPC simulation", async () => {
  const harness = grpcHarness();
  const transport = createBoostsGrpcTransport(
    harness.client,
    BOOSTS_FIXTURE_MANIFEST,
  );
  const result = await new BoostsClient(
    transport,
    BOOSTS_FIXTURE_MANIFEST,
  ).getProduct("sui-2x-bull");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.observation.checkpoint, "10");
  assert.equal(result.snapshot.supply.currentAtoms, "10000000000");
  assert.equal(result.snapshot.economics.venueEquityAtoms, "10100000");
  assert.equal(result.snapshot.rebalance.lastCompleted, null);
  assert.equal(harness.simulations, 1);
  assert.equal(harness.checksEnabled, false);
  assert.deepEqual(harness.moveCalls, ["operations::observe"]);
});

test("reads exact package lineage and coin metadata for deployment validation", async () => {
  const transport = createBoostsGrpcTransport(
    grpcHarness().client,
    BOOSTS_FIXTURE_MANIFEST,
  );
  assert.deepEqual(
    await transport.getPackageReference?.(
      BOOSTS_FIXTURE_MANIFEST.adapterPackage.packageId,
    ),
    BOOSTS_FIXTURE_MANIFEST.adapterPackage,
  );
  assert.deepEqual(
    await transport.getCoinMetadata?.(
      BOOSTS_FIXTURE_MANIFEST.products[0].collateralType,
    ),
    { decimals: 6, name: "USD Coin", symbol: "USDC" },
  );
});

test("rejects the wrong chain before running a product simulation", async () => {
  const harness = grpcHarness({ chainIdentifier: "wrong-chain" });
  const transport = createBoostsGrpcTransport(
    harness.client,
    BOOSTS_FIXTURE_MANIFEST,
  );
  const product = getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, "sui-2x-bull");
  await assert.rejects(transport.readProduct(product), /wrong chain/);
  assert.equal(harness.simulations, 0);
});

test("rejects a vault that changes after the simulated observation", async () => {
  const harness = grpcHarness({ racedVault: true });
  const transport = createBoostsGrpcTransport(
    harness.client,
    BOOSTS_FIXTURE_MANIFEST,
  );
  const product = getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, "sui-2x-bull");
  await assert.rejects(
    transport.readProduct(product),
    /vault changed during the read/,
  );
});

test("retries a product observation when the separately read vault changes", async () => {
  const harness = grpcHarness({ racedVaultOnce: true });
  const transport = createBoostsGrpcTransport(
    harness.client,
    BOOSTS_FIXTURE_MANIFEST,
  );
  const product = getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, "sui-2x-bull");

  const result = await transport.readProduct(product);

  assert.equal(result.checkpoint, "10");
  assert.equal(harness.simulations, 2);
});

test("reads current product state without requiring pruned input transactions", async () => {
  const harness = grpcHarness({ prunedTransactions: true });
  const transport = createBoostsGrpcTransport(
    harness.client,
    BOOSTS_FIXTURE_MANIFEST,
  );
  const product = getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, "sui-2x-bull");

  const result = await transport.readProduct(product);

  assert.equal(result.checkpoint, "10");
  assert.equal(result.observedAt, "1970-01-01T00:16:40.000Z");
  assert.equal(harness.transactionReads, 0);
  assert.equal(harness.simulations, 1);
});

test("rejects a retained TreasuryCap that differs from the manifest", async () => {
  const harness = grpcHarness({ wrongTreasuryCap: true });
  const transport = createBoostsGrpcTransport(
    harness.client,
    BOOSTS_FIXTURE_MANIFEST,
  );
  const product = getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, "sui-2x-bull");
  await assert.rejects(
    transport.readProduct(product),
    /TreasuryCap identity does not match/,
  );
});

test("rejects missing current checkpoint metadata", async () => {
  const harness = grpcHarness({ missingCheckpoint: true });
  const transport = createBoostsGrpcTransport(
    harness.client,
    BOOSTS_FIXTURE_MANIFEST,
  );
  const product = getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, "sui-2x-bull");
  await assert.rejects(transport.readProduct(product), /checkpoint metadata/);
});

test("reads current simulated state ahead of the RPC checkpoint watermark", async () => {
  const harness = grpcHarness({ checkpointBehindOnce: true });
  const transport = createBoostsGrpcTransport(
    harness.client,
    BOOSTS_FIXTURE_MANIFEST,
  );
  const result = await transport.readProduct(
    getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, "sui-2x-bull"),
  );
  assert.equal(result.checkpoint, "10");
  assert.equal(result.observedAt, "1970-01-01T00:16:40.000Z");
  assert.equal(harness.simulations, 1);
});

function grpcHarness(
  options: Readonly<{
    chainIdentifier?: string;
    racedVault?: boolean;
    racedVaultOnce?: boolean;
    prunedTransactions?: boolean;
    wrongTreasuryCap?: boolean;
    missingCheckpoint?: boolean;
    checkpointBehindOnce?: boolean;
  }> = {},
) {
  const product = getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, "sui-2x-bull");
  const fixture = fixtureRead("sui-2x-bull");
  const objectIds = [
    product.vault.objectId,
    product.protocol,
    product.venueAccount,
    product.registry,
    product.clearingHouse,
    product.baseOracleStorage,
    product.collateralOracleStorage,
    product.clock,
  ].map((objectId) => normalizeSuiObjectId(objectId));
  const exact = new Map(
    objectIds.map((objectId) => [
      objectId,
      { version: "9", digest: `digest-${objectId}` },
    ]),
  );
  const state = {
    simulations: 0,
    vaultReads: 0,
    transactionReads: 0,
    checksEnabled: undefined as boolean | undefined,
    moveCalls: [] as string[],
  };

  const client = {
    async getChainIdentifier() {
      return {
        chainIdentifier: options.chainIdentifier ?? "fixture-chain",
      };
    },
    async simulateTransaction(input: {
      transaction: Transaction;
      checksEnabled?: boolean;
    }) {
      state.simulations += 1;
      state.checksEnabled = input.checksEnabled;
      state.moveCalls = input.transaction
        .getData()
        .commands.flatMap((command) =>
          command.$kind === "MoveCall"
            ? [`${command.MoveCall.module}::${command.MoveCall.function}`]
            : [],
        );
      return {
        $kind: "Transaction",
        Transaction: {
          effects: {
            status: { success: true, error: null },
            unchangedConsensusObjects: objectIds.map((objectId) => {
              const reference = requireExact(exact, objectId);
              return {
                kind: "ReadOnlyRoot",
                objectId,
                version: reference.version,
                digest: reference.digest,
              };
            }),
          },
        },
        commandResults: simulationOutputs(fixture, options.wrongTreasuryCap),
      };
    },
    async getObject() {
      state.vaultReads += 1;
      const objectId = normalizeSuiObjectId(product.vault.objectId);
      const reference = requireExact(exact, objectId);
      return {
        object: {
          ...fixture.vault,
          version:
            options.racedVault ||
            (options.racedVaultOnce && state.vaultReads === 1)
              ? "10"
              : reference.version,
          digest: reference.digest,
          owner: {
            $kind: "Shared",
            Shared: {
              initialSharedVersion: product.vault.initialSharedVersion,
            },
          },
        },
      };
    },
    async getBalance() {
      return { balance: { balance: "0" } };
    },
    async getCoinMetadata() {
      return {
        coinMetadata: { decimals: 6, name: "USD Coin", symbol: "USDC" },
      };
    },
    async listEvents() {
      return {
        events: [],
        hasNextPage: false,
        startCursor: null,
        endCursor: null,
      };
    },
    ledgerService: {
      getServiceInfo() {
        return {
          response: Promise.resolve({
            chainId: options.chainIdentifier ?? "fixture-chain",
            checkpointHeight: options.missingCheckpoint ? undefined : 10n,
            timestamp: {
              seconds:
                options.checkpointBehindOnce && state.simulations === 1
                  ? 999n
                  : 1_000n,
              nanos: 0,
            },
          }),
        };
      },
      async getTransaction() {
        state.transactionReads += 1;
        if (options.prunedTransactions) {
          throw Object.assign(new Error("fixture transaction not found"), {
            name: "RpcError",
            code: "NOT_FOUND",
            methodName: "GetTransaction",
            serviceName: "sui.rpc.v2.LedgerService",
          });
        }
        return {
          response: {
            transaction: {
              checkpoint: 10n,
            },
          },
        };
      },
      async getCheckpoint() {
        const milliseconds = Date.parse("2026-09-21T00:00:00.000Z");
        return {
          response: {
            checkpoint: {
              summary: {
                timestamp: {
                  seconds: BigInt(milliseconds / 1_000),
                  nanos: 0,
                },
              },
            },
          },
        };
      },
    },
    movePackageService: {
      getPackage() {
        return {
          response: Promise.resolve({
            package: {
              storageId: BOOSTS_FIXTURE_MANIFEST.adapterPackage.packageId,
              originalId:
                BOOSTS_FIXTURE_MANIFEST.adapterPackage.originalPackageId,
            },
          }),
        };
      },
    },
  } as unknown as SuiGrpcClient;

  return {
    client,
    get simulations() {
      return state.simulations;
    },
    get transactionReads() {
      return state.transactionReads;
    },
    get checksEnabled() {
      return state.checksEnabled;
    },
    get moveCalls() {
      return state.moveCalls;
    },
  };
}

function requireExact(
  exact: ReadonlyMap<string, Readonly<{ version: string; digest: string }>>,
  objectId: string,
) {
  const reference = exact.get(objectId);
  if (!reference) throw new Error("missing fixture object reference");
  return reference;
}

function simulationOutputs(
  fixture: ReturnType<typeof fixtureRead>,
  wrongTreasuryCap = false,
) {
  const market = fixture.market;
  return [
    {
      returnValues: [
        {
          bcs: boostsCapturedSnapshotBcs
            .serialize({
              venue_equity: market.venueEquityAtoms,
              position_base: market.positionBaseAtoms,
              lot_size: market.lotSizeAtoms,
              side:
                market.observedSide === "long"
                  ? { Long: true }
                  : { Short: true },
              pending_order_count: market.pendingOrderCount,
              margin_safe: market.marginSafe,
              venue_operational: market.venueOperational,
              economics_valid: true,
              base_price: market.baseOracle.price,
              base_timestamp: market.baseOracle.publishTimeMs,
              collateral_price: market.collateralOracle.price,
              collateral_timestamp: market.collateralOracle.publishTimeMs,
              mark_price: market.markPrice,
              checkpoint: CHECKPOINT_BCS,
              collateral_fixed: 1n,
            })
            .toBytes(),
        },
        {
          bcs: bcs.Address.serialize(
            wrongTreasuryCap
              ? "0xffff"
              : BOOSTS_FIXTURE_MANIFEST.products[0].treasuryCap,
          ).toBytes(),
        },
        { bcs: bcs.u64().serialize(10_000_000_000n).toBytes() },
        { bcs: bcs.u64().serialize(1_000_000n).toBytes() },
      ],
      mutatedReferences: [],
    },
  ];
}
