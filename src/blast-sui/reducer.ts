import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";

import type { NativeTransactionPosition } from "../lib/events.ts";
import { normalizeNativeTransactionPosition } from "../lib/events.ts";
import type { BasisPoints } from "../lib/integers.ts";
import { requireU64 } from "../lib/integers.ts";
import type {
  BlastSuiEventKind,
  DecodedBlastSuiEvent,
  VaultCustodyEvent,
} from "./events.ts";
import { blastSuiEventId, blastSuiEventSpecs } from "./events.ts";

export type BlastSuiNativeFact =
  | {
      source: "objectOwnership";
      kind: "depositReceiptOwnership";
      checkpoint: bigint;
      receiptId: string;
      owner: string;
    }
  | {
      source: "transactionEffects";
      kind: "returnedCoinRecipient";
      position: NativeTransactionPosition;
      operation:
        | "mintFunSui"
        | "redeemFunSui"
        | "claimBlastSui"
        | "cancelDepositReceipt"
        | "redeemBlastSui";
      coinId: string;
      recipient: string;
    }
  | {
      source: "transactionEffects";
      kind: "depositReceiptDeleted";
      position: NativeTransactionPosition;
      receiptId: string;
    };

export type BlastSuiVaultProjection = {
  vaultId: string;
  validator: string;
  poolId: string;
  funReserveSui: bigint;
  bootstrapSui: bigint;
  lockedBlastSui: bigint;
  redeemFeeBps: BasisPoints;
  custody: VaultCustodyEvent;
  syncCount: number;
  unwindOnly: boolean;
};

export type BlastSuiReceiptProjection = {
  receiptId: string;
  vaultId: string;
  poolId: string;
  principalSui: bigint;
  activationEpoch: bigint;
  status: "requested" | "claimed" | "cancelled";
  contributedSui: bigint;
  poolTokens: bigint;
  blastOut: bigint;
  returnedSui: bigint;
};

export type BlastSuiTotalsProjection = {
  funMintedSui: bigint;
  funRedeemedFun: bigint;
  depositPrincipalSui: bigint;
  depositContributedSui: bigint;
  depositClaimedPoolTokens: bigint;
  depositClaimedBlastSui: bigint;
  depositCancelledReturnedSui: bigint;
  donatedSui: bigint;
  blastRedeemed: bigint;
  redemptionGrossSui: bigint;
  redemptionFeeSui: bigint;
  redemptionNetSui: bigint;
  sweptYieldSui: bigint;
};

export type BlastSuiAdministrationProjection = {
  pendingSuperAdminTransfer: {
    recipient: string;
    executeAfterMs: bigint;
  } | null;
  activeSuperAdminCapId: string | null;
  activeAdminCapIds: Readonly<Record<string, true>>;
  packageVersion: bigint | null;
  packageCapabilities: Readonly<
    Record<
      string,
      {
        packageAdminId: string;
        capabilityId: string;
      }
    >
  >;
  packageAdmin: {
    packageAdminId: string;
    publisherId: string;
    upgradeCapId: string;
    packageId: string;
    packageVersion: bigint;
    policy: number;
  } | null;
  pendingUpgrade: {
    packageId: string;
    packageVersion: bigint;
    policy: number;
    digest: Uint8Array;
  } | null;
  lastUpgradeAuthorization: {
    packageId: string;
    packageVersion: bigint;
    policy: number;
    digest: Uint8Array;
  } | null;
  lastUpgradePolicyRestriction: {
    previousPolicy: number;
    newPolicy: number;
  } | null;
  lastUpgradeCommit: {
    packageId: string;
    previousVersion: bigint;
    newVersion: bigint;
  } | null;
};

type DepositReceiptOwner = {
  source: "objectOwnership";
  checkpoint: bigint;
  owner: string;
};

type ReturnedCoinRecipientFact = Extract<
  BlastSuiNativeFact,
  { kind: "returnedCoinRecipient" }
>;
type DepositReceiptDeletionFact = Extract<
  BlastSuiNativeFact,
  { kind: "depositReceiptDeleted" }
>;

export type BlastSuiNativeProjection = {
  appliedFactIds: Readonly<Record<string, true>>;
  depositReceiptOwners: Readonly<Record<string, DepositReceiptOwner>>;
  depositReceiptDeletions: Readonly<Record<string, DepositReceiptDeletionFact>>;
  returnedCoinRecipients: Readonly<Record<string, ReturnedCoinRecipientFact>>;
};

