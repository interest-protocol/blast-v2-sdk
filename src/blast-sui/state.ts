import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import { suiBalanceBcs, suiIdBcs, suiUidBcs } from "../lib/bcs.ts";
import type { BasisPoints } from "../lib/integers.ts";
import {
  normalizePositiveU64,
  requireBasisPoints,
  requireU64,
} from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";

const supplyBcs = bcs.struct("Supply", { value: bcs.u64() });
const treasuryCapBcs = bcs.struct("TreasuryCap", {
  id: suiUidBcs,
  total_supply: supplyBcs,
});
const stakedSuiBcs = bcs.struct("StakedSui", {
  id: suiUidBcs,
  pool_id: suiIdBcs,
  stake_activation_epoch: bcs.u64(),
  principal: suiBalanceBcs,
});
const fungibleStakedSuiBcs = bcs.struct("FungibleStakedSui", {
  id: suiUidBcs,
  pool_id: suiIdBcs,
  value: bcs.u64(),
});
const custodyBcs = bcs.struct("Custody", {
  liquid_sui: suiBalanceBcs,
  pending_stakes: bcs.vector(stakedSuiBcs),
  active_stake: bcs.option(fungibleStakedSuiBcs),
  active_sui: bcs.u64(),
});

/** BCS layout of `blast_sui::vault::Vault` at the pinned Sui revision. */
export const blastSuiVaultBcs = bcs.struct("Vault", {
  id: suiUidBcs,
  fun_cap: treasuryCapBcs,
  blast_cap: treasuryCapBcs,
  pool_id: suiIdBcs,
  fun_custody: custodyBcs,
  blast_custody: custodyBcs,
  rate_epoch: bcs.u64(),
  rate_sui: bcs.u64(),
  rate_pool_tokens: bcs.u64(),
  redeem_fee_bps: bcs.u64(),
  unwind_only: bcs.bool(),
});

/** BCS layout of `blast_sui::deposit_receipt::BlastSuiDepositReceipt`. */
export const blastSuiDepositReceiptBcs = bcs.struct("BlastSuiDepositReceipt", {
  id: suiUidBcs,
  vault_id: suiIdBcs,
  staked_sui: stakedSuiBcs,
});

export type BlastSuiPendingStake = {
  objectId: string;
  poolId: string;
  activationEpoch: bigint;
  principalSui: bigint;
};

export type BlastSuiActiveStake = {
  objectId: string;
  poolId: string;
  poolTokens: bigint;
};

export type BlastSuiCustodyState = {
  liquidSui: bigint;
  pendingStakes: readonly BlastSuiPendingStake[];
  activeStake: BlastSuiActiveStake | null;
  activeSui: bigint;
  assets: bigint;
};

export type BlastSuiVaultState = SharedObjectReference<true> & {
  originalPackageId: string;
  poolId: string;
  funSupply: bigint;
  blastSupply: bigint;
  funCustody: BlastSuiCustodyState;
  blastCustody: BlastSuiCustodyState;
  exchangeRate: {
    epoch: bigint;
    suiAmount: bigint;
    poolTokenAmount: bigint;
  };
  redeemFeeBps: BasisPoints;
  unwindOnly: boolean;
};

export type BlastSuiDepositReceiptState = {
  objectId: string;
  owner: string;
  originalPackageId: string;
  vaultId: string;
  poolId: string;
  principalSui: bigint;
  activationEpoch: bigint;
};

export type BlastSuiVaultObject = SharedObjectReference & {
  type: string;
  content: Uint8Array;
};

export type BlastSuiDepositReceiptObject = {
  objectId: string;
  owner: SuiClientTypes.ObjectOwner;
  type: string;
  content: Uint8Array;
};

/** Decodes one canonical shared blast Sui vault object. */
export function decodeBlastSuiVaultObject(
  object: BlastSuiVaultObject,
  originalPackageId: string,
): BlastSuiVaultState {
  const typePackageId = validateType(
    object.objectId,
    object.type,
    "vault",
    "Vault",
    "blast Sui vault",
    originalPackageId,
  );
  if (object.mutable !== true) {
    throw new TypeError(`blast Sui vault ${object.objectId} must be mutable`);
  }

  const parsed = blastSuiVaultBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  assertUid("blast Sui vault", objectId, parsed.id.id.bytes);

  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    mutable: true,
    originalPackageId: typePackageId,
    poolId: normalizeSuiObjectId(parsed.pool_id.bytes),
    funSupply: decodedU64("funSupply", parsed.fun_cap.total_supply.value),
    blastSupply: decodedU64("blastSupply", parsed.blast_cap.total_supply.value),
    funCustody: decodeCustody("funCustody", parsed.fun_custody),
    blastCustody: decodeCustody("blastCustody", parsed.blast_custody),
    exchangeRate: {
      epoch: decodedU64("exchangeRate.epoch", parsed.rate_epoch),
      suiAmount: decodedU64("exchangeRate.suiAmount", parsed.rate_sui),
      poolTokenAmount: decodedU64(
        "exchangeRate.poolTokenAmount",
        parsed.rate_pool_tokens,
      ),
    },
    redeemFeeBps: requireBasisPoints(
      "redeemFeeBps",
      BigInt(parsed.redeem_fee_bps),
    ),
    unwindOnly: parsed.unwind_only,
  };
}

