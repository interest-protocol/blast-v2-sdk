import type {
  TransactionObjectArgument,
  TransactionObjectInput,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import { requirePositiveU64 } from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";
import {
  normalizeSharedObjectReference,
  normalizeSuiPackageReference,
} from "../lib/sui.ts";
import type { TakeableOffer } from "./quote.ts";
import { quoteTake } from "./quote.ts";

export type { SharedObjectReference } from "../lib/sui.ts";

/** The one Move module of `blast_fun_otc`. */
export const OTC_MODULE = "blast_fun_otc";

export type OtcDeployment = {
  packageId: string;
  originalPackageId?: string;
};

/** A shared offer and its two coin types, as `take` and `cancel` need it. */
export type OfferPosition = SharedObjectReference<true> & {
  offeredType: string;
  wantedType: string;
};

type NormalizedDeployment = Required<OtcDeployment>;

export type CreateOfferOptions = {
  offeredType: string;
  wantedType: string;
  offeredAmount: bigint;
  wantedAmount: bigint;
  /** Restricts the offer to one taker; omit or pass `null` for anyone. */
  taker?: string | null;
  partialFills: boolean;
};

export class OtcCalls {
  readonly deployment: NormalizedDeployment;

  constructor(deployment: OtcDeployment) {
    this.deployment = normalizeDeployment(deployment);
  }

  /** Escrows `offered` and returns the unshared `Offer`; the sender becomes the maker. */
  newOffer(options: {
    offeredType: string;
    wantedType: string;
    offered: TransactionObjectInput;
    wantedAmount: bigint;
    taker?: string | null;
    partialFills: boolean;
  }) {
    const types = normalizeCoinTypes(options);
    requirePositiveU64("wantedAmount", options.wantedAmount);
    const taker = normalizeTaker(options.taker);
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::${OTC_MODULE}::new`,
        typeArguments: [types.offeredType, types.wantedType],
        arguments: [
          tx.object(options.offered),
          tx.pure.u64(options.wantedAmount),
          tx.pure.option("address", taker),
          tx.pure.bool(options.partialFills),
        ],
      });
  }

  share(options: {
    offeredType: string;
    wantedType: string;
    offer: TransactionObjectInput;
  }) {
    const types = normalizeCoinTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::${OTC_MODULE}::share`,
        typeArguments: [types.offeredType, types.wantedType],
        arguments: [tx.object(options.offer)],
      });
    };
  }

  /**
   * Buys `amount` of the escrow, paying the maker from `payment` (a `Coin<Wanted>` the call
   * splits). Returns the bought `Coin<Offered>`.
   */
  take(
    options: OfferPosition & {
      amount: bigint;
      payment: TransactionObjectInput;
    },
  ) {
    const position = normalizePosition(options);
    requirePositiveU64("amount", options.amount);
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::${OTC_MODULE}::take`,
        typeArguments: [position.offeredType, position.wantedType],
        arguments: [
          sharedObject(tx, position),
          tx.pure.u64(options.amount),
          tx.object(options.payment),
        ],
      });
  }

  /** Deletes the offer and returns its remaining escrow; only the maker may call it. */
  cancel(options: OfferPosition) {
    const position = normalizePosition(options);
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::${OTC_MODULE}::cancel`,
        typeArguments: [position.offeredType, position.wantedType],
        arguments: [sharedObject(tx, position)],
      });
  }
}

export class OtcTransactions {
  readonly call: OtcCalls;

  constructor(deployment: OtcDeployment) {
    this.call = new OtcCalls(deployment);
  }

  /** Escrows `offeredAmount` from the sender and shares the offer in one transaction. */
  createOffer(options: CreateOfferOptions): Transaction {
    requirePositiveU64("offeredAmount", options.offeredAmount);
    const types = normalizeCoinTypes(options);
    const tx = new Transaction();
    const offered = tx.coin({
      type: types.offeredType,
      balance: options.offeredAmount,
    });
    const offer = tx.add(this.call.newOffer({ ...options, ...types, offered }));
    tx.add(this.call.share({ ...types, offer }));
    return tx;
  }

  /**
   * Buys `amount` of a decoded offer. Pays exactly the quoted cost, so the payment coin ends
   * empty and is destroyed, and sends the bought coins to `recipient`. Pass `sender` to reject
   * an offer restricted to another taker before signing.
   */
  take(options: {
    offer: OfferPosition & TakeableOffer;
    amount: bigint;
    recipient: string;
    sender?: string;
  }): Transaction {
    const { paid } = quoteTake(options.offer, options.amount, options.sender);
    const position = normalizePosition(options.offer);
    const tx = new Transaction();
    const payment = tx.coin({ type: position.wantedType, balance: paid });
    const bought = tx.add(
      this.call.take({ ...position, amount: options.amount, payment }),
    );
    tx.moveCall({
      target: "0x2::coin::destroy_zero",
      typeArguments: [position.wantedType],
      arguments: [payment],
    });
    tx.transferObjects([bought], normalizeSuiAddress(options.recipient));
    return tx;
  }

  /** Cancels the offer and sends its remaining escrow to `recipient`. */
  cancel(options: OfferPosition & { recipient: string }): Transaction {
    const tx = new Transaction();
    const refund = tx.add(this.call.cancel(options));
    tx.transferObjects([refund], normalizeSuiAddress(options.recipient));
    return tx;
  }
}

function normalizeDeployment(deployment: OtcDeployment): NormalizedDeployment {
  return normalizeSuiPackageReference("otc", {
    packageId: deployment.packageId,
    originalPackageId: deployment.originalPackageId ?? deployment.packageId,
  });
}

function normalizeCoinTypes(options: {
  offeredType: string;
  wantedType: string;
}): { offeredType: string; wantedType: string } {
  const offeredType = normalizeStructTag(options.offeredType);
  const wantedType = normalizeStructTag(options.wantedType);
  if (offeredType === wantedType) {
    throw new TypeError("offered and wanted coins must be different types");
  }
  return { offeredType, wantedType };
}

function normalizePosition(position: OfferPosition): OfferPosition {
  return {
    ...normalizeCoinTypes(position),
    ...normalizeSharedObjectReference("offer", position, true),
  };
}

function normalizeTaker(taker: string | null | undefined): string | null {
  if (taker === undefined || taker === null) return null;
  const address = normalizeSuiAddress(taker);
  if (BigInt(address) === 0n) {
    throw new RangeError("taker must not be the zero address");
  }
  return address;
}

function sharedObject(
  tx: Transaction,
  reference: SharedObjectReference<true>,
): TransactionObjectArgument {
  return tx.sharedObjectRef(
    normalizeSharedObjectReference("offer", reference, true),
  );
}
