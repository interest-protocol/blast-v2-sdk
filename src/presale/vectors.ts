import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import type { SuiClientTypes } from "@mysten/sui/client";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import {
  fromBase58,
  fromBase64,
  MIST_PER_SUI,
  normalizeSuiObjectId,
  parseStructTag,
  toBase64,
  toHex,
} from "@mysten/sui/utils";

import type { SharedObjectIdentity } from "../lib/sui.ts";
import type { AllowlistProof } from "./allowlist.ts";
import { buildAllowlist } from "./allowlist.ts";
import {
  decodePresaleEvent,
  decodePresalePolicyEvent,
  presaleEventModules,
  presalePolicyEventSpecs,
} from "./events.ts";
import type { PresaleEventProjection } from "./reducer.ts";
import { createPresaleEventProjection, reducePresaleEvent } from "./reducer.ts";
import type { BpsShare, EligibilityPolicy, UncappedPhase } from "./state.ts";
import type { PresaleDeployment } from "./transactions.ts";
import { PresaleTransactions } from "./transactions.ts";

/**
 * The presale parity vector file: real emitted events with the decoder's and
 * reducer's expected output. Cases come from a Sui localnet stage (every kind
 * no venue needs) and from captured mainnet transactions; there is no testnet.
 */
export type PresaleVectorFile = {
  kinds: string[];
  /** Event kinds no case covers yet. */
  pending_kinds: string[];
  cases: PresaleVectorCase[];
};

export type PresaleVectorCase = {
  name: string;
  /** `localnet` or `mainnet:<chain id>`. */
  source: string;
  original_package_id: string;
  /** One sale's full history in ledger order, or one batch of policy events. */
  events: PresaleVectorEvent[];
};

export type PresaleVectorEvent = {
  type: string;
  /** Event BCS, base64. */
  bcs: string;
  sender: string;
  position: {
    checkpoint: string;
    transactionDigest: string;
    eventIndex: number;
  };
  /** `decodePresaleEvent` or `decodePresalePolicyEvent` output, bigints as decimal strings. */
  decoded: { kind: string } & Record<string, unknown>;
  /** `reducePresaleEvent` presales, vaults, and rounds after this event; null for policy events. */
  projection: unknown;
};

/** Capture input: the transactions to capture, grouped into named cases. */
export type PresaleVectorDigests = {
  original_package_id: string;
  cases: { name: string; digests: string[] }[];
};

export const PRESALE_VECTOR_KINDS: readonly string[] = [
  ...Object.keys(presaleEventModules),
  ...Object.values(presalePolicyEventSpecs).flatMap(Object.keys),
];

export const DEFAULT_PRESALE_VECTOR_FILE = "tests/vectors/presale-events.json";

const SALE_MODULES = ["blast_presale", "presale_vault", "holder_rewards"];
const POLICY_MODULES = ["fee_policy", "creation_policy", "blast_presale_admin"];
const MAINNET_CHAIN_ID = "35834a8a";
const SUI = "0x2::sui::SUI";

/** Decoder and reducer output as the vector file stores it: bigints become decimal strings. */
export function vectorJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  );
}

/** The `EventEntry` a vector event was read from. */
export function vectorEventEntry(
  event: PresaleVectorEvent,
): SuiClientTypes.EventEntry {
  const [packageId = "", module = ""] = event.type.split("::");
  return {
    packageId,
    module,
    sender: event.sender,
    eventType: event.type,
    bcs: fromBase64(event.bcs),
    json: null,
    ...event.position,
  };
}

/** Whether `type` is a `fee_policy`, `creation_policy`, or `blast_presale_admin` event. */
export function isPresalePolicyEvent(type: string): boolean {
  return POLICY_MODULES.includes(parseStructTag(type).module);
}

/** The domain projection a vector stores: the reducer state without its bookkeeping. */
export function vectorProjection(state: PresaleEventProjection): unknown {
  const { presales, vaults, rounds } = state;
  return vectorJson({ presales, vaults, rounds });
}

export async function runPresaleVectors(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      contracts: { type: "string" },
      rpc: { type: "string", default: "http://127.0.0.1:9000" },
      faucet: { type: "string", default: "http://127.0.0.1:9123" },
      digests: { type: "string" },
      "digests-out": { type: "string" },
      out: { type: "string", default: DEFAULT_PRESALE_VECTOR_FILE },
    },
  });
  // The pin is written beside the file as `<name>.sha256`; a name without `.json` would overwrite it.
  if (!values.out.endsWith(".json"))
    throw new Error(`--out must end in .json: ${values.out}`);
  const [command] = positionals;
  if (command === "localnet" && values.contracts && positionals.length === 1) {
    await runLocalnetStage({
      contracts: resolve(values.contracts),
      rpc: values.rpc,
      faucet: values.faucet,
      out: values.out,
      digestsOut: values["digests-out"],
    });
    return;
  }
  if (command === "capture" && values.digests && positionals.length === 1) {
    const digests = JSON.parse(await readFile(values.digests, "utf8"));
    await capturePresaleVectors({ rpc: values.rpc, digests, out: values.out });
    return;
  }
  throw new Error(
    "usage: vectors:presale localnet --contracts DIR [--rpc URL] [--faucet URL] [--out FILE] [--digests-out FILE]\n" +
      "       vectors:presale capture --rpc URL --digests FILE [--out FILE]",
  );
}

