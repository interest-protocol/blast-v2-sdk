import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import type { LpVaultState } from "../migrators/state.ts";
import { getLpVault } from "../migrators/state.ts";
import type { MigratorsDeployment } from "../migrators/transactions.ts";
import { MigratorTransactions } from "../migrators/transactions.ts";
import type { RewardManifest } from "./allocations.ts";
import {
  allocateHolderRewards,
  buildRewardManifest,
  rewardAddress,
} from "./allocations.ts";
import {
  coinPackageCreationCheckpoint,
  readHolderCheckpoint,
} from "./checkpoints.ts";
import type { HolderCheckpoint, HolderLedger } from "./holders.ts";
import {
  applyHolderCheckpoint,
  createHolderLedger,
  holderWeights,
  resetHolderWeights,
} from "./holders.ts";
import {
  assertRewardRoundMatchesManifest,
  pendingRewardAllocations,
} from "./keeper.ts";
import { getRewardRound } from "./state.ts";

const CHECKPOINT_BATCH_SIZE = 100;

type OperatorConfig = {
  grpcUrl: string;
  network: "mainnet" | "testnet" | "devnet" | "localnet";
  chainId: string;
  /** Call-ready migrators deployment, including its launchpad deployment. */
  deployment: MigratorsDeployment;
  /** The migrated launch's `LpVault`, whose rewards share funds every round. */
  vaultId: string;
  /** Blast `AdminCap<BLAST_FUN_DOMAIN>` that signs in to publish rounds. */
  adminCapId?: string;
  sender?: string;
  excludedAddresses?: string[];
};
type OperatorState = {
  chainId: string;
  vaultId: string;
  activationCheckpoint: string;
  ledger: HolderLedger;
};

/** Atomic replacement keeps the durable checkpoint watermark with the balances it describes. */
export async function writeOperatorJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(
      `${JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`,
    );
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Local single-writer lock. After a hard crash, an operator must remove the stale lock. */
export async function withOperatorLock<T>(
  directory: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true });
  const lock = join(directory, ".lock");
  try {
    await mkdir(lock);
  } catch (error) {
    throw new Error(`operator lock unavailable: ${lock}`, { cause: error });
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true });
  }
}

/** Node-only operator. Publication stays unsigned; only explicit relay --execute reads a gas key. */
export async function runHolderRewardsOperator(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      dir: { type: "string" },
      until: { type: "string" },
      round: { type: "string" },
      manifest: { type: "string" },
      out: { type: "string" },
      execute: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "holder-rewards <inspect|index|prepare|publish-tx|advance|relay> --config FILE --dir DIRECTORY [--until CHECKPOINT] [--round ID] [--manifest FILE] [--out FILE] [--execute]",
    );
    return;
  }
  const command = positionals[0];
  if (!values.config || !values.dir || !command || positionals.length !== 1)
    throw new Error("supply one command, --config and --dir; use --help");
  if (values.execute && command !== "relay")
    throw new Error("--execute is supported only for permissionless relay");
  const config = await readJson<OperatorConfig>(values.config);
  if (
    !config.chainId ||
    !config.grpcUrl ||
    !config.deployment ||
    !config.vaultId ||
    !["mainnet", "testnet", "devnet", "localnet"].includes(config.network)
  )
    throw new Error(
      "config needs grpcUrl, network, expected genesis chainId, deployment and vaultId",
    );
  const client = new SuiGrpcClient({
    baseUrl: config.grpcUrl,
    network: config.network,
  });
  const info = await client.ledgerService.getServiceInfo({}).response;
  if (info.chainId !== config.chainId)
    throw new Error("RPC chain does not match configured genesis chainId");
  const directory = resolve(values.dir);
  const transactions = new MigratorTransactions(config.deployment);
  const vault = await getLpVault(
    client,
    config.vaultId,
    transactions.call.deployment.originalPackageId,
  );
  const statePath = join(directory, "state.json");
  const pendingPath = join(directory, "pending.json");
  const pair = { memeType: vault.memeType, quoteType: vault.quoteType };
  const output = values.out ?? join(directory, `${command}.json`);

  const context: OperatorContext = {
    client,
    config,
    vault,
    transactions,
    directory,
    output,
    statePath,
    pendingPath,
    pair,
    values,
    command,
    checkpointHeight: info.checkpointHeight,
  };
  await withOperatorLock(directory, () => dispatchCommand(context));
  console.log(`${command} completed; artifacts: ${directory}`);
}

type OperatorOptions = {
  until?: string;
  round?: string;
  manifest?: string;
  execute?: boolean;
};
type OperatorContext = {
  client: SuiGrpcClient;
  config: OperatorConfig;
  vault: LpVaultState;
  transactions: MigratorTransactions;
  directory: string;
  output: string;
  statePath: string;
  pendingPath: string;
  pair: { memeType: string; quoteType: string };
  values: OperatorOptions;
  command: string;
  checkpointHeight: bigint | undefined;
};

