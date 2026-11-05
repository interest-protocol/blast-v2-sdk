import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import {
  MigratorCalls,
  venueOf,
} from "@interest-protocol/blast-migrators-sdk/transactions";
import type {
  VaultPositions,
  VaultState,
} from "@interest-protocol/blast-vault-sdk/state";
import { getVault } from "@interest-protocol/blast-vault-sdk/state";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
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
 * venue (`collect_fees`). The owner's balances are claimed with
 * `PresaleTransactions.claimOwnerBalances`.
 */
export type PresaleCreatorActionKind = "collect_fees";

/** What `collect_fees` takes beyond the venue's own objects. */
type CollectInput = {
  memeType: string;
  quoteType: string;
  vault: SharedObjectIdentity;
  pool: SharedObjectIdentity;
  currency: SharedObjectIdentity;
};

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
  const migrators = new MigratorCalls(presale.migrators);
  const packageWitness = normalizeStructTag(
    `${presale.originalPackageId}::blast_presale_package::PackageWitness`,
  );

  /** A shared object's identity, or null when it is missing, not shared, or not of `type`. */
  async function shared(objectId: string, signal?: AbortSignal, type?: string) {
    const { objects } = await client.core.getObjects({
      objectIds: [objectId],
      ...(signal ? { signal } : {}),
    });
    const object = objects[0];
    if (
      !object ||
      object instanceof Error ||
      object.owner.$kind !== "Shared" ||
      (type !== undefined &&
        normalizeStructTag(object.type) !== normalizeStructTag(type))
    )
      return null;
    return {
      objectId: object.objectId,
      initialSharedVersion: String(object.owner.Shared.initialSharedVersion),
    };
  }

  /** The venue's `collect_fees` builder, or null for a venue this deployment cannot reach. */
  function collectFees(vault: VaultPositions) {
    const venue = venueOf(presale.migrators, vault.venue);
    const { cetus, bluefin } = identity.venues;
    if (venue === "cetus" && cetus) {
      return (input: CollectInput) =>
        migrators.collectCetusFees({ ...input, cetus });
    }
    if (venue === "bluefin" && bluefin) {
      return (input: CollectInput) =>
        migrators.collectBluefinFees({
          ...input,
          bluefinConfig: bluefin.config,
        });
    }
    return null;
  }

  /** The vault's pool and its Meme's Coin Registry `Currency`, both shared. */
  async function vaultObjects(
    vault: VaultState & VaultPositions,
    signal?: AbortSignal,
  ) {
    const { coinMetadata } = await client.core.getCoinMetadata({
      coinType: vault.memeType,
      ...(signal ? { signal } : {}),
    });
    const [pool, currency] = await Promise.all([
      shared(vault.poolId, signal),
      coinMetadata?.id
        ? shared(
            coinMetadata.id,
            signal,
            `0x2::coin_registry::Currency<${vault.memeType}>`,
          )
        : null,
    ]);
    return pool && currency ? { pool, currency } : null;
  }

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
    async transaction(vaultId, sender, kind, signal) {
      if (kind !== "collect_fees") return null;
      const vault = await getVault(client, vaultId, presale.vault);
      if (normalizeStructTag(vault.terms.packageWitness) !== packageWitness)
        return null;
      const collect = collectFees(vault);
      const objects = collect && (await vaultObjects(vault, signal));
      if (!collect || !objects) return null;
      const transaction = new Transaction();
      transaction.setSender(sender);
      transaction.add(
        collect({
          memeType: vault.memeType,
          quoteType: vault.quoteType,
          vault: {
            objectId: vault.objectId,
            initialSharedVersion: vault.initialSharedVersion,
          },
          ...objects,
        }),
      );
      return {
        presaleId: vault.terms.origin,
        vaultId: vault.objectId,
        transaction,
        kindBytes: await transaction.build({ onlyTransactionKind: true }),
      };
    },
  };
}
