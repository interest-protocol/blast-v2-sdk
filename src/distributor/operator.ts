import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { getLaunch } from "../launchpad/state.ts";
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
import type { DistributorState } from "./state.ts";
import {
  getDistributor,
  getDistributorVersion,
  getRewardRound,
} from "./state.ts";
import { DistributorCalls } from "./transactions.ts";

const CHECKPOINT_BATCH_SIZE = 100;

type OperatorConfig = {
  grpcUrl: string;
  network: "mainnet" | "testnet" | "devnet" | "localnet";
  chainId: string;
  packageId: string;
  originalPackageId: string;
  distributorVersionId: string;
  launchpadOriginalPackageId: string;
  distributorId: string;
  publisherCapId?: string;
  packageVersionId?: string;
  migratorsVersionId?: string;
  lpVaultId?: string;
  sender?: string;
  excludedAddresses?: string[];
};
type OperatorState = {
  chainId: string;
  distributorId: string;
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
export async function runDistributorOperator(args: string[]): Promise<void> {
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
      "distributor <inspect|index|prepare|publish-tx|collect-curve-tx|collect-lp-tx|advance|relay> --config FILE --dir DIRECTORY [--until CHECKPOINT] [--round ID] [--manifest FILE] [--out FILE] [--execute]",
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
    !config.originalPackageId ||
    !config.distributorVersionId ||
    !["mainnet", "testnet", "devnet", "localnet"].includes(config.network)
  )
    throw new Error(
      "config needs grpcUrl, network, expected genesis chainId, originalPackageId and distributorVersionId",
    );
  const client = new SuiGrpcClient({
    baseUrl: config.grpcUrl,
    network: config.network,
  });
  const info = await client.ledgerService.getServiceInfo({}).response;
  if (info.chainId !== config.chainId)
    throw new Error("RPC chain does not match configured genesis chainId");
  const directory = resolve(values.dir);
  const calls = new DistributorCalls({
    packageId: config.packageId,
    packageVersion: config.distributorVersionId,
  });
  const distributor = await getDistributor(
    client,
    config.distributorId,
    config.originalPackageId,
  );
  const statePath = join(directory, "state.json");
  const pendingPath = join(directory, "pending.json");
  const pair = {
    memeType: distributor.memeType,
    quoteType: distributor.quoteType,
  };
  const output = values.out ?? join(directory, `${command}.json`);

  const context: OperatorContext = {
    client,
    config,
    distributor,
    calls,
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
  distributor: DistributorState;
  calls: DistributorCalls;
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
      return inspectDistributor(context);
    case "collect-curve-tx":
    case "collect-lp-tx":
      return collectFees(context);
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
  if (manifest.distributorId !== context.distributor.objectId)
    throw new Error("manifest belongs to another distributor");
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
    context.config.originalPackageId,
  );
  assertRewardRoundMatchesManifest(round, manifest);
  return round;
}
async function inspectDistributor(context: OperatorContext): Promise<void> {
  const { client, distributor, config, output } = context;
  const launch = await getLaunch(
    client,
    distributor.launchId,
    config.launchpadOriginalPackageId,
  );
  const { curveFeeAuthority } = launch;
  const version = await getDistributorVersion(
    client,
    config.distributorVersionId,
    config.originalPackageId,
  );
  await writeOperatorJson(output, {
    activeVersion: version.version,
    paused: version.paused,
    distributorId: distributor.objectId,
    launchId: distributor.launchId,
    curveFeeAuthority,
    curveFeesBoundToDistributor:
      curveFeeAuthority.kind === "custodian" &&
      curveFeeAuthority.custodianId === distributor.objectId,
    memeType: distributor.memeType,
    quoteType: distributor.quoteType,
    memeAmount: distributor.memeAmount,
    quoteAmount: distributor.quoteAmount,
    nextRound: distributor.nextRound,
    lastCheckpoint: distributor.lastCheckpoint,
  });
}

async function collectFees(context: OperatorContext): Promise<void> {
  const { command, config, calls, pair, distributor, output } = context;
  const tx = new Transaction();
  if (command === "collect-curve-tx") {
    if (!config.packageVersionId) throw new Error("packageVersionId required");
    tx.add(
      calls.collectCurveFees({
        ...pair,
        distributor: distributor.objectId,
        launch: distributor.launchId,
        packageVersion: config.packageVersionId,
      }),
    );
  } else {
    if (!config.lpVaultId)
      throw new Error(
        "lpVaultId required; verify it against the launch migration event",
      );
    if (!config.migratorsVersionId)
      throw new Error("migratorsVersionId required");
    tx.add(
      calls.collectLpFees({
        ...pair,
        distributor: distributor.objectId,
        lpVault: config.lpVaultId,
        migratorsVersion: config.migratorsVersionId,
      }),
    );
  }
  await writeTransaction(output, tx, config.sender);
}