export type BlastSuiProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  eventCounts: Readonly<Record<BlastSuiEventKind, number>>;
  vault: BlastSuiVaultProjection | null;
  latestCustody: VaultCustodyEvent | null;
  receipts: Readonly<Record<string, BlastSuiReceiptProjection>>;
  totals: BlastSuiTotalsProjection;
  administration: BlastSuiAdministrationProjection;
  native: BlastSuiNativeProjection;
};

export type BlastSuiInput = DecodedBlastSuiEvent | BlastSuiNativeFact;

export function createBlastSuiProjection(): BlastSuiProjection {
  return {
    appliedEventIds: {},
    eventCounts: Object.fromEntries(
      Object.keys(blastSuiEventSpecs).map((kind) => [kind, 0]),
    ) as Record<BlastSuiEventKind, number>,
    vault: null,
    latestCustody: null,
    receipts: {},
    totals: {
      funMintedSui: 0n,
      funRedeemedFun: 0n,
      depositPrincipalSui: 0n,
      depositContributedSui: 0n,
      depositClaimedPoolTokens: 0n,
      depositClaimedBlastSui: 0n,
      depositCancelledReturnedSui: 0n,
      donatedSui: 0n,
      blastRedeemed: 0n,
      redemptionGrossSui: 0n,
      redemptionFeeSui: 0n,
      redemptionNetSui: 0n,
      sweptYieldSui: 0n,
    },
    administration: {
      pendingSuperAdminTransfer: null,
      activeSuperAdminCapId: null,
      activeAdminCapIds: {},
      packageVersion: null,
      packageCapabilities: {},
      packageAdmin: null,
      pendingUpgrade: null,
      lastUpgradeAuthorization: null,
      lastUpgradePolicyRestriction: null,
      lastUpgradeCommit: null,
    },
    native: {
      appliedFactIds: {},
      depositReceiptOwners: {},
      depositReceiptDeletions: {},
      returnedCoinRecipients: {},
    },
  };
}

export function reduceBlastSuiInput(
  state: BlastSuiProjection,
  input: BlastSuiInput,
): BlastSuiProjection {
  if (input.source === "blastSui") return reduceBlastSuiEvent(state, input);
  return reduceNativeFact(state, input);
}

