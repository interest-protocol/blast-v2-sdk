/**
 * How a transaction builder sources the SUI the transaction itself spends: a
 * fee, a deposit, or a SUI-quoted purchase. Other coin types always come from
 * the sender's coins and address balance.
 *
 * `useGasCoin` is passed to `@mysten/sui`'s `tx.coin`, whose default (`true`)
 * withdraws from the sender's address balance when it covers the amount and
 * otherwise splits the gas coin. Pass `false` when someone else pays gas: a
 * sponsored transaction's gas coin belongs to the sponsor, who may reject a
 * transaction that uses it as an argument or end up paying the sender's SUI.
 * With `false`, the SUI comes from the sender's coins and address balance, so
 * a self-paying sender needs SUI beyond what gas selection takes.
 *
 * Builders take it at construction and per call; the per-call value wins,
 * and both default to `true`, `@mysten/sui`'s own default.
 */
export type CoinSourceOptions = Readonly<{
  useGasCoin?: boolean;
}>;
