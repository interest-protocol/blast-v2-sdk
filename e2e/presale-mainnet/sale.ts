import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";
import { created, exec, sharedVersion } from "./chain.ts";
import { COIN_REGISTRY, FINGERPRINT, TESTKIT } from "./env.ts";
import { assertStateTarget } from "./target.ts";
export type Shared = { objectId: string; initialSharedVersion: string };

export type SaleRecord = {
  scenario: string;
  venue: "bluefin" | "cetus" | "aftermath";
  memeType: string;
  quoteType: string;
  presale: Shared;
  capId: string;
  currency: Shared;
  vault?: Shared;
  pool?: Shared;
};

export type SaleToken = {
  registrationDigest: string;
  memeType: string;
  treasuryCap: string;
  currency: Shared;
};

export const STATE_PATH = resolve(
  process.env.E2E_STATE ?? "e2e/presale-mainnet/state.local.json",
);
type State = {
  target: string;
  tokens: Record<string, SaleToken>;
  [key: string]: unknown;
};
function loadState(): State {
  const state: State = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
    : { target: FINGERPRINT, tokens: {} };
  assertStateTarget(state, FINGERPRINT);
  return state;
}
function saveState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(
    `${STATE_PATH}.tmp`,
    `${JSON.stringify(state, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(`${STATE_PATH}.tmp`, STATE_PATH);
}
export function stateValue<T>(key: string): T | undefined {
  return loadState()[key] as T | undefined;
}
export function saveStateValue(key: string, value: unknown): void {
  const state = loadState();
  state[key] = value;
  saveState(state);
}
export const mut = <T extends Shared>(object: T) => ({
  ...object,
  mutable: true as const,
});
export function u64(value: unknown): bigint {
  return BigInt(String(value));
}
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
    registrationDigest: executed.digest,
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