function reduceBlastSuiEvent(
  state: BlastSuiProjection,
  event: DecodedBlastSuiEvent,
): BlastSuiProjection {
  const eventId = blastSuiEventId(event);
  if (state.appliedEventIds[eventId]) return state;
  validateBlastSuiEvent(state, event);

  const custody = "custody" in event.payload ? event.payload.custody : null;
  const next: BlastSuiProjection = {
    ...state,
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
    eventCounts: {
      ...state.eventCounts,
      [event.kind]: state.eventCounts[event.kind] + 1,
    },
    vault:
      custody !== null && state.vault !== null
        ? { ...state.vault, custody }
        : state.vault,
    latestCustody: custody ?? state.latestCustody,
  };

  switch (event.kind) {
    case "VaultCreated": {
      const payload = event.payload;
      return {
        ...next,
        vault: {
          vaultId: payload.vault_id,
          validator: payload.validator,
          poolId: payload.pool_id,
          funReserveSui: payload.fun_reserve_sui,
          bootstrapSui: payload.bootstrap_sui,
          lockedBlastSui: payload.locked_blast_sui,
          redeemFeeBps: payload.redeem_fee_bps,
          custody: payload.custody,
          syncCount: 0,
          unwindOnly: false,
        },
      };
    }
    case "FunSuiMinted":
      return addTotals(next, {
        funMintedSui: event.payload.sui_in,
      });
    case "FunSuiRedeemed":
      return addTotals(next, {
        funRedeemedFun: event.payload.fun_in,
      });
    case "BlastSuiDepositRequested": {
      const payload = event.payload;
      return {
        ...addTotals(next, { depositPrincipalSui: payload.principal_sui }),
        receipts: {
          ...state.receipts,
          [payload.receipt_id]: {
            receiptId: payload.receipt_id,
            vaultId: payload.vault_id,
            poolId: payload.pool_id,
            principalSui: payload.principal_sui,
            activationEpoch: payload.activation_epoch,
            status: "requested",
            contributedSui: 0n,
            poolTokens: 0n,
            blastOut: 0n,
            returnedSui: 0n,
          },
        },
      };
    }
    case "BlastSuiDepositClaimed": {
      const payload = event.payload;
      return updateReceipt(
        addTotals(next, {
          depositContributedSui: payload.contributed_sui,
          depositClaimedPoolTokens: payload.pool_tokens,
          depositClaimedBlastSui: payload.blast_out,
        }),
        payload.receipt_id,
        (receipt) => ({
          ...receipt,
          status: "claimed",
          contributedSui: payload.contributed_sui,
          poolTokens: payload.pool_tokens,
          blastOut: payload.blast_out,
        }),
      );
    }
    case "BlastSuiDepositCancelled": {
      const payload = event.payload;
      return updateReceipt(
        addTotals(next, {
          depositCancelledReturnedSui: payload.returned_sui,
        }),
        payload.receipt_id,
        (receipt) => ({
          ...receipt,
          status: "cancelled",
          returnedSui: payload.returned_sui,
        }),
      );
    }
    case "BlastSuiDonated":
      return addTotals(next, { donatedSui: event.payload.sui_in });
    case "BlastSuiRedeemed":
      return addTotals(next, {
        blastRedeemed: event.payload.blast_in,
        redemptionGrossSui: event.payload.gross_sui,
        redemptionFeeSui: event.payload.fee_sui,
        redemptionNetSui: event.payload.net_sui,
      });
    case "FunYieldSwept":
      return addTotals(next, { sweptYieldSui: event.payload.swept_sui });
    case "RedeemFeeChanged":
      return updateVault(next, (vault) => ({
        ...vault,
        redeemFeeBps: event.payload.new_redeem_fee_bps,
      }));
    case "VaultSynced":
      return updateVault(next, (vault) => ({
        ...vault,
        syncCount: vault.syncCount + 1,
      }));
    case "NativeStakeUnwound":
      return updateVault(next, (vault) => ({ ...vault, unwindOnly: true }));
    case "SuperAdminTransferStarted":
      return updateAdministration(next, {
        ...state.administration,
        pendingSuperAdminTransfer: {
          recipient: event.payload.recipient,
          executeAfterMs: event.payload.execute_after_ms,
        },
      });
    case "SuperAdminTransferCancelled":
      return updateAdministration(next, {
        ...state.administration,
        pendingSuperAdminTransfer: null,
      });
    case "SuperAdminTransferred":
      return updateAdministration(next, {
        ...state.administration,
        pendingSuperAdminTransfer: null,
        activeSuperAdminCapId: event.payload.new_super_admin_cap_id,
      });
    case "PackageVersionAdvanced":
      return updateAdministration(next, {
        ...state.administration,
        packageVersion: event.payload.new_version,
      });
    case "AdminGranted":
      return updateAdministration(next, {
        ...state.administration,
        activeAdminCapIds: {
          ...state.administration.activeAdminCapIds,
          [event.payload.admin_cap_id]: true,
        },
      });
    case "AdminRevoked": {
      const activeAdminCapIds = { ...state.administration.activeAdminCapIds };
      delete activeAdminCapIds[event.payload.admin_cap_id];
      return updateAdministration(next, {
        ...state.administration,
        activeAdminCapIds,
      });
    }
    case "AdminDestroyed": {
      const activeAdminCapIds = { ...state.administration.activeAdminCapIds };
      delete activeAdminCapIds[event.payload.admin_cap_id];
      return updateAdministration(next, {
        ...state.administration,
        activeAdminCapIds,
      });
    }
    case "PackageCapabilityAdded":
      return updateAdministration(next, {
        ...state.administration,
        packageCapabilities: {
          ...state.administration.packageCapabilities,
          [event.payload.capability_type]: {
            packageAdminId: event.payload.package_admin_id,
            capabilityId: event.payload.capability_id,
          },
        },
      });
    case "PackageAdminCreated": {
      const payload = event.payload;
      return updateAdministration(next, {
        ...state.administration,
        packageVersion: payload.package_version,
        packageAdmin: {
          packageAdminId: payload.package_admin_id,
          publisherId: payload.publisher_id,
          upgradeCapId: payload.upgrade_cap_id,
          packageId: payload.package_id,
          packageVersion: payload.package_version,
          policy: payload.policy,
        },
      });
    }
    case "UpgradeAuthorized": {
      const packageAdmin = state.administration.packageAdmin;
      if (packageAdmin === null) {
        throw new RangeError(
          "upgrade authorization requires discovered package administration",
        );
      }
      const authorization = {
        packageId: packageAdmin.packageId,
        packageVersion: packageAdmin.packageVersion,
        policy: packageAdmin.policy,
        digest: event.payload.digest,
      };
      return updateAdministration(next, {
        ...state.administration,
        pendingUpgrade: authorization,
        lastUpgradeAuthorization: authorization,
      });
    }
    case "UpgradePolicyRestricted":
      return updateAdministration(next, {
        ...state.administration,
        packageAdmin:
          state.administration.packageAdmin === null
            ? null
            : {
                ...state.administration.packageAdmin,
                policy: event.payload.new_policy,
              },
        lastUpgradePolicyRestriction: {
          previousPolicy: event.payload.previous_policy,
          newPolicy: event.payload.new_policy,
        },
      });
    case "UpgradeCommitted":
      return updateAdministration(next, {
        ...state.administration,
        packageVersion: event.payload.new_version,
        packageAdmin:
          state.administration.packageAdmin === null
            ? null
            : {
                ...state.administration.packageAdmin,
                packageId: event.payload.new_package_id,
                packageVersion: event.payload.new_version,
              },
        pendingUpgrade: null,
        lastUpgradeCommit: {
          packageId: event.payload.new_package_id,
          previousVersion: event.payload.previous_version,
          newVersion: event.payload.new_version,
        },
      });
  }
}

