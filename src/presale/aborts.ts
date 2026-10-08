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
    "EWrongPartner",
    "ENoPartnerPayout",
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
    "EWrongPartner",
  ],
  fee_policy: ["EInvalidFees", "EFeesUnchanged", "EInvalidDestination"],
  creation_policy: [
    "EAllowanceUnchanged",
    "EQuoteNotAllowed",
    "EMigrationWitnessNotAllowed",
    "EInvalidMigrationWitness",
    "EPartnerNotAccepted",
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
  return abortName(PRESALE_ABORTS, module, code) as PresaleAbortName | null;
}

/**
 * Every `#[error(code = N)]` constant of the Aftermath DAO-pool vendor package
 * `blast_aftermath_dao_presale`, by module and indexed by code, checked like
 * `PRESALE_ABORTS`.
 */
export const AFTERMATH_PRESALE_ABORTS = {
  blast_aftermath_dao_presale: [
    "EPoolMismatch",
    "EDaoFeePoolMismatch",
    "EWrongPresale",
  ],
} as const;

export type AftermathPresaleAbortName =
  (typeof AFTERMATH_PRESALE_ABORTS)["blast_aftermath_dao_presale"][number];

/**
 * The error constant an abort in the Aftermath vendor package names; null for
 * any other module or code. Check first that the abort location's package is
 * the vendor package. Its `migrate` also aborts inside `blast_presale` and
 * Aftermath's packages: name the former with `presaleAbortName`.
 */
export function aftermathPresaleAbortName(
  module: string,
  code: number,
): AftermathPresaleAbortName | null {
  return abortName(
    AFTERMATH_PRESALE_ABORTS,
    module,
    code,
  ) as AftermathPresaleAbortName | null;
}

function abortName(
  aborts: Readonly<Record<string, readonly string[]>>,
  module: string,
  code: number,
): string | null {
  if (!Object.hasOwn(aborts, module) || !Number.isInteger(code)) return null;
  return aborts[module]?.[code] ?? null;
}
