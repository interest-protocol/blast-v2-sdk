import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { PresaleCreatorEvent } from "./creator-events.ts";
import { decodePresaleCreatorEvents } from "./creator-events.ts";
import { presaleCapBcs } from "./state.ts";
import type { PresaleDeployment } from "./transactions.ts";

/** The configured protocol objects needed to prepare a creator action. */
export type PresaleCreatorDeployment = Readonly<{
  presale: PresaleDeployment;
  venues: Readonly<{
    cetus?: Readonly<{
      config: SharedObjectIdentity;
      burnManager: SharedObjectIdentity;
    }>;
    bluefin?: Readonly<{ config: SharedObjectIdentity }>;
  }>;
}>;

/**
 * Permissionless fee collection on a sale's vault, through its migrators
 * venue. The owner's balances are claimed with
 * `PresaleTransactions.claimOwnerBalances`.
 */
export type PresaleCreatorActionKind = "collect_fees";

export type PresaleCreatorTransaction = Readonly<{
  presaleId: string;
  vaultId: string;
  transaction: Transaction;
  kindBytes: Uint8Array;
}>;

export type PresaleCreatorClient = Readonly<{
  preview(
    kind: Uint8Array,
    sender: string,
    signal?: AbortSignal,
  ): Promise<readonly PresaleCreatorEvent[] | null>;
  /** Returns at most 200 owned presale IDs, reading pages of 50. */
  ownedPresales(sender: string, signal?: AbortSignal): Promise<string[]>;
  transaction(
    vaultId: string,
    sender: string,
    kind: PresaleCreatorActionKind,
    signal?: AbortSignal,
  ): Promise<PresaleCreatorTransaction | null>;
}>;

/**
 * Protocol-only creator reads and unsigned transaction preparation. Previews
 * are estimates; completed events and contract execution remain authoritative.
 * `null` means an unavailable preview or an action this helper cannot prepare;
 * RPC failures reject. No signing, persistence or sponsorship is performed.
 */
export function createPresaleCreatorClient(
  client: ClientWithCoreApi,
  identity: PresaleCreatorDeployment,
): PresaleCreatorClient {
  const { presale } = identity;
  return {
    async preview(kind, sender, signal) {
      const transaction = Transaction.fromKind(kind);
      transaction.setSender(sender);
      const result = await client.core.simulateTransaction({
        transaction,
        checksEnabled: false,
        include: { effects: true, events: true },
        ...(signal ? { signal } : {}),
      });
      const execution =
        result.$kind === "Transaction"
          ? result.Transaction
          : result.FailedTransaction;
      if (!execution?.effects?.status.success || !execution.events) return null;
      // The vault emits nothing when both collected balances are zero.
      if (execution.events.length === 0)
        return execution.effects.eventsDigest === null ? [] : null;
      const events = decodePresaleCreatorEvents(
        execution.events,
        presale.vault.originalPackageId,
      );
      return events.length > 0 ? events : null;
    },
    async ownedPresales(sender, signal) {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: SuiClientTypes.ListOwnedObjectsResponse<{ content: true }> =
          await client.core.listOwnedObjects({
            owner: sender,
            type: `${presale.originalPackageId}::blast_presale::PresaleCap`,
            include: { content: true },
            limit: 50,
            cursor,
            ...(signal ? { signal } : {}),
          });
        for (const object of page.objects) {
          ids.push(
            normalizeSuiAddress(presaleCapBcs.parse(object.content).presale_id),
          );
        }
        cursor = page.hasNextPage ? page.cursor : null;
      } while (cursor !== null && ids.length < 200);
      return ids;
    },
    async transaction() {
      // Collection is `MigratorCalls.collectCetusFees`/`collectBluefinFees`
      // over the vault `getVault` decodes; both land with the vault (WP1) and
      // migrators (WP2) bodies.
      throw new Error(
        "WP6: PresaleCreatorClient.transaction needs the vault reader and migrators fee collection",
      );
    },
  };
}