// === Capture ===

/**
 * Reads every presale event of the package, keeps the full history of each
 * sale the listed transactions touch (or, for a case touching no sale, the
 * listed transactions' policy events), and merges the cases into `out`.
 */
export async function capturePresaleVectors(options: {
  rpc: string;
  digests: PresaleVectorDigests;
  out: string;
}): Promise<void> {
  const client = grpcClient(options.rpc);
  const source = await chainSource(client, options.rpc);
  const originalPackageId = normalizeSuiObjectId(
    options.digests.original_package_id,
  );
  const listed = new Set(options.digests.cases.flatMap((c) => c.digests));
  const entries = await packageEvents(client, originalPackageId, listed);
  await writePresaleVectors(
    options.out,
    presaleVectorCases({
      entries,
      cases: options.digests.cases,
      originalPackageId,
      source,
    }),
  );
}

/** Builds each listed case from the package's events in ledger order. */
export function presaleVectorCases(options: {
  entries: SuiClientTypes.EventEntry[];
  cases: PresaleVectorDigests["cases"];
  originalPackageId: string;
  source: string;
}): PresaleVectorCase[] {
  const { entries, originalPackageId, source } = options;
  const sales = saleIds(entries, originalPackageId);
  return options.cases.map(({ name, digests }) => {
    const inCase = (entry: SuiClientTypes.EventEntry) =>
      digests.includes(entry.transactionDigest);
    const touched = new Set(
      entries.flatMap((entry, i) => {
        if (!inCase(entry) || isPresalePolicyEvent(entry.eventType)) return [];
        const sale = sales[i];
        if (!sale)
          throw new Error(
            `no sale for event ${entry.transactionDigest}:${entry.eventIndex}`,
          );
        return [sale];
      }),
    );
    if (touched.size > 1)
      throw new Error(`case ${name} touches ${touched.size} sales`);
    const [sale] = touched;
    const events = entries.filter((entry, i) =>
      sale
        ? sales[i] === sale
        : inCase(entry) && isPresalePolicyEvent(entry.eventType),
    );
    if (events.length === 0)
      throw new Error(`case ${name} has no presale events`);
    const [first] = events;
    if (
      sale &&
      first &&
      decodePresaleEvent(first, { originalPackageId }).kind !== "PresaleCreated"
    )
      throw new Error(
        `case ${name}: the history of sale ${sale} does not start at its PresaleCreated, so the fullnode pruned it or it is incomplete`,
      );
    return {
      name,
      source,
      original_package_id: originalPackageId,
      events: vectorEvents(events, originalPackageId),
    };
  });
}

function vectorEvents(
  entries: SuiClientTypes.EventEntry[],
  originalPackageId: string,
): PresaleVectorEvent[] {
  let state = createPresaleEventProjection();
  return entries.map((entry) => {
    let decoded: unknown;
    let projection: unknown = null;
    if (isPresalePolicyEvent(entry.eventType)) {
      decoded = decodePresalePolicyEvent(entry, { originalPackageId });
    } else {
      const event = decodePresaleEvent(entry, { originalPackageId });
      state = reducePresaleEvent(state, event);
      decoded = event;
      projection = vectorProjection(state);
    }
    return {
      type: entry.eventType,
      bcs: toBase64(entry.bcs),
      sender: entry.sender,
      position: {
        checkpoint: String(entry.checkpoint),
        transactionDigest: entry.transactionDigest,
        eventIndex: entry.eventIndex,
      },
      decoded: vectorJson(decoded) as PresaleVectorEvent["decoded"],
      projection,
    };
  });
}

/**
 * Each entry's sale: its presale ID, through its vault or round when it has
 * none; null for policy events and for vault or round events whose creation
 * event the fullnode no longer retains.
 */
function saleIds(
  entries: SuiClientTypes.EventEntry[],
  originalPackageId: string,
): (string | null)[] {
  const vaultSales = new Map<string, string>();
  const roundVaults = new Map<string, string>();
  return entries.map((entry) => {
    if (isPresalePolicyEvent(entry.eventType)) return null;
    const event = decodePresaleEvent(entry, { originalPackageId });
    if (event.kind === "PresaleVaultCreated")
      vaultSales.set(event.payload.vault_id, event.payload.presale_id);
    if (event.kind === "RoundPublished")
      roundVaults.set(event.payload.round_id, event.payload.vault_id);
    const { payload } = event;
    if ("presale_id" in payload) return payload.presale_id;
    const vaultId =
      "vault_id" in payload
        ? payload.vault_id
        : roundVaults.get(payload.round_id);
    return (vaultId && vaultSales.get(vaultId)) || null;
  });
}

