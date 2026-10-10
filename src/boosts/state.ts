import { bcs, TypeTagSerializer } from "@mysten/sui/bcs";
import {
  deriveDynamicFieldID,
  normalizeStructTag,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import { suiBalanceBcs, suiIdBcs, suiUidBcs } from "../lib/bcs.ts";
import { normalizePositiveU64, requireU64 } from "../lib/integers.ts";
import type {
  BoostsBinding,
  BoostsCheckpoint,
  BoostsMarketObservation,
  BoostsProductManifest,
  BoostsTreasuryCapObject,
  BoostsVaultObject,
  BoostsVaultState,
} from "./types.ts";

const positionSideBcs = bcs.enum("PositionSide", { Long: null, Short: null });
const lifecycleBcs = bcs.enum("Lifecycle", {
  Active: null,
  Unwinding: null,
  Settled: null,
});
const rebalancePolicyBcs = bcs.struct("RebalancePolicy", {
  rebalance_below_bps: bcs.u64(),
  target_leverage_bps: bcs.u64(),
  rebalance_above_bps: bcs.u64(),
  max_leverage_bps: bcs.u64(),
  max_slippage_bps: bcs.u64(),
  emergency_max_slippage_bps: bcs.u64(),
  min_leverage_improvement_bps: bcs.u64(),
});
const pricePolicyBcs = bcs.struct("PricePolicy", {
  max_price_age_ms: bcs.u64(),
  max_price_ahead_ms: bcs.u64(),
  max_confidence_bps: bcs.u64(),
  max_mark_divergence_bps: bcs.u64(),
});
const vaultPolicyBcs = bcs.struct("VaultPolicy", {
  side: positionSideBcs,
  rebalance_policy: rebalancePolicyBcs,
  price_policy: pricePolicyBcs,
  initial_mint_fee_bps: bcs.u64(),
  initial_redeem_fee_bps: bcs.u64(),
  mint_fee_cap_bps: bcs.u64(),
  redeem_fee_cap_bps: bcs.u64(),
  admin_share_cap_bps: bcs.u64(),
  min_order_lots: bcs.u64(),
  max_reserve_bps: bcs.u64(),
});
const stateBcs = bcs.struct("State", {
  vault_policy: vaultPolicyBcs,
  max_order_notional: bcs.u64(),
  maintenance_reserve: bcs.u64(),
  uncovered_deficit: bcs.u64(),
  base_unit: bcs.u64(),
  collateral_unit: bcs.u64(),
  lifecycle: lifecycleBcs,
  mint_fee_bps: bcs.u64(),
  redeem_fee_bps: bcs.u64(),
  admin_share_bps: bcs.u64(),
  nav_cap: bcs.u64(),
});
export const boostsCheckpointBcs = bcs.struct("Checkpoint", {
  free_collateral: bcs.u64(),
  allocated_collateral: bcs.u256(),
  signed_base: bcs.u256(),
  signed_quote_notional: bcs.u256(),
  funding_snapshot_long: bcs.u256(),
  funding_snapshot_short: bcs.u256(),
  market_funding_long: bcs.u256(),
  market_funding_short: bcs.u256(),
  lot_size: bcs.u64(),
  pending_ask_base: bcs.u256(),
  pending_bid_base: bcs.u256(),
  pending_order_count: bcs.u64(),
  market_pause_mode: bcs.u8(),
  market_frozen: bcs.bool(),
  position_initial_margin_ratio: bcs.u256(),
  market_initial_margin_ratio: bcs.u256(),
  market_maintenance_margin_ratio: bcs.u256(),
});
export const boostsCapturedSnapshotBcs = bcs.struct("CapturedSnapshot", {
  venue_equity: bcs.u64(),
  position_base: bcs.u64(),
  lot_size: bcs.u64(),
  side: positionSideBcs,
  pending_order_count: bcs.u64(),
  margin_safe: bcs.bool(),
  venue_operational: bcs.bool(),
  economics_valid: bcs.bool(),
  base_price: bcs.u64(),
  base_timestamp: bcs.u64(),
  collateral_price: bcs.u64(),
  collateral_timestamp: bcs.u64(),
  mark_price: bcs.u64(),
  checkpoint: boostsCheckpointBcs,
  collateral_fixed: bcs.u256(),
});
export const boostsBindingBcs = bcs.struct("Binding", {
  account_object_id: suiIdBcs,
  account_number: bcs.u64(),
  registry_id: suiIdBcs,
  clearing_house_id: suiIdBcs,
  base_oracle_id: suiIdBcs,
  collateral_oracle_id: suiIdBcs,
  base_feed_id: suiIdBcs,
  collateral_feed_id: suiIdBcs,
});
const authorityCapBcs = bcs.struct("AuthorityCap", {
  id: suiUidBcs,
  for: suiIdBcs,
});
const venueAccountBcs = bcs.struct("VenueAccount", {
  binding: boostsBindingBcs,
  checkpoint: boostsCheckpointBcs,
  admin_cap: authorityCapBcs,
});

/** Candidate BCS layout of the reviewed `blast_boosts_aftermath::vault::Vault`. */
export const boostsVaultBcs = bcs.struct("Vault", {
  id: suiUidBcs,
  state: stateBcs,
  venue_account: venueAccountBcs,
  locked_shares: bcs.u64(),
  admin_cash: suiBalanceBcs,
  terminal_cash: suiBalanceBcs,
});

const supplyBcs = bcs.struct("Supply", { value: bcs.u64() });
export const boostsTreasuryCapBcs = bcs.struct("TreasuryCap", {
  id: suiUidBcs,
  total_supply: supplyBcs,
});
const treasuryKeyBcs = bcs.struct("TreasuryKey", {});

export function decodeBoostsVaultObject(
  object: BoostsVaultObject,
  product: BoostsProductManifest,
  adapterOriginalPackageId: string,
): BoostsVaultState {
  const objectId = normalizeSuiObjectId(object.objectId);
  if (objectId !== normalizeSuiObjectId(product.vault.objectId)) {
    throw new TypeError("Boosts vault object has an unexpected identity");
  }
  if (object.mutable !== true)
    throw new TypeError("Boosts vault must be mutable");
  const initialSharedVersion = normalizePositiveU64(
    "Boosts vault initialSharedVersion",
    object.initialSharedVersion,
  );
  if (
    initialSharedVersion !==
    normalizePositiveU64(
      "manifest vault initialSharedVersion",
      product.vault.initialSharedVersion,
    )
  ) {
    throw new TypeError(
      "Boosts vault has an unexpected initial shared version",
    );
  }

  const tag = parseStructTag(object.type);
  if (
    tag.address !== normalizeSuiObjectId(adapterOriginalPackageId) ||
    tag.module !== "vault" ||
    tag.name !== "Vault" ||
    tag.typeParams.length !== 2
  ) {
    throw new TypeError("object is not the expected Boosts vault type");
  }
  const [productTag, collateralTag] = tag.typeParams;
  if (
    productTag === undefined ||
    collateralTag === undefined ||
    normalizedType(productTag) !== normalizeStructTag(product.productType) ||
    normalizedType(collateralTag) !== normalizeStructTag(product.collateralType)
  ) {
    throw new TypeError("Boosts vault has unexpected type arguments");
  }

  const parsed = boostsVaultBcs.parse(object.content);
  assertObjectId("Boosts vault UID", parsed.id.id.bytes, objectId);
  const binding = decodeBoostsBinding(parsed.venue_account.binding);
  assertObjectId(
    "Boosts admin capability account",
    parsed.venue_account.admin_cap.for.bytes,
    binding.accountObjectId,
  );
  const state = parsed.state;
  return {
    objectId,
    initialSharedVersion,
    mutable: true,
    productType: normalizedType(productTag),
    collateralType: normalizedType(collateralTag),
    side: state.vault_policy.side.$kind === "Long" ? "long" : "short",
    rebalancePolicy: {
      rebalanceBelowBps: u64(
        "rebalanceBelowBps",
        state.vault_policy.rebalance_policy.rebalance_below_bps,
      ),
      targetLeverageBps: u64(
        "targetLeverageBps",
        state.vault_policy.rebalance_policy.target_leverage_bps,
      ),
      rebalanceAboveBps: u64(
        "rebalanceAboveBps",
        state.vault_policy.rebalance_policy.rebalance_above_bps,
      ),
      maxLeverageBps: u64(
        "maxLeverageBps",
        state.vault_policy.rebalance_policy.max_leverage_bps,
      ),
      maxSlippageBps: u64(
        "maxSlippageBps",
        state.vault_policy.rebalance_policy.max_slippage_bps,
      ),
      emergencyMaxSlippageBps: u64(
        "emergencyMaxSlippageBps",
        state.vault_policy.rebalance_policy.emergency_max_slippage_bps,
      ),
      minLeverageImprovementBps: u64(
        "minLeverageImprovementBps",
        state.vault_policy.rebalance_policy.min_leverage_improvement_bps,
      ),
    },
    pricePolicy: {
      maxPriceAgeMs: u64(
        "maxPriceAgeMs",
        state.vault_policy.price_policy.max_price_age_ms,
      ),
      maxPriceAheadMs: u64(
        "maxPriceAheadMs",
        state.vault_policy.price_policy.max_price_ahead_ms,
      ),
      maxConfidenceBps: u64(
        "maxConfidenceBps",
        state.vault_policy.price_policy.max_confidence_bps,
      ),
      maxMarkDivergenceBps: u64(
        "maxMarkDivergenceBps",
        state.vault_policy.price_policy.max_mark_divergence_bps,
      ),
    },
    maxReserveBps: u64("maxReserveBps", state.vault_policy.max_reserve_bps),
    maxOrderNotionalAtoms: u64(
      "maxOrderNotionalAtoms",
      state.max_order_notional,
    ),
    maintenanceReserveAtoms: u64(
      "maintenanceReserveAtoms",
      state.maintenance_reserve,
    ),
    uncoveredDeficitAtoms: u64(
      "uncoveredDeficitAtoms",
      state.uncovered_deficit,
    ),
    baseUnit: u64("baseUnit", state.base_unit),
    collateralUnit: u64("collateralUnit", state.collateral_unit),
    lifecycle: lifecycle(state.lifecycle.$kind),
    mintFeeBps: u64("mintFeeBps", state.mint_fee_bps),
    redeemFeeBps: u64("redeemFeeBps", state.redeem_fee_bps),
    adminShareBps: u64("adminShareBps", state.admin_share_bps),
    navCapAtoms: u64("navCapAtoms", state.nav_cap),
    binding,
    checkpoint: decodeBoostsCheckpoint(parsed.venue_account.checkpoint),
    lockedSharesAtoms: u64("lockedSharesAtoms", parsed.locked_shares),
    adminCashAtoms: u64("adminCashAtoms", parsed.admin_cash.value),
    terminalCashAtoms: u64("terminalCashAtoms", parsed.terminal_cash.value),
  };
}

export function decodeBoostsTreasurySupply(
  object: BoostsTreasuryCapObject,
  product: BoostsProductManifest,
  adapterOriginalPackageId: string,
): bigint {
  const expectedType = normalizeStructTag(
    `0x2::coin::TreasuryCap<${product.shareType}>`,
  );
  if (normalizeStructTag(object.type) !== expectedType) {
    throw new TypeError("object is not the expected Boosts TreasuryCap");
  }
  const keyType = `${normalizeSuiObjectId(adapterOriginalPackageId)}::vault::TreasuryKey<${product.productType}>`;
  const wrapperType = TypeTagSerializer.parseFromStr(
    `0x2::dynamic_object_field::Wrapper<${keyType}>`,
  );
  const expectedOwner = deriveDynamicFieldID(
    product.vault.objectId,
    wrapperType,
    treasuryKeyBcs.serialize({}).toBytes(),
  );
  if (
    normalizeSuiObjectId(object.ownerObjectId) !==
    normalizeSuiObjectId(expectedOwner)
  ) {
    throw new TypeError("Boosts TreasuryCap belongs to another vault");
  }
  const parsed = boostsTreasuryCapBcs.parse(object.content);
  assertObjectId("Boosts TreasuryCap UID", parsed.id.id.bytes, object.objectId);
  return u64("Boosts current supply", parsed.total_supply.value);
}

export function decodeBoostsBinding(
  input: ReturnType<typeof boostsBindingBcs.parse>,
): BoostsBinding {
  return {
    accountObjectId: normalizeSuiObjectId(input.account_object_id.bytes),
    accountNumber: u64("binding.accountNumber", input.account_number),
    registryId: normalizeSuiObjectId(input.registry_id.bytes),
    clearingHouseId: normalizeSuiObjectId(input.clearing_house_id.bytes),
    baseOracleId: normalizeSuiObjectId(input.base_oracle_id.bytes),
    collateralOracleId: normalizeSuiObjectId(input.collateral_oracle_id.bytes),
    baseFeedId: normalizeSuiObjectId(input.base_feed_id.bytes),
    collateralFeedId: normalizeSuiObjectId(input.collateral_feed_id.bytes),
  };
}

export function decodeBoostsCheckpoint(
  input: ReturnType<typeof boostsCheckpointBcs.parse>,
): BoostsCheckpoint {
  return {
    freeCollateral: u64("checkpoint.freeCollateral", input.free_collateral),
    allocatedCollateral: BigInt(input.allocated_collateral),
    signedBase: BigInt(input.signed_base),
    signedQuoteNotional: BigInt(input.signed_quote_notional),
    fundingSnapshotLong: BigInt(input.funding_snapshot_long),
    fundingSnapshotShort: BigInt(input.funding_snapshot_short),
    marketFundingLong: BigInt(input.market_funding_long),
    marketFundingShort: BigInt(input.market_funding_short),
    lotSize: u64("checkpoint.lotSize", input.lot_size),
    pendingAskBase: BigInt(input.pending_ask_base),
    pendingBidBase: BigInt(input.pending_bid_base),
    pendingOrderCount: u64(
      "checkpoint.pendingOrderCount",
      input.pending_order_count,
    ),
    marketPauseMode: input.market_pause_mode,
    marketFrozen: input.market_frozen,
    positionInitialMarginRatio: BigInt(input.position_initial_margin_ratio),
    marketInitialMarginRatio: BigInt(input.market_initial_margin_ratio),
    marketMaintenanceMarginRatio: BigInt(input.market_maintenance_margin_ratio),
  };
}

/** Decodes the canonical result of `snapshot::capture` from dev-inspect. */
export function decodeBoostsCapturedSnapshot(
  content: Uint8Array,
  binding: BoostsBinding,
): BoostsMarketObservation {
  const input = boostsCapturedSnapshotBcs.parse(content);
  if (!input.economics_valid) {
    throw new TypeError("Boosts market economics could not be normalized");
  }
  return {
    binding,
    checkpoint: decodeBoostsCheckpoint(input.checkpoint),
    venueEquityAtoms: u64("market.venueEquityAtoms", input.venue_equity),
    positionBaseAtoms: u64("market.positionBaseAtoms", input.position_base),
    lotSizeAtoms: u64("market.lotSizeAtoms", input.lot_size),
    observedSide: input.side.$kind === "Long" ? "long" : "short",
    baseOracle: {
      price: u64("market.baseOracle.price", input.base_price),
      confidence: 0n,
      publishTimeMs: u64(
        "market.baseOracle.publishTimeMs",
        input.base_timestamp,
      ),
    },
    collateralOracle: {
      price: u64("market.collateralOracle.price", input.collateral_price),
      confidence: 0n,
      publishTimeMs: u64(
        "market.collateralOracle.publishTimeMs",
        input.collateral_timestamp,
      ),
    },
    markPrice: u64("market.markPrice", input.mark_price),
    venueOperational: input.venue_operational,
    marginSafe: input.margin_safe,
    pendingOrderCount: u64(
      "market.pendingOrderCount",
      input.pending_order_count,
    ),
  };
}

function normalizedType(
  type: ReturnType<typeof parseStructTag>["typeParams"][number],
): string {
  return typeof type === "string" ? type : normalizeStructTag(type);
}

function lifecycle(
  kind: "Active" | "Unwinding" | "Settled",
): BoostsVaultState["lifecycle"] {
  if (kind === "Active") return "active";
  if (kind === "Unwinding") return "unwinding";
  return "settled";
}

function u64(name: string, value: string): bigint {
  return requireU64(name, BigInt(value));
}

function assertObjectId(name: string, actual: string, expected: string): void {
  if (normalizeSuiObjectId(actual) !== normalizeSuiObjectId(expected)) {
    throw new TypeError(`${name} does not match its object ID`);
  }
}
