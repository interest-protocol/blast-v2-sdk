import type {
  TransactionObjectArgument,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";

import { grossGasBudget } from "./gas.ts";

import type { SharedObjectIdentity } from "./sui.ts";

type MoveResults<
  Count extends number,
  Results extends TransactionObjectArgument[] = [],
> = Results["length"] extends Count
  ? Results
  : MoveResults<Count, [...Results, TransactionObjectArgument]>;

/** The first `count` values one Move call returned, in return order. */
export function moveResults<const Count extends number>(
  result: TransactionResult,
  count: Count,
): MoveResults<Count> {
  return Array.from({ length: count }, (_, index) => {
    const value = result[index];
    if (!value) throw new RangeError(`Move call has no result ${index}`);
    return value;
  }) as MoveResults<Count>;
}

/** A deployment's shared object with the mutability this Move call needs. */
export function deploymentObject(
  tx: Transaction,
  identity: SharedObjectIdentity,
  mutable: boolean,
): TransactionObjectArgument {
  return tx.sharedObjectRef({ ...identity, mutable });
}

/**
 * A new transaction that budgets its gas at gross cost plus headroom when
 * built without a budget (`grossGasBudget`). Every SDK builder starts here.
 */
export function newTransaction(): Transaction {
  const tx = new Transaction();
  tx.addBuildPlugin(grossGasBudget());
  return tx;
}
