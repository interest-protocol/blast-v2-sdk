import { bcs, TypeTagSerializer } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { deriveDynamicFieldID } from "@mysten/sui/utils";
import type { BoostsActivityKind } from "../src/boosts/events.ts";
import { boostsActivityEventBcs } from "../src/boosts/events.ts";
import {
  defineBoostsManifest,
  getBoostsProduct,
} from "../src/boosts/manifest.ts";
import { boostsTreasuryCapBcs, boostsVaultBcs } from "../src/boosts/state.ts";
import type {
  BoostsCheckpoint,
  BoostsManifest,
  BoostsProductKey,
  BoostsProductManifest,
  BoostsTreasuryProductRead,
} from "../src/boosts/types.ts";

export const ADAPTER_CURRENT = "0xa1";
export const ADAPTER_ORIGINAL = "0xa0";
export const PRODUCTS_CURRENT = "0xb1";
export const PRODUCTS_ORIGINAL = "0xb0";
export const COLLATERAL_TYPE = "0xc0::usdc::USDC";

const common = {
  registry: "0x31",
  clearingHouse: "0x32",
  baseOracleStorage: "0x33",
  collateralOracleStorage: "0x34",
  baseFeedOrigin: "0x35",
  collateralFeedOrigin: "0x36",
  protocol: "0x37",
  clock: "0x6",
  collateralDecimals: 6 as const,
  shareDecimals: 9 as const,
  expectedNavCapAtoms: "1000000000" as const,
};

export const BOOSTS_FIXTURE_MANIFEST = defineBoostsManifest({
  network: "testnet",
  chainIdentifier: "fixture-chain",
  adapterPackage: {
    packageId: ADAPTER_CURRENT,
    originalPackageId: ADAPTER_ORIGINAL,
  },
  productsPackage: {
    packageId: PRODUCTS_CURRENT,
    originalPackageId: PRODUCTS_ORIGINAL,
  },
  explorerTransactionUrlPrefix: "https://explorer.example/tx/",
  products: [
    {
      ...common,
      productKey: "sui-2x-bull",
      name: "SUI 2x Bull",
      symbol: "SUI2L",
      direction: "bull",
      productTag: "SUI_BULL_2X",
      productType: `${PRODUCTS_ORIGINAL}::blast_boosts_products::SUI_BULL_2X`,
      collateralType: COLLATERAL_TYPE,
      shareType: `${ADAPTER_ORIGINAL}::blast_boost::BlastBoost<${PRODUCTS_ORIGINAL}::blast_boosts_products::SUI_BULL_2X>`,
      vault: { objectId: "0x11", initialSharedVersion: "7", mutable: true },
      treasuryCap: "0x31",
      venueAccount: "0x21",
    },
    {
      ...common,
      productKey: "nvda-2x-bull",
      name: "NVDA 2x Bull",
      symbol: "NVDA2L",
      direction: "bull",
      productTag: "NVDA_BULL_2X",
      productType: `${PRODUCTS_ORIGINAL}::blast_boosts_products::NVDA_BULL_2X`,
      collateralType: COLLATERAL_TYPE,
      shareType: `${ADAPTER_ORIGINAL}::blast_boost::BlastBoost<${PRODUCTS_ORIGINAL}::blast_boosts_products::NVDA_BULL_2X>`,
      vault: { objectId: "0x12", initialSharedVersion: "7", mutable: true },
      treasuryCap: "0x32",
      venueAccount: "0x22",
    },
    {
      ...common,
      productKey: "zec-2x-bull",
      name: "ZEC 2x Bull",
      symbol: "ZEC2L",
      direction: "bull",
      productTag: "ZEC_BULL_2X",
      productType: `${PRODUCTS_ORIGINAL}::blast_boosts_products::ZEC_BULL_2X`,
      collateralType: COLLATERAL_TYPE,
      shareType: `${ADAPTER_ORIGINAL}::blast_boost::BlastBoost<${PRODUCTS_ORIGINAL}::blast_boosts_products::ZEC_BULL_2X>`,
      vault: { objectId: "0x13", initialSharedVersion: "7", mutable: true },
      treasuryCap: "0x33",
      venueAccount: "0x23",
    },
  ],
}) as BoostsManifest & {
  products: readonly [
    BoostsProductManifest,
    BoostsProductManifest,
    BoostsProductManifest,
  ];
};

export const CHECKPOINT_BCS = {
  free_collateral: 10_100_000n,
  allocated_collateral: 0n,
  signed_base: 0n,
  signed_quote_notional: 0n,
  funding_snapshot_long: 0n,
  funding_snapshot_short: 0n,
  market_funding_long: 0n,
  market_funding_short: 0n,
  lot_size: 1_000_000n,
  pending_ask_base: 0n,
  pending_bid_base: 0n,
  pending_order_count: 0n,
  market_pause_mode: 0,
  market_frozen: false,
  position_initial_margin_ratio: 0n,
  market_initial_margin_ratio: 0n,
  market_maintenance_margin_ratio: 0n,
};

