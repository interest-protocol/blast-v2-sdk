import { MigratorCalls } from "@interest-protocol/blast-migrators-sdk/transactions";
import { VaultCalls } from "@interest-protocol/blast-vault-sdk/transactions";
import type {
  Transaction,
  TransactionArgument,
  TransactionObjectInput,
} from "@mysten/sui/transactions";

/**
 * Stand-ins for the migrators and vault builders the launchpad compositions
 * call (WP2 and WP1 fill the real bodies in parallel). Each emits one Move call
 * named after the real function, typed `<Meme, Quote>`, passing on the
 * arguments that thread the PTB (the `TreasuryCap`, the `Migration`, the
 * `OwnerProof`, a `Coin<SUI>`), so the composition's command shape can be
 * asserted. Returns a function that restores the originals.
 */
export function stubVenueCalls(): () => void {
  const migrators = MigratorCalls.prototype;
  const vault = VaultCalls.prototype;
  const saved = {
    prepareCetus: migrators.prepareCetus,
    prepareBluefin: migrators.prepareBluefin,
    migrateCetus: migrators.migrateCetus,
    migrateBluefin: migrators.migrateBluefin,
    claimOwnerBalances: vault.claimOwnerBalances,
    scheduleFeeSplit: vault.scheduleFeeSplit,
    cancelFeeSplit: vault.cancelFeeSplit,
  };
  type Types = { memeType: string; quoteType: string };
  const call =
    (
      self: { deployment: { packageId: string } },
      target: string,
      options: Types,
      args: (tx: Transaction) => TransactionArgument[],
    ) =>
    (tx: Transaction) =>
      tx.moveCall({
        target: `${self.deployment.packageId}::${target}`,
        typeArguments: [options.memeType, options.quoteType],
        arguments: args(tx),
      });
  migrators.prepareCetus = function (
    this: MigratorCalls,
    options: Types & { treasuryCap: TransactionObjectInput },
  ) {
    return call(this, "cetus::prepare", options, (tx) => [
      tx.object(options.treasuryCap),
    ]);
  } as never;
  migrators.prepareBluefin = function (
    this: MigratorCalls,
    options: Types & { treasuryCap: TransactionObjectInput },
  ) {
    return call(this, "bluefin::prepare", options, (tx) => [
      tx.object(options.treasuryCap),
    ]);
  } as never;
  migrators.migrateCetus = function (
    this: MigratorCalls,
    options: Types & { migration: TransactionArgument },
  ) {
    return call(this, "cetus::migrate", options, () => [options.migration]);
  } as never;
  migrators.migrateBluefin = function (
    this: MigratorCalls,
    options: Types & {
      migration: TransactionArgument;
      creationFee: TransactionArgument;
    },
  ) {
    return call(this, "bluefin::migrate", options, () => [
      options.migration,
      options.creationFee,
    ]);
  } as never;
  vault.claimOwnerBalances = function (
    this: VaultCalls,
    options: Types & { proof: TransactionArgument },
  ) {
    return call(this, "vault::claim_owner_balances", options, () => [
      options.proof,
    ]);
  } as never;
  vault.scheduleFeeSplit = function (
    this: VaultCalls,
    options: Types & {
      proof: TransactionArgument;
      proposed: TransactionArgument;
    },
  ) {
    return call(this, "vault::schedule_fee_split", options, () => [
      options.proof,
      options.proposed,
    ]);
  } as never;
  vault.cancelFeeSplit = function (
    this: VaultCalls,
    options: Types & { proof: TransactionArgument },
  ) {
    return call(this, "vault::cancel_fee_split", options, () => [
      options.proof,
    ]);
  } as never;
  return () => {
    const { claimOwnerBalances, scheduleFeeSplit, cancelFeeSplit, ...venue } =
      saved;
    Object.assign(migrators, venue);
    Object.assign(vault, {
      claimOwnerBalances,
      scheduleFeeSplit,
      cancelFeeSplit,
    });
  };
}
