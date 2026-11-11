import type {
  Deadline,
  PendingDelay,
  Proposal,
} from "@interest-protocol/blast-core/bcs";
import {
  admission,
  delayedBcs,
  delayedSetBcs,
  isDelayedGuarded,
  isDelayedSetGuarded,
  suiBalanceBcs,
  suiIdBcs,
  suiObjectIdBcs,
  suiUidBcs,
  u64Bcs,
  unitKeyBcs,
} from "@interest-protocol/blast-core/bcs";
import type { BasisPoints } from "@interest-protocol/blast-core/integers";
import {
  normalizePositiveU64,
  requireBasisPoints,
  requireU64,
} from "@interest-protocol/blast-core/integers";
import type { SharedObjectReference } from "@interest-protocol/blast-core/sui";
import { bcs, TypeTagSerializer } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import {
  deriveDynamicFieldID,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";
import { blastSuiType, funSuiType } from "./types.ts";

const supplyBcs = bcs.struct("Supply", { value: bcs.u64() });
const treasuryKeyBcs = bcs.struct("TreasuryKey", {
  dummy_field: bcs.bool(),
});
export const blastSuiTreasuryCapBcs = bcs.struct("TreasuryCap", {
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
const positionBcs = bcs.struct("Position", {
  pending_stakes: bcs.vector(stakedSuiBcs),
  active_stake: bcs.option(fungibleStakedSuiBcs),
  active_sui: bcs.u64(),
});
const custodyBcs = bcs.struct("Custody", {
  liquid_sui: suiBalanceBcs,
  positions: bcs.struct("VecMap", {
    contents: bcs.vector(
      bcs.struct("Entry", { key: suiObjectIdBcs, value: positionBcs }),
    ),
  }),
});
const poolRateBcs = bcs.struct("PoolRate", {
  epoch: bcs.u64(),
  sui: bcs.u64(),
  pool_tokens: bcs.u64(),
});

/** BCS layout of `blast_sui::vault::Vault` at the pinned Sui revision. */
export const blastSuiVaultBcs = bcs.struct("Vault", {
  id: suiUidBcs,
  validators: delayedSetBcs(unitKeyBcs, suiObjectIdBcs),
  pool_rates: bcs.struct("VecMap", {
    contents: bcs.vector(
      bcs.struct("Entry", { key: suiObjectIdBcs, value: poolRateBcs }),
    ),
  }),
  fun_custody: custodyBcs,
  blast_custody: custodyBcs,
  redeem_fee: delayedBcs(unitKeyBcs, u64Bcs),
});

/** BCS layout of `blast_sui::deposit_receipt::BlastSuiDepositReceipt`. */
export const blastSuiDepositReceiptBcs = bcs.struct("BlastSuiDepositReceipt", {
  id: suiUidBcs,
  vault_id: suiIdBcs,
  staked_sui: stakedSuiBcs,
});

export type BlastSuiPendingStake = {
  objectId: string;
  activationEpoch: bigint;
  principalSui: bigint;
};

export type BlastSuiActiveStake = {
  objectId: string;
  poolTokens: bigint;
};

/** One ledger's stake in one listed pool. */
export type BlastSuiPositionState = {
  pendingStakes: readonly BlastSuiPendingStake[];
  activeStake: BlastSuiActiveStake | null;
  activeSui: bigint;
};

export type BlastSuiCustodyState = {
  liquidSui: bigint;
  /** By pool ID, in list order. */
  positions: Readonly<Record<string, BlastSuiPositionState>>;
  /** Liquid SUI plus every position's pending principal and active SUI. */
  assets: bigint;
};

/** A listed pool's exchange rate, cached at `epoch`. */
export type BlastSuiPoolRate = {
  epoch: bigint;
  suiAmount: bigint;
  poolTokenAmount: bigint;
};

export type BlastSuiVaultState = SharedObjectReference<true> & {
  originalPackageId: string;
  /** Listed staking pools in list order; picks must name one of them. */
  pools: readonly string[];
  /** The validator delay; admissions wait it, removals are immediate. */
  validatorDelayMs: bigint;
  pendingValidatorDelay: PendingDelay | null;
  /** Scheduled admissions by pool ID; `apply_validator` lists one once ready. */
  pendingValidators: Readonly<Record<string, Deadline>>;
  /** By pool ID, in list order. */
  poolRates: Readonly<Record<string, BlastSuiPoolRate>>;
  funSupply: bigint;
  blastSupply: bigint;
  funCustody: BlastSuiCustodyState;
  blastCustody: BlastSuiCustodyState;
  redeemFeeBps: BasisPoints;
  redeemFeeDelayMs: bigint;
  pendingRedeemFee: Proposal<BasisPoints> | null;
  /**
   * The vault's own `vault::unpause` precondition: both delays are nonzero,
   * no change would set either to zero, and no admission is pending.
   * `PackageAdmin` also requires a guarded upgrade delay, and
   * `PackageVersion` requires one of the bits to be paused; read those apart.
   */
  vaultDelaysGuarded: boolean;
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

export type BlastSuiTreasuryCapObject = {
  objectId: string;
  owner: SuiClientTypes.ObjectOwner;
  type: string;
  content: Uint8Array;
};

export type BlastSuiTreasuryCapObjects = {
  fun: BlastSuiTreasuryCapObject;
  blast: BlastSuiTreasuryCapObject;
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
  treasuryCaps: BlastSuiTreasuryCapObjects,
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
  if (
    parsed.validators.parent !== objectId ||
    parsed.redeem_fee.parent !== objectId
  ) {
    throw new TypeError(`blast Sui vault ${objectId} has a mismatched parent`);
  }
  const funSupply = decodeTreasuryCap(
    treasuryCaps.fun,
    objectId,
    funSuiType(originalPackageId),
    originalPackageId,
  );
  const blastSupply = decodeTreasuryCap(
    treasuryCaps.blast,
    objectId,
    blastSuiType(originalPackageId),
    originalPackageId,
  );
  const validators = admission(parsed.validators);
  const redeemFee = parsed.redeem_fee;

  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    mutable: true,
    originalPackageId: typePackageId,
    pools: validators.members,
    validatorDelayMs: validators.delayMs,
    pendingValidatorDelay: validators.pendingDelay,
    pendingValidators: validators.pendingMembers,
    poolRates: Object.fromEntries(
      parsed.pool_rates.contents.map(({ key, value }) => [
        key,
        {
          epoch: decodedU64(`poolRates[${key}].epoch`, value.epoch),
          suiAmount: decodedU64(`poolRates[${key}].suiAmount`, value.sui),
          poolTokenAmount: decodedU64(
            `poolRates[${key}].poolTokenAmount`,
            value.pool_tokens,
          ),
        },
      ]),
    ),
    funSupply,
    blastSupply,
    funCustody: decodeCustody("funCustody", parsed.fun_custody),
    blastCustody: decodeCustody("blastCustody", parsed.blast_custody),
    redeemFeeBps: requireBasisPoints("redeemFeeBps", redeemFee.value),
    redeemFeeDelayMs: redeemFee.delay_ms,
    pendingRedeemFee: redeemFee.pending && {
      ...redeemFee.pending,
      value: requireBasisPoints("pendingRedeemFee", redeemFee.pending.value),
    },
    vaultDelaysGuarded:
      isDelayedGuarded(redeemFee) && isDelayedSetGuarded(parsed.validators),
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
  const normalizedVaultId = normalizeSuiObjectId(objectId);
  const [vaultResponse, funResponse, blastResponse] = await Promise.all([
    client.core.getObject({
      objectId,
      include: { content: true },
    }),
    client.core.getDynamicObjectField({
      parentId: normalizedVaultId,
      name: treasuryKey(originalPackageId, funSuiType(originalPackageId)),
      include: { content: true },
    }),
    client.core.getDynamicObjectField({
      parentId: normalizedVaultId,
      name: treasuryKey(originalPackageId, blastSuiType(originalPackageId)),
      include: { content: true },
    }),
  ]);
  const { object } = vaultResponse;
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
    {
      fun: funResponse.object,
      blast: blastResponse.object,
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
  let assets = liquidSui;
  const positions: Record<string, BlastSuiPositionState> = {};
  for (const { key: poolId, value } of custody.positions.contents) {
    const label = `${name}.positions[${poolId}]`;
    const pendingStakes = value.pending_stakes.map((stake, index) => ({
      objectId: normalizeSuiObjectId(stake.id.id.bytes),
      activationEpoch: decodedU64(
        `${label}.pendingStakes[${index}].activationEpoch`,
        stake.stake_activation_epoch,
      ),
      principalSui: decodedU64(
        `${label}.pendingStakes[${index}].principalSui`,
        stake.principal.value,
      ),
    }));
    const activeStake = value.active_stake
      ? {
          objectId: normalizeSuiObjectId(value.active_stake.id.id.bytes),
          poolTokens: decodedU64(
            `${label}.activeStake.poolTokens`,
            value.active_stake.value,
          ),
        }
      : null;
    const activeSui = decodedU64(`${label}.activeSui`, value.active_sui);
    assets +=
      pendingStakes.reduce((total, stake) => total + stake.principalSui, 0n) +
      activeSui;
    positions[poolId] = { pendingStakes, activeStake, activeSui };
  }

  return {
    liquidSui,
    positions,
    assets: requireU64(`${name}.assets`, assets),
  };
}

function decodeTreasuryCap(
  object: BlastSuiTreasuryCapObject,
  vaultId: string,
  coinType: string,
  originalPackageId: string,
): bigint {
  const expectedType = normalizeStructTag(
    `0x2::coin::TreasuryCap<${coinType}>`,
  );
  if (normalizeStructTag(object.type) !== expectedType) {
    throw new TypeError(
      `object ${object.objectId} is not the ${coinType} TreasuryCap`,
    );
  }
  if (object.owner.$kind !== "ObjectOwner") {
    throw new TypeError(`${coinType} TreasuryCap must be a child object`);
  }
  const key = treasuryKey(originalPackageId, coinType);
  const wrapperType = TypeTagSerializer.parseFromStr(
    `0x2::dynamic_object_field::Wrapper<${key.type}>`,
  );
  const fieldId = deriveDynamicFieldID(vaultId, wrapperType, key.bcs);
  if (
    normalizeSuiObjectId(object.owner.ObjectOwner) !==
    normalizeSuiObjectId(fieldId)
  ) {
    throw new TypeError(`${coinType} TreasuryCap belongs to another parent`);
  }

  const parsed = blastSuiTreasuryCapBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  assertUid(`${coinType} TreasuryCap`, objectId, parsed.id.id.bytes);
  return decodedU64(`${coinType} totalSupply`, parsed.total_supply.value);
}

function treasuryKey(
  originalPackageId: string,
  coinType: string,
): SuiClientTypes.DynamicFieldName {
  return {
    type: `${normalizeSuiAddress(originalPackageId)}::vault::TreasuryKey<${coinType}>`,
    bcs: treasuryKeyBcs.serialize({ dummy_field: false }).toBytes(),
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
