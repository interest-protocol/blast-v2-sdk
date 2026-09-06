import type {
  TransactionArgument,
  TransactionObjectInput,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import {
  requireBasisPoints,
  requirePositiveU64,
  requireU64,
  requireU128,
} from "../lib/integers.ts";
import type { SharedObjectIdentity } from "../lib/sui.ts";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "../lib/sui.ts";

export type DexPair = { memeType: string; quoteType: string };
export type DexPoolInput = DexPair & { pool: TransactionObjectInput };
export type DexDeployment = {
  packageId: string;
  originalPackageId?: string;
  factory: SharedObjectIdentity;
};
export type DexSwapOptions = DexPoolInput & {
  input: TransactionObjectInput;
  minimumOutput: bigint;
  maximumFeeBps: bigint;
  deadlineMs: bigint;
};
export type DexLiquidityOptions = DexPoolInput & {
  position: TransactionObjectInput;
  meme: TransactionObjectInput;
  quote: TransactionObjectInput;
  minimumShares: bigint;
  deadlineMs: bigint;
};
export type DexRemoveOptions = DexPoolInput & {
  position: TransactionObjectInput;
  shares: bigint;
  minimumMeme: bigint;
  minimumQuote: bigint;
  deadlineMs: bigint;
};
export type DexCreateOptions = DexPair & {
  creatorCap: TransactionObjectInput;
  launch: TransactionObjectInput;
  currency: TransactionObjectInput;
  meme: TransactionObjectInput;
  quote: TransactionObjectInput;
  burnBps: bigint;
};
export type DexMigrationOptions = DexPair & {
  launch: TransactionObjectInput;
  packageVersion: TransactionObjectInput;
  currency: TransactionObjectInput;
};

/** Composable calls; callers retain every returned coin/position and must deliver it in the PTB. */
export class DexCalls {
  readonly deployment: Required<DexDeployment>;
  constructor(deployment: DexDeployment) {
    this.deployment = {
      ...normalizeSuiPackageReference("dex", {
        packageId: deployment.packageId,
        originalPackageId: deployment.originalPackageId ?? deployment.packageId,
      }),
      factory: normalizeSharedObjectIdentity("factory", deployment.factory),
    };
  }
  assertCurrent() {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::assert_current`,
        arguments: [this.factory(tx)],
      });
  }
  activate(options: { adminWitness: TransactionArgument }) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::activate`,
        arguments: [this.factory(tx, true), options.adminWitness],
      });
  }
  create(options: DexCreateOptions) {
    requireU64("burnBps", options.burnBps);
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::create`,
        typeArguments: dexPairTypes(options),
        arguments: [
          this.factory(tx, true),
          tx.object(options.creatorCap),
          tx.object(options.launch),
          tx.object(options.currency),
          tx.object(options.meme),
          tx.object(options.quote),
          tx.pure.u64(options.burnBps),
          tx.object.clock(),
        ],
      });
  }
  share(options: DexPoolInput) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::share`,
        typeArguments: dexPairTypes(options),
        arguments: [tx.object(options.pool)],
      });
  }
  newPosition(options: DexPoolInput) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::new_position`,
        typeArguments: dexPairTypes(options),
        arguments: [tx.object(options.pool)],
      });
  }
  setMaxFee(
    options: DexPoolInput & {
      adminWitness: TransactionArgument;
      maximumBps: bigint;
    },
  ) {
    requireU64("maximumBps", options.maximumBps);
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::set_max_fee`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.pool),
          this.factory(tx),
          options.adminWitness,
          tx.pure.u64(options.maximumBps),
        ],
      });
  }
  depositAmounts(
    options: DexPoolInput & { memeMaximum: bigint; quoteMaximum: bigint },
  ) {
    requireU64("memeMaximum", options.memeMaximum);
    requireU64("quoteMaximum", options.quoteMaximum);
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::deposit_amounts`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.pool),
          tx.pure.u64(options.memeMaximum),
          tx.pure.u64(options.quoteMaximum),
        ],
      });
  }
  addLiquidity(options: DexLiquidityOptions) {
    requireU128("minimumShares", options.minimumShares);
    requireU64("deadlineMs", options.deadlineMs);
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::add_liquidity`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.pool),
          this.factory(tx),
          tx.object(options.position),
          tx.object(options.meme),
          tx.object(options.quote),
          tx.pure.u128(options.minimumShares),
          tx.pure.u64(options.deadlineMs),
          tx.object.clock(),
        ],
      });
  }
  removeLiquidity(options: DexRemoveOptions) {
    requireU128("shares", options.shares);
    requireU64("minimumMeme", options.minimumMeme);
    requireU64("minimumQuote", options.minimumQuote);
    requireU64("deadlineMs", options.deadlineMs);
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::remove_liquidity`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.pool),
          this.factory(tx),
          tx.object(options.position),
          tx.pure.u128(options.shares),
          tx.pure.u64(options.minimumMeme),
          tx.pure.u64(options.minimumQuote),
          tx.pure.u64(options.deadlineMs),
          tx.object.clock(),
        ],
      });
  }
  claimFees(options: DexPoolInput & { position: TransactionObjectInput }) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::claim_fees`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.pool),
          this.factory(tx),
          tx.object(options.position),
        ],
      });
  }
  destroyEmpty(options: DexPair & { position: TransactionObjectInput }) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::destroy_empty`,
        typeArguments: dexPairTypes(options),
        arguments: [tx.object(options.position)],
      });
  }
  buy(options: DexSwapOptions) {
    return this.swap("buy", options);
  }
  sell(options: DexSwapOptions) {
    return this.swap("sell", options);
  }
  buyAndBurn(options: DexSwapOptions & { currency: TransactionObjectInput }) {
    return this.swap("buy_and_burn", options);
  }
  sellAndBurn(options: DexSwapOptions & { currency: TransactionObjectInput }) {
    return this.swap("sell_and_burn", options);
  }
  migrate(options: DexMigrationOptions) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::migration::migrate`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.launch),
          tx.object(options.packageVersion),
          this.factory(tx, true),
          tx.object(options.currency),
          tx.object.clock(),
        ],
      });
  }
  collectNativeFees(
    options: DexPoolInput & {
      vault: TransactionObjectInput;
      runtimeConfig: TransactionObjectInput;
    },
  ) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::migration::collect`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.vault),
          tx.object(options.pool),
          this.factory(tx),
          tx.object(options.runtimeConfig),
        ],
      });
  }
  claimNativeCreatorFees(
    options: DexPair & {
      vault: TransactionObjectInput;
      creatorCap: TransactionObjectInput;
    },
  ) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::migration::claim_creator_fees`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.vault),
          tx.object(options.creatorCap),
          this.factory(tx),
        ],
      });
  }
  claimNativeProtocolFees(
    options: DexPair & {
      vault: TransactionObjectInput;
      adminWitness: TransactionArgument;
    },
  ) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::migration::claim_protocol_fees`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.vault),
          options.adminWitness,
          this.factory(tx),
        ],
      });
  }
  private factory(tx: Transaction, mutable = false) {
    return tx.sharedObjectRef({ ...this.deployment.factory, mutable });
  }
  private swap(
    method: "buy" | "sell" | "buy_and_burn" | "sell_and_burn",
    options: DexSwapOptions & { currency?: TransactionObjectInput },
  ) {
    requireU64("minimumOutput", options.minimumOutput);
    requireBasisPoints("maximumFeeBps", options.maximumFeeBps);
    requireU64("deadlineMs", options.deadlineMs);
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::pool::${method}`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.pool),
          this.factory(tx),
          tx.object(options.input),
          ...(method.endsWith("_and_burn") && options.currency !== undefined
            ? [tx.object(options.currency)]
            : []),
          tx.pure.u64(options.minimumOutput),
          tx.pure.u64(options.maximumFeeBps),
          tx.pure.u64(options.deadlineMs),
          tx.object.clock(),
        ],
      });
  }
}

