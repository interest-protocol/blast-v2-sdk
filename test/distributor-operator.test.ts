import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, normalizeSuiAddress } from "@mysten/sui/utils";
import type { RewardManifest } from "../src/distributor/allocations.ts";
import { buildRewardManifest } from "../src/distributor/allocations.ts";
import type { HolderLedger } from "../src/distributor/holders.ts";
import {
  createHolderLedger,
  holderWeights,
} from "../src/distributor/holders.ts";
import {
  assertRewardRoundMatchesManifest,
  pendingRewardAllocations,
} from "../src/distributor/keeper.ts";
import {
  runDistributorOperator,
  withOperatorLock,
  writeOperatorJson,
} from "../src/distributor/operator.ts";
import { distributorBcs, rewardRoundBcs } from "../src/distributor/state.ts";

const manifest = buildRewardManifest({
  distributorId: "0xd",
  number: 0n,
  startCheckpoint: 1n,
  endCheckpoint: 2n,
  allocations: [
    { beneficiary: "0xa", memeAmount: 10n, quoteAmount: 20n },
    { beneficiary: "0xb", memeAmount: 30n, quoteAmount: 40n },
  ],
});
const round = {
  distributorId: manifest.distributorId,
  number: 0n,
  startCheckpoint: 1n,
  endCheckpoint: 2n,
  root: manifest.root,
  manifestDigest: manifest.manifestDigest,
  leafCount: 2,
  claimed: [1n],
};

test("keeper resumes only unpaid leaves and rejects manifests for another round", () => {
  assertRewardRoundMatchesManifest(round, manifest);
  assert.deepEqual(
    pendingRewardAllocations(round, manifest).map(
      (allocation) => allocation.index,
    ),
    ["1"],
  );
  assert.throws(
    () =>
      pendingRewardAllocations({ ...round, root: "00".repeat(32) }, manifest),
    /match/,
  );
  assert.throws(
    () => pendingRewardAllocations({ ...round, number: 1n }, manifest),
    /match/,
  );
});

