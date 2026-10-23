import { normalizeStructTag, parseStructTag } from "@mysten/sui/utils";

/**
 * Cetus orders a pool's coin types by type name. `a` means Meme is coin A
 * (`Pool<Meme, Quote>`); `b` means Quote is coin A (`Pool<Quote, Meme>`).
 * Every Cetus route after `new` takes `<Meme, Quote, CoinA, CoinB>`
 * (contracts ADR 0100); the SDK derives `CoinA` and `CoinB` from this side.
 */
export type CetusMemeSide = "a" | "b";

/**
 * Cetus orders a pool's coins by `type_name::with_defining_ids` text (64 hex
 * digits, no `0x`); Meme is coin A exactly when its name sorts after Quote's.
 * Pass original (defining) type addresses.
 */
export function cetusMemeSide(
  memeType: string,
  quoteType: string,
): CetusMemeSide {
  return cetusTypeName(memeType) > cetusTypeName(quoteType) ? "a" : "b";
}

function cetusTypeName(type: string): string {
  return normalizeStructTag(parseStructTag(type)).replace(
    /0x([0-9a-f]{64})/g,
    "$1",
  );
}
