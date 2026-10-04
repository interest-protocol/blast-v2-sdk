/**
 * E2E-029: the holder-reward distribution algorithm, end to end, on the
 * E2E-027 open-policy vault (SALE_M / SUI on Bluefin).
 *
 * 1. Real holding history: a transfer, a buy, a sell, with time between them;
 *    the trades accrue LP fees, collected into the vault's holder share.
 * 2. The SDK ledger (`applyHolderCheckpoint`, `resetHolderWeights` at vault
 *    creation, `holderWeights`, `allocateHolderRewards`) replays every mainnet
 *    checkpoint, as the operator's `index`/`prepare` do.
 * 3. The weights are cross-checked against an independent replay of the
 *    sale token's balance changes from its transactions.
 * 4. The round is published under the presale leaf domain and every holder
 *    is paid exactly its allocation; dust stays in the vault.
 *
 * Replay starts at SALE_M's registration, where its supply was zero, instead
 * of the shared testkit package's creation; both see the same SALE_M history.
 */
import { readdirSync, readFileSync } from "node:fs";

import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { HolderCheckpoint } from "../../../src/holder-rewards/index.ts";
import {
  allocateHolderRewards,
  applyHolderCheckpoint,
  buildRewardManifest,
  createHolderLedger,
  holderWeights,
  PRESALE_REWARD_LEAF_DOMAIN,
  pendingRewardAllocations,
  readHolderCheckpoint,
  resetHolderWeights,
} from "../../../src/holder-rewards/index.ts";
import {
  balance,
  balanceChange,
  check,
  created,
  equal,
  exec,
  record,
  sharedVersion,
  single,
  waitUntil,
} from "../chain.ts";
import {
  ADMIN_CAP,
  BLUEFIN,
  client,
  DEPLOYMENT,
  deployer,
  presale,
  wallets,
} from "../env.ts";
import type { SaleRecord, Shared } from "../sale.ts";
import { coins, mut, sale, types } from "../sale.ts";

const MIN_SQRT_PRICE = 4_295_048_016n;
const MAX_SQRT_PRICE = 79_226_673_515_401_279_992_447_579_055n;