/**
 * Every event of the package's sale and policy modules in ledger order. Waits
 * until each listed transaction's events are indexed.
 */
async function packageEvents(
  client: SuiGrpcClient,
  originalPackageId: string,
  listed: ReadonlySet<string>,
): Promise<SuiClientTypes.EventEntry[]> {
  for (let attempt = 0; ; attempt++) {
    // ponytail: scans the package's whole event history; fine for a handful of sales, and the
    // fullnode must still retain the oldest event of each captured sale.
    const streams = await Promise.all(
      [...SALE_MODULES, ...POLICY_MODULES].map((module) =>
        listEvents(client, `${originalPackageId}::${module}`),
      ),
    );
    const entries = streams.flat();
    const seen = new Set(entries.map((entry) => entry.transactionDigest));
    const missing = [...listed].filter((digest) => !seen.has(digest));
    if (missing.length === 0) return ledgerOrder(client, entries);
    if (attempt === 30)
      throw new Error(`no presale events for ${missing.join(", ")}`);
    await sleep(1_000);
  }
}

async function listEvents(
  client: SuiGrpcClient,
  eventType: string,
): Promise<SuiClientTypes.EventEntry[]> {
  const entries: SuiClientTypes.EventEntry[] = [];
  let after: string | null = null;
  do {
    const page: SuiClientTypes.ListEventsResponse =
      await client.core.listEvents({
        filter: { eventType },
        limit: 50,
        after,
      });
    entries.push(...page.events);
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
  return entries;
}

/** Sorts by checkpoint, by transaction order within a shared checkpoint, then by event index. */
export async function ledgerOrder(
  client: SuiGrpcClient,
  entries: SuiClientTypes.EventEntry[],
): Promise<SuiClientTypes.EventEntry[]> {
  const digests = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.checkpoint === null)
      throw new Error("events need checkpoint metadata (use gRPC)");
    const set = digests.get(entry.checkpoint) ?? new Set();
    digests.set(entry.checkpoint, set.add(entry.transactionDigest));
  }
  const txIndex = new Map<string, number>();
  for (const [sequence, set] of digests) {
    if (set.size < 2) continue;
    const { checkpoint } = await client.ledgerService.getCheckpoint({
      checkpointId: {
        oneofKind: "sequenceNumber",
        sequenceNumber: BigInt(sequence),
      },
      readMask: { paths: ["contents.transactions.transaction"] },
    }).response;
    const listing =
      checkpoint?.contents?.transactions.map((tx) => tx.transaction) ?? [];
    for (const digest of set) {
      const index = listing.indexOf(digest);
      if (index < 0)
        throw new Error(
          `checkpoint ${sequence} does not list transaction ${digest}`,
        );
      txIndex.set(digest, index);
    }
  }
  // Only a transaction alone in its checkpoint has no index, so any constant orders it.
  const order = (entry: SuiClientTypes.EventEntry) =>
    [
      BigInt(entry.checkpoint ?? 0),
      txIndex.get(entry.transactionDigest) ?? 0,
      entry.eventIndex,
    ] as const;
  return entries.sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : x[1] - y[1] || x[2] - y[2];
  });
}

/** Replaces cases of the same name in place, appends new ones, recomputes coverage, and pins the file. */
export async function writePresaleVectors(
  out: string,
  cases: PresaleVectorCase[],
): Promise<void> {
  const existing: PresaleVectorFile = await readFile(out, "utf8").then(
    JSON.parse,
    () => ({ cases: [] }),
  );
  const kept = new Set(existing.cases.map((c) => c.name));
  const all = [
    ...existing.cases.map((c) => cases.find((n) => n.name === c.name) ?? c),
    ...cases.filter((c) => !kept.has(c.name)),
  ];
  const covered = new Set(
    all.flatMap((c) => c.events.map((e) => e.decoded.kind)),
  );
  const file: PresaleVectorFile = {
    kinds: PRESALE_VECTOR_KINDS.filter((kind) => covered.has(kind)),
    pending_kinds: PRESALE_VECTOR_KINDS.filter((kind) => !covered.has(kind)),
    cases: all,
  };
  const text = `${JSON.stringify(file, null, 2)}\n`;
  const sha256 = createHash("sha256").update(text).digest("hex");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text);
  await writeFile(
    out.replace(/\.json$/, ".sha256"),
    `${sha256}  ${basename(out)}\n`,
  );
  console.log(`${out}: ${all.length} cases, sha256 ${sha256}`);
}