type TradeTransactionOptions = Omit<DexSwapOptions, "input"> & {
  recipient: string;
  currency?: TransactionObjectInput;
};
/** Complete common transactions; every returned coin and position is delivered explicitly. */
export class DexTransactions {
  readonly call: DexCalls;
  constructor(deployment: DexDeployment) {
    this.call = new DexCalls(deployment);
  }
  buy(options: TradeTransactionOptions & { quoteAmount: bigint }): Transaction {
    requirePositiveU64("quoteAmount", options.quoteAmount);
    const tx = new Transaction();
    const input = tx.coin({
      type: normalizeStructTag(options.quoteType),
      balance: options.quoteAmount,
    });
    const args = { ...options, input };
    const result = tx.add(
      options.currency === undefined
        ? this.call.buy(args)
        : this.call.buyAndBurn({ ...args, currency: options.currency }),
    );
    tx.transferObjects(
      [result[0]!, result[1]!],
      dexRecipient(options.recipient),
    );
    return tx;
  }
  sell(options: TradeTransactionOptions & { memeAmount: bigint }): Transaction {
    requirePositiveU64("memeAmount", options.memeAmount);
    const tx = new Transaction();
    const input = tx.coin({
      type: normalizeStructTag(options.memeType),
      balance: options.memeAmount,
    });
    const args = { ...options, input };
    const result = tx.add(
      options.currency === undefined
        ? this.call.sell(args)
        : this.call.sellAndBurn({ ...args, currency: options.currency }),
    );
    tx.transferObjects([result], dexRecipient(options.recipient));
    return tx;
  }
  create(
    options: Omit<DexCreateOptions, "meme" | "quote"> & {
      memeAmount: bigint;
      quoteAmount: bigint;
      recipient: string;
    },
  ): Transaction {
    requirePositiveU64("memeAmount", options.memeAmount);
    requirePositiveU64("quoteAmount", options.quoteAmount);
    const tx = new Transaction();
    const result = tx.add(
      this.call.create({
        ...options,
        meme: tx.coin({
          type: normalizeStructTag(options.memeType),
          balance: options.memeAmount,
        }),
        quote: tx.coin({
          type: normalizeStructTag(options.quoteType),
          balance: options.quoteAmount,
        }),
      }),
    );
    tx.add(this.call.share({ ...options, pool: result[0]! }));
    tx.transferObjects([result[1]!], dexRecipient(options.recipient));
    return tx;
  }
  addLiquidity(
    options: Omit<DexLiquidityOptions, "meme" | "quote"> & {
      memeMaximum: bigint;
      quoteMaximum: bigint;
      recipient: string;
    },
  ): Transaction {
    requirePositiveU64("memeMaximum", options.memeMaximum);
    requirePositiveU64("quoteMaximum", options.quoteMaximum);
    const tx = new Transaction();
    const result = tx.add(
      this.call.addLiquidity({
        ...options,
        meme: tx.coin({
          type: normalizeStructTag(options.memeType),
          balance: options.memeMaximum,
        }),
        quote: tx.coin({
          type: normalizeStructTag(options.quoteType),
          balance: options.quoteMaximum,
        }),
      }),
    );
    tx.transferObjects(
      [result[0]!, result[1]!],
      dexRecipient(options.recipient),
    );
    return tx;
  }
  removeLiquidity(
    options: DexRemoveOptions & { recipient: string },
  ): Transaction {
    const tx = new Transaction();
    const result = tx.add(this.call.removeLiquidity(options));
    tx.transferObjects(
      [result[0]!, result[1]!],
      dexRecipient(options.recipient),
    );
    return tx;
  }
  claimFees(
    options: DexPoolInput & {
      position: TransactionObjectInput;
      recipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const coin = tx.add(this.call.claimFees(options));
    tx.transferObjects([coin], dexRecipient(options.recipient));
    return tx;
  }
  newPosition(options: DexPoolInput & { recipient: string }): Transaction {
    const tx = new Transaction();
    const position = tx.add(this.call.newPosition(options));
    tx.transferObjects([position], dexRecipient(options.recipient));
    return tx;
  }
  migrate(options: DexMigrationOptions): Transaction {
    const tx = new Transaction();
    tx.add(this.call.migrate(options));
    return tx;
  }
}

export function dexPairTypes(pair: DexPair): [string, string] {
  const meme = normalizeStructTag(pair.memeType);
  const quote = normalizeStructTag(pair.quoteType);
  if (meme === quote) throw new TypeError("Meme and Quote must differ");
  return [meme, quote];
}
export function dexRecipient(value: string): string {
  const address = normalizeSuiAddress(value);
  if (BigInt(address) === 0n)
    throw new RangeError("recipient/executor must not be zero");
  return address;
}