async function dispatchCommand(context: OperatorContext): Promise<void> {
  switch (context.command) {
    case "inspect":
      return inspectVault(context);
    case "index":
      return indexHolders(context);
    case "prepare":
      return prepareRound(context);
    case "publish-tx":
      return publishRound(context);
    case "advance":
      return advanceRound(context);
    case "relay":
      return relayRewards(context);
    default:
      throw new Error(`unknown command: ${context.command}`);
  }
}
async function readManifest(context: OperatorContext): Promise<RewardManifest> {
  const manifest = await readJson<RewardManifest>(
    context.values.manifest ?? context.pendingPath,
  );
  if (manifest.vaultId !== context.vault.objectId)
    throw new Error("manifest belongs to another vault");
  return manifest;
}
async function readConfirmedRound(
  context: OperatorContext,
  manifest: RewardManifest,
) {
  if (!context.values.round)
    throw new Error("supply the confirmed --round object ID");
  const round = await getRewardRound(
    context.client,
    context.values.round,
    context.transactions.call.deployment.originalPackageId,
  );
  assertRewardRoundMatchesManifest(round, manifest);
  return round;
}
async function inspectVault(context: OperatorContext): Promise<void> {
  const { vault, output } = context;
  await writeOperatorJson(output, {
    vaultId: vault.objectId,
    memeType: vault.memeType,
    quoteType: vault.quoteType,
    generation: vault.generation,
    feeSplit: vault.feeSplit,
    rewardsMeme: vault.rewardsMeme,
    rewardsQuote: vault.rewardsQuote,
    nextRound: vault.nextRound,
    lastCheckpoint: vault.lastCheckpoint,
  });
}

async function indexHolders(context: OperatorContext): Promise<void> {
  const {
    values,
    pendingPath,
    statePath,
    client,
    config,
    vault,
    directory,
    checkpointHeight,
  } = context;
  if (!values.until || !/^\d+$/.test(values.until))
    throw new Error("index needs --until CHECKPOINT");
  if (await readOptional<RewardManifest>(pendingPath))
    throw new Error(
      "a prepared round is pending; confirm and advance before indexing further",
    );
  let state =
    (await readOptional<OperatorState>(statePath)) ??
    (await bootstrap(client, config, vault));
  assertState(state, config, vault);
  const until = BigInt(values.until);
  if (checkpointHeight === undefined || until > checkpointHeight)
    throw new Error("requested checkpoint is not finalized at this provider");
  // ponytail: bound replay and memory to 100 checkpoints; use a dedicated indexer if archival replay outgrows this keeper.
  let batch: HolderCheckpoint[] = [];
  while (BigInt(state.ledger.nextCheckpoint) <= until) {
    const checkpoint = await readHolderCheckpoint(
      client,
      vault.memeType,
      BigInt(state.ledger.nextCheckpoint),
    );
    let ledger = applyHolderCheckpoint(state.ledger, checkpoint);
    if (checkpoint.sequence === BigInt(state.activationCheckpoint))
      ledger = resetHolderWeights(ledger);
    state = { ...state, ledger };
    batch.push(checkpoint);
    if (
      batch.length === CHECKPOINT_BATCH_SIZE ||
      checkpoint.sequence === until
    ) {
      const first = batch[0];
      if (!first) throw new Error("empty checkpoint batch");
      // Journal first, then the matching durable watermark. Retry overwrites the same batch start.
      await writeOperatorJson(
        join(directory, "checkpoints", `batch-${first.sequence}.json`),
        batch,
      );
      await writeOperatorJson(statePath, state);
      batch = [];
    }
  }
}

async function prepareRound(context: OperatorContext): Promise<void> {
  const { pendingPath, statePath, config, vault, directory } = context;
  if (await readOptional<RewardManifest>(pendingPath))
    throw new Error("a prepared round already exists");
  const state = await readJson<OperatorState>(statePath);
  assertState(state, config, vault);
  const end = BigInt(state.ledger.nextCheckpoint) - 1n;
  if (
    end <= BigInt(state.activationCheckpoint) ||
    (vault.lastCheckpoint !== null &&
      vault.lastCheckpoint !== BigInt(state.ledger.startCheckpoint))
  )
    throw new Error(
      "ledger interval does not match vault; index or advance first",
    );
  const exclusions = [vault.objectId, ...(config.excludedAddresses ?? [])];
  const weights = holderWeights(state.ledger, exclusions);
  const allocation = allocateHolderRewards(
    weights,
    vault.rewardsMeme,
    vault.rewardsQuote,
  );
  if (!allocation.allocations.length)
    throw new Error(
      "no payable holder allocations; keep indexing and accumulate funds",
    );
  const manifest = buildRewardManifest({
    vaultId: vault.objectId,
    number: vault.nextRound,
    startCheckpoint: BigInt(state.ledger.startCheckpoint),
    endCheckpoint: end,
    allocations: allocation.allocations,
  });
  const roundDir = join(directory, "rounds", manifest.number);
  await writeOperatorJson(join(roundDir, "accounting.json"), {
    chainId: config.chainId,
    policy: "address-balance-time-v1",
    activationCheckpoint: state.activationCheckpoint,
    endDigest: state.ledger.lastDigest,
    excludedAddresses: exclusions,
    weights,
    state,
    memeDust: allocation.memeDust,
    quoteDust: allocation.quoteDust,
  });
  await writeOperatorJson(join(roundDir, "manifest.json"), manifest);
  await writeOperatorJson(pendingPath, manifest);
}