async function chainSource(
  client: SuiGrpcClient,
  rpc: string,
): Promise<string> {
  const { chainIdentifier } = await client.core.getChainIdentifier();
  const chainId = toHex(fromBase58(chainIdentifier).slice(0, 4));
  if (chainId === MAINNET_CHAIN_ID) return `mainnet:${chainId}`;
  if (["127.0.0.1", "localhost", "[::1]"].includes(new URL(rpc).hostname)) {
    return "localnet";
  }
  throw new Error(
    `chain ${chainId} is neither mainnet nor a localnet; there is no testnet stage`,
  );
}

function grpcClient(rpc: string): SuiGrpcClient {
  return new SuiGrpcClient({ network: "localnet", baseUrl: rpc });
}

// === Localnet stage ===

type Wallet = Ed25519Keypair;
type Commit = [
  wallet: number,
  route: "open" | "allowlisted" | "uncapped",
  sui: number,
];

/** One localnet sale; every sale migrates to Bluefin, since `cetus::new` calls aborting interface stubs. */
type SaleCase = {
  name: string;
  eligibility: (wallets: Wallet[]) => EligibilityPolicy;
  uncapped: UncappedPhase | null;
  commits: Commit[];
  /** Commits once the uncapped phase has started. */
  uncappedCommits: Commit[];
  /** Participants whose refunds are claimed after settlement. */
  claims: number[];
  /** Token recipients (1,000 BPS in all) and raise recipients; `other` is a fresh address. */
  recipientAllocations?: (deployer: string, other: string) => BpsShare[];
  raiseAllocations?: (deployer: string) => BpsShare[];
};

const sui = (amount: number) => BigInt(amount) * MIST_PER_SUI;
const open = (
  cap: number,
  participants: number,
  min: number,
): EligibilityPolicy => ({
  kind: "open",
  walletCap: sui(cap),
  maxParticipants: BigInt(participants),
  minCommitment: sui(min),
});
const ALLOWLIST_CAPS = [6, 5, 5];
const allowlist = (wallets: Wallet[]) =>
  buildAllowlist(
    ALLOWLIST_CAPS.map((cap, i) => ({
      wallet: wallets[i]?.toSuiAddress() ?? "",
      walletCap: sui(cap),
    })),
  );

/**
 * Raise 10 SUI; each sale's window is `DURATION_MS`. Without explicit
 * allocations a sale pays the deployer 1,000 token BPS and 2,000 raise BPS,
 * unvested.
 */
const SALE_CASES: SaleCase[] = [
  {
    name: "open-funded",
    eligibility: () => open(6, 3, 4),
    uncapped: null,
    commits: [
      [0, "open", 6],
      [1, "open", 4],
      [1, "open", 1],
      [2, "open", 4],
    ],
    uncappedCommits: [],
    claims: [],
    recipientAllocations: (deployer, other) => [
      {
        recipient: deployer,
        bps: 600n,
        vesting: { cliffMs: 600_000n, periodMs: 300_000n, periods: 3n },
      },
      { recipient: other, bps: 400n },
    ],
    raiseAllocations: (deployer) => [
      {
        recipient: deployer,
        bps: 2_000n,
        vesting: { cliffMs: 0n, periodMs: 86_400_000n, periods: 12n },
      },
    ],
  },
  {
    name: "open-missed-raise-refunded",
    eligibility: () => open(6, 3, 4),
    uncapped: null,
    commits: [
      [0, "open", 4],
      [1, "open", 4],
    ],
    uncappedCommits: [],
    claims: [0, 1],
    // 2^62 + 2^62: a duration of exactly 2^63 ms, the contract's bound.
    recipientAllocations: (deployer) => [
      {
        recipient: deployer,
        bps: 1_000n,
        vesting: { cliffMs: 2n ** 62n, periodMs: 2n ** 62n, periods: 2n },
      },
    ],
  },
  {
    name: "allowlisted-funded",
    eligibility: (wallets) => {
      const { root, leafCount } = allowlist(wallets);
      return { kind: "allowlisted", root, leafCount };
    },
    uncapped: null,
    commits: [
      [0, "allowlisted", 6],
      [1, "allowlisted", 5],
    ],
    uncappedCommits: [],
    claims: [],
  },
  {
    name: "uncapped-hard-cap-filled",
    eligibility: () => open(3, 4, 3),
    uncapped: {
      startsAfterMs: 120_000n,
      access: { kind: "anyone", maxParticipants: 6n, minCommitment: sui(2) },
      hardCap: true,
    },
    commits: [
      [0, "open", 3],
      [1, "open", 3],
    ],
    // Offers 6 SUI; the hard cap accepts the 4 left of the raise and returns 2.
    uncappedCommits: [[2, "uncapped", 6]],
    claims: [],
  },
];
// Long enough for every sale's commits to land on a loaded host before its window ends.
const DURATION_MS = 240_000n;
const SEVEN_DAYS_MS = 7n * 24n * 60n * 60n * 1_000n;

/**
 * Publishes `blast_presale` with its unpublished dependencies (the venue
 * interface stubs and `blast_fun_vesting`) from `contracts` on a localnet,
 * runs the policy calls, the `AdminCap` replacement and revocation, and the
 * venue-free sales, and captures them into `out`.
 */
