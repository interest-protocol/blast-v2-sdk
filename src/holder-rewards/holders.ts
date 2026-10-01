import {
  isValidSuiAddress,
  normalizeStructTag,
  normalizeSuiAddress,
} from "@mysten/sui/utils";
import { requireU64 } from "../lib/integers.ts";
import type { HolderWeight } from "./allocations.ts";
import { rewardAddress } from "./allocations.ts";

export type HolderCheckpoint = {
  sequence: bigint;
  digest: string;
  previousDigest: string | null;
  timestampMs: bigint;
  changes: readonly { address: string; amount: bigint }[];
};
type Account = { balance: string; weight: string; timestampMs: string };
/** JSON-safe durable state. Bootstrap must include every checkpoint from the coin's creation. */
export type HolderLedger = {
  version: 1;
  coinType: string;
  startCheckpoint: string;
  nextCheckpoint: string;
  lastDigest: string | null;
  timestampMs: string | null;
  accounts: Record<string, Account>;
};

export function createHolderLedger(
  coinType: string,
  firstCheckpoint: bigint,
): HolderLedger {
  requireU64("firstCheckpoint", firstCheckpoint);
  return {
    version: 1,
    coinType: normalizeStructTag(coinType),
    startCheckpoint: firstCheckpoint.toString(),
    nextCheckpoint: firstCheckpoint.toString(),
    lastDigest: null,
    timestampMs: null,
    accounts: {},
  };
}

/** Applies the checkpoint atomically; balances after this checkpoint accrue until the next. */
export function applyHolderCheckpoint(
  ledger: HolderLedger,
  checkpoint: HolderCheckpoint,
): HolderLedger {
  if (ledger.version !== 1) throw new Error("unsupported ledger version");
  if (checkpoint.sequence !== BigInt(ledger.nextCheckpoint))
    throw new Error("checkpoint sequence gap or replay");
  requireU64("checkpoint", checkpoint.sequence);
  requireU64("timestamp", checkpoint.timestampMs);
  if (
    !checkpoint.digest ||
    (ledger.lastDigest !== null &&
      checkpoint.previousDigest !== ledger.lastDigest)
  )
    throw new Error("checkpoint digest chain mismatch");
  if (
    ledger.timestampMs !== null &&
    checkpoint.timestampMs < BigInt(ledger.timestampMs)
  )
    throw new Error("checkpoint timestamp moved backwards");
  const changes = new Map<string, bigint>();
  for (const change of checkpoint.changes) {
    const address = normalizeSuiAddress(change.address);
    if (!isValidSuiAddress(address))
      throw new TypeError("invalid balance address");
    changes.set(address, (changes.get(address) ?? 0n) + change.amount);
  }
  const accounts = { ...ledger.accounts };
  for (const [address, delta] of changes) {
    const before = accounts[address] ?? {
      balance: "0",
      weight: "0",
      timestampMs: checkpoint.timestampMs.toString(),
    };
    const balance = BigInt(before.balance) + delta;
    if (balance < 0n)
      throw new Error(
        `negative holder balance at ${address}; incomplete history`,
      );
    requireU64("holder balance", balance);
    const weight =
      BigInt(before.weight) +
      BigInt(before.balance) *
        (checkpoint.timestampMs - BigInt(before.timestampMs));
    accounts[address] = {
      balance: balance.toString(),
      weight: weight.toString(),
      timestampMs: checkpoint.timestampMs.toString(),
    };
  }
  return {
    ...ledger,
    nextCheckpoint: (checkpoint.sequence + 1n).toString(),
    lastDigest: checkpoint.digest,
    timestampMs: checkpoint.timestampMs.toString(),
    accounts,
  };
}

/** Atomic-token milliseconds. Exclusions remove custody, never redistribute its token balance. */
export function holderWeights(
  ledger: HolderLedger,
  excluded: readonly string[] = [],
): HolderWeight[] {
  const { timestampMs } = ledger;
  if (timestampMs === null) return [];
  const exclusions = new Set([
    normalizeSuiAddress("0x0"),
    ...excluded.map(rewardAddress),
  ]);
  return Object.entries(ledger.accounts)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([address, account]) => {
      const weight =
        BigInt(account.weight) +
        BigInt(account.balance) *
          (BigInt(timestampMs) - BigInt(account.timestampMs));
      return !exclusions.has(address) && weight > 0n
        ? [{ address, weight }]
        : [];
    });
}

/** Call only after the matching funded round is confirmed; current balances continue unchanged. */
export function resetHolderWeights(ledger: HolderLedger): HolderLedger {
  const { timestampMs } = ledger;
  if (timestampMs === null) throw new Error("cannot reset an empty ledger");
  return {
    ...ledger,
    startCheckpoint: (BigInt(ledger.nextCheckpoint) - 1n).toString(),
    accounts: Object.fromEntries(
      Object.entries(ledger.accounts)
        .filter(([, value]) => BigInt(value.balance) > 0n)
        .map(([address, value]) => [
          address,
          {
            balance: value.balance,
            weight: "0",
            timestampMs,
          },
        ]),
    ),
  };
}