function reduceNativeFact(
  state: BlastSuiProjection,
  fact: BlastSuiNativeFact,
): BlastSuiProjection {
  const normalized = normalizeNativeFact(fact);
  const factId = nativeFactId(normalized);
  if (state.native.appliedFactIds[factId]) return state;
  if (normalized.kind === "depositReceiptOwnership") {
    return reduceDepositReceiptOwnership(state, normalized, factId);
  }
  if (normalized.kind === "depositReceiptDeleted") {
    return reduceDepositReceiptDeletion(state, normalized, factId);
  }
  return {
    ...state,
    native: {
      ...state.native,
      appliedFactIds: { ...state.native.appliedFactIds, [factId]: true },
      returnedCoinRecipients: {
        ...state.native.returnedCoinRecipients,
        [factId]: normalized,
      },
    },
  };
}

function addTotals(
  state: BlastSuiProjection,
  additions: Partial<BlastSuiTotalsProjection>,
): BlastSuiProjection {
  const totals = { ...state.totals };
  for (const [name, amount] of Object.entries(additions)) {
    const key = name as keyof BlastSuiTotalsProjection;
    totals[key] += amount;
  }
  return { ...state, totals };
}

function updateReceipt(
  state: BlastSuiProjection,
  receiptId: string,
  update: (receipt: BlastSuiReceiptProjection) => BlastSuiReceiptProjection,
): BlastSuiProjection {
  const receipt = state.receipts[receiptId];
  if (receipt === undefined) {
    throw new TypeError(`unknown deposit receipt ${receiptId}`);
  }
  return {
    ...state,
    receipts: { ...state.receipts, [receiptId]: update(receipt) },
  };
}

function updateVault(
  state: BlastSuiProjection,
  update: (vault: BlastSuiVaultProjection) => BlastSuiVaultProjection,
): BlastSuiProjection {
  if (state.vault === null) return state;
  return { ...state, vault: update(state.vault) };
}

function updateAdministration(
  state: BlastSuiProjection,
  administration: BlastSuiAdministrationProjection,
): BlastSuiProjection {
  return { ...state, administration };
}

function normalizeNativeFact(fact: BlastSuiNativeFact): BlastSuiNativeFact {
  if (fact.kind === "depositReceiptOwnership") {
    requireU64("deposit-receipt ownership checkpoint", fact.checkpoint);
    return {
      ...fact,
      receiptId: normalizeSuiObjectId(fact.receiptId),
      owner: normalizeSuiAddress(fact.owner),
    };
  }
  if (fact.kind === "depositReceiptDeleted") {
    return {
      ...fact,
      position: normalizeNativeTransactionPosition(
        fact.position,
        "deposit-receipt deletion fact",
      ),
      receiptId: normalizeSuiObjectId(fact.receiptId),
    };
  }
  return {
    ...fact,
    position: normalizeNativeTransactionPosition(
      fact.position,
      "returned-coin fact",
    ),
    coinId: normalizeSuiObjectId(fact.coinId),
    recipient: normalizeSuiAddress(fact.recipient),
  };
}

function nativeFactId(fact: BlastSuiNativeFact): string {
  if (fact.kind === "depositReceiptOwnership") {
    return `${fact.checkpoint}:${fact.kind}:${fact.receiptId}:${fact.owner}`;
  }
  if (fact.kind === "depositReceiptDeleted") {
    return `${fact.position.transactionDigest}:${fact.kind}:${fact.receiptId}`;
  }
  return `${fact.position.transactionDigest}:${fact.kind}:${fact.coinId}`;
}

