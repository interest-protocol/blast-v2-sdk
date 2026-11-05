import { abortName } from "@interest-protocol/blast-core/aborts";

/**
 * The `blast_presale` error registry (`sui/presale/sources/errors.move`): a
 * name's index is its numeric abort code. Codes are package-wide, raised from
 * `blast_presale`, `creation_policy` and `fee_policy` alike, so check first
 * that the abort location's package is the presale package. A presale call
 * also aborts inside `blast_core` (`coreAbortName`), `blast_admin`
 * (`adminAbortName`) and `blast_partners`.
 */
export const PRESALE_ABORTS = [
  "EUnguardedDelay",
  "EAllowanceUnchanged",
  "EQuoteNotAllowed",
  "EVenueNotAllowed",
  "EInvalidVenue",
  "EInvalidFees",
  "EInvalidAssetPair",
  "EInvalidRaiseTarget",
  "EInvalidTokenAllocation",
  "EInvalidWindow",
  "EInvalidEligibilityPolicy",
  "EInvalidLifecycle",
  "EPresaleEnded",
  "EPresaleNotEnded",
  "EZeroCommitment",
  "EWalletCapExceeded",
  "EParticipantCapacityReached",
  "EInvalidEligibilityProof",
  "EWrongEligibilityPolicy",
  "ETotalCommitmentOverflow",
  "ENoCommitment",
  "EWrongPresaleCap",
  "ELiquidityDeadlineNotReached",
  "EInitialSupplyNotZero",
  "EBelowMinimumCommitment",
  "EUnreachableRaise",
  "EUnseedablePrice",
  "EInvalidUncappedPhase",
  "EUncappedPhaseNotOpen",
  "EPresaleFilled",
  "EInvalidRaiseAllocation",
  "EPresaleNotStarted",
  "EPresaleStarted",
  "EProtocolFeesUnchanged",
  "EInvalidHardCap",
  "EMissingSetting",
  "ESaleTokenNotUnregulated",
  "EAboveFeePolicy",
  "EProtocolFeesIncreased",
] as const;

export type PresaleAbortName = (typeof PRESALE_ABORTS)[number];

/** The error a `blast_presale` abort `code` names; null for an unknown code. */
export function presaleAbortName(code: number): PresaleAbortName | null {
  return abortName(PRESALE_ABORTS, code);
}

/**
 * The `#[error(code = N)]` constants of the Aftermath DAO-pool vendor package
 * `blast_aftermath_dao_presale`, indexed by code. Its `migrate` also aborts
 * inside `blast_core` (a wrong venue or package witness on the hand-off) and
 * Aftermath's packages.
 */
export const AFTERMATH_DAO_PRESALE_ABORTS = [
  "EPoolMismatch",
  "EDaoFeePoolMismatch",
  "EInvalidPackageWitness",
  "EWrongPackageWitness",
] as const;

export type AftermathDaoPresaleAbortName =
  (typeof AFTERMATH_DAO_PRESALE_ABORTS)[number];

/** The error a vendor abort `code` names; null for an unknown code. */
export function aftermathDaoPresaleAbortName(
  code: number,
): AftermathDaoPresaleAbortName | null {
  return abortName(AFTERMATH_DAO_PRESALE_ABORTS, code);
}
