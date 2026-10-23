import { normalizeSuiObjectId } from "@mysten/sui/utils";

import { BASIS_POINTS_DENOMINATOR, requireU64 } from "../lib/integers.ts";
import type {
  BoostsBinding,
  BoostsCheckpoint,
  BoostsManifest,
  BoostsMarketObservation,
  BoostsObservation,
  BoostsProductManifest,
  BoostsProductSnapshotV1,
  BoostsTransport,
  BoostsUnavailableCode,
  BoostsVaultState,
} from "./types.ts";

const IFIXED_COLLATERAL_ATOM_SCALE = 1_000_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const U256_SIGN = 1n << 255n;
const U256_MODULUS = 1n << 256n;

export class BoostsObservationError extends Error {
  readonly code: BoostsUnavailableCode;
  readonly retryable: boolean;

  constructor(code: BoostsUnavailableCode, message: string, retryable = true) {
    super(message);
    this.name = "BoostsObservationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function assertBoostsTransportChain(
  transport: BoostsTransport,
  manifest: BoostsManifest,
): Promise<string> {
  let chainIdentifier: string;
  try {
    chainIdentifier = await transport.getChainIdentifier();
  } catch {
    throw new BoostsObservationError(
      "DATA_UNAVAILABLE",
      "Sui chain identity is temporarily unavailable",
    );
  }
  if (chainIdentifier !== manifest.chainIdentifier) {
    throw new BoostsObservationError(
      "IDENTITY_MISMATCH",
      "Boosts transport is connected to the wrong network or chain",
      false,
    );
  }
  return chainIdentifier;
}

export type BoostsDerivedEconomics = Readonly<{
  shareholderNavAtoms: bigint;
  admittedMaintenanceReserveAtoms: bigint;
  notionalAtoms: bigint;
  leverageBps: bigint;
  needsRebalance: boolean;
}>;

/**
 * Mirrors the core observation arithmetic. Inputs/outputs are atomic units.
 * Notional and leverage round up; the reserve cap and remaining capacity round
 * down, leaving every remainder with holders or on the lower-risk side.
 */
export function deriveBoostsEconomics(
  vault: BoostsVaultState,
  market: BoostsMarketObservation,
  nowMs: bigint,
): BoostsDerivedEconomics {
  validateBinding(vault.binding, market.binding);
  validateCheckpoint(vault.checkpoint, market.checkpoint);
  if (!market.venueOperational) {
    throw new BoostsObservationError(
      "VENUE_UNAVAILABLE",
      "bound venue is not operational",
    );
  }
  if (!market.marginSafe) {
    throw new BoostsObservationError(
      "MARGIN_UNSAFE",
      "bound venue account is below its margin gate",
    );
  }
  if (market.pendingOrderCount !== 0n) {
    throw new BoostsObservationError(
      "PENDING_ORDERS",
      "bound venue account has pending orders",
    );
  }
  validatePosition(vault, market);
  validatePrice("base", market.baseOracle, vault.pricePolicy, nowMs);
  validatePrice(
    "collateral",
    market.collateralOracle,
    vault.pricePolicy,
    nowMs,
  );
  if (market.markPrice <= 0n) {
    throw new BoostsObservationError(
      "MARK_DIVERGENCE",
      "venue mark price must be positive",
    );
  }
  if (
    absoluteDifference(market.markPrice, market.baseOracle.price) *
      BASIS_POINTS_DENOMINATOR >
    vault.pricePolicy.maxMarkDivergenceBps * market.baseOracle.price
  ) {
    throw new BoostsObservationError(
      "MARK_DIVERGENCE",
      "venue mark exceeds the configured oracle divergence",
    );
  }

  const notionalAtoms = divUp(
    market.positionBaseAtoms * market.baseOracle.price * vault.collateralUnit,
    market.collateralOracle.price * vault.baseUnit,
  );
  requireU64("notionalAtoms", notionalAtoms);
  const reserveCap =
    notionalAtoms === 0n
      ? vault.maintenanceReserveAtoms
      : (notionalAtoms * vault.maxReserveBps) / BASIS_POINTS_DENOMINATOR;
  const admittedMaintenanceReserveAtoms =
    vault.maintenanceReserveAtoms < reserveCap
      ? vault.maintenanceReserveAtoms
      : reserveCap;
  if (market.venueEquityAtoms <= admittedMaintenanceReserveAtoms) {
    throw new BoostsObservationError(
      "INVALID_NAV",
      "shareholder NAV is not positive",
    );
  }
  const shareholderNavAtoms =
    market.venueEquityAtoms - admittedMaintenanceReserveAtoms;
  const leverageBps = divUp(
    notionalAtoms * BASIS_POINTS_DENOMINATOR,
    shareholderNavAtoms,
  );
  const scaledNotional = notionalAtoms * BASIS_POINTS_DENOMINATOR;
  const needsRebalance =
    scaledNotional <
      shareholderNavAtoms * vault.rebalancePolicy.rebalanceBelowBps ||
    scaledNotional >
      shareholderNavAtoms * vault.rebalancePolicy.rebalanceAboveBps;

  return {
    shareholderNavAtoms,
    admittedMaintenanceReserveAtoms,
    notionalAtoms,
    leverageBps,
    needsRebalance,
  };
}

export function createBoostsSnapshot(
  product: BoostsProductManifest,
  observation: BoostsObservation,
  vault: BoostsVaultState,
  currentSupplyAtoms: bigint,
  market: BoostsMarketObservation,
  nowMs: bigint,
  lastCompletedRebalance: null | {
    transactionDigest: string;
    checkpoint: bigint;
  },
): BoostsProductSnapshotV1 {
  requireU64("currentSupplyAtoms", currentSupplyAtoms);
  const derived = deriveBoostsEconomics(vault, market, nowMs);
  const capMatches =
    vault.navCapAtoms.toString() === product.expectedNavCapAtoms;
  const active = vault.lifecycle === "active";
  const healthy = !derived.needsRebalance;
  const expectedCap = BigInt(product.expectedNavCapAtoms);
  const remaining =
    expectedCap > derived.shareholderNavAtoms
      ? expectedCap - derived.shareholderNavAtoms
      : 0n;
  const eligible =
    currentSupplyAtoms > vault.lockedSharesAtoms
      ? currentSupplyAtoms - vault.lockedSharesAtoms
      : 0n;

  return {
    schemaVersion: 1,
    observation,
    identity: {
      productKey: product.productKey,
      name: product.name,
      symbol: product.symbol,
      direction: product.direction,
      productType: product.productType,
      collateralType: product.collateralType,
      shareType: product.shareType,
      vault: product.vault.objectId,
    },
    decimals: { collateral: 6, shares: 9 },
    lifecycle: vault.lifecycle,
    availability: {
      read: true,
      mint: active && healthy && capMatches,
      redeem: active,
      rebalance: active && derived.needsRebalance,
      code: capMatches ? null : "CAP_CONFIGURATION_MISMATCH",
    },
    economics: {
      shareholderNavAtoms: derived.shareholderNavAtoms.toString(),
      sharePrice: {
        navAtoms: derived.shareholderNavAtoms.toString(),
        supplyAtoms: currentSupplyAtoms.toString(),
      },
      venueEquityAtoms: market.venueEquityAtoms.toString(),
      maintenanceReserveAtoms:
        derived.admittedMaintenanceReserveAtoms.toString(),
      storedMaintenanceReserveAtoms: vault.maintenanceReserveAtoms.toString(),
      notionalAtoms: derived.notionalAtoms.toString(),
      leverageBps: derived.leverageBps.toString(),
      health: derived.needsRebalance ? "rebalance_needed" : "healthy",
    },
    capacity: {
      navCapAtoms: product.expectedNavCapAtoms,
      liveNavCapAtoms: vault.navCapAtoms.toString(),
      usedAtoms: derived.shareholderNavAtoms.toString(),
      remainingAtoms: remaining.toString(),
    },
    supply: {
      currentAtoms: currentSupplyAtoms.toString(),
      lockedSeedAtoms: vault.lockedSharesAtoms.toString(),
      userEligibleAtoms: eligible.toString(),
    },
    fees: {
      mintBps: vault.mintFeeBps.toString(),
      redeemBps: vault.redeemFeeBps.toString(),
    },
    rebalance: {
      needed: derived.needsRebalance,
      lastCompleted: lastCompletedRebalance
        ? {
            digest: lastCompletedRebalance.transactionDigest,
            checkpoint: lastCompletedRebalance.checkpoint.toString(),
          }
        : null,
    },
  };
}

function validateBinding(expected: BoostsBinding, actual: BoostsBinding): void {
  const objectFields = [
    "accountObjectId",
    "registryId",
    "clearingHouseId",
  ] as const;
  if (
    expected.accountNumber !== actual.accountNumber ||
    objectFields.some(
      (field) =>
        normalizeSuiObjectId(expected[field]) !==
        normalizeSuiObjectId(actual[field]),
    )
  ) {
    throw new BoostsObservationError(
      "BINDING_MISMATCH",
      "captured venue binding does not match the vault",
    );
  }
}

function validateCheckpoint(
  stored: BoostsCheckpoint,
  observed: BoostsCheckpoint,
): void {
  const unchangedBeforeSettlement =
    nonFundingFieldsEqual(stored, observed) &&
    stored.allocatedCollateral === observed.allocatedCollateral &&
    stored.fundingSnapshotLong === observed.fundingSnapshotLong &&
    stored.fundingSnapshotShort === observed.fundingSnapshotShort;
  const snapshotsRefreshed =
    stored.fundingSnapshotLong !== observed.fundingSnapshotLong ||
    stored.fundingSnapshotShort !== observed.fundingSnapshotShort;
  if (
    unchangedBeforeSettlement ||
    (nonFundingFieldsEqual(stored, observed) &&
      snapshotsRefreshed &&
      allocatedDeltaIsRepresentable(stored, observed))
  ) {
    return;
  }
  throw new BoostsObservationError(
    "CHECKPOINT_DRIFT",
    "captured venue checkpoint contains unexplained drift",
  );
}

function nonFundingFieldsEqual(
  left: BoostsCheckpoint,
  right: BoostsCheckpoint,
): boolean {
  return (
    left.freeCollateral === right.freeCollateral &&
    left.signedBase === right.signedBase &&
    left.signedQuoteNotional === right.signedQuoteNotional &&
    left.lotSize === right.lotSize &&
    left.pendingAskBase === right.pendingAskBase &&
    left.pendingBidBase === right.pendingBidBase &&
    left.pendingOrderCount === right.pendingOrderCount &&
    left.marketPauseMode === right.marketPauseMode &&
    left.marketFrozen === right.marketFrozen &&
    left.positionInitialMarginRatio === right.positionInitialMarginRatio &&
    left.marketInitialMarginRatio === right.marketInitialMarginRatio &&
    left.marketMaintenanceMarginRatio === right.marketMaintenanceMarginRatio
  );
}

function allocatedDeltaIsRepresentable(
  before: BoostsCheckpoint,
  after: BoostsCheckpoint,
): boolean {
  const stored = signedU256(before.allocatedCollateral);
  const observed = signedU256(after.allocatedCollateral);
  if (stored === null || observed === null) return false;
  const delta = observed - stored;
  if (delta === 0n) return true;
  const magnitude = delta < 0n ? -delta : delta;
  const atoms =
    delta < 0n
      ? (magnitude + IFIXED_COLLATERAL_ATOM_SCALE - 1n) /
        IFIXED_COLLATERAL_ATOM_SCALE
      : magnitude / IFIXED_COLLATERAL_ATOM_SCALE;
  return atoms <= U64_MAX;
}

function signedU256(raw: bigint): bigint | null {
  if (raw < 0n || raw >= U256_MODULUS || raw === U256_SIGN) return null;
  return raw < U256_SIGN ? raw : raw - U256_MODULUS;
}

function validatePosition(
  vault: BoostsVaultState,
  market: BoostsMarketObservation,
): void {
  for (const [name, value] of [
    ["venueEquityAtoms", market.venueEquityAtoms],
    ["positionBaseAtoms", market.positionBaseAtoms],
    ["lotSizeAtoms", market.lotSizeAtoms],
    ["pendingOrderCount", market.pendingOrderCount],
  ] as const) {
    requireU64(name, value);
  }
  if (
    market.lotSizeAtoms === 0n ||
    market.positionBaseAtoms % market.lotSizeAtoms !== 0n ||
    market.lotSizeAtoms !== market.checkpoint.lotSize ||
    market.pendingOrderCount !== market.checkpoint.pendingOrderCount ||
    (market.positionBaseAtoms !== 0n && market.observedSide !== vault.side)
  ) {
    throw new BoostsObservationError(
      "INVALID_POSITION",
      "captured position is inconsistent with the vault policy",
    );
  }
}

function validatePrice(
  label: string,
  price: BoostsMarketObservation["baseOracle"],
  policy: BoostsVaultState["pricePolicy"],
  nowMs: bigint,
): void {
  requireU64(`${label} price`, price.price);
  requireU64(`${label} confidence`, price.confidence);
  requireU64(`${label} publish time`, price.publishTimeMs);
  if (price.price === 0n) {
    throw new BoostsObservationError(
      "MALFORMED_CHAIN_STATE",
      `${label} price must be positive`,
      false,
    );
  }
  if (price.publishTimeMs > nowMs) {
    if (price.publishTimeMs - nowMs > policy.maxPriceAheadMs) {
      throw new BoostsObservationError(
        "FUTURE_PRICE",
        `${label} price is future-dated`,
      );
    }
  } else if (nowMs - price.publishTimeMs > policy.maxPriceAgeMs) {
    throw new BoostsObservationError("STALE_PRICE", `${label} price is stale`);
  }
  if (
    price.confidence * BASIS_POINTS_DENOMINATOR >
    policy.maxConfidenceBps * price.price
  ) {
    throw new BoostsObservationError(
      "EXCESSIVE_CONFIDENCE",
      `${label} price confidence is too wide`,
    );
  }
}

function divUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError(
      "ceil division requires non-negative numerator and positive denominator",
    );
  }
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function absoluteDifference(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}
