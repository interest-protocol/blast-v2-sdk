import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";
import type { PresaleCreatorActionKind } from "./creator.ts";
import { presaleEventBcs, presaleEventModules } from "./events.ts";

/** Amounts are exact base-10 atomic-unit strings; recipient arrays follow the vault fee split. */
export type PresaleCreatorEvent = Readonly<{
  kind: PresaleCreatorActionKind;
  vaultId: string;
  meme: string;
  quote: string;
  recipientsMeme: readonly string[];
  recipientsQuote: readonly string[];
}>;

/** Decode only the pinned protocol's events; look-alike modules never prove payment. */
export function decodePresaleCreatorEvents(
  events: readonly Readonly<{ eventType: string; bcs: Uint8Array }>[],
  originalPackageId: string,
): PresaleCreatorEvent[] {
  return events.flatMap((event): PresaleCreatorEvent[] => {
    try {
      const tag = parseStructTag(event.eventType);
      if (
        normalizeSuiAddress(tag.address) !==
        normalizeSuiAddress(originalPackageId)
      )
        return [];
      if (tag.module !== presaleEventModules.FeesCollected) return [];
      if (tag.name === "FeesCollected") {
        const value = presaleEventBcs.FeesCollected.parse(event.bcs);
        return [
          {
            kind: "collect_fees" as const,
            vaultId: normalizeSuiAddress(value.vault_id),
            meme: String(value.gross_meme),
            quote: String(value.gross_quote),
            recipientsMeme: value.fee_recipient_meme.map(String),
            recipientsQuote: value.fee_recipient_quote.map(String),
          },
        ];
      }
      if (tag.name === "MigrationResidualsClaimed") {
        const value = presaleEventBcs.MigrationResidualsClaimed.parse(
          event.bcs,
        );
        return [
          {
            kind: "claim_residuals" as const,
            vaultId: normalizeSuiAddress(value.vault_id),
            meme: String(value.meme),
            quote: String(value.quote),
            recipientsMeme: [],
            recipientsQuote: [],
          },
        ];
      }
    } catch {
      return [];
    }
    return [];
  });
}
