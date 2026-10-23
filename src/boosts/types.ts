import type { SuiClientTypes } from "@mysten/sui/client";

import type { NativeTransactionPosition } from "../lib/events.ts";
import type { SharedObjectReference, SuiPackageReference } from "../lib/sui.ts";

export const BOOSTS_PRODUCT_KEYS = [
  "sui-2x-bull",
  "nvda-2x-bull",
  "zec-2x-bull",
] as const;
export type BoostsProductKey = (typeof BOOSTS_PRODUCT_KEYS)[number];

export type BoostsProductManifest = Readonly<{
  productKey: BoostsProductKey;
  name: "SUI 2x Bull" | "NVDA 2x Bull" | "ZEC 2x Bull";
  symbol: "SUI2L" | "NVDA2L" | "ZEC2L";
  direction: "bull";
  productTag: "SUI_BULL_2X" | "NVDA_BULL_2X" | "ZEC_BULL_2X";
  productType: string;
  collateralType: string;
  shareType: string;
  vault: SharedObjectReference<true>;
  treasuryCap: string;
  venueAccount: string;
  registry: string;
  clearingHouse: string;
  baseOracleStorage: string;
  collateralOracleStorage: string;
  protocol: string;
  clock: string;
  collateralDecimals: 6;
  shareDecimals: 9;
  expectedNavCapAtoms: "1000000000";
}>;

export type BoostsManifest = Readonly<{
  network: "mainnet" | "testnet";
  chainIdentifier: string;
  adapterPackage: SuiPackageReference;
  productsPackage: SuiPackageReference;
  explorerTransactionUrlPrefix: string;
  products: readonly [BoostsProductManifest, ...BoostsProductManifest[]];
}>;

export type BoostsCheckpoint = Readonly<{
  freeCollateral: bigint;
  allocatedCollateral: bigint;
  signedBase: bigint;
  signedQuoteNotional: bigint;
  fundingSnapshotLong: bigint;
  fundingSnapshotShort: bigint;
  marketFundingLong: bigint;
  marketFundingShort: bigint;
  lotSize: bigint;
  pendingAskBase: bigint;
  pendingBidBase: bigint;
  pendingOrderCount: bigint;
  marketPauseMode: number;
  marketFrozen: boolean;
  positionInitialMarginRatio: bigint;
  marketInitialMarginRatio: bigint;
  marketMaintenanceMarginRatio: bigint;
}>;

export type BoostsBinding = Readonly<{
  accountObjectId: string;
  accountNumber: bigint;
  registryId: string;
  clearingHouseId: string;
}>;

export type BoostsPricePolicy = Readonly<{
  maxPriceAgeMs: bigint;
  maxPriceAheadMs: bigint;
  maxConfidenceBps: bigint;
  maxMarkDivergenceBps: bigint;
}>;

export type BoostsRebalancePolicy = Readonly<{
  rebalanceBelowBps: bigint;
  targetLeverageBps: bigint;
  rebalanceAboveBps: bigint;
  maxLeverageBps: bigint;
  maxSlippageBps: bigint;
  emergencyMaxSlippageBps: bigint;
  minLeverageImprovementBps: bigint;
}>;

export type BoostsVaultState = Readonly<{
  objectId: string;
  initialSharedVersion: string;
  mutable: true;
  productType: string;
  collateralType: string;
  side: "long" | "short";
  rebalancePolicy: BoostsRebalancePolicy;
  pricePolicy: BoostsPricePolicy;
  maxReserveBps: bigint;
  maxOrderNotionalAtoms: bigint;
  maintenanceReserveAtoms: bigint;
  uncoveredDeficitAtoms: bigint;
  baseUnit: bigint;
  collateralUnit: bigint;
  lifecycle: "active" | "unwinding" | "settled";
  mintFeeBps: bigint;
  redeemFeeBps: bigint;
  adminShareBps: bigint;
  navCapAtoms: bigint;
  binding: BoostsBinding;
  checkpoint: BoostsCheckpoint;
  lockedSharesAtoms: bigint;
  adminCashAtoms: bigint;
  terminalCashAtoms: bigint;
}>;

export type BoostsVaultObject = SharedObjectReference<true> & {
  type: string;
  content: Uint8Array;
};

export type BoostsTreasuryCapObject = {
  objectId: string;
  ownerObjectId: string;
  type: string;
  content: Uint8Array;
};

export type BoostsPriceObservation = Readonly<{
  price: bigint;
  confidence: bigint;
  publishTimeMs: bigint;
}>;

export type BoostsMarketObservation = Readonly<{
  binding: BoostsBinding;
  checkpoint: BoostsCheckpoint;
  venueEquityAtoms: bigint;
  positionBaseAtoms: bigint;
  lotSizeAtoms: bigint;
  observedSide: "long" | "short";
  baseOracle: BoostsPriceObservation;
  collateralOracle: BoostsPriceObservation;
  markPrice: bigint;
  venueOperational: boolean;
  marginSafe: boolean;
  pendingOrderCount: bigint;
}>;

/**
 * One transport-authenticated current-state read with coherent object inputs.
 * checkpoint is the node's latest executed checkpoint watermark; observedAt
 * is the simulated Sui Clock time, not an unchanged object's last update time.
 */
