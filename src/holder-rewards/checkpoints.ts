import type { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  isValidSuiAddress,
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from "@mysten/sui/utils";
import type { HolderCheckpoint } from "./holders.ts";

type CheckpointData = {
  sequenceNumber?: bigint;
  digest?: string;
  summary?: {
    previousDigest?: string;
    timestamp?: { seconds: bigint; nanos: number };
  };
  contents?: { transactions: readonly { transaction?: string }[] };
  transactions: readonly {
    digest?: string;
    balanceChanges: readonly {
      address?: string;
      coinType?: string;
      amount?: string;
    }[];
  }[];
};

/** Validates completeness against checkpoint contents before exposing address-level balance deltas. */
export function decodeHolderCheckpoint(
  checkpoint: CheckpointData,
  coinType: string,
): HolderCheckpoint {
  const timestamp = checkpoint.summary?.timestamp;
  if (
    checkpoint.sequenceNumber === undefined ||
    !checkpoint.digest ||
    !timestamp ||
    !checkpoint.contents ||
    checkpoint.transactions.length !== checkpoint.contents.transactions.length
  )
    throw new Error("incomplete checkpoint response");
  if (
    timestamp.seconds < 0n ||
    !Number.isInteger(timestamp.nanos) ||
    timestamp.nanos < 0 ||
    timestamp.nanos >= 1_000_000_000
  )
    throw new Error("invalid checkpoint timestamp");
  const target = normalizeStructTag(coinType);
  const changes: { address: string; amount: bigint }[] = [];
  const seen = new Set<string>();
  for (const [i, tx] of checkpoint.transactions.entries()) {
    if (
      !tx.digest ||
      tx.digest !== checkpoint.contents.transactions[i]?.transaction ||
      seen.has(tx.digest)
    )
      throw new Error("checkpoint transaction digest mismatch");
    seen.add(tx.digest);
    changes.push(...decodeBalanceChanges(tx.balanceChanges, target));
  }
  return {
    sequence: checkpoint.sequenceNumber,
    digest: checkpoint.digest,
    previousDigest: checkpoint.summary?.previousDigest ?? null,
    timestampMs:
      timestamp.seconds * 1000n +
      BigInt(Math.floor(timestamp.nanos / 1_000_000)),
    changes,
  };
}

function decodeBalanceChanges(
  balanceChanges: CheckpointData["transactions"][number]["balanceChanges"],
  target: string,
): { address: string; amount: bigint }[] {
  const changes: { address: string; amount: bigint }[] = [];
  for (const change of balanceChanges) {
    if (
      !change.coinType ||
      !change.address ||
      change.amount === undefined ||
      !/^-?\d+$/.test(change.amount)
    )
      throw new Error("incomplete balance change");
    if (normalizeStructTag(change.coinType) !== target) continue;
    const address = normalizeSuiAddress(change.address);
    if (!isValidSuiAddress(address)) throw new Error("invalid balance address");
    changes.push({ address, amount: BigInt(change.amount) });
  }
  return changes;
}

/** Uses the full-node's coin plus address-accumulator balance-change derivation. */
export async function readHolderCheckpoint(
  client: SuiGrpcClient,
  coinType: string,
  sequence: bigint,
): Promise<HolderCheckpoint> {
  const { checkpoint } = await client.ledgerService.getCheckpoint({
    checkpointId: { oneofKind: "sequenceNumber", sequenceNumber: sequence },
    readMask: {
      paths: [
        "sequence_number",
        "digest",
        "summary.previous_digest",
        "summary.timestamp",
        "contents.transactions.transaction",
        "transactions.digest",
        "transactions.balance_changes",
      ],
    },
  }).response;
  if (!checkpoint) throw new Error("missing checkpoint");
  const result = decodeHolderCheckpoint(checkpoint, coinType);
  if (result.sequence !== sequence)
    throw new Error("provider returned another checkpoint");
  return result;
}

/** Starts before any issuance of a type defined in this immutable package; no guessed holder bootstrap. */
export async function coinPackageCreationCheckpoint(
  client: SuiGrpcClient,
  coinType: string,
): Promise<bigint> {
  const objectId = normalizeSuiAddress(parseStructTag(coinType).address);
  const { object } = await client.ledgerService.getObject({
    objectId,
    readMask: { paths: ["object_id", "previous_transaction"] },
  }).response;
  if (object?.objectId !== objectId || !object.previousTransaction)
    throw new Error("cannot establish coin package provenance");
  const { transaction } = await client.ledgerService.getTransaction({
    digest: object.previousTransaction,
    readMask: { paths: ["digest", "checkpoint"] },
  }).response;
  if (
    transaction?.digest !== object.previousTransaction ||
    transaction.checkpoint === undefined
  )
    throw new Error("coin package creation transaction unavailable");
  return transaction.checkpoint;
}