/** Decodes one canonical address-owned blast Sui deposit receipt. */
export function decodeBlastSuiDepositReceiptObject(
  object: BlastSuiDepositReceiptObject,
  originalPackageId: string,
): BlastSuiDepositReceiptState {
  const typePackageId = validateType(
    object.objectId,
    object.type,
    "deposit_receipt",
    "BlastSuiDepositReceipt",
    "blast Sui deposit receipt",
    originalPackageId,
  );
  if (object.owner.$kind !== "AddressOwner") {
    throw new TypeError(
      `blast Sui deposit receipt ${object.objectId} must be address-owned`,
    );
  }

  const parsed = blastSuiDepositReceiptBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  assertUid("blast Sui deposit receipt", objectId, parsed.id.id.bytes);

  return {
    objectId,
    owner: normalizeSuiAddress(object.owner.AddressOwner),
    originalPackageId: typePackageId,
    vaultId: normalizeSuiObjectId(parsed.vault_id.bytes),
    poolId: normalizeSuiObjectId(parsed.staked_sui.pool_id.bytes),
    principalSui: decodedU64("principalSui", parsed.staked_sui.principal.value),
    activationEpoch: decodedU64(
      "activationEpoch",
      parsed.staked_sui.stake_activation_epoch,
    ),
  };
}

/** Reads and decodes one shared blast Sui vault through the Sui Core API. */
export async function getBlastSuiVault(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<BlastSuiVaultState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(
      `blast Sui vault ${object.objectId} is not a shared object`,
    );
  }
  return decodeBlastSuiVaultObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      mutable: true,
      type: object.type,
      content: object.content,
    },
    originalPackageId,
  );
}

/** Reads one address-owned blast Sui deposit receipt through the Sui Core API. */
export async function getBlastSuiDepositReceipt(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<BlastSuiDepositReceiptState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  return decodeBlastSuiDepositReceiptObject(
    {
      objectId: object.objectId,
      owner: object.owner,
      type: object.type,
      content: object.content,
    },
    originalPackageId,
  );
}

function decodeCustody(
  name: string,
  custody: ReturnType<typeof custodyBcs.parse>,
): BlastSuiCustodyState {
  const liquidSui = decodedU64(`${name}.liquidSui`, custody.liquid_sui.value);
  const pendingStakes = custody.pending_stakes.map((stake, index) => ({
    objectId: normalizeSuiObjectId(stake.id.id.bytes),
    poolId: normalizeSuiObjectId(stake.pool_id.bytes),
    activationEpoch: decodedU64(
      `${name}.pendingStakes[${index}].activationEpoch`,
      stake.stake_activation_epoch,
    ),
    principalSui: decodedU64(
      `${name}.pendingStakes[${index}].principalSui`,
      stake.principal.value,
    ),
  }));
  const activeStake = custody.active_stake
    ? {
        objectId: normalizeSuiObjectId(custody.active_stake.id.id.bytes),
        poolId: normalizeSuiObjectId(custody.active_stake.pool_id.bytes),
        poolTokens: decodedU64(
          `${name}.activeStake.poolTokens`,
          custody.active_stake.value,
        ),
      }
    : null;
  const activeSui = decodedU64(`${name}.activeSui`, custody.active_sui);
  const assets = requireU64(
    `${name}.assets`,
    liquidSui +
      pendingStakes.reduce((total, stake) => total + stake.principalSui, 0n) +
      activeSui,
  );

  return {
    liquidSui,
    pendingStakes,
    activeStake,
    activeSui,
    assets,
  };
}

function validateType(
  objectId: string,
  type: string,
  module: string,
  name: string,
  label: string,
  originalPackageId: string,
): string {
  const tag = parseStructTag(type);
  if (
    tag.module !== module ||
    tag.name !== name ||
    tag.typeParams.length !== 0
  ) {
    throw new TypeError(`object ${objectId} is not a ${label}`);
  }
  const typePackageId = normalizeSuiAddress(tag.address);
  if (typePackageId !== normalizeSuiAddress(originalPackageId)) {
    throw new TypeError(`${label} ${objectId} has an unexpected package`);
  }
  return typePackageId;
}

function assertUid(label: string, objectId: string, uid: string): void {
  if (normalizeSuiObjectId(uid) !== objectId) {
    throw new TypeError(`${label} ${objectId} has a mismatched UID`);
  }
}

function decodedU64(name: string, value: string): bigint {
  return requireU64(name, BigInt(value));
}
