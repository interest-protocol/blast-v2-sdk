import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, normalizeSuiAddress } from "@mysten/sui/utils";
import type { RewardManifest } from "../src/holder-rewards/allocations.ts";
import { buildRewardManifest } from "../src/holder-rewards/allocations.ts";
import type { HolderLedger } from "../src/holder-rewards/holders.ts";
import {
  createHolderLedger,
  holderWeights,
} from "../src/holder-rewards/holders.ts";
import {
  assertRewardRoundMatchesManifest,
  pendingRewardAllocations,
} from "../src/holder-rewards/keeper.ts";
import {
  runHolderRewardsOperator,
  withOperatorLock,
  writeOperatorJson,
} from "../src/holder-rewards/operator.ts";
import { rewardRoundBcs } from "../src/holder-rewards/state.ts";
import { lpVaultBcs } from "../src/migrators/state.ts";

const manifest = buildRewardManifest({
  vaultId: "0xd",
  number: 0n,
  startCheckpoint: 1n,
  endCheckpoint: 2n,
  allocations: [
    { beneficiary: "0xa", memeAmount: 10n, quoteAmount: 20n },
    { beneficiary: "0xb", memeAmount: 30n, quoteAmount: 40n },
  ],
});
const round = {
  vaultId: manifest.vaultId,
  number: 0n,
  root: manifest.root,
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
  const dir = await mkdtemp(join(tmpdir(), "blast-holder-rewards-"));
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
  const dir = await mkdtemp(join(tmpdir(), "blast-holder-rewards-flow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const address = normalizeSuiAddress;
  const memeType = `${address("0x42")}::meme::MEME`;
  const quoteType = `${address("0x2")}::sui::SUI`;
  const alice = address("0xa");
  const bob = address("0xb");
  const vaultId = address("0xd");
  const roundId = address("0xc");
  const originalPackageId = address("0x99");
  const packageId = address("0x100");
  const shared = (objectId: string, mutable: boolean) => ({
    objectId: address(objectId),
    initialSharedVersion: "1",
    mutable,
  });
  const uid = (id: string) => ({ id: { bytes: address(id) } });
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const pendingPath = join(dir, "pending.json");
  const manifestPath = join(dir, "rounds", "0", "manifest.json");
  const readJson = async (path: string) =>
    JSON.parse(await readFile(path, "utf8"));
  const run = (command: string, ...args: string[]) =>
    runHolderRewardsOperator([
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
    deployment: {
      packageId,
      originalPackageId,
      launchpad: {
        packageId: address("0x41"),
        adminPackageId: address("0xad"),
        partnersPackageId: address("0xae"),
        timelockPackageId: address("0xaf"),
        packageVersion: shared("0x42", false),
        launchConfig: shared("0x43", false),
        runtimeConfig: shared("0x44", false),
        acl: shared("0x45", false),
      },
      migratorsVersion: shared("0x90", false),
      lpFeePolicy: shared("0x91", false),
      venueConfig: shared("0x92", false),
    },
    vaultId,
    adminCapId: address("0x93"),
    sender: alice,
  });
  await writeOperatorJson(statePath, {
    chainId: "test-genesis",
    vaultId,
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
      if (request.objectId === vaultId)
        return {
          object: {
            ...base,
            type: `${originalPackageId}::vault::LpVault<${memeType},${quoteType}>`,
            content: lpVaultBcs
              .serialize({
                id: uid(vaultId),
                pool_id: { bytes: address("0x10") },
                protocol_meme_residual: { value: 0n },
                protocol_quote_residual: { value: 0n },
                generation: 0n,
                fee_split: {
                  creatorBps: 0n,
                  autoLpBps: 0n,
                  rewardsBps: 10_000n,
                  burnBps: 0n,
                  recipients: [],
                },
                creator_meme: { value: 0n },
                creator_quote: { value: 0n },
                auto_lp_meme: { value: 0n },
                auto_lp_quote: { value: 0n },
                rewards_meme: { value: published ? 0n : 2020n },
                rewards_quote: { value: published ? 0n : 4040n },
                burn_quote: { value: 0n },
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
          type: `${originalPackageId}::blast_holder_rewards::Round<${memeType},${quoteType}>`,
          content: rewardRoundBcs
            .serialize({
              id: uid(roundId),
              vault: { bytes: vaultId },
              number: 0n,
              root: Array.from(fromHex(published.root)),
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
    ["sign_in", "publish_round"],
  );
  assert.equal(publishTx.getData().commands[1]?.MoveCall?.package, packageId);
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
