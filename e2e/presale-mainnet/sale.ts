import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";

import type { AllowlistProof, PresaleTerms } from "../../src/presale/index.ts";
import type { Executed } from "./chain.ts";
import { created, event, exec, sharedVersion } from "./chain.ts";
import {
  BLUEFIN,
  CETUS,
  COIN_REGISTRY,
  DEPLOYMENT,
  FAUCET,
  presale,
  SUI,
  SUI_CURRENCY,
  TEST_SUI,
  TEST_SUI_CURRENCY,
  TESTKIT,
} from "./env.ts";

export type Shared = { objectId: string; initialSharedVersion: string };

export type SaleRecord = {
  scenario: string;
  venue: "bluefin" | "cetus";
  memeType: string;
  quoteType: string;
  presale: Shared;
  capId: string;
  currency: Shared;
  vault?: Shared;
  pool?: Shared;
};

export type SaleToken = {
  memeType: string;
  treasuryCap: string;
  currency: Shared;
};

type State = {
  sales: Record<string, SaleRecord>;
  tokens: Record<string, SaleToken>;
};

const STATE_PATH = new URL("state.json", import.meta.url);

/** Sales and registered tokens later runs reuse. Committed, so reruns resume. */
function loadState(): State {
  return existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
    : { sales: {}, tokens: {} };
}

function saveState(state: State): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export function saveSale(name: string, sale: SaleRecord): void {
  const state = loadState();
  state.sales[name] = sale;
  saveState(state);
}

export function sale(name: string): SaleRecord {
  const found = loadState().sales[name];
  if (!found)
    throw new Error(`no recorded sale ${name}; run its scenario first`);
  return found;
}

export function hasSale(name: string): boolean {
  return name in loadState().sales;
}

export const mut = <T extends Shared>(object: T) => ({
  ...object,
  mutable: true as const,
});
export const imm = <T extends Shared>(object: T) => ({
  ...object,
  mutable: false as const,
});

export const types = (record: SaleRecord) => ({
  memeType: record.memeType,
  quoteType: record.quoteType,
});

/** Whole-coin amounts in 9-decimal atoms. */
export const coins = (amount: number): bigint =>
  BigInt(Math.round(amount * 1e9));

/** Registers sale token `letter` and returns its type, zero-supply `TreasuryCap`, and `Currency`. */
export async function newSaleToken(
  letter: string,
  creator: Ed25519Keypair,
): Promise<SaleToken> {
  const known = loadState().tokens[letter];
  if (known) return known;
  const tx = new Transaction();
  const [cap] = tx.moveCall({
    target: `${TESTKIT}::sale_tokens::new_sale_${letter.toLowerCase()}`,
    arguments: [tx.object(COIN_REGISTRY)],
  });
  tx.transferObjects([cap as TransactionArgument], creator.toSuiAddress());
  const executed = await exec(`register sale token ${letter}`, creator, tx);
  const memeType = normalizeStructTag(
    `${TESTKIT}::sale_tokens::SALE_${letter.toUpperCase()}`,
  );
  const currencyId = created(executed, "0x2::coin_registry::Currency<");
  const token = {
    memeType,
    treasuryCap: created(executed, "0x2::coin::TreasuryCap<"),
    currency: {
      objectId: currencyId,
      initialSharedVersion: sharedVersion(executed, currencyId),
    },
  };
  const state = loadState();
  state.tokens[letter] = token;
  saveState(state);
  return token;
}

/** Mints TEST_SUI from the faucet into `recipients`, `amount` each, in one transaction. */
export async function mintTestSui(
  signer: Ed25519Keypair,
  recipients: string[],
  amount: bigint,
): Promise<void> {
  const tx = new Transaction();
  const faucet = tx.sharedObjectRef({ ...FAUCET, mutable: true });
  for (const recipient of recipients) {
    const [coin] = tx.moveCall({
      target: `${TESTKIT}::test_sui::mint`,
      arguments: [faucet, tx.pure.u64(amount)],
    });
    tx.transferObjects([coin as TransactionArgument], recipient);
  }
  await exec(
    `mint ${amount} TEST_SUI to ${recipients.length} wallets`,
    signer,
    tx,
  );
}

export type Terms = Omit<
  PresaleTerms,
  "memeType" | "quoteType" | "treasuryCap" | "memeCurrency"
>;

/** Sensible defaults: 1B tokens, 50/40 sale/LP, no recipients, a 7-day LP window. */
export function defaultTerms(overrides: Partial<Terms>): Terms {
  return {
    tokenSupply: coins(1_000_000_000),
    tokenAllocationBps: 6_000n,
    liquidityTokenAllocationBps: 4_000n,
    recipientAllocations: [],
    burnable: false,
    raiseTarget: coins(100),
    raiseAllocations: [],
    durationMs: 6n * 60_000n,
    liquidityWindowMs: 7n * 24n * 3_600_000n,
    eligibility: {
      kind: "open",
      walletCap: coins(50),
      maxParticipants: 4n,
      minCommitment: coins(25),
    },
    uncapped: null,
    feeRecipients: [],
    holderRewardsBps: 10_000n,
    ...overrides,
  };
}

/** Bluefin tier every Bluefin test sale uses: tick spacing 200 at a 1% fee. */
export const BLUEFIN_TIER = { tickSpacing: 200, feeRate: 10_000n };
/** The only tick spacing Cetus lets a SUI pair reserve (E2E-003). */
export const CETUS_TICK_SPACING = 200;

