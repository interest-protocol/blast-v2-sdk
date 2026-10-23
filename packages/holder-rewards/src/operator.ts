import type {
  RewardLeafDomain,
  RewardManifest,
  RewardProof,
} from "@interest-protocol/blast-core/rewards/allocations";
import {
  allocateHolderRewards,
  buildRewardManifest,
  MIGRATOR_REWARD_LEAF_DOMAIN,
  PRESALE_REWARD_LEAF_DOMAIN,
  rewardAddress,
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
  assertRewardRoundMatchesManifest,
  pendingRewardAllocations,
} from "@interest-protocol/blast-core/rewards/keeper";
import { getRewardRound } from "@interest-protocol/blast-core/rewards/state";
import type { SharedObjectReference } from "@interest-protocol/blast-core/sui";
import { getLpVault } from "@interest-protocol/blast-migrators-sdk/state";
import type { MigratorsDeployment } from "@interest-protocol/blast-migrators-sdk/transactions";
import { MigratorTransactions } from "@interest-protocol/blast-migrators-sdk/transactions";
import {
  getPresaleRewardRound,
  getPresaleVault,
} from "@interest-protocol/blast-presale-sdk/state";
import type { PresaleDeployment } from "@interest-protocol/blast-presale-sdk/transactions";
import { PresaleTransactions } from "@interest-protocol/blast-presale-sdk/transactions";
import type { Signer } from "@mysten/sui/cryptography";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Transaction } from "@mysten/sui/transactions";

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
  /** The package whose vault funds the rounds; `migrators` when omitted. */
  product?: "migrators" | "presale";
  /**
   * Call-ready deployment of that product: `MigratorsDeployment` (including
   * its launchpad deployment) or `PresaleDeployment`.
   */
  deployment: MigratorsDeployment | PresaleDeployment;
  /** The migrated launch's `LpVault` or presale package's `Vault`, whose holder share funds every round. */
  vaultId: string;
  /**
   * Blast `blast_acl::AdminCap` that signs in to publish: holding the
   * launchpad's `RewardsAdmin` role for migrators, or the presale's
   * `blast_presale_domain::RewardsAdmin` role for a presale.
   */
  adminCapId?: string;
  /** Presale only: claims stay open this many milliseconds after `publishTransaction` builds the round. */
  claimWindowMs?: string;
  /** Explicit per-publication Quote gas reserve; zero chooses Blast-paid gas. */
  gasReserveAmount?: string;
  /** Presale only: explicit governed treasury expected by this publication. */
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
  /** The vault's reward balances, round cursor, and product summary. */
  inspect(): Promise<Record<string, unknown>>;
  /** Replays finalized checkpoints through `until` into the stored ledger. */
  index(until: bigint): Promise<void>;
  /** Freezes the indexed interval into the pending manifest and its accounting. */
  prepare(): Promise<RewardManifest>;
  /** Unsigned publication of `manifest`, or of the pending manifest when omitted. */
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

