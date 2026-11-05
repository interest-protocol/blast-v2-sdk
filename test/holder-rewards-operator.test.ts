import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import type { RewardManifest } from "@interest-protocol/blast-core/rewards/allocations";
import {
  buildRewardManifest,
  MIGRATOR_REWARD_LEAF_DOMAIN,
  PRESALE_REWARD_LEAF_DOMAIN,
  validateRewardManifest,
} from "@interest-protocol/blast-core/rewards/allocations";
import {
  createHolderLedger,
  resetHolderWeights,
} from "@interest-protocol/blast-core/rewards/holders";
import {
  assertRewardRoundMatchesManifest,
  pendingRewardAllocations,
} from "@interest-protocol/blast-core/rewards/keeper";
import type { HolderRewardsStore } from "@interest-protocol/blast-holder-rewards-sdk/operator";
import { holderRewardsOperator } from "@interest-protocol/blast-holder-rewards-sdk/operator";
import type { MigratorsDeployment } from "@interest-protocol/blast-migrators-sdk/transactions";
import {
  presaleRewardRoundBcs,
  presaleVaultBcs,
} from "@interest-protocol/blast-presale-sdk/state";
import { bcs } from "@mysten/sui/bcs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";
import { withOperatorLock, writeOperatorJson } from "../operator/file-store.ts";
import { runHolderRewardsOperator } from "../operator/holder-rewards.ts";

