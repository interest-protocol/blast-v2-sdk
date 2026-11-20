import { abortName } from "@interest-protocol/blast-core/aborts";

export const BOOSTS_CORE_ABORTS = [
  "EZeroAmount",
  "EInvalidFeeBps",
  "EInvalidNav",
  "EInvalidShareSupply",
  "EInvalidShareAmount",
  "ENonpositiveContribution",
  "EZeroSharesOut",
  "ENonpositiveGross",
  "EZeroNetPayout",
  "EInvalidTargetLeverageBps",
  "EInvalidLotSize",
  "EInvalidBase",
  "EOrderBelowMinLots",
  "ERedemptionUnderReduced",
  "ERedemptionOverReduced",
  "EArithmeticOverflow",
  "EMaintenanceReserveExceedsEquity",
  "EInvalidLifecycleTransition",
  "EOperationNotPermittedInLifecycle",
  "EMintBaseAboveBound",
  "EMintBaseBelowBound",
  "EInvalidMinOrderLots",
  "EInvalidRebalancePolicy",
  "EInvalidNavCap",
  "EInvalidMaxPriceAge",
  "EInvalidMaxConfidenceBps",
  "EInvalidMaxMarkDivergenceBps",
  "EStalePrice",
  "EFuturePrice",
  "EInvalidPrice",
  "EConfidenceExceedsBound",
  "EMarkOracleDivergenceExceedsBound",
  "EInvalidMaxSlippageBps",
  "EInvalidEmergencyMaxSlippageBps",
  "EInvalidMinLeverageImprovementBps",
  "ESharesOutBelowMinimum",
  "ENavCapExceeded",
  "EExecutionOutsideMaxSlippage",
  "EInvalidFreshnessWindow",
  "EInvalidMaxOrderNotional",
  "EMaxOrderNotionalUnchanged",
  "EInvalidObservationLotSize",
  "EInvalidPositionObservation",
  "EOrderNotionalExceedsMaximum",
  "EInvalidInitializationObservation",
  "EInitializationLeverageUnhealthy",
  "EInitializationBaseBelowMinOrder",
  "EFeeCapExceeded",
  "EFeeSettingsUnchanged",
  "EMintOutsideRebalanceBand",
  "EActiveCheckpointChanged",
  "EActiveFillIncomplete",
  "EActiveLeverageAboveCap",
  "ERedemptionOutputBelowMinimum",
  "ERebalanceInsideBand",
  "ERebalanceNoProgress",
  "EVenueFeeUnusable",
  "EInvalidAssetDecimals",
  "ENavCapUnchanged",
  "EInvalidMaxReserveBps",
  "ESeedReserveAboveCap",
  "EInvariantViolated",
  "EInvalidTickSize",
  "EOrderCapBelowMinimum",
  "EProfitRealizationNotNeeded",
  "EProfitRealizationUneconomic",
  "EInitialMarginHeadroom",
  "ERebalanceNotActionable",
  "ERebalanceOutsideBand",
  "ERebalanceCapacity",
  "ERebalanceOrderLimit",
  "EProtectedShutdownNotAllowed",
  "ERebalanceOrderMismatch",
] as const;

/** Decode a Move abort after matching its core package ID. */
export function boostsCoreAbortName(module: string, code: number) {
  switch (module) {
    case "accounting_math":
    case "lifecycle":
    case "observation":
    case "policy":
    case "rebalance_math":
    case "state":
      return abortName(BOOSTS_CORE_ABORTS, code);
    default:
      return null;
  }
}

export const BOOSTS_ADAPTER_ABORTS = [
  "EInvalidProductWitnessType",
  "EAdminCapAccountMismatch",
  "EAccountObjectMismatch",
  "EAccountNumberMismatch",
  "ERegistryMismatch",
  "EClearingHouseMismatch",
  "EBaseOracleMismatch",
  "ECollateralOracleMismatch",
  "EOracleObservationMismatch",
  "ENormalizationOverflow",
  "EInvalidCollateralDecimals",
  "EInvalidSeed",
  "EInvalidSeedReserve",
  "EInvalidInitializationOrderSize",
  "EInitializationFillMismatch",
  "EInitializationImrMismatch",
  "ELockedSharesOverflow",
  "EInitializationOrderCountExceeded",
  "EZeroAmount",
  "EInsufficientAdminCash",
  "ECashCheckpointMismatch",
  "EFillMismatch",
  "EOrdersPosted",
  "ELiquidation",
  "EActiveOrderCountExceeded",
  "EDeadlineExpired",
  "EActiveCheckpointMismatch",
  "ERedemptionShareMismatch",
  "EVenueFeeUnusable",
  "EUnresolvedCheckpoint",
  "ETerminalVenueUnsettled",
  "EInvalidUnwindExposure",
  "EVenueNotReady",
  "EMetadataUnchanged",
  "EPriorityGasPrice",
  "EInvalidRebaseline",
  "ERedemptionExceedsReleasable",
  "EProfitRealizationNoProgress",
] as const;

/** Decode a Move abort after matching its aftermath_adapter package ID. */
export function boostsAdapterAbortName(module: string, code: number) {
  switch (module) {
    case "package_admin":
      return abortName(["EUnguardedTreasuryDelay"], code);
    case "blast_boosts_aftermath":
      return abortName(["EGenerationMismatch", "EGenerationOverflow"], code);
    case "checkpoint":
    case "operations":
    case "orders":
    case "snapshot":
    case "vault":
    case "venue_account":
      return abortName(BOOSTS_ADAPTER_ABORTS, code);
    default:
      return null;
  }
}
