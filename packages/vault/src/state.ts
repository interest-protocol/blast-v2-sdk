import type {
  Deadline,
  DelayedChange,
  PendingDelay,
  Proposal,
} from "@interest-protocol/blast-core/bcs";
import {
  addressBcs,
  admission,
  balanceBcs,
  delayedActionBcs,
  delayedBcs,
  delayedSetBcs,
  moveTypeNameBcs,
  suiObjectIdBcs,
  suiUidBcs,
  u64Bcs,
  unitKeyBcs,
} from "@interest-protocol/blast-core/bcs";
import { bpsBcs } from "@interest-protocol/blast-core/bps";
import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import { feeSplitBcs } from "@interest-protocol/blast-core/fee-split";
import { normalizePositiveU64 } from "@interest-protocol/blast-core/integers";
import type { VaultTerms } from "@interest-protocol/blast-core/migration";
import { vaultTermsBcs } from "@interest-protocol/blast-core/migration";
import type { Ledger } from "@interest-protocol/blast-core/protocol-fees";
import { ledgerBcs } from "@interest-protocol/blast-core/protocol-fees";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  deriveObjectID,
  fromHex,
  normalizeStructTag,
  normalizeSuiObjectId,
  parseStructTag,
  toHex,
} from "@mysten/sui/utils";
import type { VaultDeployment } from "./transactions.ts";

/** A digest or root as lowercase hex without a prefix. */
const hexBytesBcs = bcs.byteVector().transform({
  input: (hex: string) => fromHex(hex),
  output: (bytes) => toHex(bytes),
});

/** `vault::ProtocolBps`: Blast's LP-fee share of each asset. */
export const protocolBpsBcs = bcs.struct("ProtocolBps", {
  meme_bps: bpsBcs,
  quote_bps: bpsBcs,
});

export type ProtocolBps = ReturnType<typeof protocolBpsBcs.parse>;

/**
 * `vault::RoundTerms`: a scheduled holder-reward round waiting in the vault's
 * `round_publication`; `claim_window_duration_ms` starts at publication.
 */
export const roundTermsBcs = bcs.struct("RoundTerms", {
  number: u64Bcs,
  start_checkpoint: u64Bcs,
  end_checkpoint: u64Bcs,
  root: hexBytesBcs,
  manifest_digest: hexBytesBcs,
  leaf_count: u64Bcs,
  meme_amount: u64Bcs,
  quote_amount: u64Bcs,
  gas_reserve_amount: u64Bcs,
  claim_window_duration_ms: u64Bcs,
  expected_treasury: addressBcs,
});

export type RoundTerms = ReturnType<typeof roundTermsBcs.parse>;

/** BCS layout of `vault::Vault<Meme, Quote>`; balances decode to atomic amounts. */
export const vaultBcs = bcs.struct("Vault", {
  id: suiUidBcs,
  terms: vaultTermsBcs,
  pool_id: suiObjectIdBcs,
  fee_split: delayedBcs(unitKeyBcs, feeSplitBcs),
  protocol_bps: delayedBcs(unitKeyBcs, protocolBpsBcs),
  protocol: ledgerBcs,
  owner_meme: balanceBcs,
  owner_quote: balanceBcs,
  auto_lp_meme: balanceBcs,
  auto_lp_quote: balanceBcs,
  rewards_meme: balanceBcs,
  rewards_quote: balanceBcs,
  burn_quote: balanceBcs,
  next_round: u64Bcs,
  last_checkpoint: bcs.option(u64Bcs),
  round_publication: delayedActionBcs(unitKeyBcs, roundTermsBcs),
});

/**
 * BCS layout of `holder_rewards::Round<Meme, Quote>`: 256 leaves per
 * `claimed_bitmap` word.
 */
export const roundBcs = bcs.struct("Round", {
  id: suiUidBcs,
  vault_id: suiObjectIdBcs,
  number: u64Bcs,
  claim_deadline_at_ms: u64Bcs,
  root: hexBytesBcs,
  leaf_count: u64Bcs,
  claimed_bitmap: bcs.vector(bcs.u256()),
  meme: balanceBcs,
  quote: balanceBcs,
  treasury: addressBcs,
  gas_reserve: bcs.option(balanceBcs),
});

/** BCS layout of `blast_vault_package::VaultRegistry`: admitted venues and package witnesses. */
export const vaultRegistryBcs = bcs.struct("VaultRegistry", {
  id: suiUidBcs,
  witnesses: delayedSetBcs(unitKeyBcs, moveTypeNameBcs),
});

