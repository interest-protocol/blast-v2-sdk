import { moveResults } from "@interest-protocol/blast-core/ptb";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { PresaleClient } from "./client.ts";
import type { PresaleCreatorEvent } from "./creator-events.ts";
import { decodePresaleCreatorEvents } from "./creator-events.ts";
import type { PresaleVaultState } from "./state.ts";
import type { PresaleDeployment } from "./transactions.ts";
import { PresaleTransactions } from "./transactions.ts";

/** The configured protocol objects needed to prepare a creator action. */
export type PresaleCreatorDeployment = Readonly<{
  presale: PresaleDeployment;
  venues: Readonly<{
    cetus?: Readonly<{
      globalConfig: SharedObjectIdentity;
      burnManager: SharedObjectIdentity;
    }>;
    bluefin?: Readonly<{ globalConfig: SharedObjectIdentity }>;
  }>;
}>;

export type PresaleCreatorActionKind = "collect_fees" | "claim_residuals";

export type PresaleCreatorTransaction = Readonly<{
  presaleId: string;
  vault: PresaleVaultState;
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

// PresaleCap contains only its UID and sale ID; economics and vault state use the SDK decoders.
const presaleCap = bcs.struct("PresaleCap", {
  id: bcs.Address,
  presaleId: bcs.Address,
});

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
  const sdk = new PresaleClient(client, identity.presale);
  const calls = new PresaleTransactions(identity.presale);

  async function shared(objectId: string, signal?: AbortSignal) {
    const { objects } = await client.core.getObjects({
      objectIds: [objectId],
      ...(signal ? { signal } : {}),
    });
    const object = objects[0];
    if (!object || object instanceof Error || object.owner.$kind !== "Shared")
      return null;
    return {
      objectId: object.objectId,
      initialSharedVersion: String(object.owner.Shared.initialSharedVersion),
    };
  }

  async function claimResiduals(
    vault: PresaleVaultState,
    owner: string,
    signal?: AbortSignal,
  ): Promise<PresaleCreatorTransaction | null> {
    if (
      vault.migrationMemeResidual === 0n &&
      vault.migrationQuoteResidual === 0n
    )
      return null;
    const { objects } = await client.core.getObjects({
      objectIds: [vault.presaleCapId],
      ...(signal ? { signal } : {}),
    });
    const cap = objects[0];
    if (
      !cap ||
      cap instanceof Error ||
      cap.owner.$kind !== "AddressOwner" ||
      normalizeSuiAddress(cap.owner.AddressOwner) !== owner ||
      normalizeStructTag(cap.type) !==
        normalizeStructTag(
          `${identity.presale.originalPackageId}::blast_presale::PresaleCap`,
        )
    )
      return null;
    const transaction = new Transaction();
    const coins = transaction.add(
      calls.call.claimMigrationResiduals({
        memeType: vault.memeType,
        quoteType: vault.quoteType,
        vault,
        presaleCap: transaction.objectRef({
          objectId: cap.objectId,
          version: cap.version,
          digest: cap.digest,
        }),
      }),
    );
    transaction.transferObjects(moveResults(coins, 2), owner);
    return {
      presaleId: vault.presaleId,
      vault,
      transaction,
      kindBytes: await transaction.build({ onlyTransactionKind: true }),
    };
  }

  async function collectFees(
    vault: PresaleVaultState,
    migrationWitness: string,
    signal?: AbortSignal,
  ): Promise<PresaleCreatorTransaction | null> {
    const common = {
      memeType: vault.memeType,
      quoteType: vault.quoteType,
      vault,
    };
    const pool = await shared(vault.poolId, signal);
    const partner = vault.partnerId
      ? await shared(vault.partnerId, signal)
      : null;
    if (!pool || (vault.partnerId && !partner)) return null;
    const collection = {
      ...common,
      pool: { ...pool, mutable: true as const },
      ...(partner ? { partner: { ...partner, mutable: false as const } } : {}),
    };
    const witness = normalizeStructTag(migrationWitness);
    let transaction: Transaction;
    if (
      witness ===
        normalizeStructTag(
          `${identity.presale.originalPackageId}::cetus::Witness`,
        ) &&
      identity.venues.cetus
    ) {
      transaction = calls.collectCetusFees({
        ...collection,
        cetusConfig: { ...identity.venues.cetus.globalConfig, mutable: false },
        burnManager: { ...identity.venues.cetus.burnManager, mutable: false },
      });
    } else if (
      witness ===
        normalizeStructTag(
          `${identity.presale.originalPackageId}::bluefin::Witness`,
        ) &&
      identity.venues.bluefin
    ) {
      transaction = calls.collectBluefinFees({
        ...collection,
        bluefinConfig: {
          ...identity.venues.bluefin.globalConfig,
          mutable: false,
        },
      });
    } else return null;
    return {
      presaleId: vault.presaleId,
      vault,
      transaction,
      kindBytes: await transaction.build({ onlyTransactionKind: true }),
    };
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
      // The contract emits nothing when both collected balances are zero.
      if (execution.events.length === 0)
        return execution.effects.eventsDigest === null ? [] : null;
      const events = decodePresaleCreatorEvents(
        execution.events,
        identity.presale.originalPackageId,
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
            type: `${identity.presale.originalPackageId}::blast_presale::PresaleCap`,
            include: { content: true },
            limit: 50,
            cursor,
            ...(signal ? { signal } : {}),
          });
        for (const object of page.objects) {
          ids.push(
            normalizeSuiAddress(presaleCap.parse(object.content).presaleId),
          );
        }
        cursor = page.hasNextPage ? page.cursor : null;
      } while (cursor !== null && ids.length < 200);
      return ids;
    },
    async transaction(vaultId, sender, kind, signal) {
      const vault = await sdk.getVault(vaultId);
      const sale = await sdk.getPresale(vault.presaleId);
      if (
        sale.lifecycle !== "Migrated" ||
        sale.presaleCapId !== vault.presaleCapId ||
        normalizeStructTag(sale.memeType) !==
          normalizeStructTag(vault.memeType) ||
        normalizeStructTag(sale.quoteType) !==
          normalizeStructTag(vault.quoteType)
      )
        return null;
      const owner = normalizeSuiAddress(sender);
      if (kind === "claim_residuals")
        return claimResiduals(vault, owner, signal);
      if (
        !vault.feeRecipients.some(
          (share) =>
            normalizeSuiAddress(share.recipient) === owner && share.bps > 0n,
        )
      )
        return null;
      return collectFees(vault, sale.migrationWitness, signal);
    },
  };
}
