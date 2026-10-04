/**
 * Every `#[error(code = N)]` constant of the `blast_presale` package, by
 * module; a name's index is its code. `test/presale-aborts.test.ts` checks it
 * against the contracts source at the commit `check:abi` freezes the presale
 * ABI at. Only presale-package modules are listed; other packages reuse
 * module names such as `cetus`, `bluefin`, `bps` and `package_admin`.
 */
export const PRESALE_ABORTS = {
  blast_presale: [
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
    "EInvalidFeeSplit",
    "EWrongMigrationWitness",
    "EBelowMinimumCommitment",
    "EUnreachableRaise",
    "EUnseedablePrice",
    "EInvalidUncappedPhase",
    "EUncappedPhaseNotOpen",
    "EPresaleFilled",
    "EInvalidRaiseAllocation",
    "EInvalidVestingTerms",
    "EPresaleNotStarted",
    "EPresaleStarted",
    "EProtocolFeesUnchanged",
  ],
  blast_presale_admin: ["EInvalidAdminCap", "ENoAdminCap", "EInvalidRecipient"],
  holder_rewards: [
    "EWrongRound",
    "EInvalidInterval",
    "EInvalidCommitment",
    "EInvalidLeafCount",
    "EEmptyBudget",
    "EInvalidIndex",
    "EAlreadyClaimed",
    "EInvalidBeneficiary",
    "EInvalidProof",
    "EInvalidClaimDeadline",
    "EWrongVault",
    "EClaimsStillOpen",
    "EEmptyClaim",
  ],
  cetus: ["EInvalidCoinOrder", "EPositionPoolMismatch", "EWrongCoinPair"],
  bluefin: ["EPositionPoolMismatch", "EInvalidTier", "ESymbolTooLong"],
  presale_vault: [
    "ENoMigrationResiduals",
    "EZeroLiquidity",
    "EWrongPresaleCap",
    "EProtocolLpFeesUnchanged",
  ],
  fee_policy: ["EInvalidFees", "EFeesUnchanged", "EInvalidDestination"],
  creation_policy: [
    "EAllowanceUnchanged",
    "EQuoteNotAllowed",
    "EMigrationWitnessNotAllowed",
  ],
  package_admin: ["EInvalidUpgradeCap"],
  bps: ["EInvalidBps"],
} as const;

export type PresaleAbortModule = keyof typeof PRESALE_ABORTS;
export type PresaleAbortName =
  (typeof PRESALE_ABORTS)[PresaleAbortModule][number];

/**
 * The error constant a presale-package Move abort names: `module` is the
 * abort location's module and `code` its clever error code (`errorCode` in
 * `@mysten/sui` execution errors). Null for any other module or code.
 *
 * The key is the module name only: check first that the abort location's
 * package is the presale package, or a migrators `cetus` abort would be named
 * as the presale one.
 */
export function presaleAbortName(
  module: string,
  code: number,
): PresaleAbortName | null {
  if (!Object.hasOwn(PRESALE_ABORTS, module) || !Number.isInteger(code)) {
    return null;
  }
  return PRESALE_ABORTS[module as PresaleAbortModule][code] ?? null;
}