export async function e029(phase?: string): Promise<void> {
  const w = wallets();
  const sm = sale("e027-open");
  const vault = sm.vault as Shared;
  const digests: string[] = [];
  const track = async (
    label: string,
    signer: Ed25519Keypair,
    tx: Transaction,
  ) => {
    const done = await exec(label, signer, tx);
    digests.push(done.digest);
    return done;
  };

  if (phase !== "round") {
    // 1. Holding history.
    const p1Held = await balance(w.p1.toSuiAddress(), sm.memeType);
    check("p1 holds SALE_M from its claim", p1Held > 0n, p1Held);
    const half = single((tx) => {
      const coin = tx.coin({ type: sm.memeType, balance: p1Held / 2n });
      tx.transferObjects([coin], w.p5.toSuiAddress());
    });
    await track("p1 sends half its tokens to p5", w.p1, half);
    await waitUntil(BigInt(Date.now()) + 45_000n, "time between holdings", 0);
    await track(
      "p6 buys with 0.004 SUI",
      w.p6,
      swap(sm, false, coins(0.004), w.p6),
    );
    await waitUntil(BigInt(Date.now()) + 45_000n, "time between holdings", 0);
    const p2Held = await balance(w.p2.toSuiAddress(), sm.memeType);
    await track(
      "p2 sells half its tokens",
      w.p2,
      swap(sm, true, p2Held / 2n, w.p2),
    );
    await waitUntil(BigInt(Date.now()) + 30_000n, "time between holdings", 0);
    await exec(
      "relayer collects the trades' fees into the holder share",
      w.relayer,
      single((tx) =>
        tx.add(
          presale.call.collectBluefinFees({
            ...types(sm),
            vault: mut(vault),
            bluefinConfig: { ...BLUEFIN.config, mutable: false },
            pool: mut(sm.pool as Shared),
          }),
        ),
      ),
    );
  }
  const funded = await presale.getVault(vault.objectId);
  check(
    "holder share funded",
    funded.holderRewardsMeme > 0n && funded.holderRewardsQuote > 0n,
    funded,
  );

  // 2. Replay every checkpoint from SALE_M's registration to now.
  const { checkpointHeight } = await client.ledgerService.getServiceInfo({})
    .response;
  const end = BigInt(checkpointHeight ?? 0n);
  const registration = await checkpointOfObjectCreation(sm.currency.objectId);
  const activation = await checkpointOfObjectCreation(vault.objectId);
  console.log(
    `  replaying checkpoints ${registration}..${end} (activation ${activation})`,
  );
  let ledger = createHolderLedger(sm.memeType, registration);
  for await (const checkpoint of checkpoints(sm.memeType, registration, end)) {
    ledger = applyHolderCheckpoint(ledger, checkpoint);
    if (checkpoint.sequence === activation) ledger = resetHolderWeights(ledger);
  }
  const weights = holderWeights(ledger, [vault.objectId]);
  record({ kind: "weights", weights });
  for (const { address, weight } of weights)
    console.log(`    ${address.slice(0, 10)}… weight ${weight}`);

  // 3. Independent replay from the token's own balance changes.
  const independent = await independentWeights(sm, activation, end, digests);
  equal(
    "ledger weights equal an independent replay",
    weights.map((h) => `${h.address}:${h.weight}`).join(","),
    independent.map((h) => `${h.address}:${h.weight}`).join(","),
  );
  const holders = new Set(weights.map((h) => h.address));
  for (const [name, key] of [
    ["p1", w.p1],
    ["p2", w.p2],
    ["p4", w.p4],
    ["p5", w.p5],
    ["p6", w.p6],
  ] as const) {
    check(
      `${name} is weighted`,
      holders.has(normalizeSuiAddress(key.toSuiAddress())),
    );
  }
  const weightOf = (key: Ed25519Keypair) =>
    weights.find((h) => h.address === normalizeSuiAddress(key.toSuiAddress()))
      ?.weight ?? 0n;
  check(
    "p5, given half of p1's tokens later, weighs less than p1",
    weightOf(w.p5) < weightOf(w.p1),
  );

  // 4. Allocate, publish, pay.
  const allocation = allocateHolderRewards(
    weights,
    funded.holderRewardsMeme,
    funded.holderRewardsQuote,
  );
  const total = weights.reduce((sum, h) => sum + h.weight, 0n);
  for (const a of allocation.allocations) {
    const weight =
      weights.find((h) => h.address === a.beneficiary)?.weight ?? 0n;
    equal(
      `${a.beneficiary.slice(0, 10)}… share is weight-proportional`,
      a.memeAmount,
      (funded.holderRewardsMeme * weight) / total,
    );
  }
  const manifest = buildRewardManifest({
    vaultId: vault.objectId,
    number: funded.nextRound,
    startCheckpoint: activation,
    endCheckpoint: end,
    allocations: allocation.allocations,
    leafDomain: PRESALE_REWARD_LEAF_DOMAIN,
  });
  const published = await exec(
    "admin publishes the computed round",
    deployer(),
    single((tx) =>
      tx.add(
        presale.call.publishHolderRewardRound({
          ...types(sm),
          vault: mut(vault),
          adminCap: ADMIN_CAP,
          manifest,
          claimDeadlineMs: BigInt(Date.now()) + 24n * 3_600_000n,
        }),
      ),
    ),
  );
  const roundId = created(
    published,
    `${DEPLOYMENT.originalPackageId}::holder_rewards::Round<`,
  );
  const round = {
    objectId: roundId,
    initialSharedVersion: sharedVersion(published, roundId),
  };
  const roundState = await getRound(roundId);
  const pending = pendingRewardAllocations(
    roundState,
    manifest,
    PRESALE_REWARD_LEAF_DOMAIN,
  );
  equal(
    "every allocation pending",
    pending.length,
    allocation.allocations.length,
  );
  const relay = new Transaction();
  for (const proof of pending) {
    relay.add(
      presale.call.claimHolderReward({
        ...types(sm),
        round: mut(round),
        allocation: proof,
      }),
    );
  }
  const paid = await exec(
    "relayer pays every holder in one transaction",
    w.relayer,
    relay,
  );
  for (const a of allocation.allocations) {
    equal(
      `${a.beneficiary.slice(0, 10)}… paid its tokens`,
      balanceChange(paid, a.beneficiary, sm.memeType),
      a.memeAmount,
    );
  }
  const after = await presale.getVault(vault.objectId);
  equal(
    "rounding dust stays in the vault",
    after.holderRewardsMeme,
    allocation.memeDust,
  );
  equal("next round advanced", after.nextRound, funded.nextRound + 1n);
}