/** `vault::VaultKey`'s BCS: `package_witness` as its `TypeName` text, then `origin`. */
const vaultKeyBcs = bcs.struct("VaultKey", {
  package_witness: moveTypeNameBcs,
  origin: suiObjectIdBcs,
});

/**
 * The ID of the vault of sale `originId` sealed under `packageWitnessType`:
 * `derived_object::derive_address(registry, VaultKey { package_witness,
 * origin })`. `packageWitnessType` names the product's package witness
 * (`<product original>::blast_fun::PackageWitness` or
 * `::blast_presale_package::PackageWitness`); it is encoded as
 * `type_name::with_original_ids`, so pass the original package ID.
 */
export function vaultId(
  vault: Pick<VaultDeployment, "originalPackageId" | "registry">,
  packageWitnessType: string,
  originId: string,
): string {
  return deriveObjectID(
    normalizeSuiObjectId(vault.registry.objectId),
    `${normalizeSuiObjectId(vault.originalPackageId)}::vault::VaultKey`,
    vaultKeyBcs
      .serialize({
        package_witness: packageWitnessType,
        origin: originId,
      })
      .toBytes(),
  );
}

/** `holder_rewards::claim_bit`: whether leaf `index` is paid, 256 leaves per `u256` word. */
export function rewardIsClaimed(
  claimedBitmap: readonly bigint[],
  index: number,
): boolean {
  const word = claimedBitmap[Math.floor(index / 256)];
  if (!Number.isSafeInteger(index) || index < 0 || word === undefined)
    throw new RangeError("claim index out of bounds");
  return (word & (1n << BigInt(index % 256))) !== 0n;
}

/** A shared object's identity, type and BCS content, as a Core API read returns it. */
export type VaultObject = SharedObjectIdentity & {
  type: string;
  content: Uint8Array;
};

/**
 * A decoded `Vault<Meme, Quote>`. Each delayed value is its applied value,
 * the delay its next change waits, and the scheduled change; readiness never
 * applies one. Balances are atomic amounts; `rewards*` are not yet reserved
 * by a round.
 */
export type VaultState = SharedObjectIdentity & {
  memeType: string;
  quoteType: string;
  terms: VaultTerms;
  poolId: string;
  feeSplit: FeeSplit;
  feeSplitDelayMs: bigint;
  pendingFeeSplit: Proposal<FeeSplit> | null;
  protocolBps: ProtocolBps;
  protocolBpsDelayMs: bigint;
  pendingProtocolBps: Proposal<ProtocolBps> | null;
  /** Blast's held LP fees: nonzero only while the sale names a partner. */
  protocol: Ledger;
  ownerMeme: bigint;
  ownerQuote: bigint;
  autoLpMeme: bigint;
  autoLpQuote: bigint;
  rewardsMeme: bigint;
  rewardsQuote: bigint;
  /** Quote the burn route keeps for buyback. */
  burnQuote: bigint;
  /** The number the next round must carry. */
  nextRound: bigint;
  /** The checkpoint the next round must start at or after; null before the first. */
  lastCheckpoint: bigint | null;
  roundDelayMs: bigint;
  /** A scheduled round (`Action`) or round-delay change (`Delay`). */
  pendingRoundPublication: Proposal<DelayedChange<RoundTerms>> | null;
};

/**
 * The venue that holds a vault's position, from its `PositionKey<Venue>`
 * dynamic object field, and the venue's auto-LP position once attached.
 */
export type VaultPositions = {
  venue: string;
  positionId: string;
  autoLpPositionId: string | null;
};

export function decodeVaultObject(
  object: VaultObject,
  vault: Pick<VaultDeployment, "originalPackageId">,
): VaultState {
  const [memeType, quoteType] = typeArguments(object, vault, "vault", "Vault");
  const parsed = vaultBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (
    normalizeSuiObjectId(parsed.id.id.bytes) !== objectId ||
    parsed.fee_split.owner !== objectId ||
    parsed.protocol_bps.owner !== objectId ||
    parsed.round_publication.owner !== objectId ||
    parsed.protocol.origin !== objectId
  ) {
    throw new TypeError(`vault ${object.objectId} has a mismatched UID`);
  }
  return {
    ...identity(object),
    memeType,
    quoteType,
    terms: parsed.terms,
    poolId: parsed.pool_id,
    feeSplit: parsed.fee_split.value,
    feeSplitDelayMs: parsed.fee_split.delay_ms,
    pendingFeeSplit: parsed.fee_split.pending,
    protocolBps: parsed.protocol_bps.value,
    protocolBpsDelayMs: parsed.protocol_bps.delay_ms,
    pendingProtocolBps: parsed.protocol_bps.pending,
    protocol: parsed.protocol,
    ownerMeme: parsed.owner_meme,
    ownerQuote: parsed.owner_quote,
    autoLpMeme: parsed.auto_lp_meme,
    autoLpQuote: parsed.auto_lp_quote,
    rewardsMeme: parsed.rewards_meme,
    rewardsQuote: parsed.rewards_quote,
    burnQuote: parsed.burn_quote,
    nextRound: parsed.next_round,
    lastCheckpoint: parsed.last_checkpoint,
    roundDelayMs: parsed.round_publication.delay_ms,
    pendingRoundPublication: parsed.round_publication.pending,
  };
}

