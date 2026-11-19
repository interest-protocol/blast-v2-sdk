import { normalizeSuiAddress } from "@mysten/sui/utils";

import {
  mulDivDown,
  mulDivUp,
  requirePositiveU64,
  requireU64,
} from "../lib/integers.ts";

/** The fixed rate an offer sells at: `offeredAmount` of `Offered` for `wantedAmount` of `Wanted`. */
export type OfferTerms = Readonly<{
  offeredAmount: bigint;
  wantedAmount: bigint;
}>;

/** What `take` checks before it moves value. */
export type TakeableOffer = OfferTerms &
  Readonly<{
    balance: bigint;
    partialFills: boolean;
    taker: string | null;
  }>;

export type TakeQuote = Readonly<{
  amount: bigint;
  paid: bigint;
}>;

/**
 * Returns what buying `amount` of the escrow costs: `amount * wantedAmount / offeredAmount`,
 * rounded up for the maker as `take` does. A full take costs exactly `wantedAmount`.
 */
export function takeCost(terms: OfferTerms, amount: bigint): bigint {
  requireTerms(terms);
  requireU64("amount", amount);
  return mulDivUp(amount, terms.wantedAmount, terms.offeredAmount);
}

/**
 * Returns the most of the escrow `payment` buys at the offer's rate, without the partial-fill
 * or balance limits: the largest `amount` whose `takeCost` does not exceed `payment`.
 */
export function maxTakeForPayment(terms: OfferTerms, payment: bigint): bigint {
  requireTerms(terms);
  requireU64("payment", payment);
  return mulDivDown(payment, terms.offeredAmount, terms.wantedAmount);
}

/**
 * Quotes one `take` and applies its guards in the contract's order, so a quote that returns
 * would not abort on-chain against the same state. Pass `sender` to check a restricted offer.
 */
export function quoteTake(
  offer: TakeableOffer,
  amount: bigint,
  sender?: string,
): TakeQuote {
  requireTerms(offer);
  requireU64("balance", offer.balance);
  if (
    sender !== undefined &&
    offer.taker !== null &&
    normalizeSuiAddress(sender) !== normalizeSuiAddress(offer.taker)
  ) {
    throw new RangeError("sender is not the taker this offer names");
  }
  requirePositiveU64("amount", amount);
  if (amount > offer.balance) {
    throw new RangeError("amount exceeds the offer balance");
  }
  if (!offer.partialFills && amount !== offer.balance) {
    throw new RangeError("offer must be taken in full");
  }
  return { amount, paid: takeCost(offer, amount) };
}

function requireTerms(terms: OfferTerms): void {
  requirePositiveU64("offeredAmount", terms.offeredAmount);
  requirePositiveU64("wantedAmount", terms.wantedAmount);
}