async function checkpointOfObjectCreation(objectId: string): Promise<bigint> {
  const { object } = await client.ledgerService.getObject({
    objectId,
    readMask: { paths: ["previous_transaction", "owner"] },
  }).response;
  // Shared objects keep their creating transaction at the initial shared version.
  const initial = (object?.owner as { version?: bigint } | undefined)?.version;
  const atCreation = initial
    ? (
        await client.ledgerService.getObject({
          objectId,
          version: initial,
          readMask: { paths: ["previous_transaction"] },
        }).response
      ).object
    : object;
  const digest = atCreation?.previousTransaction;
  if (!digest) throw new Error(`no creating transaction for ${objectId}`);
  const { transaction } = await client.ledgerService.getTransaction({
    digest,
    readMask: { paths: ["checkpoint"] },
  }).response;
  if (transaction?.checkpoint === undefined) throw new Error("no checkpoint");
  return transaction.checkpoint;
}

/** Fetches checkpoints concurrently and yields them in order. */
async function* checkpoints(
  coinType: string,
  from: bigint,
  to: bigint,
): AsyncGenerator<HolderCheckpoint> {
  const window = 24n;
  for (let start = from; start <= to; start += window) {
    const last = start + window - 1n < to ? start + window - 1n : to;
    const batch = await Promise.all(
      Array.from({ length: Number(last - start + 1n) }, (_, i) =>
        retry(() => readHolderCheckpoint(client, coinType, start + BigInt(i))),
      ),
    );
    yield* batch;
    if ((start - from) % 2_400n === 0n)
      console.log(`    … checkpoint ${start}`);
  }
}

async function retry<T>(read: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (error) {
      if (i >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * i));
    }
  }
}

/**
 * Atomic-unit-milliseconds per holder from activation to `end`, built from the
 * balance changes of every transaction that touched the sale token, ignoring
 * the checkpoint ledger entirely.
 */
async function independentWeights(
  sm: SaleRecord,
  activation: bigint,
  end: bigint,
  extra: string[],
) {
  const events = await saleTokenChanges(sm.memeType, [
    ...extra,
    claimDigest(),
    ...e029Digests(),
  ]);
  const start = await checkpointTime(activation);
  const stop = await checkpointTime(end);
  const balances = new Map<string, bigint>();
  const weights = new Map<string, bigint>();
  const since = new Map<string, bigint>();
  for (const e of events.sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  )) {
    const before = balances.get(e.address) ?? 0n;
    const from = since.get(e.address) ?? start;
    const at = e.at < start ? start : e.at;
    weights.set(
      e.address,
      (weights.get(e.address) ?? 0n) +
        before * (at - (from < start ? start : from)),
    );
    balances.set(e.address, before + e.delta);
    since.set(e.address, at);
  }
  return [...balances.keys()]
    .sort()
    .map((address) => ({
      address,
      weight:
        (weights.get(address) ?? 0n) +
        (balances.get(address) ?? 0n) * (stop - (since.get(address) ?? start)),
    }))
    .filter((h) => h.weight > 0n && h.address !== normalizeSuiAddress("0x0"));
}

/** Every balance change of `coinType` in `digests`, with its execution time. */
async function saleTokenChanges(coinType: string, digests: string[]) {
  const changes: { at: bigint; address: string; delta: bigint }[] = [];
  for (const digest of new Set(digests)) {
    const { transaction } = await client.ledgerService.getTransaction({
      digest,
      readMask: { paths: ["balance_changes", "timestamp"] },
    }).response;
    const ts = transaction?.timestamp;
    const at =
      BigInt(ts?.seconds ?? 0n) * 1_000n +
      BigInt(Math.floor((ts?.nanos ?? 0) / 1e6));
    for (const change of transaction?.balanceChanges ?? []) {
      if (normalizeType(change.coinType ?? "") !== normalizeType(coinType))
        continue;
      changes.push({
        at,
        address: normalizeSuiAddress(change.address ?? "0x0"),
        delta: BigInt(change.amount ?? "0"),
      });
    }
  }
  return changes;
}