export async function runLocalnetStage(options: {
  contracts: string;
  rpc: string;
  faucet: string;
  out: string;
  digestsOut: string | undefined;
}): Promise<void> {
  const started = Date.now();
  const stop = await ensureLocalnet(options.rpc);
  try {
    const client = grpcClient(options.rpc);
    if ((await chainSource(client, options.rpc)) !== "localnet") {
      throw new Error("the localnet stage needs a local RPC");
    }
    const work = await mkdtemp(join(tmpdir(), "presale-vectors-"));
    const deployer = new Ed25519Keypair();
    const wallets = [
      new Ed25519Keypair(),
      new Ed25519Keypair(),
      new Ed25519Keypair(),
    ];
    await requestSuiFromFaucetV2({
      host: options.faucet,
      recipient: deployer.toSuiAddress(),
    });
    const cli = await suiCli(work, options.rpc, deployer);
    const deployment = await publishPresale(cli, options.contracts, work);
    const run = new LocalnetRun(client, deployer, wallets, deployment);
    await run.fundWallets();
    const digests: PresaleVectorDigests = {
      original_package_id: deployment.originalPackageId,
      cases: [
        { name: "policy", digests: await run.setPolicies() },
        // After every call that needs the AdminCap, since it ends revoked.
        { name: "admin", digests: await run.replaceAndRevokeAdminCap() },
      ],
    };
    const tokens = await run.saleTokens(cli, work);
    digests.cases.push(...(await run.sales(tokens)));
    const digestsOut = options.digestsOut ?? `${work}-digests.json`;
    await writeFile(digestsOut, `${JSON.stringify(digests, null, 2)}\n`);
    console.log(`localnet digests: ${digestsOut}`);
    await capturePresaleVectors({
      rpc: options.rpc,
      digests,
      out: options.out,
    });
    await rm(work, { recursive: true });
    console.log(
      `localnet stage took ${Math.round((Date.now() - started) / 1000)} s`,
    );
  } finally {
    stop();
  }
}

class LocalnetRun {
  readonly client: SuiGrpcClient;
  readonly deployer: Wallet;
  readonly wallets: Wallet[];
  readonly deployment: LocalnetDeployment;
  readonly presale: PresaleTransactions;

  constructor(
    client: SuiGrpcClient,
    deployer: Wallet,
    wallets: Wallet[],
    deployment: LocalnetDeployment,
  ) {
    this.client = client;
    this.deployer = deployer;
    this.wallets = wallets;
    this.deployment = deployment;
    this.presale = new PresaleTransactions(deployment);
  }

  async fundWallets(): Promise<void> {
    const tx = new Transaction();
    const coins = tx.splitCoins(
      tx.gas,
      this.wallets.map(() => sui(30)),
    );
    this.wallets.forEach((wallet, i) => {
      tx.transferObjects([coins[i] ?? tx.gas], wallet.toSuiAddress());
    });
    await this.execute(tx);
  }

  /** Emits the four policy events with the `AdminCap` publication sent the deployer. */
  async setPolicies(): Promise<string[]> {
    const { adminCapId } = this.deployment;
    const policies = [
      this.presale.setQuoteAllowed({
        adminCapId,
        quoteType: SUI,
        allowed: true,
      }),
      this.presale.setMigrationWitnessAllowed({
        adminCapId,
        venue: "bluefin",
        allowed: true,
      }),
      this.presale.setProtocolFees({
        adminCapId,
        fees: {
          raiseBps: 500n,
          tokenBps: 100n,
          lpFeeMemeBps: 1_000n,
          lpFeeQuoteBps: 1_000n,
        },
      }),
      this.presale.setProtocolDestination({
        adminCapId,
        // Publication pays the publisher, and the destination must change.
        destination: new Ed25519Keypair().toSuiAddress(),
      }),
    ];
    const digests: string[] = [];
    for (const tx of policies) digests.push((await this.execute(tx)).digest);
    return digests;
  }

  /**
   * Replaces the publication's `AdminCap` (`AdminCapReplaced` naming it as
   * the previous cap), then revokes the replacement (`AdminCapRevoked`).
   */
  async replaceAndRevokeAdminCap(): Promise<string[]> {
    const { superAdminCapId } = this.deployment;
    const replaced = await this.execute(
      this.presale.replaceAdminCap({
        superAdminCapId,
        recipient: this.deployer.toSuiAddress(),
      }),
    );
    const revoked = await this.execute(
      this.presale.revokeAdminCap({ superAdminCapId }),
    );
    return [replaced.digest, revoked.digest];
  }

