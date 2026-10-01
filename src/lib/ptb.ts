import type {
  TransactionObjectArgument,
  TransactionResult,
} from "@mysten/sui/transactions";

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