test("operator writes complete atomic state and refuses a concurrent writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blast-distributor-"));
  try {
    await withOperatorLock(dir, async () => {
      await assert.rejects(() => withOperatorLock(dir, async () => {}), /lock/);
      await writeOperatorJson(join(dir, "state.json"), {
        amount: 9007199254740993n,
      });
      assert.equal(
        JSON.parse(await readFile(join(dir, "state.json"), "utf8")).amount,
        "9007199254740993",
      );
    });
    await withOperatorLock(dir, async () => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI resumes checkpoint batches and publishes, advances and relays the same accounting interval", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blast-distributor-flow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const address = normalizeSuiAddress;
  const memeType = `${address("0x42")}::meme::MEME`;
  const quoteType = `${address("0x2")}::sui::SUI`;
  const alice = address("0xa");
  const bob = address("0xb");
  const distributorId = address("0xd");
  const roundId = address("0xc");
  const originalPackageId = address("0x99");
  const packageId = address("0x100");
  const uid = (id: string) => ({ id: { bytes: address(id) } });
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const pendingPath = join(dir, "pending.json");
  const manifestPath = join(dir, "rounds", "0", "manifest.json");
  const readJson = async (path: string) =>
    JSON.parse(await readFile(path, "utf8"));
  const run = (command: string, ...args: string[]) =>
    runDistributorOperator([
      command,
      "--config",
      configPath,
      "--dir",
      dir,
      ...args,
    ]);
  await writeOperatorJson(configPath, {
    grpcUrl: "http://127.0.0.1:0",
    network: "localnet",
    chainId: "test-genesis",
    packageId,
    originalPackageId,
    distributorVersionId: address("0x90"),
    launchpadOriginalPackageId: address("0x41"),
    distributorId,
    publisherCapId: address("0x91"),
    sender: alice,
  });
  await writeOperatorJson(statePath, {
    chainId: "test-genesis",
    distributorId,
    activationCheckpoint: "0",
    ledger: createHolderLedger(memeType, 0n),
  });
  const client = new SuiGrpcClient({
    baseUrl: "http://127.0.0.1:0",
    network: "localnet",
  });
  const ledgerPrototype = Object.getPrototypeOf(client.ledgerService);
  const requested: bigint[] = [];
  let failAt: bigint | undefined = 100n;
  let published: RewardManifest | undefined;
  t.mock.method(console, "log", () => {});
  t.mock.method(ledgerPrototype, "getServiceInfo", () => ({
    response: Promise.resolve({
      chainId: "test-genesis",
      checkpointHeight: 101n,
    }),
  }));
  t.mock.method(
    ledgerPrototype,
    "getCheckpoint",
    (request: { checkpointId: { sequenceNumber: bigint } }) => {
      const sequence = request.checkpointId.sequenceNumber;
      requested.push(sequence);
      if (sequence === failAt) throw new Error("injected archival RPC failure");
      const changes =
        sequence === 0n
          ? [
              { address: alice, amount: "100" },
              { address: bob, amount: "100" },
            ]
          : sequence === 50n
            ? [
                { address: alice, amount: "-50" },
                { address: bob, amount: "50" },
              ]
            : sequence === 100n
              ? [
                  { address: alice, amount: "-10" },
                  { address: bob, amount: "10" },
                ]
              : [];
      return {
        response: Promise.resolve({
          checkpoint: {
            sequenceNumber: sequence,
            digest: `cp-${sequence}`,
            summary: {
              previousDigest:
                sequence === 0n ? undefined : `cp-${sequence - 1n}`,
              timestamp: { seconds: sequence + 1n, nanos: 0 },
            },
            contents: { transactions: [{ transaction: `tx-${sequence}` }] },
            transactions: [
              {
                digest: `tx-${sequence}`,
                balanceChanges: changes.map((change) => ({
                  ...change,
                  coinType: memeType,
                })),
              },
            ],
          },
        }),
      };
    },
  );
  t.mock.method(
    Object.getPrototypeOf(client.core),
    "getObject",
    async (request: { objectId: string }) => {
      const base = {
        objectId: request.objectId,
        owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
      };
      if (request.objectId === distributorId)
        return {
          object: {
            ...base,
            type: `${originalPackageId}::blast_fun_distributor::Distributor<${memeType},${quoteType}>`,
            content: distributorBcs
              .serialize({
                id: uid(distributorId),
                launch: { bytes: address("0x10") },
                meme: { value: published ? 0n : 2020n },
                quote: { value: published ? 0n : 4040n },
                next_round: published ? 1n : 0n,
                last_checkpoint: published ? 101n : null,
              })
              .toBytes(),
          },
        };
      assert.equal(request.objectId, roundId);
      assert.ok(published);
      return {
        object: {
          ...base,
          type: `${originalPackageId}::blast_fun_distributor::Round<${memeType},${quoteType}>`,
          content: rewardRoundBcs
            .serialize({
              id: uid(roundId),
              distributor: { bytes: distributorId },
              number: 0n,
              start_checkpoint: 0n,
              end_checkpoint: 101n,
              root: Array.from(fromHex(published.root)),
              manifest_digest: Array.from(fromHex(published.manifestDigest)),
              leaf_count: 2n,
              claimed: [1n],
              meme: { value: 1266n },
              quote: { value: 2532n },
            })
            .toBytes(),
        },
      };
    },
  );

  await assert.rejects(
    () => run("index", "--until", "101"),
    /injected archival RPC failure/,
  );
  assert.equal((await readJson(statePath)).ledger.nextCheckpoint, "100");
  assert.deepEqual(await readdir(join(dir, "checkpoints")), ["batch-0.json"]);
  assert.equal(
    (await readJson(join(dir, "checkpoints", "batch-0.json"))).length,
    100,
  );
  failAt = 101n;
  await assert.rejects(
    () => run("index", "--until", "101"),
    /injected archival RPC failure/,
  );
  const committed = (await readJson(statePath)).ledger as HolderLedger;
  assert.equal(committed.nextCheckpoint, "100");
  assert.equal(committed.accounts[alice]?.balance, "50");
  assert.deepEqual(await readdir(join(dir, "checkpoints")), ["batch-0.json"]);
  // A crash after the journal rename but before state commit must overwrite this batch on retry.
  await writeOperatorJson(join(dir, "checkpoints", "batch-100.json"), []);
  failAt = undefined;
  requested.length = 0;
  await run("index", "--until", "101");
  assert.deepEqual(requested, [100n, 101n]);
  const ledger = (await readJson(statePath)).ledger as HolderLedger;
  assert.equal(ledger.nextCheckpoint, "102");
  assert.equal(ledger.accounts[alice]?.balance, "40");
  assert.equal(ledger.accounts[bob]?.balance, "160");
  assert.deepEqual(holderWeights(ledger), [
    { address: alice, weight: 7_540_000n },
    { address: bob, weight: 12_660_000n },
  ]);
  assert.deepEqual(
    (await readJson(join(dir, "checkpoints", "batch-100.json"))).map(
      (checkpoint: { sequence: string }) => checkpoint.sequence,
    ),
    ["100", "101"],
  );

  await run("prepare");
  const prepared = (await readJson(pendingPath)) as RewardManifest;
  assert.deepEqual(
    prepared.allocations.map(({ beneficiary, memeAmount, quoteAmount }) => ({
      beneficiary,
      memeAmount,
      quoteAmount,
    })),
    [
      { beneficiary: alice, memeAmount: "754", quoteAmount: "1508" },
      { beneficiary: bob, memeAmount: "1266", quoteAmount: "2532" },
    ],
  );
  await assert.rejects(
    () => run("index", "--until", "101"),
    /prepared round is pending/,
  );
  await run("publish-tx");
  const publishTx = Transaction.from(
    (await readJson(join(dir, "publish-tx.json"))).transaction,
  );
  assert.deepEqual(
    publishTx.getData().commands.map((command) => command.MoveCall?.function),
    ["publish_round", "share_round"],
  );
  assert.equal(publishTx.getData().commands[0]?.MoveCall?.package, packageId);
  published = prepared;
  await run("advance", "--round", roundId);
  await assert.rejects(() => readFile(pendingPath), { code: "ENOENT" });
  const advanced = await readJson(statePath);
  assert.equal(advanced.ledger.startCheckpoint, "101");
  assert.deepEqual(holderWeights(advanced.ledger), []);
  await run("advance", "--round", roundId, "--manifest", manifestPath);
  assert.deepEqual(await readJson(statePath), advanced);
  await run("relay", "--round", roundId, "--manifest", manifestPath);
  const relayTx = Transaction.from(
    (await readJson(join(dir, "rounds", "0", "relay-1.json"))).transaction,
  );
  assert.deepEqual(
    relayTx.getData().commands.map((command) => command.MoveCall?.function),
    ["claim"],
  );
  await assert.rejects(
    () => readFile(join(dir, "rounds", "0", "relay-0.json")),
    { code: "ENOENT" },
  );
});