const manifest = buildRewardManifest({
  leafDomain: MIGRATOR_REWARD_LEAF_DOMAIN,
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
  assertRewardRoundMatchesManifest(
    round,
    manifest,
    MIGRATOR_REWARD_LEAF_DOMAIN,
  );
  assert.deepEqual(
    pendingRewardAllocations(round, manifest, MIGRATOR_REWARD_LEAF_DOMAIN).map(
      (allocation) => allocation.index,
    ),
    ["1"],
  );
  assert.throws(
    () =>
      pendingRewardAllocations(
        { ...round, root: "00".repeat(32) },
        manifest,
        MIGRATOR_REWARD_LEAF_DOMAIN,
      ),
    /match/,
  );
  assert.throws(
    () =>
      pendingRewardAllocations(
        { ...round, number: 1n },
        manifest,
        MIGRATOR_REWARD_LEAF_DOMAIN,
      ),
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

test("SDK operator checks the chain inside the caller's store lock", async (t) => {
  const events: string[] = [];
  const store: HolderRewardsStore = {
    read: async () => undefined,
    write: async () => {},
    remove: async () => {},
    async withLock(action) {
      events.push("lock");
      try {
        return await action();
      } finally {
        events.push("unlock");
      }
    },
  };
  const client = new SuiGrpcClient({
    baseUrl: "http://127.0.0.1:0",
    network: "mainnet",
  });
  t.mock.method(
    Object.getPrototypeOf(client.ledgerService),
    "getServiceInfo",
    () => {
      events.push("rpc");
      return { response: Promise.resolve({ chainId: "another-genesis" }) };
    },
  );
  const operator = holderRewardsOperator(
    client,
    {
      chainId: "test-genesis",
      deployment: {} as MigratorsDeployment,
      vaultId: "0xd",
    },
    store,
  );
  await assert.rejects(() => operator.index(1n), /chain/);
  assert.deepEqual(events, ["lock", "rpc", "unlock"]);
});

async function presaleRoundJourney(t: TestContext, skippedDay: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "blast-holder-rewards-presale-"));
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
  const shared = (objectId: string) => ({
    objectId: address(objectId),
    initialSharedVersion: "1",
  });
  const uid = (id: string) => ({ id: { bytes: address(id) } });
  const configPath = join(dir, "config.json");
  const pendingPath = join(dir, "pending.json");
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
  const config = {
    grpcUrl: "http://127.0.0.1:0",
    network: "mainnet",
    chainId: "test-genesis",
    product: "presale",
    deployment: {
      packageId,
      originalPackageId,
      packageVersion: shared("0x95"),
      venueConfig: shared("0x90"),
      creationPolicy: shared("0x91"),
      feePolicy: shared("0x92"),
      admin: { packageId: address("0xad"), acl: shared("0x93") },
    },
    vaultId,
    adminCapId: address("0x94"),
    sender: alice,
  };
  await writeOperatorJson(configPath, config);
  await writeOperatorJson(join(dir, "state.json"), {
    chainId: "test-genesis",
    vaultId,
    activationCheckpoint: "0",
    ledger: createHolderLedger(memeType, 0n),
  });
  const client = new SuiGrpcClient({
    baseUrl: "http://127.0.0.1:0",
    network: "mainnet",
  });
  const ledgerPrototype = Object.getPrototypeOf(client.ledgerService);
  let published: RewardManifest | undefined;
  let previousEnd = skippedDay ? 0n : null;
  const number = skippedDay ? 1n : 0n;
  t.mock.method(console, "log", () => {});
  t.mock.method(ledgerPrototype, "getServiceInfo", () => ({
    response: Promise.resolve({
      chainId: "test-genesis",
      checkpointHeight: 2n,
    }),
  }));
  t.mock.method(
    ledgerPrototype,
    "getCheckpoint",
    (request: { checkpointId: { sequenceNumber: bigint } }) => {
      const sequence = request.checkpointId.sequenceNumber;
      const changes =
        sequence === 0n
          ? [
              { address: alice, amount: "300" },
              { address: bob, amount: "100" },
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
            type: `${originalPackageId}::presale_vault::Vault<${memeType},${quoteType}>`,
            content: presaleVaultBcs
              .serialize({
                id: uid(vaultId),
                presale_id: { bytes: address("0x20") },
                presale_cap_id: { bytes: address("0x21") },
                pool_id: { bytes: address("0x22") },
                fee_split: {
                  owner: address(vaultId),
                  key: null,
                  value: {
                    fee_recipients: [],
                    holder_rewards_bps: 10_000n,
                  },
                  delay_ms: 172_800_000n,
                  pending: null,
                },
                protocol_fees: {
                  owner: address(vaultId),
                  key: null,
                  value: {
                    raiseBps: 0n,
                    tokenBps: 0n,
                    lpFeeMemeBps: 0n,
                    lpFeeQuoteBps: 0n,
                  },
                  delay_ms: 172_800_000n,
                  pending: null,
                },
                partner_id: null,
                unpaid_protocol_meme: { value: 0n },
                unpaid_protocol_quote: { value: 0n },
                migration_meme_residual: { value: 0n },
                migration_quote_residual: { value: 0n },
                holder_rewards_quote: { value: published ? 0n : 800n },
                next_round: published ? number + 1n : number,
                last_checkpoint: published ? 2n : previousEnd,
                round_publication: {
                  owner: address(vaultId),
                  key: null,
                  delay_ms: 0n,
                  pending: null,
                },
              })
              .toBytes(),
          },
        };
      assert.equal(request.objectId, roundId);
      assert.ok(published);
      return {
        object: {
          ...base,
          type: `${originalPackageId}::holder_rewards::Round<${memeType},${quoteType}>`,
          content: presaleRewardRoundBcs
            .serialize({
              id: uid(roundId),
              vault_id: { bytes: vaultId },
              number,
              claim_deadline_ms: 9_999_999_999_999n,
              root: published.root,
              leaf_count: 2n,
              claimed_bitmap: [1n],
              meme: { value: 1000n },
              quote: { value: 200n },
              treasury: "0x7ea5",
              gas_reserve: null,
            })
            .toBytes(),
        },
      };
    },
  );

  if (skippedDay) {
    await run("index", "--until", "1");
    const statePath = join(dir, "state.json");
    const state = await readJson(statePath);
    await writeOperatorJson(statePath, {
      ...state,
      ledger: resetHolderWeights(state.ledger),
    });
  }
  await run("index", "--until", "2");
  if (skippedDay) {
    previousEnd = 2n;
    await assert.rejects(() => run("prepare"), /ledger interval/);
    previousEnd = 0n;
  }
  await run("prepare");
  const prepared = (await readJson(pendingPath)) as RewardManifest;
  assert.equal(prepared.number, number.toString());
  assert.equal(prepared.startCheckpoint, skippedDay ? "1" : "0");
  assert.equal(prepared.endCheckpoint, "2");
  validateRewardManifest(prepared, PRESALE_REWARD_LEAF_DOMAIN);
  assert.throws(() =>
    validateRewardManifest(prepared, MIGRATOR_REWARD_LEAF_DOMAIN),
  );
  assert.deepEqual(
    prepared.allocations.map(({ beneficiary, memeAmount, quoteAmount }) => ({
      beneficiary,
      memeAmount,
      quoteAmount,
    })),
    [
      { beneficiary: alice, memeAmount: "0", quoteAmount: "600" },
      { beneficiary: bob, memeAmount: "0", quoteAmount: "200" },
    ],
  );
  await assert.rejects(() => run("publish-tx"), /claimWindowMs/);
  await writeOperatorJson(configPath, {
    ...config,
    claimWindowMs: "604800000",
    gasReserveAmount: "0",
  });
  await assert.rejects(() => run("publish-tx"), /expectedTreasury/);
  await writeOperatorJson(configPath, {
    ...config,
    claimWindowMs: "604800000",
    gasReserveAmount: "0",
    expectedTreasury: address("0xc0"),
  });
  await run("publish-tx");
  const publishTx = Transaction.from(
    (await readJson(join(dir, "publish-tx.json"))).transaction,
  );
  const call = publishTx.getData().commands[1]?.MoveCall;
  // The vault's round notice is zero, so one PTB schedules and publishes.
  assert.deepEqual(
    publishTx.getData().commands.map((command) => command.MoveCall?.function),
    ["sign_in", "schedule_round", "publish_round"],
  );
  assert.equal(call?.package, packageId);
  assert.equal(call?.module, "holder_rewards");
  const windowArgument = call?.arguments[12];
  assert.ok(windowArgument?.$kind === "Input");
  const windowInput = publishTx.getData().inputs[windowArgument.Input];
  assert.ok(windowInput?.$kind === "Pure");
  assert.equal(
    BigInt(bcs.u64().parse(fromBase64(windowInput.Pure.bytes))),
    604_800_000n,
  );

  published = prepared;
  await run("advance", "--round", roundId);
  await run(
    "relay",
    "--round",
    roundId,
    "--manifest",
    join(dir, "rounds", number.toString(), "manifest.json"),
  );
  const relayTx = Transaction.from(
    (await readJson(join(dir, "rounds", number.toString(), "relay-1.json")))
      .transaction,
  );
  assert.deepEqual(
    relayTx
      .getData()
      .commands.map((command) => [
        command.MoveCall?.module,
        command.MoveCall?.function,
      ]),
    [["holder_rewards", "claim"]],
  );
}

for (const skippedDay of [false, true]) {
  test(`CLI runs a presale round ${skippedDay ? "after a skipped day" : "from activation"} with its own claim window`, (t) =>
    presaleRoundJourney(t, skippedDay));
}
