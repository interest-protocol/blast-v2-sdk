import type {
  TransactionArgument,
  TransactionObjectInput,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import type { DexDeployment, DexPair } from "../dex/transactions.ts";
import { DexCalls, dexPairTypes, dexRecipient } from "../dex/transactions.ts";
import { requireU64, requireU128 } from "../lib/integers.ts";
import type { SharedObjectIdentity } from "../lib/sui.ts";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "../lib/sui.ts";

export type AutoLpDeployment = {
  packageId: string;
  originalPackageId?: string;
  control: SharedObjectIdentity;
  dex: DexDeployment;
};
export type AutoLpVaultInput = DexPair & { vault: TransactionObjectInput };
export type AutoLpEnrollOptions = DexPair & {
  creatorCap: TransactionObjectInput;
  pool: TransactionObjectInput;
  executor: string;
};
export type AutoLpCompoundOptions = AutoLpVaultInput & {
  pool: TransactionObjectInput;
  maximumMeme: bigint;
  maximumQuote: bigint;
  minimumShares: bigint;
  deadlineMs: bigint;
};

/** Sealed custody calls. These never return the cap, position, principal or fees. */
export class AutoLpCalls {
  readonly deployment: Required<AutoLpDeployment>;
  constructor(deployment: AutoLpDeployment) {
    this.deployment = {
      ...normalizeSuiPackageReference("autoLp", {
        packageId: deployment.packageId,
        originalPackageId: deployment.originalPackageId ?? deployment.packageId,
      }),
      control: normalizeSharedObjectIdentity("control", deployment.control),
      dex: new DexCalls(deployment.dex).deployment,
    };
  }
  enroll(options: AutoLpEnrollOptions) {
    const executor = dexRecipient(options.executor);
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::new`,
        typeArguments: dexPairTypes(options),
        arguments: [
          this.control(tx),
          tx.object(options.creatorCap),
          tx.object(options.pool),
          this.factory(tx),
          tx.pure.address(executor),
        ],
      });
  }
  share(options: AutoLpVaultInput) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::share`,
        typeArguments: dexPairTypes(options),
        arguments: [tx.object(options.vault)],
      });
  }
  collectCurve(
    options: AutoLpVaultInput & {
      launch: TransactionObjectInput;
      packageVersion: TransactionObjectInput;
    },
  ) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::collect_curve`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.vault),
          this.control(tx),
          tx.object(options.launch),
          tx.object(options.packageVersion),
        ],
      });
  }
  collectExternalLp(
    options: AutoLpVaultInput & { source: TransactionObjectInput },
  ) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::collect_external_lp`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.vault),
          this.control(tx),
          tx.object(options.source),
        ],
      });
  }
  collectNativeLp(
    options: AutoLpVaultInput & { source: TransactionObjectInput },
  ) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::collect_native_lp`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.vault),
          this.control(tx),
          tx.object(options.source),
          this.factory(tx),
        ],
      });
  }
  collectOwnLp(options: AutoLpVaultInput & { pool: TransactionObjectInput }) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::collect_own_lp`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.vault),
          this.control(tx),
          tx.object(options.pool),
          this.factory(tx),
        ],
      });
  }
  contribute(
    options: AutoLpVaultInput & {
      meme: TransactionObjectInput;
      quote: TransactionObjectInput;
    },
  ) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::contribute`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.vault),
          this.control(tx),
          tx.object(options.meme),
          tx.object(options.quote),
        ],
      });
  }
  /** Only the stored executor can execute this call; minimum shares must be chosen against a trusted quote. */
  compound(options: AutoLpCompoundOptions) {
    requireU64("maximumMeme", options.maximumMeme);
    requireU64("maximumQuote", options.maximumQuote);
    requireU128("minimumShares", options.minimumShares);
    requireU64("deadlineMs", options.deadlineMs);
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::compound`,
        typeArguments: dexPairTypes(options),
        arguments: [
          tx.object(options.vault),
          this.control(tx),
          tx.object(options.pool),
          this.factory(tx),
          tx.pure.u64(options.maximumMeme),
          tx.pure.u64(options.maximumQuote),
          tx.pure.u128(options.minimumShares),
          tx.pure.u64(options.deadlineMs),
          tx.object.clock(),
        ],
      });
  }
  activate(options: { adminWitness: TransactionArgument }) {
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::activate`,
        arguments: [this.control(tx, true), options.adminWitness],
      });
  }
  private control(tx: Transaction, mutable = false) {
    return tx.sharedObjectRef({ ...this.deployment.control, mutable });
  }
  private factory(tx: Transaction) {
    return tx.sharedObjectRef({
      ...this.deployment.dex.factory,
      mutable: false,
    });
  }
}

export class AutoLpTransactions {
  readonly call: AutoLpCalls;
  constructor(deployment: AutoLpDeployment) {
    this.call = new AutoLpCalls(deployment);
  }
  enroll(options: AutoLpEnrollOptions): Transaction {
    const tx = new Transaction();
    const vault = tx.add(this.call.enroll(options));
    tx.add(this.call.share({ ...options, vault }));
    return tx;
  }
  compound(options: AutoLpCompoundOptions): Transaction {
    const tx = new Transaction();
    tx.add(this.call.compound(options));
    return tx;
  }
  contribute(
    options: AutoLpVaultInput & { memeAmount: bigint; quoteAmount: bigint },
  ): Transaction {
    requireU64("memeAmount", options.memeAmount);
    requireU64("quoteAmount", options.quoteAmount);
    const tx = new Transaction();
    const [memeType, quoteType] = dexPairTypes(options);
    const meme =
      options.memeAmount === 0n
        ? tx.moveCall({ target: "0x2::coin::zero", typeArguments: [memeType] })
        : tx.coin({ type: memeType, balance: options.memeAmount });
    const quote =
      options.quoteAmount === 0n
        ? tx.moveCall({ target: "0x2::coin::zero", typeArguments: [quoteType] })
        : tx.coin({ type: quoteType, balance: options.quoteAmount });
    tx.add(this.call.contribute({ ...options, meme, quote }));
    return tx;
  }
}