async function indexHolders(context: OperatorContext): Promise<void> {
  const {
    values,
    pendingPath,
    statePath,
    client,
    config,
    distributor,
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
    (await bootstrap(client, config, distributor));
  assertState(state, config, distributor);
  const until = BigInt(values.until);
  if (checkpointHeight === undefined || until > checkpointHeight)
    throw new Error("requested checkpoint is not finalized at this provider");
  // ponytail: bound replay and memory to 100 checkpoints; use a dedicated indexer if archival replay outgrows this keeper.
  let batch: HolderCheckpoint[] = [];
  while (BigInt(state.ledger.nextCheckpoint) <= until) {
    const checkpoint = await readHolderCheckpoint(
      client,
      distributor.memeType,
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
  const { pendingPath, statePath, config, distributor, directory } = context;
  if (await readOptional<RewardManifest>(pendingPath))
    throw new Error("a prepared round already exists");
  const state = await readJson<OperatorState>(statePath);
  assertState(state, config, distributor);
  const end = BigInt(state.ledger.nextCheckpoint) - 1n;
  if (
    end <= BigInt(state.activationCheckpoint) ||
    (distributor.lastCheckpoint !== null &&
      distributor.lastCheckpoint !== BigInt(state.ledger.startCheckpoint))
  )
    throw new Error(
      "ledger interval does not match distributor; index or advance first",
    );
  const exclusions = [
    distributor.objectId,
    distributor.launchId,
    ...(config.lpVaultId ? [config.lpVaultId] : []),
    ...(config.excludedAddresses ?? []),
  ];
  const weights = holderWeights(state.ledger, exclusions);
  const allocation = allocateHolderRewards(
    weights,
    distributor.memeAmount,
    distributor.quoteAmount,
  );
  if (!allocation.allocations.length)
    throw new Error(
      "no payable holder allocations; keep indexing and accumulate funds",
    );
  const manifest = buildRewardManifest({
    distributorId: distributor.objectId,
    number: distributor.nextRound,
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
  const { config, calls, pair, output } = context;
  const manifest = await readManifest(context);
  if (!config.publisherCapId) throw new Error("publisherCapId required");
  const tx = new Transaction();
  const round = tx.add(
    calls.publishRound({
      ...pair,
      publisherCap: config.publisherCapId,
      manifest,
    }),
  );
  tx.add(calls.shareRound({ ...pair, round }));
  await writeTransaction(output, tx, config.sender);
}

async function advanceRound(context: OperatorContext): Promise<void> {
  const { statePath, config, distributor, directory, pendingPath } = context;
  const manifest = await readManifest(context);
  const round = await readConfirmedRound(context, manifest);
  const state = await readJson<OperatorState>(statePath);
  assertState(state, config, distributor);
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
  const { values, calls, pair, directory, config, client } = context;
  const manifest = await readManifest(context);
  const round = await readConfirmedRound(context, manifest);
  const pending = pendingRewardAllocations(round, manifest);
  const key = values.execute ? process.env.DISTRIBUTOR_RELAYER_KEY : undefined;
  if (values.execute && !key)
    throw new Error(
      "relay --execute requires DISTRIBUTOR_RELAYER_KEY (gas only)",
    );
  const signer = key ? Ed25519Keypair.fromSecretKey(key) : undefined;
  for (let offset = 0; offset < pending.length; offset += 10) {
    const batch = pending.slice(offset, offset + 10);
    const first = batch[0];
    if (!first) continue;
    const tx = new Transaction();
    for (const allocation of batch)
      tx.add(calls.claim({ ...pair, round: round.objectId, allocation }));
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
  distributor: DistributorState,
): Promise<OperatorState> {
  const first = await coinPackageCreationCheckpoint(
    client,
    distributor.memeType,
  );
  const { object } = await client.ledgerService.getObject({
    objectId: distributor.objectId,
    version: BigInt(distributor.initialSharedVersion),
    readMask: { paths: ["previous_transaction"] },
  }).response;
  if (!object?.previousTransaction)
    throw new Error("distributor creation history is unavailable");
  const { transaction } = await client.ledgerService.getTransaction({
    digest: object.previousTransaction,
    readMask: { paths: ["checkpoint"] },
  }).response;
  if (transaction?.checkpoint === undefined || transaction.checkpoint < first)
    throw new Error("invalid distributor activation checkpoint");
  return {
    chainId: config.chainId,
    distributorId: distributor.objectId,
    activationCheckpoint: transaction.checkpoint.toString(),
    ledger: createHolderLedger(distributor.memeType, first),
  };
}
function assertState(
  state: OperatorState,
  config: OperatorConfig,
  distributor: DistributorState,
) {
  if (
    state.chainId !== config.chainId ||
    state.distributorId !== distributor.objectId ||
    state.ledger.coinType !== distributor.memeType
  )
    throw new Error(
      "operator state belongs to another chain, distributor or coin",
    );
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