/** Creates and shares a sale; the creator keeps the `PresaleCap`. */
export async function createSale(options: {
  scenario: string;
  letter: string;
  creator: Ed25519Keypair;
  venue: "bluefin" | "cetus";
  quoteType?: string;
  terms: Terms;
  startMs?: bigint;
}): Promise<{ record: SaleRecord; executed: Executed }> {
  const quoteType =
    options.quoteType ?? (options.venue === "cetus" ? SUI : TEST_SUI);
  const token = await newSaleToken(options.letter, options.creator);
  const common = {
    ...options.terms,
    memeType: token.memeType,
    quoteType,
    treasuryCap: token.treasuryCap,
    memeCurrency: mut(token.currency),
    startMs: options.startMs ?? 0n,
    capRecipient: options.creator.toSuiAddress(),
  };
  const tx =
    options.venue === "bluefin"
      ? presale.tx.createBluefinPresale({ ...common, ...BLUEFIN_TIER })
      : presale.tx.createCetusPresale({
          ...common,
          cetusConfig: imm(CETUS.config),
          cetusPools: mut(CETUS.pools),
          tickSpacing: CETUS_TICK_SPACING,
        });
  const executed = await exec(
    `create ${options.scenario} sale`,
    options.creator,
    tx,
  );
  const presaleId = created(
    executed,
    `${DEPLOYMENT.originalPackageId}::blast_presale::Presale<`,
  );
  const record: SaleRecord = {
    scenario: options.scenario,
    venue: options.venue,
    memeType: token.memeType,
    quoteType: normalizeStructTag(quoteType),
    presale: {
      objectId: presaleId,
      initialSharedVersion: sharedVersion(executed, presaleId),
    },
    capId: created(
      executed,
      `${DEPLOYMENT.originalPackageId}::blast_presale::PresaleCap`,
    ),
    currency: token.currency,
  };
  return { record, executed };
}

/** One commitment through `route`; the change coin returns to the sender. */
export function commitTx(
  record: SaleRecord,
  signer: Ed25519Keypair,
  amount: bigint,
  route: "open" | "uncapped" | { allowlist: AllowlistProof },
): Transaction {
  const common = {
    ...types(record),
    presale: mut(record.presale),
    amount,
    recipient: signer.toSuiAddress(),
  };
  return typeof route === "string"
    ? presale.tx.commit({ ...common, route })
    : presale.tx.commit({
        ...common,
        route: "allowlisted",
        allowlist: route.allowlist,
      });
}

export async function commit(
  label: string,
  record: SaleRecord,
  signer: Ed25519Keypair,
  amount: bigint,
  route: "open" | "uncapped" | { allowlist: AllowlistProof },
): Promise<Executed> {
  return exec(label, signer, commitTx(record, signer, amount, route));
}

/** Adds `settle` to `tx`. */
export function addSettle(tx: Transaction, record: SaleRecord): void {
  tx.add(
    presale.call.settle({ ...types(record), presale: mut(record.presale) }),
  );
}

/** Adds the venue's migration to `tx`; Bluefin's creation fee is `bluefinFee` MIST from gas. */
export function addMigrate(
  tx: Transaction,
  record: SaleRecord,
  bluefinFee = 0n,
): void {
  if (record.venue === "bluefin") {
    const [creationFee] = tx.splitCoins(tx.gas, [bluefinFee]);
    tx.add(
      presale.call.migrateBluefin({
        ...types(record),
        presale: mut(record.presale),
        memeCurrency: imm(record.currency),
        quoteCurrency: imm(quoteCurrency(record)),
        bluefinConfig: mut(BLUEFIN.config),
        creationFee: creationFee as TransactionArgument,
      }),
    );
    return;
  }
  tx.add(
    presale.call.migrateCetus({
      ...types(record),
      presale: mut(record.presale),
      cetusConfig: imm(CETUS.config),
      cetusPools: mut(CETUS.pools),
      burnManager: mut(CETUS.burnManager),
    }),
  );
}

export function quoteCurrency(record: SaleRecord): Shared {
  if (record.quoteType === normalizeStructTag(TEST_SUI))
    return TEST_SUI_CURRENCY;
  if (record.quoteType === normalizeStructTag(SUI)) return SUI_CURRENCY;
  throw new Error(`no Currency recorded for ${record.quoteType}`);
}

/** Records the vault and pool a migration created. */
export function recordMigration(
  record: SaleRecord,
  executed: Executed,
): SaleRecord {
  const vaultId = created(
    executed,
    `${DEPLOYMENT.originalPackageId}::presale_vault::PresaleVault<`,
  );
  const vaultEvent = event(executed, "PresaleVaultCreated");
  const poolId = String(vaultEvent.pool_id);
  const poolChange = executed.effects?.changedObjects.find(
    (change) => change.objectId === poolId,
  );
  const poolOwner = poolChange?.outputOwner;
  const poolVersion =
    poolOwner?.$kind === "Shared"
      ? String(poolOwner.Shared.initialSharedVersion)
      : undefined;
  return {
    ...record,
    vault: {
      objectId: vaultId,
      initialSharedVersion: sharedVersion(executed, vaultId),
    },
    ...(poolVersion
      ? { pool: { objectId: poolId, initialSharedVersion: poolVersion } }
      : {}),
  };
}

/** Relays one claim per participant. */
export function claimTx(
  record: SaleRecord,
  participants: string[],
): Transaction {
  return presale.tx.claim({
    ...types(record),
    presale: mut(record.presale),
    participants,
  });
}

export function u64(value: unknown): bigint {
  return BigInt(String(value));
}