function validateBlastSuiEvent(
  state: BlastSuiProjection,
  event: DecodedBlastSuiEvent,
): void {
  switch (event.kind) {
    case "BlastSuiDepositRequested":
      validateDepositRequest(state, event.payload);
      return;
    case "BlastSuiDepositClaimed":
    case "BlastSuiDepositCancelled":
      validateDepositTransition(state, event.payload);
      return;
    case "BlastSuiRedeemed":
      if (
        event.payload.gross_sui !==
        event.payload.fee_sui + event.payload.net_sui
      ) {
        throw new RangeError("gross SUI must equal fee SUI plus net SUI");
      }
  }
}

function validateDepositRequest(
  state: BlastSuiProjection,
  payload: { receipt_id: string; vault_id: string; pool_id: string },
): void {
  validateDiscoveredVault(state, payload.vault_id);
  if (state.vault !== null && state.vault.poolId !== payload.pool_id) {
    throw new TypeError("deposit receipt pool does not match discovered vault");
  }
  if (state.receipts[payload.receipt_id] !== undefined) {
    throw new TypeError(
      `deposit receipt ${payload.receipt_id} already requested`,
    );
  }
}

function validateDepositTransition(
  state: BlastSuiProjection,
  payload: {
    receipt_id: string;
    vault_id: string;
    principal_sui: bigint;
  },
): void {
  validateDiscoveredVault(state, payload.vault_id);
  const receipt = state.receipts[payload.receipt_id];
  if (receipt === undefined) {
    throw new TypeError(`unknown deposit receipt ${payload.receipt_id}`);
  }
  if (receipt.status !== "requested") {
    throw new TypeError("deposit receipt must be requested");
  }
  if (receipt.vaultId !== payload.vault_id) {
    throw new TypeError("deposit receipt vault does not match");
  }
  if (receipt.principalSui !== payload.principal_sui) {
    throw new RangeError("deposit receipt principal does not match");
  }
}

function validateDiscoveredVault(
  state: BlastSuiProjection,
  vaultId: string,
): void {
  if (state.vault !== null && state.vault.vaultId !== vaultId) {
    throw new TypeError(
      "deposit receipt vault does not match discovered vault",
    );
  }
}

function reduceDepositReceiptOwnership(
  state: BlastSuiProjection,
  fact: Extract<BlastSuiNativeFact, { kind: "depositReceiptOwnership" }>,
  factId: string,
): BlastSuiProjection {
  const deletion = state.native.depositReceiptDeletions[fact.receiptId];
  if (deletion !== undefined) {
    if (fact.checkpoint < deletion.position.checkpoint) return state;
    throw new TypeError("deleted deposit receipt cannot have an owner");
  }
  const current = state.native.depositReceiptOwners[fact.receiptId];
  if (current !== undefined) {
    if (fact.checkpoint < current.checkpoint) return state;
    if (fact.checkpoint === current.checkpoint) {
      throw new TypeError(
        `deposit receipt ownership conflict at checkpoint ${fact.checkpoint}`,
      );
    }
  }
  return {
    ...state,
    native: {
      ...state.native,
      appliedFactIds: { ...state.native.appliedFactIds, [factId]: true },
      depositReceiptOwners: {
        ...state.native.depositReceiptOwners,
        [fact.receiptId]: {
          source: "objectOwnership",
          checkpoint: fact.checkpoint,
          owner: fact.owner,
        },
      },
    },
  };
}

function reduceDepositReceiptDeletion(
  state: BlastSuiProjection,
  fact: DepositReceiptDeletionFact,
  factId: string,
): BlastSuiProjection {
  const existing = state.native.depositReceiptDeletions[fact.receiptId];
  if (existing !== undefined) {
    if (fact.position.checkpoint < existing.position.checkpoint) return state;
    throw new TypeError("deposit receipt deletion provenance conflicts");
  }
  const owner = state.native.depositReceiptOwners[fact.receiptId];
  if (owner !== undefined) {
    if (fact.position.checkpoint < owner.checkpoint) return state;
    if (fact.position.checkpoint === owner.checkpoint) {
      throw new TypeError(
        `deposit receipt deletion conflicts at checkpoint ${owner.checkpoint}`,
      );
    }
  }
  const depositReceiptOwners = { ...state.native.depositReceiptOwners };
  delete depositReceiptOwners[fact.receiptId];
  return {
    ...state,
    native: {
      ...state.native,
      appliedFactIds: { ...state.native.appliedFactIds, [factId]: true },
      depositReceiptOwners,
      depositReceiptDeletions: {
        ...state.native.depositReceiptDeletions,
        [fact.receiptId]: fact,
      },
    },
  };
}