/** The vault fields every product's rounds read. */
type RewardsVault = SharedObjectReference<true> & {
  memeType: string;
  quoteType: string;
  rewardsMeme: bigint;
  rewardsQuote: bigint;
  nextRound: bigint;
  lastCheckpoint: bigint | null;
  summary: Record<string, unknown>;
};
/** A funded round in the keeper's shape. */
type RewardsRound = SharedObjectReference<true> & {
  vaultId: string;
  number: bigint;
  root: string;
  leafCount: number;
  claimed: bigint[];
};
/** One product's vault, leaf domain, round reader, and transaction builders. */
type RewardsProduct = {
  leafDomain: RewardLeafDomain;
  vault: RewardsVault;
  readRound(roundId: string): Promise<RewardsRound>;
  publish(manifest: RewardManifest, adminCapId: string): Transaction;
  claim(round: RewardsRound, allocations: readonly RewardProof[]): Transaction;
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
  vault: RewardsVault;
  product: RewardsProduct;
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
  const product = await loadProduct(client, config);
  return {
    client,
    config,
    store,
    vault: product.vault,
    product,
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
  const round = await context.product.readRound(roundId);
  assertRewardRoundMatchesManifest(round, manifest, context.product.leafDomain);
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
function inspectVault(vault: RewardsVault): Record<string, unknown> {
  return {
    vaultId: vault.objectId,
    memeType: vault.memeType,
    quoteType: vault.quoteType,
    ...vault.summary,
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
  const { store, config, vault, product } = context;
  if (await store.read("pending"))
    throw new Error("a prepared round already exists");
  const state = await readState(context);
  const start = BigInt(state.ledger.startCheckpoint);
  const end = BigInt(state.ledger.nextCheckpoint) - 1n;
  if (
    end <= BigInt(state.activationCheckpoint) ||
    (vault.lastCheckpoint !== null &&
      (config.product === "presale"
        ? vault.lastCheckpoint > start
        : vault.lastCheckpoint !== start))
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
    startCheckpoint: start,
    endCheckpoint: end,
    allocations: allocation.allocations,
    leafDomain: product.leafDomain,
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
  const { config, product } = context;
  const manifest = await readManifest(context, supplied);
  if (!config.adminCapId) throw new Error("adminCapId required");
  return withSender(product.publish(manifest, config.adminCapId), config);
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
  const { product, config, client, store } = context;
  const { signer } = options;
  const manifest = await readManifest(context, options.manifest);
  const round = await readConfirmedRound(context, roundId, manifest);
  const pending = pendingRewardAllocations(round, manifest, product.leafDomain);
  const relay: HolderRewardsRelay = {
    roundNumber: manifest.number,
    batches: [],
  };
  for (let offset = 0; offset < pending.length; offset += RELAY_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + RELAY_BATCH_SIZE);
    const first = batch[0];
    if (!first) continue;
    const transaction = product.claim(round, batch);
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
  vault: RewardsVault,
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
  vault: RewardsVault,
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

/** Reads the configured product's vault and binds its round reader and builders. */
async function loadProduct(
  client: SuiGrpcClient,
  config: HolderRewardsOperatorConfig,
): Promise<RewardsProduct> {
  if (config.product === "presale") {
    const transactions = new PresaleTransactions(
      config.deployment as PresaleDeployment,
    );
    const { originalPackageId } = transactions.call.deployment;
    const state = await getPresaleVault(
      client,
      config.vaultId,
      originalPackageId,
    );
    const pair = { memeType: state.memeType, quoteType: state.quoteType };
    const vault: RewardsVault = {
      ...state,
      rewardsMeme: state.holderRewardsMeme,
      rewardsQuote: state.holderRewardsQuote,
      summary: {
        presaleId: state.presaleId,
        feeRecipients: state.feeRecipients,
        holderRewardsBps: state.holderRewardsBps,
      },
    };
    return {
      leafDomain: PRESALE_REWARD_LEAF_DOMAIN,
      vault,
      readRound: async (roundId) => {
        const round = await getPresaleRewardRound(
          client,
          roundId,
          originalPackageId,
        );
        return {
          ...round,
          leafCount: Number(round.leafCount),
          claimed: round.claimedBitmap,
        };
      },
      publish: (manifest, adminCapId) => {
        if (!config.claimWindowMs || !/^\d+$/.test(config.claimWindowMs))
          throw new Error("presale publish-tx needs claimWindowMs");
        if (
          config.gasReserveAmount === undefined ||
          !/^(0|[1-9][0-9]*)$/.test(config.gasReserveAmount)
        )
          throw new Error(
            "presale publish-tx needs explicit gasReserveAmount (0 disables reimbursement)",
          );
        if (config.expectedTreasury === undefined)
          throw new Error("presale publish-tx needs explicit expectedTreasury");
        return transactions.publishHolderRewardRound({
          ...pair,
          vault,
          adminCapId,
          manifest,
          claimDeadlineMs: BigInt(Date.now()) + BigInt(config.claimWindowMs),
          gasReserveAmount: BigInt(config.gasReserveAmount),
          expectedTreasury: config.expectedTreasury,
        });
      },
      claim: (round, allocations) =>
        transactions.claimHolderRewards({ ...pair, round, allocations }),
    };
  }
  const transactions = new MigratorTransactions(
    config.deployment as MigratorsDeployment,
  );
  const { originalPackageId } = transactions.call.deployment;
  const state = await getLpVault(client, config.vaultId, originalPackageId);
  const pair = { memeType: state.memeType, quoteType: state.quoteType };
  return {
    leafDomain: MIGRATOR_REWARD_LEAF_DOMAIN,
    vault: {
      ...state,
      summary: { feeSplit: state.feeSplit },
    },
    readRound: (roundId) => getRewardRound(client, roundId, originalPackageId),
    publish: (manifest, adminCapId) =>
      transactions.publishHolderRewardRound({
        ...pair,
        vault: state,
        adminCapId,
        manifest,
      }),
    claim: (round, allocations) =>
      transactions.claimHolderRewards({ ...pair, round, allocations }),
  };
}
