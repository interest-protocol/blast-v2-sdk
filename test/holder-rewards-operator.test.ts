import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import type { RewardManifest } from "@interest-protocol/blast-core/rewards/allocations";
import { validateRewardManifest } from "@interest-protocol/blast-core/rewards/allocations";
import {
  createHolderLedger,
  resetHolderWeights,
} from "@interest-protocol/blast-core/rewards/holders";
import type { HolderRewardsStore } from "@interest-protocol/blast-holder-rewards-sdk/operator";
import { holderRewardsOperator } from "@interest-protocol/blast-holder-rewards-sdk/operator";
import { roundBcs, vaultBcs } from "@interest-protocol/blast-vault-sdk/state";
import type { VaultDeployment } from "@interest-protocol/blast-vault-sdk/transactions";
import { bcs } from "@mysten/sui/bcs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";
import { withOperatorLock, writeOperatorJson } from "../operator/file-store.ts";
import { runHolderRewardsOperator } from "../operator/holder-rewards.ts";

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
      vault: {} as VaultDeployment,
      vaultId: "0xd",
    },
    store,
  );
  await assert.rejects(() => operator.index(1n), /chain/);
  assert.deepEqual(events, ["lock", "rpc", "unlock"]);
});

async function roundJourney(
  t: TestContext,
  options: { skippedDay: boolean; roundDelayMs: bigint },
) {
  const { skippedDay, roundDelayMs } = options;
  const dir = await mkdtemp(join(tmpdir(), "blast-holder-rewards-"));
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
  const corePackageId = address("0xc0e");
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
    vault: {
      packageId,
      originalPackageId,
      registry: shared("0x90"),
      packageVersion: shared("0x95"),
      packageAdmin: shared("0x96"),
      core: {
        packageId: corePackageId,
        originalPackageId: corePackageId,
        treasury: shared("0x97"),
      },
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
  let scheduled: RewardManifest | undefined;
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
  /** The vault's BCS: funded until the round publishes, then advanced past it. */
  const vaultContent = () =>
    vaultBcs
      .serialize({
        id: uid(vaultId),
        terms: {
          origin: address("0x20"),
          packageWitness: `${address("0x30").slice(2)}::blast_presale_package::PackageWitness`,
          feeSplit: {
            routes: [{ destination: { kind: "HolderRewards" }, bps: 10_000n }],
          },
          protocolMemeBps: 0n,
          protocolQuoteBps: 0n,
          partnerId: null,
          residuals: "Owner",
        },
        venue: `${address("0x30").slice(2)}::venue::Venue`,
        pool_id: address("0x22"),
        fee_split: {
          parent: vaultId,
          key: null,
          value: {
            routes: [{ destination: { kind: "HolderRewards" }, bps: 10_000n }],
          },
          delay_ms: 172_800_000n,
          pending: null,
        },
        protocol_bps: {
          parent: vaultId,
          key: null,
          value: { meme_bps: 0n, quote_bps: 0n },
          delay_ms: 172_800_000n,
          pending: null,
        },
        protocol: {
          packageWitness: `${address("0x30").slice(2)}::blast_presale_package::PackageWitness`,
          // The vault's own protocol ledger names the vault as its origin.
          origin: vaultId,
          partnerId: null,
          meme: 0n,
          quote: 0n,
          sui: 0n,
        },
        owner_meme: 0n,
        owner_quote: 0n,
        auto_lp_meme: 0n,
        auto_lp_quote: 0n,
        rewards_meme: published ? 0n : 400n,
        rewards_quote: published ? 0n : 800n,
        burn_quote: 0n,
        next_round: published ? number + 1n : number,
        last_checkpoint: published ? 2n : previousEnd,
        round_publication: {
          parent: vaultId,
          key: null,
          delay_ms: roundDelayMs,
          pending: scheduled
            ? {
                value: {
                  kind: "Action",
                  action: {
                    number,
                    start_checkpoint: 0n,
                    end_checkpoint: 2n,
                    root: scheduled.root,
                    manifest_digest: scheduled.manifestDigest,
                    leaf_count: 2n,
                    meme_amount: 400n,
                    quote_amount: 800n,
                    gas_reserve_amount: 0n,
                    claim_window_duration_ms: 604_800_000n,
                    expected_treasury: address("0xc0"),
                  },
                },
                delay_ms: roundDelayMs,
                ready_at_ms: 0n,
              }
            : null,
        },
      })
      .toBytes();
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
            type: `${originalPackageId}::vault::Vault<${memeType},${quoteType}>`,
            content: vaultContent(),
          },
        };
      assert.equal(request.objectId, roundId);
      assert.ok(published);
      return {
        object: {
          ...base,
          type: `${originalPackageId}::holder_rewards::Round<${memeType},${quoteType}>`,
          content: roundBcs
            .serialize({
              id: uid(roundId),
              vault_id: vaultId,
              number,
              claim_deadline_at_ms: 9_999_999_999_999n,
              root: published.root,
              leaf_count: 2n,
              claimed_bitmap: [1n],
              meme: 100n,
              quote: 200n,
              treasury: address("0x7ea5"),
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
  validateRewardManifest(prepared);
  assert.throws(() =>
    validateRewardManifest({ ...prepared, version: 1 } as never),
  );
  assert.deepEqual(
    prepared.allocations.map(({ beneficiary, memeAmount, quoteAmount }) => ({
      beneficiary,
      memeAmount,
      quoteAmount,
    })),
    [
      { beneficiary: alice, memeAmount: "300", quoteAmount: "600" },
      { beneficiary: bob, memeAmount: "100", quoteAmount: "200" },
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
  const calls = () =>
    publishTx.getData().commands.map((command) => command.MoveCall?.function);
  // At a zero round notice one PTB schedules and publishes.
  assert.deepEqual(
    calls(),
    roundDelayMs === 0n
      ? ["sign_in", "schedule_round", "publish_round"]
      : ["sign_in", "schedule_round"],
  );
  const signIn = publishTx.getData().commands[0]?.MoveCall;
  assert.deepEqual(signIn?.typeArguments, [
    `${corePackageId}::blast_domain::RewardsAdmin`,
  ]);
  const call = publishTx.getData().commands[1]?.MoveCall;
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
  if (roundDelayMs !== 0n) {
    // Once scheduled, rerunning builds only the permissionless publication.
    scheduled = prepared;
    await run("publish-tx");
    const publication = Transaction.from(
      (await readJson(join(dir, "publish-tx.json"))).transaction,
    );
    assert.deepEqual(
      publication
        .getData()
        .commands.map((command) => command.MoveCall?.function),
      ["publish_round"],
    );
  }

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
  test(`CLI runs a round ${skippedDay ? "after a skipped day" : "from activation"} at a zero round notice`, (t) =>
    roundJourney(t, { skippedDay, roundDelayMs: 0n }));
}

test("CLI schedules, then publishes, a round behind the vault's round notice", (t) =>
  roundJourney(t, { skippedDay: false, roundDelayMs: 7_200_000n }));