/**
 * The venue and positions of a vault's dynamic object fields:
 * `vault::PositionKey<Venue>` and, once attached, `AutoLpPositionKey<Venue>`.
 */
export function decodeVaultPositions(
  fields: readonly {
    name: { type: string };
    childId?: string | undefined;
  }[],
  vault: Pick<VaultDeployment, "originalPackageId">,
): VaultPositions {
  const module = `${normalizeSuiObjectId(vault.originalPackageId)}::vault`;
  const positions = new Map<string, { venue: string; id: string }>();
  for (const field of fields) {
    const tag = parseStructTag(unwrapObjectFieldName(field.name.type));
    const name = `${tag.address}::${tag.module}`;
    const [venue, ...extra] = tag.typeParams;
    if (
      name !== module ||
      (tag.name !== "PositionKey" && tag.name !== "AutoLpPositionKey") ||
      venue === undefined ||
      extra.length > 0 ||
      field.childId === undefined ||
      positions.has(tag.name)
    ) {
      throw new TypeError(`unexpected vault dynamic field ${field.name.type}`);
    }
    positions.set(tag.name, {
      venue: normalizeStructTag(venue),
      id: normalizeSuiObjectId(field.childId),
    });
  }
  const position = positions.get("PositionKey");
  const autoLp = positions.get("AutoLpPositionKey");
  if (!position || (autoLp && autoLp.venue !== position.venue)) {
    throw new TypeError("a shared vault holds exactly one venue's position");
  }
  return {
    venue: position.venue,
    positionId: position.id,
    autoLpPositionId: autoLp?.id ?? null,
  };
}

/** Reads a shared vault and its venue's positions. */
export async function getVault(
  client: ClientWithCoreApi,
  objectId: string,
  vault: Pick<VaultDeployment, "originalPackageId">,
): Promise<VaultState & VaultPositions> {
  const state = decodeVaultObject(
    await getSharedObject(client, objectId, "vault"),
    vault,
  );
  const { dynamicFields, hasNextPage } = await client.core.listDynamicFields({
    parentId: state.objectId,
    limit: 50,
  });
  if (hasNextPage) throw new TypeError("vault has unexpected dynamic fields");
  return { ...state, ...decodeVaultPositions(dynamicFields, vault) };
}

/**
 * A decoded `holder_rewards::Round<Meme, Quote>`: the balances still owed to
 * unpaid leaves and the unsettled gas reserve. Its checkpoints and manifest
 * digest are only in its `RoundPublished` event.
 */
export type RoundState = SharedObjectIdentity & {
  memeType: string;
  quoteType: string;
  vaultId: string;
  number: bigint;
  claimDeadlineAtMs: bigint;
  root: string;
  leafCount: number;
  claimedBitmap: bigint[];
  meme: bigint;
  quote: bigint;
  treasury: string;
  /** Null once settled, or when the round funded no reserve. */
  gasReserve: bigint | null;
};

export function decodeRoundObject(
  object: VaultObject,
  vault: Pick<VaultDeployment, "originalPackageId">,
): RoundState {
  const [memeType, quoteType] = typeArguments(
    object,
    vault,
    "holder_rewards",
    "Round",
  );
  const parsed = roundBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (normalizeSuiObjectId(parsed.id.id.bytes) !== objectId) {
    throw new TypeError(`round ${object.objectId} has a mismatched UID`);
  }
  const leafCount = Number(parsed.leaf_count);
  if (
    leafCount < 1 ||
    leafCount > MAX_REWARD_LEAVES ||
    parsed.claimed_bitmap.length !== Math.ceil(leafCount / 256) ||
    parsed.root.length !== 64
  ) {
    throw new TypeError(`round ${object.objectId} has invalid bounds`);
  }
  return {
    ...identity(object),
    memeType,
    quoteType,
    vaultId: parsed.vault_id,
    number: parsed.number,
    claimDeadlineAtMs: parsed.claim_deadline_at_ms,
    root: parsed.root,
    leafCount,
    claimedBitmap: parsed.claimed_bitmap.map(BigInt),
    meme: parsed.meme,
    quote: parsed.quote,
    treasury: parsed.treasury,
    gasReserve: parsed.gas_reserve,
  };
}