async function checkpointTime(sequence: bigint): Promise<bigint> {
  const { checkpoint } = await client.ledgerService.getCheckpoint({
    checkpointId: { oneofKind: "sequenceNumber", sequenceNumber: sequence },
    readMask: { paths: ["summary.timestamp"] },
  }).response;
  const ts = checkpoint?.summary?.timestamp;
  return (
    BigInt(ts?.seconds ?? 0n) * 1_000n +
    BigInt(Math.floor((ts?.nanos ?? 0) / 1e6))
  );
}

function normalizeType(type: string): string {
  return type.replace(/0x[0-9a-fA-F]+(?=::)/g, (address) =>
    normalizeSuiAddress(address),
  );
}

/** The presale round in the keeper's shape (`claimed`, numeric `leafCount`). */
async function getRound(roundId: string) {
  const round = await presale.getHolderRewardRound(roundId);
  return {
    vaultId: round.vaultId,
    number: round.number,
    root: round.root,
    leafCount: Number(round.leafCount),
    claimed: round.claimedBitmap,
  };
}

/** One exact-input Bluefin swap of `amount` from `trader`; the output returns to the trader. */
function swap(
  sm: SaleRecord,
  memeToQuote: boolean,
  amount: bigint,
  trader: Ed25519Keypair,
): Transaction {
  const tx = new Transaction();
  const [zero] = tx.moveCall({
    target: "0x2::coin::zero",
    typeArguments: [memeToQuote ? sm.quoteType : sm.memeType],
  });
  const input = tx.coin({
    type: memeToQuote ? sm.memeType : sm.quoteType,
    balance: amount,
  });
  tx.moveCall({
    target: `${BLUEFIN.packageId}::gateway::swap_assets`,
    typeArguments: [sm.memeType, sm.quoteType],
    arguments: [
      tx.object.clock(),
      tx.sharedObjectRef({ ...BLUEFIN.config, mutable: false }),
      tx.sharedObjectRef(mut(sm.pool as Shared)),
      memeToQuote ? input : (zero as TransactionArgument),
      memeToQuote ? (zero as TransactionArgument) : input,
      tx.pure.bool(memeToQuote),
      tx.pure.bool(true),
      tx.pure.u64(amount),
      tx.pure.u64(0),
      tx.pure.u128(memeToQuote ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n),
    ],
  });
  void trader;
  return tx;
}

/** The E2E-027 open-policy claim, the only earlier transaction that moved SALE_M coins. */
function claimDigest(): string {
  const directory = new URL("../runs/", import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => name.startsWith("e027-"))
    .sort()) {
    for (const line of readFileSync(new URL(file, directory), "utf8").split(
      "\n",
    )) {
      if (!line) continue;
      const entry = JSON.parse(line) as {
        kind: string;
        label?: string;
        digest?: string;
      };
      if (
        entry.kind === "tx" &&
        entry.label === "relayer claims for every participant" &&
        entry.digest
      ) {
        return entry.digest;
      }
    }
  }
  throw new Error("E2E-027 claim digest not found in runs/");
}

/** Every transaction any E2E-029 run executed, including runs that stopped early. */
function e029Digests(): string[] {
  const directory = new URL("../runs/", import.meta.url);
  const digests: string[] = [];
  for (const file of readdirSync(directory).filter((name) =>
    name.startsWith("e029-"),
  )) {
    for (const line of readFileSync(new URL(file, directory), "utf8").split(
      "\n",
    )) {
      if (!line) continue;
      const entry = JSON.parse(line) as { kind: string; digest?: string };
      if (entry.kind === "tx" && entry.digest) digests.push(entry.digest);
    }
  }
  return digests;
}
