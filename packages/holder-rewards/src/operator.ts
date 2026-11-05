import type {
  RewardManifest,
  RewardProof,
} from "@interest-protocol/blast-core/rewards/allocations";
import {
  allocateHolderRewards,
  buildRewardManifest,
  rewardAddress,
  validateRewardManifest,
} from "@interest-protocol/blast-core/rewards/allocations";
import {
  coinPackageCreationCheckpoint,
  readHolderCheckpoint,
} from "@interest-protocol/blast-core/rewards/checkpoints";
import type {
  HolderCheckpoint,
  HolderLedger,
} from "@interest-protocol/blast-core/rewards/holders";
import {
  applyHolderCheckpoint,
  createHolderLedger,
  holderWeights,
  resetHolderWeights,
} from "@interest-protocol/blast-core/rewards/holders";
import {
  assertRoundMatchesManifest,
  pendingRewardAllocations,
} from "@interest-protocol/blast-vault-sdk/reducer";
import type {
  RoundState,
  VaultState,
} from "@interest-protocol/blast-vault-sdk/state";
import {
  decodeVaultObject,
  getRound,
} from "@interest-protocol/blast-vault-sdk/state";
import type { VaultDeployment } from "@interest-protocol/blast-vault-sdk/transactions";
import { VaultTransactions } from "@interest-protocol/blast-vault-sdk/transactions";
import type { Signer } from "@mysten/sui/cryptography";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Transaction } from "@mysten/sui/transactions";
import { fromHex } from "@mysten/sui/utils";

const CHECKPOINT_BATCH_SIZE = 100;
const RELAY_BATCH_SIZE = 10;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Durable operator state for one vault, supplied by the deployment: files for
 * a single-host CLI, a database for a service. Keys are `/`-separated paths
 * such as `state` or `rounds/0/manifest`; values arrive JSON-safe, with every
 * `bigint` already a decimal string.
 */
export type HolderRewardsStore = {
  /** Resolves `undefined` for a key that was never written or was removed. */
  read(key: string): Promise<JsonValue | undefined>;
  /** Must replace the whole value atomically and durably before resolving. */
  write(key: string, value: JsonValue): Promise<void>;
  /** Removing an absent key is a no-op. */
  remove(key: string): Promise<void>;
  /** Must exclude every other writer of this store, across processes and hosts, while `action` runs. */
  withLock<T>(action: () => Promise<T>): Promise<T>;
};

export type HolderRewardsOperatorConfig = {
  /** Expected genesis checkpoint digest; every command rejects another chain. */
  chainId: string;
  /** Call-ready `blast_vault` deployment (`vaultDeployment(blast)`). */
  vault: VaultDeployment;
  /**
   * The launch's or presale's `vault::Vault`, whose holder-rewards route
   * funds every round; take it from verified history (`VaultCreated`) or
   * `vaultId`.
   */
  vaultId: string;
  /**
   * Blast `blast_acl::AdminCap` that signs in to schedule a round: it must
   * hold `blast_core::blast_domain::RewardsAdmin`.
   */
  adminCapId?: string;
  /**
   * Claims stay open this many milliseconds after the round is published.
   * `publish-tx` schedules the round and, while the vault's round notice is
   * zero, publishes it in the same PTB. Vaults start at a two-hour notice, so
   * `publish-tx` usually runs twice: once to schedule, then, once the notice
   * has passed, to build the permissionless publication of that round.
   */
  claimWindowMs?: string;
  /**
   * Explicit per-publication Quote gas reserve; zero chooses Blast-paid gas.
   * The contracts cap it at 10% of the round's holder Quote.
   */
  gasReserveAmount?: string;
  /** Explicit governed treasury expected by this publication. */
  expectedTreasury?: string;
  /** Sender set on unsigned publication and relay transactions. */
  sender?: string;
  excludedAddresses?: string[];
};

export type HolderRewardsRelay = {
  roundNumber: string;
  /** Up to ten unpaid claims each; `digest` is set once a signer executed the batch. */
  batches: { firstIndex: string; transaction: Transaction; digest?: string }[];
};

