import type {
  TransactionObjectArgument,
  TransactionObjectInput,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, SUI_TYPE_ARG } from "@mysten/sui/utils";

import { requireU64 } from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";
import type { BlastSuiDeployment } from "./types.ts";
import {
  blastSuiType,
  funSuiType,
  normalizeBlastSuiDeployment,
} from "./types.ts";

type NormalizedBlastSuiDeployment = ReturnType<
  typeof normalizeBlastSuiDeployment
>;

export class BlastSuiCalls {
  readonly deployment: NormalizedBlastSuiDeployment;

  constructor(deployment: BlastSuiDeployment) {
    this.deployment = normalizeBlastSuiDeployment(deployment);
  }

  mintFunSui(options: { suiCoin: TransactionObjectInput }) {
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::mint_fun_sui`,
        arguments: [
          this.vault(tx),
          this.packageVersion(tx),
          tx.object.system({ mutable: true }),
          tx.object(options.suiCoin),
        ],
      });
  }

  redeemFunSui(options: { funSuiCoin: TransactionObjectInput }) {
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::redeem_fun_sui`,
        arguments: [
          this.vault(tx),
          this.packageVersion(tx),
          tx.object.system({ mutable: true }),
          tx.object(options.funSuiCoin),
        ],
      });
  }

  requestBlastSui(options: { suiCoin: TransactionObjectInput }) {
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::request_blast_sui`,
        arguments: [
          this.vault(tx),
          this.packageVersion(tx),
          tx.object.system({ mutable: true }),
          tx.object(options.suiCoin),
        ],
      });
  }

  keepDepositReceipt(options: { receipt: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::deposit_receipt::keep`,
        arguments: [tx.object(options.receipt)],
      });
    };
  }

  claimBlastSui(options: {
    receipt: TransactionObjectInput;
    minBlastOut: bigint;
  }) {
    requireU64("minBlastOut", options.minBlastOut);
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::claim_blast_sui`,
        arguments: [
          this.vault(tx),
          this.packageVersion(tx),
          tx.object.system({ mutable: true }),
          tx.object(options.receipt),
          tx.pure.u64(options.minBlastOut),
        ],
      });
  }

  cancelDepositReceipt(options: { receipt: TransactionObjectInput }) {
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::deposit_receipt::cancel`,
        arguments: [
          tx.object(options.receipt),
          tx.object.system({ mutable: true }),
        ],
      });
  }

  donateSui(options: { suiCoin: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::donate_sui`,
        arguments: [
          this.vault(tx),
          this.packageVersion(tx),
          tx.object.system({ mutable: true }),
          tx.object(options.suiCoin),
        ],
      });
    };
  }

  redeemBlastSui(options: {
    blastSuiCoin: TransactionObjectInput;
    minSuiOut: bigint;
  }) {
    requireU64("minSuiOut", options.minSuiOut);
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::redeem_blast_sui`,
        arguments: [
          this.vault(tx),
          this.packageVersion(tx),
          tx.object.system({ mutable: true }),
          tx.object(options.blastSuiCoin),
          tx.pure.u64(options.minSuiOut),
        ],
      });
  }

  syncVault() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::sync`,
        arguments: [
          this.vault(tx),
          this.packageVersion(tx),
          tx.object.system({ mutable: true }),
        ],
      });
    };
  }

  private vault(tx: Transaction): TransactionObjectArgument {
    return sharedObject(tx, this.deployment.vault);
  }

  private packageVersion(tx: Transaction): TransactionObjectArgument {
    return sharedObject(tx, this.deployment.packageVersion);
  }
}

export class BlastSuiTransactions {
  readonly call: BlastSuiCalls;

  constructor(deployment: BlastSuiDeployment) {
    this.call = new BlastSuiCalls(deployment);
  }

  mintFunSui(options: { amount: bigint; recipient: string }): Transaction {
    requireU64("amount", options.amount);
    const tx = new Transaction();
    const suiCoin = tx.coin({ type: SUI_TYPE_ARG, balance: options.amount });
    const funSuiCoin = tx.add(this.call.mintFunSui({ suiCoin }));
    transfer(tx, funSuiCoin, options.recipient);
    return tx;
  }

  redeemFunSui(options: { amount: bigint; recipient: string }): Transaction {
    requireU64("amount", options.amount);
    const tx = new Transaction();
    const funSuiCoin = tx.coin({
      type: funSuiType(this.call.deployment.originalPackageId),
      balance: options.amount,
    });
    const suiCoin = tx.add(this.call.redeemFunSui({ funSuiCoin }));
    transfer(tx, suiCoin, options.recipient);
    return tx;
  }

  requestBlastSui(options: { amount: bigint }): Transaction {
    requireU64("amount", options.amount);
    const tx = new Transaction();
    const suiCoin = tx.coin({ type: SUI_TYPE_ARG, balance: options.amount });
    const receipt = tx.add(this.call.requestBlastSui({ suiCoin }));
    tx.add(this.call.keepDepositReceipt({ receipt }));
    return tx;
  }

  claimBlastSui(options: {
    receiptId: string;
    minBlastOut: bigint;
    recipient: string;
  }): Transaction {
    const tx = new Transaction();
    const blastSuiCoin = tx.add(
      this.call.claimBlastSui({
        receipt: options.receiptId,
        minBlastOut: options.minBlastOut,
      }),
    );
    transfer(tx, blastSuiCoin, options.recipient);
    return tx;
  }

  cancelDepositReceipt(options: {
    receiptId: string;
    recipient: string;
  }): Transaction {
    const tx = new Transaction();
    const suiCoin = tx.add(
      this.call.cancelDepositReceipt({ receipt: options.receiptId }),
    );
    transfer(tx, suiCoin, options.recipient);
    return tx;
  }

  donateSui(options: { amount: bigint }): Transaction {
    requireU64("amount", options.amount);
    const tx = new Transaction();
    const suiCoin = tx.coin({ type: SUI_TYPE_ARG, balance: options.amount });
    tx.add(this.call.donateSui({ suiCoin }));
    return tx;
  }

  redeemBlastSui(options: {
    amount: bigint;
    minSuiOut: bigint;
    recipient: string;
  }): Transaction {
    requireU64("amount", options.amount);
    const tx = new Transaction();
    const blastSuiCoin = tx.coin({
      type: blastSuiType(this.call.deployment.originalPackageId),
      balance: options.amount,
    });
    const suiCoin = tx.add(
      this.call.redeemBlastSui({
        blastSuiCoin,
        minSuiOut: options.minSuiOut,
      }),
    );
    transfer(tx, suiCoin, options.recipient);
    return tx;
  }

  syncVault(): Transaction {
    const tx = new Transaction();
    tx.add(this.call.syncVault());
    return tx;
  }
}

function sharedObject(
  tx: Transaction,
  reference: SharedObjectReference,
): TransactionObjectArgument {
  return tx.sharedObjectRef(reference);
}

function transfer(
  tx: Transaction,
  object: TransactionObjectArgument,
  recipient: string,
): void {
  tx.transferObjects([object], normalizeSuiAddress(recipient));
}

export type { BlastSuiDeployment } from "./types.ts";
