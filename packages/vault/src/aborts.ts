import { abortName } from "@interest-protocol/blast-core/aborts";

/**
 * The `blast_vault` error registry (`sui/vault/sources/errors.move`): a
 * name's index is its numeric abort code. Codes are package-wide, so check
 * first that the abort location's package is the vault package; the module
 * is only where the macro expanded.
 */
export const VAULT_ABORTS = [
  "EInvalidWitness",
  "EUnadmittedVenue",
  "EUnguardedDelay",
  "EInvalidProtocolBps",
  "EZeroLiquidity",
  "EWrongVenue",
  "ENothingToClaim",
  "EBuybackQuoteOutOfRange",
  "EBuybackBelowMinimum",
  "EInvalidCommitment",
  "EInvalidLeafCount",
  "EEmptyBudget",
  "EEmptyInterval",
  "EBudgetOverflow",
  "EGasReserveTooLarge",
  "EZeroTreasury",
  "EZeroClaimWindow",
  "EWrongRound",
  "EOverlappingInterval",
  "EInsufficientBudget",
  "EWrongRoundProposal",
  "ETreasuryChanged",
  "EClaimDeadlineOverflow",
  "EClaimsClosed",
  "EInvalidIndex",
  "EAlreadyClaimed",
  "EInvalidBeneficiary",
  "EEmptyClaim",
  "EInvalidProof",
  "EWrongVault",
  "EReserveSettled",
  "EOverReserve",
  "EClaimsStillOpen",
  "EUnadmittedPackageWitness",
  "EReturnedExceedsTaken",
] as const;

export type VaultAbortName = (typeof VAULT_ABORTS)[number];

/** The error a `blast_vault` abort `code` names; null for an unknown code. */
export function vaultAbortName(code: number): VaultAbortName | null {
  return abortName(VAULT_ABORTS, code);
}