  /** Publishes one one-time-witness currency per sale and registers each `Currency`. */
  async saleTokens(cli: SuiCli, work: string): Promise<SaleToken[]> {
    const dir = join(work, "tokens");
    const modules = SALE_CASES.map((sale) => sale.name.replaceAll("-", "_"));
    await mkdir(join(dir, "sources"), { recursive: true });
    await writeFile(
      join(dir, "Move.toml"),
      '[package]\nname = "presale_vector_tokens"\nedition = "2024"\n\n[addresses]\npresale_vector_tokens = "0x0"\n',
    );
    for (const module of modules) {
      await writeFile(
        join(dir, "sources", `${module}.move`),
        tokenModule(module),
      );
    }
    const published = await cli.publish(dir);
    const tx = new Transaction();
    const types = modules.map(
      (module) => `${published.packageId}::${module}::${module.toUpperCase()}`,
    );
    for (const type of types) {
      tx.moveCall({
        target: "0x2::coin_registry::finalize_registration",
        typeArguments: [type],
        arguments: [
          tx.object("0xc"),
          tx.object(published.created(`Currency<${type}>`).objectId),
        ],
      });
    }
    const registered = await this.execute(tx);
    return types.map((memeType) => ({
      memeType,
      treasuryCapId: published.created(`TreasuryCap<${memeType}>`).objectId,
      currency: created(registered, `::coin_registry::Currency<${memeType}>`),
    }));
  }

  /** Creates every sale, commits, settles once each window ends, and relays refund claims. */
  async sales(
    tokens: SaleToken[],
  ): Promise<{ name: string; digests: string[] }[]> {
    const deployer = this.deployer.toSuiAddress();
    const live = [];
    for (const [i, sale] of SALE_CASES.entries()) {
      const token = tokens[i] as SaleToken;
      const types = { memeType: token.memeType, quoteType: SUI };
      const creation = await this.execute(
        this.presale.createBluefinPresale({
          ...types,
          treasuryCap: token.treasuryCapId,
          memeCurrency: { ...token.currency, mutable: true },
          tokenSupply: 1_000_000_000_000_000_000n,
          tokenAllocationBps: 5_000n,
          liquidityTokenAllocationBps: 3_900n,
          recipientAllocations: sale.recipientAllocations?.(
            deployer,
            new Ed25519Keypair().toSuiAddress(),
          ) ?? [{ recipient: deployer, bps: 1_000n }],
          burnable: false,
          raiseTarget: sui(10),
          raiseAllocations: sale.raiseAllocations?.(deployer) ?? [
            { recipient: deployer, bps: 2_000n },
          ],
          durationMs: DURATION_MS,
          liquidityWindowMs: SEVEN_DAYS_MS,
          eligibility: sale.eligibility(this.wallets),
          uncapped: sale.uncapped,
          feeRecipients: [{ recipient: deployer, bps: 7_000n }],
          holderRewardsBps: 3_000n,
          tickSpacing: 60,
          feeRate: 3_000n,
          // The redeployed contract gives a sale a scheduled start: `share` sets
          // `start = max(start_ms, now)`, so 0 keeps these cases opening at once, which is what
          // every vector assertion about the window expects.
          startMs: 0n,
          capRecipient: deployer,
        }),
      );
      const presale = {
        ...created(creation, "::blast_presale::Presale<"),
        mutable: true as const,
      };
      const opened = openedEvent(creation, this.deployment.originalPackageId);
      live.push({ sale, types, presale, opened, digests: [creation.digest] });
    }
    for (const { sale, types, presale, digests } of live) {
      digests.push(...(await this.commit(sale.commits, { ...types, presale })));
    }
    for (const { sale, types, presale, opened, digests } of live) {
      if (sale.uncappedCommits.length === 0) continue;
      await untilChainTime(this.client, opened.uncapped_from_ms);
      digests.push(
        ...(await this.commit(sale.uncappedCommits, { ...types, presale })),
      );
    }
    for (const { sale, types, presale, opened, digests } of live) {
      await untilChainTime(this.client, opened.end_ms);
      digests.push(
        (await this.execute(this.presale.settle({ ...types, presale }))).digest,
      );
      if (sale.claims.length === 0) continue;
      const participants = sale.claims.map(
        (i) => this.wallets[i]?.toSuiAddress() ?? "",
      );
      digests.push(
        (
          await this.execute(
            this.presale.claim({ ...types, presale, participants }),
          )
        ).digest,
      );
    }
    return live.map(({ sale, digests }) => ({ name: sale.name, digests }));
  }

  async commit(
    commits: Commit[],
    target: Parameters<PresaleTransactions["settle"]>[0],
  ): Promise<string[]> {
    const proofs = allowlist(this.wallets).proofs;
    const digests: string[] = [];
    for (const [i, route, amount] of commits) {
      const wallet = this.wallets[i] as Wallet;
      const recipient = wallet.toSuiAddress();
      const common = { ...target, amount: sui(amount), recipient };
      const tx =
        route === "allowlisted"
          ? this.presale.commit({
              ...common,
              route,
              allowlist: allowlistProof(proofs, recipient),
            })
          : this.presale.commit({ ...common, route });
      digests.push((await this.execute(tx, wallet)).digest);
    }
    return digests;
  }