/** Holder-rewards keeper over a caller-supplied store. Every command holds the store lock. */
export type HolderRewardsOperator = {
  /** The vault's reward balances, round cursor, and sale. */
  inspect(): Promise<Record<string, unknown>>;
  /** Replays finalized checkpoints through `until` into the stored ledger. */
  index(until: bigint): Promise<void>;
  /** Freezes the indexed interval into the pending manifest and its accounting. */
  prepare(): Promise<RewardManifest>;
  /**
   * Unsigned next step for `manifest`, or the pending manifest when omitted:
   * its publication once it is the vault's scheduled round, else its schedule.
   */
  publishTransaction(manifest?: RewardManifest): Promise<Transaction>;
  /** After `roundId` confirms, closes its interval and clears the pending manifest. */
  advance(roundId: string, manifest?: RewardManifest): Promise<void>;
  /** Claims every unpaid leaf: unsigned without `signer`; with it, executes and records receipts. */
  relay(
    roundId: string,
    options?: {
      manifest?: RewardManifest | undefined;
      signer?: Signer | undefined;
    },
  ): Promise<HolderRewardsRelay>;
};

type OperatorState = {
  chainId: string;
  vaultId: string;
  activationCheckpoint: string;
  ledger: HolderLedger;
};

type OperatorContext = {
  client: SuiGrpcClient;
  config: HolderRewardsOperatorConfig;
  store: HolderRewardsStore;
  vault: VaultState;
  transactions: VaultTransactions;
  checkpointHeight: bigint | undefined;
};

export function holderRewardsOperator(
  client: SuiGrpcClient,
  config: HolderRewardsOperatorConfig,
  store: HolderRewardsStore,
): HolderRewardsOperator {
  const run = <T>(action: (context: OperatorContext) => Promise<T>) =>
    store.withLock(async () =>
      action(await openContext(client, config, store)),
    );
  return {
    inspect: () => run(async ({ vault }) => inspectVault(vault)),
    index: (until) => run((context) => indexHolders(context, until)),
    prepare: () => run(prepareRound),
    publishTransaction: (manifest) =>
      run((context) => publishRound(context, manifest)),
    advance: (roundId, manifest) =>
      run((context) => advanceRound(context, roundId, manifest)),
    relay: (roundId, options = {}) =>
      run((context) => relayRewards(context, roundId, options)),
  };
}

/** Reads the vault fresh under the lock, after rejecting a provider on another chain. */
async function openContext(
  client: SuiGrpcClient,
  config: HolderRewardsOperatorConfig,
  store: HolderRewardsStore,
): Promise<OperatorContext> {
  const info = await client.ledgerService.getServiceInfo({}).response;
  if (info.chainId !== config.chainId)
    throw new Error("RPC chain does not match configured genesis chainId");
  const transactions = new VaultTransactions(config.vault);
  return {
    client,
    config,
    store,
    vault: await readVault(client, transactions, config.vaultId),
    transactions,
    checkpointHeight: info.checkpointHeight,
  };
}

async function readManifest(
  context: OperatorContext,
  supplied: RewardManifest | undefined,
): Promise<RewardManifest> {
  const manifest =
    supplied ??
    ((await context.store.read("pending")) as RewardManifest | undefined);
  if (!manifest)
    throw new Error("no pending manifest; prepare a round or supply one");
  if (manifest.vaultId !== context.vault.objectId)
    throw new Error("manifest belongs to another vault");
  return manifest;
}
async function readConfirmedRound(
  context: OperatorContext,
  roundId: string,
  manifest: RewardManifest,
) {
  if (!roundId) throw new Error("supply the confirmed round object ID");
  const round = await getRound(
    context.client,
    roundId,
    context.transactions.call.deployment,
  );
  if (
    round.memeType !== context.vault.memeType ||
    round.quoteType !== context.vault.quoteType
  )
    throw new Error("round pays another coin pair");
  // The round commits only its root: check the manifest's own leaves and proofs first.
  validateRewardManifest(manifest);
  assertRoundMatchesManifest(round, manifest);
  return round;
}
async function readState(context: OperatorContext): Promise<OperatorState> {
  const state = (await context.store.read("state")) as
    | OperatorState
    | undefined;
  if (!state) throw new Error("no indexed ledger; index first");
  assertState(state, context.config, context.vault);
  return state;
}
function inspectVault(vault: VaultState): Record<string, unknown> {
  return {
    vaultId: vault.objectId,
    memeType: vault.memeType,
    quoteType: vault.quoteType,
    origin: vault.terms.origin,
    packageWitness: vault.terms.packageWitness,
    poolId: vault.poolId,
    rewardsMeme: vault.rewardsMeme,
    rewardsQuote: vault.rewardsQuote,
    nextRound: vault.nextRound,
    lastCheckpoint: vault.lastCheckpoint,
  };
}

async function indexHolders(
  context: OperatorContext,
  until: bigint,
): Promise<void> {
  const { store, client, config, vault, checkpointHeight } = context;
  if (await store.read("pending"))
    throw new Error(
      "a prepared round is pending; confirm and advance before indexing further",
    );
  let state =
    ((await store.read("state")) as OperatorState | undefined) ??
    (await bootstrap(client, config, vault));
  assertState(state, config, vault);
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
      await write(store, `checkpoints/batch-${first.sequence}`, batch);
      await write(store, "state", state);
      batch = [];
    }
  }
}