export async function getRound(
  client: ClientWithCoreApi,
  objectId: string,
  vault: Pick<VaultDeployment, "originalPackageId">,
): Promise<RoundState> {
  return decodeRoundObject(
    await getSharedObject(client, objectId, "round"),
    vault,
  );
}

/**
 * The shared `VaultRegistry`: the admitted venue and package witnesses
 * (original-ID type names), the admission delay, its pending change, and each
 * scheduled admission's deadline.
 */
export type VaultRegistryState = SharedObjectIdentity & {
  witnesses: string[];
  delayMs: bigint;
  pendingDelay: PendingDelay | null;
  pendingWitnesses: Readonly<Record<string, Deadline>>;
};

export function decodeVaultRegistryObject(
  object: VaultObject,
  vault: Pick<VaultDeployment, "originalPackageId">,
): VaultRegistryState {
  if (
    normalizeStructTag(object.type) !==
    normalizeStructTag(
      `${vault.originalPackageId}::blast_vault_package::VaultRegistry`,
    )
  ) {
    throw new TypeError(`object ${object.objectId} is not the vault registry`);
  }
  const parsed = vaultRegistryBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (
    normalizeSuiObjectId(parsed.id.id.bytes) !== objectId ||
    parsed.witnesses.owner !== objectId
  ) {
    throw new TypeError(`registry ${object.objectId} has a mismatched UID`);
  }
  const witnesses = admission(parsed.witnesses);
  return {
    ...identity(object),
    witnesses: witnesses.members,
    delayMs: witnesses.delayMs,
    pendingDelay: witnesses.pendingDelay,
    pendingWitnesses: witnesses.pendingMembers,
  };
}

/** Reads the deployment's shared `VaultRegistry`. */
export async function getVaultRegistry(
  client: ClientWithCoreApi,
  vault: Pick<VaultDeployment, "originalPackageId" | "registry">,
): Promise<VaultRegistryState> {
  return decodeVaultRegistryObject(
    await getSharedObject(client, vault.registry.objectId, "vault registry"),
    vault,
  );
}

/** `blast_vault::constants::max_reward_leaves`: the most leaves one round commits. */
const MAX_REWARD_LEAVES = 65_536;

/** `<vault original>::<module>::<name><Meme, Quote>`'s two type arguments. */
function typeArguments(
  object: VaultObject,
  vault: Pick<VaultDeployment, "originalPackageId">,
  module: string,
  name: string,
): [string, string] {
  const tag = parseStructTag(object.type);
  const [memeType, quoteType, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiObjectId(vault.originalPackageId) ||
    tag.module !== module ||
    tag.name !== name ||
    memeType === undefined ||
    quoteType === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(`object ${object.objectId} is not a vault ${name}`);
  }
  return [normalizeStructTag(memeType), normalizeStructTag(quoteType)];
}

function identity(object: SharedObjectIdentity): SharedObjectIdentity {
  return {
    objectId: normalizeSuiObjectId(object.objectId),
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
  };
}

/** A dynamic object field's name type, without `dynamic_object_field::Wrapper`. */
function unwrapObjectFieldName(type: string): string {
  const tag = parseStructTag(type);
  const [inner] = tag.typeParams;
  return tag.address === normalizeSuiObjectId("0x2") &&
    tag.module === "dynamic_object_field" &&
    tag.name === "Wrapper" &&
    inner !== undefined
    ? normalizeStructTag(inner)
    : type;
}

async function getSharedObject(
  client: ClientWithCoreApi,
  objectId: string,
  label: string,
): Promise<VaultObject> {
  const { object } = await client.core.getObject({
    objectId: normalizeSuiObjectId(objectId),
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`${label} ${object.objectId} is not a shared object`);
  }
  return {
    objectId: object.objectId,
    initialSharedVersion: object.owner.Shared.initialSharedVersion,
    type: object.type,
    content: object.content,
  };
}
