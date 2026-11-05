import {
  addressBcs,
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
import { feeSplitBcs } from "@interest-protocol/blast-core/fee-split";
import { vaultTermsBcs } from "@interest-protocol/blast-core/migration";
import { ledgerBcs } from "@interest-protocol/blast-core/protocol-fees";
import { bcs } from "@mysten/sui/bcs";
import {
  deriveObjectID,
  fromHex,
  normalizeStructTag,
  normalizeSuiObjectId,
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
  package_witness: bcs.string(),
  origin: bcs.Address,
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
        package_witness: typeNameText(packageWitnessType),
        origin: normalizeSuiObjectId(originId),
      })
      .toBytes(),
  );
}

/** Move `type_name` text: the normalized type with every `0x` address prefix dropped. */
function typeNameText(type: string): string {
  return normalizeStructTag(type).replace(/0x([0-9a-f]{64})/g, "$1");
}
