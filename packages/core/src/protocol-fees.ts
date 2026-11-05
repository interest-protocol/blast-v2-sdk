import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from "@mysten/sui/utils";
import {
  addressBcs,
  balanceBcs,
  moveTypeNameBcs,
  suiObjectIdBcs,
  u64Bcs,
} from "./bcs.ts";
import { applyBpsUp } from "./bps.ts";
import type { SuiEventPosition } from "./events.ts";
import { normalizeSuiEventPosition } from "./events.ts";
import { BASIS_POINTS_DENOMINATOR, mulDivDown } from "./integers.ts";

/**
 * `blast_core::protocol_fees::Ledger<Meme, Quote>`: Blast's held fees of one
 * launch, presale or vault. `packageWitness` is the original type of the
 * package witness that created it; `partnerId` is fixed at creation.
 */
export const ledgerBcs = bcs
  .struct("Ledger", {
    package_witness: moveTypeNameBcs,
    origin: suiObjectIdBcs,
    partner_id: bcs.option(suiObjectIdBcs),
    meme: balanceBcs,
    quote: balanceBcs,
    sui: balanceBcs,
  })
  .transform({
    input: (ledger: Ledger) => ({
      package_witness: ledger.packageWitness,
      origin: ledger.origin,
      partner_id: ledger.partnerId,
      meme: ledger.meme,
      quote: ledger.quote,
      sui: ledger.sui,
    }),
    output: (ledger): Ledger => ({
      packageWitness: ledger.package_witness,
      origin: ledger.origin,
      partnerId: ledger.partner_id,
      meme: ledger.meme,
      quote: ledger.quote,
      sui: ledger.sui,
    }),
  });

export type Ledger = {
  packageWitness: string;
  origin: string;
  partnerId: string | null;
  meme: bigint;
  quote: bigint;
  sui: bigint;
};

/**
 * Mirrors the amount `protocol_fees::take_cut` moves into the ledger from
 * one fee of one asset: `ceil(amount * bps / 10,000)`; the fee keeps the rest.
 */
export function takeCut(amount: bigint, bps: bigint): bigint {
  return applyBpsUp(amount, bps);
}

/** `blast_core::blast_core_events::ProtocolFeesPaid<Meme, Quote>`, in Move field order. */
export const protocolFeesPaidBcs = bcs.struct("ProtocolFeesPaid", {
  package_witness: moveTypeNameBcs,
  origin: suiObjectIdBcs,
  treasury: addressBcs,
  meme_amount: u64Bcs,
  quote_amount: u64Bcs,
  sui_amount: u64Bcs,
  partner_id: bcs.option(suiObjectIdBcs),
  partner_meme_amount: u64Bcs,
  partner_quote_amount: u64Bcs,
  partner_sui_amount: u64Bcs,
});

export type ProtocolFeesPaid = ReturnType<typeof protocolFeesPaidBcs.parse>;

export type DecodedProtocolFeesPaid = {
  source: "core";
  kind: "ProtocolFeesPaid";
  memeType: string;
  quoteType: string;
  payload: ProtocolFeesPaid;
  sender: string;
  position: SuiEventPosition;
};

/**
 * Decodes one `<core>::blast_core_events::ProtocolFeesPaid<Meme, Quote>`.
 * `payload.origin` is the launch, presale or vault whose ledger paid, and
 * `payload.package_witness` the package that created the ledger.
 */
export function decodeProtocolFeesPaid(
  event: SuiClientTypes.EventEntry,
  core: { originalPackageId: string },
): DecodedProtocolFeesPaid {
  const tag = parseStructTag(event.eventType);
  const [meme, quote, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(core.originalPackageId) ||
    tag.module !== "blast_core_events" ||
    tag.name !== "ProtocolFeesPaid" ||
    meme === undefined ||
    quote === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(`unexpected core event type ${event.eventType}`);
  }
  return {
    source: "core",
    kind: "ProtocolFeesPaid",
    memeType: normalizeStructTag(meme),
    quoteType: normalizeStructTag(quote),
    payload: protocolFeesPaidBcs.parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  };
}

/**
 * Previews `protocol_fees::pay` / `pay_with_partner` over a decoded ledger:
 * the bound partner's cut of each asset first (`partnerShareBps` of it,
 * rounded down per asset as `blast_partners::pay`), Blast's treasury the
 * rest. `partnerShareBps` is required exactly when the ledger names a
 * partner. Null when the ledger is empty: the contract sends and emits
 * nothing. Omits `package_witness`, `origin` and `treasury`, which the
 * ledger and the treasury object carry.
 */
export function previewProtocolFeesPaid(
  ledger: Ledger,
  partnerShareBps: bigint | null,
): Pick<
  ProtocolFeesPaid,
  | "meme_amount"
  | "quote_amount"
  | "sui_amount"
  | "partner_id"
  | "partner_meme_amount"
  | "partner_quote_amount"
  | "partner_sui_amount"
> | null {
  if ((ledger.partnerId === null) !== (partnerShareBps === null)) {
    throw new TypeError(
      "a partner share is required exactly when the ledger names a partner",
    );
  }
  if (ledger.meme === 0n && ledger.quote === 0n && ledger.sui === 0n) {
    return null;
  }
  const cut = (amount: bigint) =>
    partnerShareBps === null
      ? 0n
      : mulDivDown(amount, partnerShareBps, BASIS_POINTS_DENOMINATOR);
  const partnerMeme = cut(ledger.meme);
  const partnerQuote = cut(ledger.quote);
  const partnerSui = cut(ledger.sui);
  return {
    meme_amount: ledger.meme - partnerMeme,
    quote_amount: ledger.quote - partnerQuote,
    sui_amount: ledger.sui - partnerSui,
    partner_id: ledger.partnerId,
    partner_meme_amount: partnerMeme,
    partner_quote_amount: partnerQuote,
    partner_sui_amount: partnerSui,
  };
}