export const CHECKPOINT: BoostsCheckpoint = {
  freeCollateral: 10_100_000n,
  allocatedCollateral: 0n,
  signedBase: 0n,
  signedQuoteNotional: 0n,
  fundingSnapshotLong: 0n,
  fundingSnapshotShort: 0n,
  marketFundingLong: 0n,
  marketFundingShort: 0n,
  lotSize: 1_000_000n,
  pendingAskBase: 0n,
  pendingBidBase: 0n,
  pendingOrderCount: 0n,
  marketPauseMode: 0,
  marketFrozen: false,
  positionInitialMarginRatio: 0n,
  marketInitialMarginRatio: 0n,
  marketMaintenanceMarginRatio: 0n,
};

export function fixtureRead(
  key: BoostsProductKey,
  options: Readonly<{
    lifecycle?: "Active" | "Unwinding" | "Settled";
    navCapAtoms?: bigint;
    currentSupplyAtoms?: bigint;
    lockedSharesAtoms?: bigint;
  }> = {},
): BoostsTreasuryProductRead {
  const product = getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, key);
  const binding = bindingFor(product);
  return {
    network: "testnet",
    chainIdentifier: "fixture-chain",
    checkpoint: "10",
    observedAt: "2026-09-21T00:00:00.000Z",
    clockTimestampMs: 1_000_000n,
    vault: {
      ...product.vault,
      type: `${ADAPTER_ORIGINAL}::vault::Vault<${product.productType},${product.collateralType}>`,
      content: vaultBytes(product, binding, options),
    },
    treasuryCap: treasuryCap(
      product,
      options.currentSupplyAtoms ?? 10_000_000_000n,
    ),
    market: {
      binding: {
        accountObjectId: product.venueAccount,
        accountNumber: 1n,
        registryId: product.registry,
        clearingHouseId: product.clearingHouse,
        baseOracleId: product.baseOracleStorage,
        collateralOracleId: product.collateralOracleStorage,
        baseFeedId: product.baseFeedOrigin,
        collateralFeedId: product.collateralFeedOrigin,
      },
      checkpoint: CHECKPOINT,
      venueEquityAtoms: 10_100_000n,
      positionBaseAtoms: 10_000_000_000n,
      lotSizeAtoms: 1_000_000n,
      observedSide: product.direction === "bull" ? "long" : "short",
      baseOracle: {
        price: 2_000_000_000n,
        confidence: 1_000_000n,
        publishTimeMs: 999_000n,
      },
      collateralOracle: {
        price: 1_000_000_000n,
        confidence: 500_000n,
        publishTimeMs: 999_000n,
      },
      markPrice: 2_000_000_000n,
      venueOperational: true,
      marginSafe: true,
      pendingOrderCount: 0n,
    },
    lastCompletedRebalance: {
      checkpoint: 8n,
      transactionDigest: "last-rebalance",
    },
  };
}

export function fixtureEvent(
  key: BoostsProductKey,
  kind: BoostsActivityKind,
  eventIndex = 0,
  overrides: Record<string, unknown> = {},
): SuiClientTypes.EventEntry {
  const product = getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, key);
  const payload = {
    ...eventPayload(kind, product),
    ...overrides,
  };
  const encoded =
    kind === "Minted"
      ? boostsActivityEventBcs.Minted.serialize(
          payload as Parameters<
            typeof boostsActivityEventBcs.Minted.serialize
          >[0],
        ).toBytes()
      : kind === "Redeemed"
        ? boostsActivityEventBcs.Redeemed.serialize(
            payload as Parameters<
              typeof boostsActivityEventBcs.Redeemed.serialize
            >[0],
          ).toBytes()
        : boostsActivityEventBcs.Rebalanced.serialize(
            payload as Parameters<
              typeof boostsActivityEventBcs.Rebalanced.serialize
            >[0],
          ).toBytes();
  return {
    packageId: ADAPTER_CURRENT,
    module: "blast_events",
    sender: "0xd",
    eventType: `${ADAPTER_ORIGINAL}::blast_events::Event<${ADAPTER_ORIGINAL}::events::${kind}<${product.productType}>>`,
    bcs: encoded,
    json: null,
    checkpoint: String(100 - eventIndex),
    transactionDigest: `digest-${eventIndex}`,
    eventIndex,
  };
}

