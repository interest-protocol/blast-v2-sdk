import { vaultEventBcs } from "@interest-protocol/blast-vault-sdk/events";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";
import type { PresaleCreatorActionKind } from "./creator.ts";

/**
 * One `blast_vault_events::FeesCollected` of a creator action. Amounts are
 * exact base-10 atomic-unit strings; route amounts follow the vault's
 * applied fee split, in route order.
 */
export type PresaleCreatorEvent = Readonly<{
  kind: PresaleCreatorActionKind;
  vaultId: string;
  grossMemeAmount: string;
  grossQuoteAmount: string;
  routeMemeAmounts: readonly string[];
  routeQuoteAmounts: readonly string[];
}>;

/** Decodes only the pinned vault package's events; look-alike modules never prove payment. */
export function decodePresaleCreatorEvents(
  events: readonly Readonly<{ eventType: string; bcs: Uint8Array }>[],
  vaultOriginalPackageId: string,
): PresaleCreatorEvent[] {
  return events.flatMap((event): PresaleCreatorEvent[] => {
    try {
      const tag = parseStructTag(event.eventType);
      if (
        normalizeSuiAddress(tag.address) !==
          normalizeSuiAddress(vaultOriginalPackageId) ||
        tag.module !== "blast_vault_events" ||
        tag.name !== "FeesCollected"
      )
        return [];
      const value = vaultEventBcs.FeesCollected.parse(event.bcs);
      return [
        {
          kind: "collect_fees",
          vaultId: normalizeSuiAddress(value.vault_id),
          grossMemeAmount: String(value.gross_meme_amount),
          grossQuoteAmount: String(value.gross_quote_amount),
          routeMemeAmounts: value.route_meme_amounts.map(String),
          routeQuoteAmounts: value.route_quote_amounts.map(String),
        },
      ];
    } catch {
      return [];
    }
  });
}