type BoostsProductReadBase = Readonly<{
  network: BoostsManifest["network"];
  chainIdentifier: string;
  checkpoint: string;
  observedAt: string;
  clockTimestampMs: bigint;
  vault: BoostsVaultObject;
  market: BoostsMarketObservation;
  lastCompletedRebalance: NativeTransactionPosition | null;
}>;

/**
 * Supply is either decoded from the retained TreasuryCap object or returned by
 * the adapter's canonical `vault::total_share_supply` read during dev-inspect.
 */
export type BoostsTreasuryProductRead = BoostsProductReadBase &
  Readonly<{
    treasuryCap: BoostsTreasuryCapObject;
    currentSupplyAtoms?: never;
  }>;

export type BoostsInspectedProductRead = BoostsProductReadBase &
  Readonly<{
    treasuryCap?: never;
    currentSupplyAtoms: bigint;
  }>;

export type BoostsProductRead =
  | BoostsTreasuryProductRead
  | BoostsInspectedProductRead;

export type BoostsTransport = {
  readProduct(product: BoostsProductManifest): Promise<BoostsProductRead>;
  getChainIdentifier(): Promise<string>;
  getPackageReference?(packageId: string): Promise<SuiPackageReference>;
  getCoinMetadata?(coinType: string): Promise<null | Readonly<{
    decimals: number;
    name: string;
    symbol: string;
  }>>;
  getBalance(input: { owner: string; coinType: string }): Promise<string>;
  listEvents(
    input: SuiClientTypes.ListEventsOptions,
  ): Promise<SuiClientTypes.ListEventsResponse>;
  getIndexedTransaction(digest: string): Promise<null | Readonly<{
    digest: string;
    checkpoint: string;
    events: readonly SuiClientTypes.Event[];
    changedObjectIds: readonly string[];
  }>>;
  getCheckpointTimestampMs?(checkpoint: string): Promise<string | null>;
};

export type BoostsObservation = Readonly<{
  network: BoostsManifest["network"];
  chainIdentifier: string;
  checkpoint: string;
  observedAt: string;
  source: "sui";
}>;

export type BoostsUnavailableCode =
  | "DATA_UNAVAILABLE"
  | "IDENTITY_MISMATCH"
  | "COHERENCE_MISMATCH"
  | "BINDING_MISMATCH"
  | "CHECKPOINT_DRIFT"
  | "VENUE_UNAVAILABLE"
  | "MARGIN_UNSAFE"
  | "PENDING_ORDERS"
  | "INVALID_POSITION"
  | "STALE_PRICE"
  | "FUTURE_PRICE"
  | "EXCESSIVE_CONFIDENCE"
  | "MARK_DIVERGENCE"
  | "INVALID_NAV"
  | "MALFORMED_CHAIN_STATE";

export type BoostsProductSnapshotV1 = Readonly<{
  schemaVersion: 1;
  observation: BoostsObservation;
  identity: Readonly<{
    productKey: BoostsProductKey;
    name: BoostsProductManifest["name"];
    symbol: BoostsProductManifest["symbol"];
    direction: BoostsProductManifest["direction"];
    productType: string;
    collateralType: string;
    shareType: string;
    vault: string;
  }>;
  decimals: Readonly<{ collateral: 6; shares: 9 }>;
  lifecycle: BoostsVaultState["lifecycle"];
  availability: Readonly<{
    read: true;
    mint: boolean;
    redeem: boolean;
    rebalance: boolean;
    code: "CAP_CONFIGURATION_MISMATCH" | null;
  }>;
  economics: Readonly<{
    shareholderNavAtoms: string;
    sharePrice: Readonly<{ navAtoms: string; supplyAtoms: string }>;
    venueEquityAtoms: string;
    maintenanceReserveAtoms: string;
    storedMaintenanceReserveAtoms: string;
    notionalAtoms: string;
    leverageBps: string;
    health: "healthy" | "rebalance_needed";
  }>;
  capacity: Readonly<{
    navCapAtoms: "1000000000";
    liveNavCapAtoms: string;
    usedAtoms: string;
    remainingAtoms: string;
  }>;
  supply: Readonly<{
    currentAtoms: string;
    lockedSeedAtoms: string;
    userEligibleAtoms: string;
  }>;
  fees: Readonly<{ mintBps: string; redeemBps: string }>;
  rebalance: Readonly<{
    needed: boolean;
    lastCompleted: null | Readonly<{ digest: string; checkpoint: string }>;
  }>;
}>;

export type BoostsObservationResult =
  | Readonly<{ ok: true; snapshot: BoostsProductSnapshotV1 }>
  | Readonly<{
      ok: false;
      productKey: BoostsProductKey;
      code: BoostsUnavailableCode;
      message: string;
      retryable: boolean;
      observation: BoostsObservation | null;
    }>;

export type BoostsWalletBalances = Readonly<{
  owner: string;
  network: BoostsManifest["network"];
  chainIdentifier: string;
  suiAtoms: string;
  usdcAtoms: string;
  productSharesAtoms: Readonly<Partial<Record<BoostsProductKey, string>>>;
}>;