function vaultBytes(
  product: BoostsProductManifest,
  binding: ReturnType<typeof bindingFor>,
  options: Readonly<{
    lifecycle?: "Active" | "Unwinding" | "Settled";
    navCapAtoms?: bigint;
    lockedSharesAtoms?: bigint;
  }>,
): Uint8Array {
  const lifecycle = options.lifecycle ?? "Active";
  return boostsVaultBcs
    .serialize({
      id: uid(product.vault.objectId),
      state: {
        vault_policy: {
          side: product.direction === "bull" ? { Long: true } : { Short: true },
          rebalance_policy: {
            rebalance_below_bps: 18_000n,
            target_leverage_bps: 20_000n,
            rebalance_above_bps: 22_000n,
            max_leverage_bps: 30_000n,
            max_slippage_bps: 100n,
            emergency_max_slippage_bps: 500n,
            min_leverage_improvement_bps: 100n,
          },
          price_policy: {
            max_price_age_ms: 60_000n,
            max_price_ahead_ms: 1_000n,
            max_confidence_bps: 100n,
            max_mark_divergence_bps: 500n,
          },
          initial_mint_fee_bps: 30n,
          initial_redeem_fee_bps: 30n,
          mint_fee_cap_bps: 100n,
          redeem_fee_cap_bps: 100n,
          admin_share_cap_bps: 5_000n,
          min_order_lots: 1n,
          max_reserve_bps: 500n,
        },
        max_order_notional: 1_000_000_000n,
        maintenance_reserve: 100_000n,
        uncovered_deficit: 0n,
        base_unit: 1_000_000_000n,
        collateral_unit: 1_000_000n,
        lifecycle:
          lifecycle === "Active"
            ? { Active: true }
            : lifecycle === "Unwinding"
              ? { Unwinding: true }
              : { Settled: true },
        mint_fee_bps: 30n,
        redeem_fee_bps: 40n,
        admin_share_bps: 1_000n,
        nav_cap: options.navCapAtoms ?? 1_000_000_000n,
      },
      venue_account: {
        binding,
        checkpoint: CHECKPOINT_BCS,
        admin_cap: { id: uid("0x41"), for: id(product.venueAccount) },
      },
      locked_shares: options.lockedSharesAtoms ?? 1_000_000_000n,
      admin_cash: { value: 0n },
      terminal_cash: { value: 0n },
    })
    .toBytes();
}

function treasuryCap(product: BoostsProductManifest, supply: bigint) {
  const keyType = `${ADAPTER_ORIGINAL}::vault::TreasuryKey<${product.productType}>`;
  const wrapper = TypeTagSerializer.parseFromStr(
    `0x2::dynamic_object_field::Wrapper<${keyType}>`,
  );
  const keyBytes = bcs.struct("TreasuryKey", {}).serialize({}).toBytes();
  return {
    objectId: product.direction === "bull" ? "0x51" : "0x52",
    ownerObjectId: deriveDynamicFieldID(
      product.vault.objectId,
      wrapper,
      keyBytes,
    ),
    type: `0x2::coin::TreasuryCap<${product.shareType}>`,
    content: boostsTreasuryCapBcs
      .serialize({
        id: uid(product.direction === "bull" ? "0x51" : "0x52"),
        total_supply: { value: supply },
      })
      .toBytes(),
  };
}

function bindingFor(product: BoostsProductManifest) {
  return {
    account_object_id: id(product.venueAccount),
    account_number: 1n,
    registry_id: id(product.registry),
    clearing_house_id: id(product.clearingHouse),
    base_oracle_id: id(product.baseOracleStorage),
    collateral_oracle_id: id(product.collateralOracleStorage),
    base_feed_id: id(product.baseFeedOrigin),
    collateral_feed_id: id(product.collateralFeedOrigin),
  };
}

function eventPayload(
  kind: BoostsActivityKind,
  product: BoostsProductManifest,
) {
  if (kind === "Minted") {
    return {
      vault_id: product.vault.objectId,
      deposit: 1_000_000n,
      shares: 1_000_000_000n,
      contribution: 997_000n,
      fee: 3_000n,
      admin_fee: 300n,
      reserve_fee: 2_700n,
      reserve_after: 102_700n,
      admin_cash_after: 300n,
      supply_after: 11_000_000_000n,
      checkpoint: CHECKPOINT_BCS,
    };
  }
  if (kind === "Redeemed") {
    return {
      vault_id: product.vault.objectId,
      shares: 1_000_000_000n,
      net: 996_000n,
      fee: 4_000n,
      admin_fee: 400n,
      reserve_fee: 3_600n,
      reserve_after: 103_600n,
      admin_cash_after: 400n,
      supply_after: 9_000_000_000n,
      checkpoint: CHECKPOINT_BCS,
    };
  }
  return {
    vault_id: product.vault.objectId,
    equity_before: 10_100_000n,
    equity_after: 10_000_000n,
    base_before: 10_000_000_000n,
    base_after: 9_000_000_000n,
    increase: false,
    reserve_after: 100_000n,
    admin_cash_after: 0n,
    supply_after: 10_000_000_000n,
    checkpoint: CHECKPOINT_BCS,
  };
}

function id(value: string) {
  return { bytes: value };
}

function uid(value: string) {
  return { id: id(value) };
}