async function publishRound(context: OperatorContext): Promise<void> {
  const { config, transactions, pair, output, vault } = context;
  const manifest = await readManifest(context);
  if (!config.adminCapId) throw new Error("adminCapId required");
  const tx = transactions.publishHolderRewardRound({
    ...pair,
    vault,
    adminCapId: config.adminCapId,
    manifest,
  });
  await writeTransaction(output, tx, config.sender);
}

async function advanceRound(context: OperatorContext): Promise<void> {
  const { statePath, config, vault, directory, pendingPath } = context;
  const manifest = await readManifest(context);
  const round = await readConfirmedRound(context, manifest);
  const state = await readJson<OperatorState>(statePath);
  assertState(state, config, vault);
  if (BigInt(state.ledger.nextCheckpoint) - 1n !== round.endCheckpoint)
    throw new Error("round does not close this ledger checkpoint");
  // Repeating advance after a crash is safe: resetting a zero-weight interval is idempotent.
  await writeOperatorJson(statePath, {
    ...state,
    ledger: resetHolderWeights(state.ledger),
  });
  await writeOperatorJson(
    join(directory, "rounds", manifest.number, "publication.json"),
    { roundId: round.objectId, manifestDigest: round.manifestDigest },
  );
  await rm(pendingPath, { force: true });
}

async function relayRewards(context: OperatorContext): Promise<void> {
  const { values, transactions, pair, directory, config, client } = context;
  const manifest = await readManifest(context);
  const round = await readConfirmedRound(context, manifest);
  const pending = pendingRewardAllocations(round, manifest);
  const key = values.execute
    ? process.env.HOLDER_REWARDS_RELAYER_KEY
    : undefined;
  if (values.execute && !key)
    throw new Error(
      "relay --execute requires HOLDER_REWARDS_RELAYER_KEY (gas only)",
    );
  const signer = key ? Ed25519Keypair.fromSecretKey(key) : undefined;
  for (let offset = 0; offset < pending.length; offset += 10) {
    const batch = pending.slice(offset, offset + 10);
    const first = batch[0];
    if (!first) continue;
    const tx = transactions.claimHolderRewards({
      ...pair,
      round,
      allocations: batch,
    });
    const roundDir = join(directory, "rounds", manifest.number);
    if (!signer) {
      await writeTransaction(
        join(roundDir, `relay-${first.index}.json`),
        tx,
        config.sender,
      );
      continue;
    }
    const result = await client.core.signAndExecuteTransaction({
      transaction: tx,
      signer,
    });
    if (result.$kind === "FailedTransaction")
      throw new Error(
        `relay failed: ${result.FailedTransaction.digest}; rerun to refresh claimed bits`,
      );
    await client.core.waitForTransaction({ digest: result.Transaction.digest });
    await writeOperatorJson(join(roundDir, `receipt-${first.index}.json`), {
      digest: result.Transaction.digest,
    });
  }
}

async function bootstrap(
  client: SuiGrpcClient,
  config: OperatorConfig,
  vault: LpVaultState,
): Promise<OperatorState> {
  const first = await coinPackageCreationCheckpoint(client, vault.memeType);
  const { object } = await client.ledgerService.getObject({
    objectId: vault.objectId,
    version: BigInt(vault.initialSharedVersion),
    readMask: { paths: ["previous_transaction"] },
  }).response;
  if (!object?.previousTransaction)
    throw new Error("vault creation history is unavailable");
  const { transaction } = await client.ledgerService.getTransaction({
    digest: object.previousTransaction,
    readMask: { paths: ["checkpoint"] },
  }).response;
  if (transaction?.checkpoint === undefined || transaction.checkpoint < first)
    throw new Error("invalid vault activation checkpoint");
  return {
    chainId: config.chainId,
    vaultId: vault.objectId,
    activationCheckpoint: transaction.checkpoint.toString(),
    ledger: createHolderLedger(vault.memeType, first),
  };
}
function assertState(
  state: OperatorState,
  config: OperatorConfig,
  vault: LpVaultState,
) {
  if (
    state.chainId !== config.chainId ||
    state.vaultId !== vault.objectId ||
    state.ledger.coinType !== vault.memeType
  )
    throw new Error("operator state belongs to another chain, vault or coin");
}
async function writeTransaction(
  path: string,
  tx: Transaction,
  sender?: string,
) {
  if (sender) tx.setSender(rewardAddress(sender));
  await writeOperatorJson(path, { transaction: await tx.toJSON() });
}
async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
async function readOptional<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