  async execute(
    tx: Transaction,
    signer: Wallet = this.deployer,
  ): Promise<Executed> {
    const result = await this.client.core.signAndExecuteTransaction({
      transaction: tx,
      signer,
      include: { effects: true, events: true, objectTypes: true },
    });
    if (result.$kind === "FailedTransaction") {
      const { digest, status } = result.FailedTransaction;
      throw new Error(
        `transaction ${digest} failed: ${JSON.stringify(status.error)}`,
      );
    }
    await this.client.core.waitForTransaction({
      digest: result.Transaction.digest,
    });
    return result.Transaction;
  }
}

type LocalnetDeployment = PresaleDeployment & {
  superAdminCapId: string;
  adminCapId: string;
};
type Executed = SuiClientTypes.Transaction<{
  effects: true;
  events: true;
  objectTypes: true;
}>;
type SaleToken = {
  memeType: string;
  treasuryCapId: string;
  currency: SharedObjectIdentity;
};

/** The object a transaction created whose type contains `typePart`, with its shared version when shared. */
function created(tx: Executed, typePart: string): SharedObjectIdentity {
  const change = tx.effects.changedObjects.find(
    (object) =>
      object.idOperation === "Created" &&
      tx.objectTypes[object.objectId]?.includes(typePart),
  );
  if (!change)
    throw new Error(`transaction ${tx.digest} created no ${typePart}`);
  const owner = change.outputOwner;
  return {
    objectId: change.objectId,
    initialSharedVersion:
      owner?.$kind === "Shared" ? owner.Shared.initialSharedVersion : 0,
  };
}

function openedEvent(tx: Executed, originalPackageId: string) {
  for (const [eventIndex, event] of tx.events.entries()) {
    if (!event.eventType.includes("::blast_presale::PresaleOpened<")) continue;
    const decoded = decodePresaleEvent(
      { ...event, checkpoint: "0", transactionDigest: tx.digest, eventIndex },
      { originalPackageId },
    );
    if (decoded.kind === "PresaleOpened") return decoded.payload;
  }
  throw new Error(`transaction ${tx.digest} opened no presale`);
}

/** Waits until a checkpoint timestamp passes `ms`, so the Clock a new transaction reads has too. */
async function untilChainTime(
  client: SuiGrpcClient,
  ms: bigint,
): Promise<void> {
  for (;;) {
    const { checkpoint } = await client.ledgerService.getCheckpoint({
      checkpointId: { oneofKind: undefined },
      readMask: { paths: ["summary.timestamp"] },
    }).response;
    const timestamp = checkpoint?.summary?.timestamp;
    const now =
      BigInt(timestamp?.seconds ?? 0n) * 1_000n +
      BigInt(Math.floor((timestamp?.nanos ?? 0) / 1e6));
    if (now > ms) return;
    await sleep(Math.min(Number(ms - now) + 500, 5_000));
  }
}

function tokenModule(module: string): string {
  const otw = module.toUpperCase();
  return `module presale_vector_tokens::${module};

public struct ${otw} has drop {}

fun init(otw: ${otw}, ctx: &mut TxContext) {
    let (currency, treasury_cap) = sui::coin_registry::new_currency_with_otw(
        otw,
        9,
        b"${otw.replaceAll("_", "").slice(0, 32)}".to_string(),
        b"${module}".to_string(),
        b"Presale parity vector sale token".to_string(),
        b"".to_string(),
        ctx,
    );
    transfer::public_transfer(currency.finalize(ctx), ctx.sender());
    transfer::public_transfer(treasury_cap, ctx.sender());
}
`;
}

// === Localnet and CLI publishing ===