async function prepareRound(context: OperatorContext): Promise<RewardManifest> {
  const { store, config, vault } = context;
  if (await store.read("pending"))
    throw new Error("a prepared round already exists");
  const state = await readState(context);
  const start = BigInt(state.ledger.startCheckpoint);
  const end = BigInt(state.ledger.nextCheckpoint) - 1n;
  if (
    end <= BigInt(state.activationCheckpoint) ||
    (vault.lastCheckpoint !== null && vault.lastCheckpoint > start)
  )
    throw new Error(
      "ledger interval does not match vault; index or advance first",
    );
  const exclusions = [vault.objectId, ...(config.excludedAddresses ?? [])];
  const weights = holderWeights(state.ledger, exclusions);
  const reserveText = config.gasReserveAmount ?? "0";
  if (
    !/^(0|[1-9][0-9]*)$/.test(reserveText) ||
    BigInt(reserveText) > (1n << 64n) - 1n
  )
    throw new RangeError("gasReserveAmount must be a u64");
  const reserve = BigInt(reserveText);
  if (reserve < 0n || reserve > vault.rewardsQuote)
    throw new RangeError("gas reserve exceeds unallocated Quote");
  const allocation = allocateHolderRewards(
    weights,
    vault.rewardsMeme,
    vault.rewardsQuote - reserve,
  );
  if (!allocation.allocations.length)
    throw new Error(
      "no payable holder allocations; keep indexing and accumulate funds",
    );
  const manifest = buildRewardManifest({
    vaultId: vault.objectId,
    number: vault.nextRound,
    startCheckpoint: start,
    endCheckpoint: end,
    allocations: allocation.allocations,
  });
  const round = `rounds/${manifest.number}`;
  await write(store, `${round}/accounting`, {
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
  await write(store, `${round}/manifest`, manifest);
  await write(store, "pending", manifest);
  return manifest;
}

async function publishRound(
  context: OperatorContext,
  supplied: RewardManifest | undefined,
): Promise<Transaction> {
  const { config, vault, transactions } = context;
  const manifest = validateRewardManifest(
    await readManifest(context, supplied),
  );
  const target = {
    memeType: vault.memeType,
    quoteType: vault.quoteType,
    vault,
  };
  if (isScheduled(vault, manifest))
    return withSender(transactions.publishRound(target), config);
  if (!config.adminCapId) throw new Error("adminCapId required");
  const round = {
    ...target,
    adminCapId: config.adminCapId,
    number: BigInt(manifest.number),
    startCheckpoint: BigInt(manifest.startCheckpoint),
    endCheckpoint: BigInt(manifest.endCheckpoint),
    root: fromHex(manifest.root),
    manifestDigest: fromHex(manifest.manifestDigest),
    leafCount: BigInt(manifest.allocations.length),
    memeAmount: BigInt(manifest.memeAmount),
    quoteAmount: BigInt(manifest.quoteAmount),
    ...roundTerms(config),
  };
  // A scheduled round waits the vault's round notice; at zero it publishes in the same PTB.
  return withSender(
    vault.roundDelayMs === 0n
      ? transactions.scheduleAndPublishRound(round)
      : transactions.scheduleRound(round),
    config,
  );
}

async function advanceRound(
  context: OperatorContext,
  roundId: string,
  supplied: RewardManifest | undefined,
): Promise<void> {
  const { store, vault } = context;
  const manifest = await readManifest(context, supplied);
  const round = await readConfirmedRound(context, roundId, manifest);
  const state = await readState(context);
  const end = BigInt(state.ledger.nextCheckpoint) - 1n;
  // Publication moved the vault's last checkpoint to the round's end.
  if (end !== BigInt(manifest.endCheckpoint) || vault.lastCheckpoint !== end)
    throw new Error("round does not close this ledger checkpoint");
  // Repeating advance after a crash is safe: resetting a zero-weight interval is idempotent.
  await write(store, "state", {
    ...state,
    ledger: resetHolderWeights(state.ledger),
  });
  await write(store, `rounds/${manifest.number}/publication`, {
    roundId: round.objectId,
    manifestDigest: manifest.manifestDigest,
  });
  await store.remove("pending");
}

async function relayRewards(
  context: OperatorContext,
  roundId: string,
  options: {
    manifest?: RewardManifest | undefined;
    signer?: Signer | undefined;
  },
): Promise<HolderRewardsRelay> {
  const { transactions, config, client, store } = context;
  const { signer } = options;
  const manifest = await readManifest(context, options.manifest);
  const round = await readConfirmedRound(context, roundId, manifest);
  const pending = pendingRewardAllocations(round, manifest);
  const relay: HolderRewardsRelay = {
    roundNumber: manifest.number,
    batches: [],
  };
  for (let offset = 0; offset < pending.length; offset += RELAY_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + RELAY_BATCH_SIZE);
    const first = batch[0];
    if (!first) continue;
    const transaction = claimTransaction(transactions, round, batch);
    if (!signer) {
      relay.batches.push({
        firstIndex: first.index,
        transaction: withSender(transaction, config),
      });
      continue;
    }
    const result = await client.core.signAndExecuteTransaction({
      transaction,
      signer,
    });
    if (result.$kind === "FailedTransaction")
      throw new Error(
        `relay failed: ${result.FailedTransaction.digest}; rerun to refresh claimed bits`,
      );
    const { digest } = result.Transaction;
    await client.core.waitForTransaction({ digest });
    await write(store, `rounds/${manifest.number}/receipt-${first.index}`, {
      digest,
    });
    relay.batches.push({ firstIndex: first.index, transaction, digest });
  }
  return relay;
}

async function bootstrap(
  client: SuiGrpcClient,
  config: HolderRewardsOperatorConfig,
  vault: VaultState,
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
  config: HolderRewardsOperatorConfig,
  vault: VaultState,
) {
  if (
    state.chainId !== config.chainId ||
    state.vaultId !== vault.objectId ||
    state.ledger.coinType !== vault.memeType
  )
    throw new Error("operator state belongs to another chain, vault or coin");
}
function withSender(
  tx: Transaction,
  config: HolderRewardsOperatorConfig,
): Transaction {
  if (config.sender) tx.setSender(rewardAddress(config.sender));
  return tx;
}
/** Stores receive JSON-safe values: `bigint` becomes its decimal string. */
function write(
  store: HolderRewardsStore,
  key: string,
  value: unknown,
): Promise<void> {
  return store.write(
    key,
    JSON.parse(
      JSON.stringify(value, (_, item) =>
        typeof item === "bigint" ? item.toString() : item,
      ),
    ),
  );
}

/** The configured terms a round schedule needs; all three are explicit. */
function roundTerms(config: HolderRewardsOperatorConfig) {
  if (!config.claimWindowMs || !/^\d+$/.test(config.claimWindowMs))
    throw new Error("publish-tx needs claimWindowMs");
  if (
    config.gasReserveAmount === undefined ||
    !/^(0|[1-9][0-9]*)$/.test(config.gasReserveAmount)
  )
    throw new Error(
      "publish-tx needs explicit gasReserveAmount (0 disables reimbursement)",
    );
  if (config.expectedTreasury === undefined)
    throw new Error("publish-tx needs explicit expectedTreasury");
  return {
    claimWindowDurationMs: BigInt(config.claimWindowMs),
    gasReserveAmount: BigInt(config.gasReserveAmount),
    expectedTreasury: rewardAddress(config.expectedTreasury),
  };
}

/** True when `manifest` is the round already waiting in the vault's publication slot. */
function isScheduled(vault: VaultState, manifest: RewardManifest): boolean {
  const change = vault.pendingRoundPublication?.value;
  return (
    change?.kind === "Action" &&
    change.action.manifest_digest === manifest.manifestDigest
  );
}

/** One PTB of `holder_rewards::claim` calls, one per unpaid leaf. */
function claimTransaction(
  transactions: VaultTransactions,
  round: RoundState,
  allocations: readonly RewardProof[],
): Transaction {
  return transactions.claimRewards({
    memeType: round.memeType,
    quoteType: round.quoteType,
    round,
    leaves: allocations.map((allocation) => ({
      index: BigInt(allocation.index),
      beneficiary: allocation.beneficiary,
      memeAmount: BigInt(allocation.memeAmount),
      quoteAmount: BigInt(allocation.quoteAmount),
      proof: allocation.proof.map((sibling) => fromHex(sibling)),
    })),
  });
}

/** Reads the configured shared `vault::Vault<Meme, Quote>`. */
async function readVault(
  client: SuiGrpcClient,
  transactions: VaultTransactions,
  vaultId: string,
): Promise<VaultState> {
  const { object } = await client.core.getObject({
    objectId: rewardAddress(vaultId),
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared")
    throw new Error("the vault must be a shared object");
  return decodeVaultObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      type: object.type,
      content: object.content,
    },
    transactions.call.deployment,
  );
}
