import { bcs } from "@mysten/sui/bcs";
import { moveTypeNameBcs, suiObjectIdBcs } from "./bcs.ts";
import { bpsBcs } from "./bps.ts";
import type { FeeSplit } from "./fee-split.ts";
import { feeSplitBcs } from "./fee-split.ts";

/**
 * `blast_core::migration::ResidualPolicy`: migration residuals the pool does
 * not take are paid to Blast (`Protocol`) or held for the owner (`Owner`).
 * `VenueTicket`, `Migration` and `OwnerProof` have no abilities: they exist
 * only inside one PTB, as transaction results, and have no BCS here.
 */
export type ResidualPolicy = "Protocol" | "Owner";

export const residualPolicyBcs = bcs
  .enum("ResidualPolicy", { Protocol: null, Owner: null })
  .transform({
    input: (policy: ResidualPolicy) =>
      policy === "Protocol"
        ? { Protocol: true as const }
        : { Owner: true as const },
    output: (policy): ResidualPolicy => policy.$kind,
  });

/**
 * `blast_core::migration::VaultTerms`: what a vault snapshots from the sale
 * that sealed its terms. `origin` is the launch or presale ID and
 * `packageWitness` the original type of the product's package witness.
 */
export type VaultTerms = {
  origin: string;
  packageWitness: string;
  feeSplit: FeeSplit;
  protocolMemeBps: bigint;
  protocolQuoteBps: bigint;
  partnerId: string | null;
  residuals: ResidualPolicy;
};

export const vaultTermsBcs = bcs
  .struct("VaultTerms", {
    origin: suiObjectIdBcs,
    package_witness: moveTypeNameBcs,
    fee_split: feeSplitBcs,
    protocol_meme_bps: bpsBcs,
    protocol_quote_bps: bpsBcs,
    partner_id: bcs.option(suiObjectIdBcs),
    residuals: residualPolicyBcs,
  })
  .transform({
    input: (terms: VaultTerms) => ({
      origin: terms.origin,
      package_witness: terms.packageWitness,
      fee_split: terms.feeSplit,
      protocol_meme_bps: terms.protocolMemeBps,
      protocol_quote_bps: terms.protocolQuoteBps,
      partner_id: terms.partnerId,
      residuals: terms.residuals,
    }),
    output: (terms): VaultTerms => ({
      origin: terms.origin,
      packageWitness: terms.package_witness,
      feeSplit: terms.fee_split,
      protocolMemeBps: terms.protocol_meme_bps,
      protocolQuoteBps: terms.protocol_quote_bps,
      partnerId: terms.partner_id,
      residuals: terms.residuals,
    }),
  });