async function ensureLocalnet(rpc: string): Promise<() => void> {
  const client = grpcClient(rpc);
  const ready = () =>
    client.core.getChainIdentifier().then(
      () => true,
      () => false,
    );
  if (await ready()) return () => {};
  console.log("starting sui start --force-regenesis --with-faucet");
  const node = spawn("sui", ["start", "--force-regenesis", "--with-faucet"], {
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 90; attempt++) {
    if (await ready()) {
      await sleep(5_000); // the faucet starts after the RPC
      return () => node.kill("SIGINT");
    }
    await sleep(2_000);
  }
  node.kill("SIGINT");
  throw new Error(`no localnet at ${rpc}`);
}

type Published = {
  packageId: string;
  created: (typePart: string) => SharedObjectIdentity;
};

type SuiCli = { publish: (dir: string) => Promise<Published> };

/** A `sui client` bound to its own config and keystore holding only `signer`, never the user's. */
async function suiCli(
  work: string,
  rpc: string,
  signer: Wallet,
): Promise<SuiCli> {
  const config = join(work, "client.yaml");
  const keystore = join(work, "sui.keystore");
  const pubfile = join(work, "Pub.localnet.toml");
  const { secretKey } = decodeSuiPrivateKey(signer.getSecretKey());
  await writeFile(
    keystore,
    JSON.stringify([toBase64(Uint8Array.of(0, ...secretKey))]),
  );
  await writeFile(
    config,
    `keystore:\n  File: ${keystore}\nenvs:\n  - alias: localnet\n    rpc: "${rpc}"\nactive_env: localnet\nactive_address: "${signer.toSuiAddress()}"\n`,
  );
  const run = promisify(execFile);
  return {
    async publish(dir) {
      const { stdout } = await run(
        "sui",
        [
          "client",
          "--client.config",
          config,
          "test-publish",
          dir,
          "--build-env",
          "mainnet",
          "--pubfile-path",
          pubfile,
          "--publish-unpublished-deps",
          "--skip-dependency-verification",
          "--json",
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const result = JSON.parse(stdout.slice(stdout.search(/^\{/m)));
      const changes: {
        type: string;
        objectType?: string;
        objectId?: string;
        packageId?: string;
        owner?: { Shared?: { initial_shared_version: number } };
      }[] = result.objectChanges;
      return {
        packageId:
          changes.find((change) => change.type === "published")?.packageId ??
          "",
        created(typePart) {
          const change = changes.find(
            (c) => c.type === "created" && c.objectType?.includes(typePart),
          );
          if (!change?.objectId)
            throw new Error(`publish of ${dir} created no ${typePart}`);
          return {
            objectId: change.objectId,
            initialSharedVersion:
              change.owner?.Shared?.initial_shared_version ?? 0,
          };
        },
      };
    },
  };
}

/**
 * Publishes `blast_presale` with its unpublished dependencies (the Cetus and
 * Bluefin interface stubs, `blast_fun_vesting`, and the integer libraries),
 * from a copy so the contracts worktree stays untouched. Publication sends
 * the publisher the `SuperAdminCap` and the `AdminCap`.
 */
async function publishPresale(
  cli: SuiCli,
  contracts: string,
  work: string,
): Promise<LocalnetDeployment> {
  for (const path of ["presale", "migrators/interfaces"]) {
    await cp(join(contracts, "sui", path), join(work, "sui", path), {
      recursive: true,
      filter: (source) => basename(source) !== "build",
    });
  }
  const presaleDir = join(work, "sui/presale");
  const presale = await cli.publish(presaleDir).catch(async (error) => {
    if (
      !String(error.stdout + error.stderr).includes(
        "Unpublished dependencies: IntegerMate",
      )
    ) {
      throw error;
    }
    await aliasIntegerMate(presaleDir, join(work, "Pub.localnet.toml"));
    return cli.publish(presaleDir);
  });
  const shared = (typePart: string) => presale.created(typePart);
  return {
    packageId: presale.packageId,
    originalPackageId: presale.packageId,
    venueConfig: shared("::venue_config::VenueConfig"),
    creationPolicy: shared("::creation_policy::CreationPolicy"),
    feePolicy: shared("::fee_policy::FeePolicy"),
    adminRegistry: shared("::blast_presale_admin::AdminRegistry"),
    superAdminCapId: presale.created("::blast_presale_admin::SuperAdminCap")
      .objectId,
    adminCapId: presale.created("::blast_presale_admin::AdminCap").objectId,
  };
}

/**
 * Bluefin's interface pins IntegerMate `sui-v1.1.2`, which `blast_presale`
 * overrides. The CLI ignores the override when it publishes Bluefin as a
 * transitive dependency, so record the pinned copy at the override's address.
 */
async function aliasIntegerMate(
  presaleDir: string,
  pubfile: string,
): Promise<void> {
  const lock = await readFile(join(presaleDir, "Move.lock"), "utf8");
  const [pinned, override] = ["IntegerMate", "IntegerMate_1"].map((name) => {
    const match = lock.match(
      new RegExp(
        `\\[pinned\\.mainnet\\.${name}\\]\\nsource = \\{ git = "([^"]+)", subdir = "([^"]+)", rev = "([^"]+)" \\}`,
      ),
    );
    if (!match) throw new Error(`Move.lock pins no ${name}`);
    const [, url = "", subdir = "", rev = ""] = match;
    return join(
      homedir(),
      ".move/git",
      `${url.replace(/[:/.]/g, "_")}_${rev}`,
      subdir,
    );
  });
  const entry = (await readFile(pubfile, "utf8"))
    .split("[[published]]")
    .find((published) => published.includes(`"${override}"`));
  if (!entry || !pinned || !override)
    throw new Error("the IntegerMate override is not published");
  await appendFile(
    pubfile,
    `\n[[published]]${entry.replace(override, pinned)}`,
  );
}

function allowlistProof(
  proofs: AllowlistProof[],
  wallet: string,
): AllowlistProof {
  const proof = proofs.find((p) => p.wallet === wallet);
  if (!proof) throw new Error(`${wallet} is not allowlisted`);
  return proof;
}
