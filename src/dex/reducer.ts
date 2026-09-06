import { suiEventId } from "../lib/events.ts";
import { requireU64, requireU128 } from "../lib/integers.ts";
import type { DecodedDexEvent } from "./events.ts";
import type { DexPoolEconomics, DexPositionEconomics } from "./math.ts";
import { DEX_MINIMUM_SHARES, DEX_X64, previewDexPositionFees } from "./math.ts";

export type DexPoolProjection = DexPoolEconomics & {
  memeType: string;
  quoteType: string;
};
export type DexPositionProjection = DexPositionEconomics & { poolId: string };
export type NativeLpProjection = {
  poolId: string;
  launchId: string;
  positionId: string;
  protocolQuoteFees: bigint;
  creatorQuoteFees: bigint;
};
export type DexReplayState = {
  pools: Map<string, DexPoolProjection>;
  positions: Map<string, DexPositionProjection>;
  nativeVaults: Map<string, NativeLpProjection>;
  applied: Set<string>;
  checkpoint: bigint;
  version: bigint | null;
};
export function createDexReplayState(): DexReplayState {
  return {
    pools: new Map(),
    positions: new Map(),
    nativeVaults: new Map(),
    applied: new Set(),
    checkpoint: 0n,
    version: null,
  };
}

/** Apply complete ordered history. Checks finish before mutation; duplicate events are harmless.
 * Position ownership comes from native object effects, never inferred from swap/claim senders. */
export function applyDexEvent(
  state: DexReplayState,
  event: DecodedDexEvent,
): void {
  const id = suiEventId(event.position);
  if (state.applied.has(id)) return;
  if (event.position.checkpoint < state.checkpoint)
    throw new Error("DEX replay is out of order");
  switch (event.kind) {
    case "pool.PoolCreated":
      applypoolPoolCreated(state, event);
      break;
    case "pool.PositionCreated":
      applypoolPositionCreated(state, event);
      break;
    case "pool.Swapped":
      applypoolSwapped(state, event);
      break;
    case "pool.LiquidityChanged":
      applypoolLiquidityChanged(state, event);
      break;
    case "pool.FeesClaimed":
      applypoolFeesClaimed(state, event);
      break;
    case "pool.PositionClosed":
      applypoolPositionClosed(state, event);
      break;
    case "pool.MaximumFeeChanged":
      applypoolMaximumFeeChanged(state, event);
      break;
    case "pool.VersionActivated":
      applypoolVersionActivated(state, event);
      break;
    case "migration.Migrated":
      applymigrationMigrated(state, event);
      break;
    case "migration.FeesCollected":
      applymigrationFeesCollected(state, event);
      break;
    case "migration.CreatorFeesClaimed":
    case "migration.ProtocolFeesClaimed":
      applymigrationProtocolFeesClaimed(state, event);
      break;
  }
  state.applied.add(id);
  state.checkpoint = event.position.checkpoint;
}
function requirePool(state: DexReplayState, id: string) {
  const pool = state.pools.get(id);
  if (!pool) throw new Error("missing pool history");
  return pool;
}
function requirePosition(state: DexReplayState, id: string, poolId: string) {
  const position = state.positions.get(id);
  if (!position || position.poolId !== poolId)
    throw new Error("missing position or wrong pool history");
  return position;
}

function applypoolPoolCreated(
  state: DexReplayState,
  event: Extract<DecodedDexEvent, { kind: "pool.PoolCreated" }>,
) {
  const p = event.payload;
  if (state.pools.has(p.pool_id) || state.positions.has(p.position_id))
    throw new Error("duplicate pool or position");
  if (
    p.total_shares <= DEX_MINIMUM_SHARES ||
    p.meme === 0n ||
    p.quote === 0n ||
    event.typeArguments.length !== 2
  )
    throw new Error("invalid initial pool");
  state.pools.set(p.pool_id, {
    memeType: event.typeArguments[0]!,
    quoteType: event.typeArguments[1]!,
    memeReserve: p.meme,
    quoteReserve: p.quote,
    quoteFees: 0n,
    totalShares: p.total_shares,
    feeGrowthX64: 0n,
    volumeX32: 0n,
    lastTradeSeconds: p.timestamp_seconds,
    volumeTarget: p.quote,
    maxFeeBps: p.max_fee_bps,
    burnBps: p.burn_bps,
  });
  state.positions.set(p.position_id, {
    poolId: p.pool_id,
    shares: p.total_shares - DEX_MINIMUM_SHARES,
    feeCheckpointX64: 0n,
    feesOwed: 0n,
    feeFractionX64: 0n,
  });
}

function applypoolPositionCreated(
  state: DexReplayState,
  event: Extract<DecodedDexEvent, { kind: "pool.PositionCreated" }>,
) {
  const p = event.payload;
  const pool = requirePool(state, p.pool_id);
  if (state.positions.has(p.position_id)) throw new Error("duplicate position");
  state.positions.set(p.position_id, {
    poolId: p.pool_id,
    shares: 0n,
    feeCheckpointX64: pool.feeGrowthX64,
    feesOwed: 0n,
    feeFractionX64: 0n,
  });
}

function applypoolSwapped(
  state: DexReplayState,
  event: Extract<DecodedDexEvent, { kind: "pool.Swapped" }>,
) {
  const p = event.payload;
  const pool = requirePool(state, p.pool_id);
  const meme =
    pool.memeReserve + (p.buy ? -p.meme_principal : p.meme_principal);
  const quote =
    pool.quoteReserve + (p.buy ? p.quote_principal : -p.quote_principal);
  if (
    meme !== p.meme_reserve ||
    quote !== p.quote_reserve ||
    pool.quoteFees + p.quote_fee !== p.fee_balance ||
    p.timestamp_seconds < pool.lastTradeSeconds
  )
    throw new Error("swap replay conservation mismatch");
  const growth = requireU128(
    "fee growth",
    pool.feeGrowthX64 + (p.quote_fee * DEX_X64) / pool.totalShares,
  );
  state.pools.set(p.pool_id, {
    ...pool,
    memeReserve: meme,
    quoteReserve: quote,
    quoteFees: p.fee_balance,
    feeGrowthX64: growth,
    volumeX32: p.volume_x32,
    lastTradeSeconds: p.timestamp_seconds,
  });
}

function applypoolLiquidityChanged(
  state: DexReplayState,
  event: Extract<DecodedDexEvent, { kind: "pool.LiquidityChanged" }>,
) {
  const p = event.payload;
  const pool = requirePool(state, p.pool_id);
  const position = requirePosition(state, p.position_id, p.pool_id);
  const sign = p.added ? 1n : -1n;
  const total = pool.totalShares + sign * p.shares;
  if (total !== p.total_shares || total < DEX_MINIMUM_SHARES)
    throw new Error("liquidity share mismatch");
  const accrued = previewDexPositionFees(pool, position);
  const shares = requireU128(
    "position shares",
    position.shares + sign * p.shares,
  );
  const meme = requireU64("memeReserve", pool.memeReserve + sign * p.meme);
  const quote = requireU64("quoteReserve", pool.quoteReserve + sign * p.quote);
  state.positions.set(p.position_id, {
    ...position,
    shares,
    feeCheckpointX64: pool.feeGrowthX64,
    feesOwed: accrued.quote,
    feeFractionX64: accrued.feeFractionX64,
  });
  state.pools.set(p.pool_id, {
    ...pool,
    totalShares: total,
    memeReserve: meme,
    quoteReserve: quote,
  });
}

function applypoolFeesClaimed(
  state: DexReplayState,
  event: Extract<DecodedDexEvent, { kind: "pool.FeesClaimed" }>,
) {
  const p = event.payload;
  const pool = requirePool(state, p.pool_id);
  const position = requirePosition(state, p.position_id, p.pool_id);
  const accrued = previewDexPositionFees(pool, position);
  if (accrued.quote !== p.quote || p.quote > pool.quoteFees)
    throw new Error("fee claim mismatch");
  state.positions.set(p.position_id, {
    ...position,
    feesOwed: 0n,
    feeCheckpointX64: pool.feeGrowthX64,
    feeFractionX64: accrued.feeFractionX64,
  });
  state.pools.set(p.pool_id, {
    ...pool,
    quoteFees: pool.quoteFees - p.quote,
  });
}

function applypoolPositionClosed(
  state: DexReplayState,
  event: Extract<DecodedDexEvent, { kind: "pool.PositionClosed" }>,
) {
  const p = event.payload;
  const position = requirePosition(state, p.position_id, p.pool_id);
  if (position.shares !== 0n || position.feesOwed !== 0n)
    throw new Error("nonempty position close");
  state.positions.delete(p.position_id);
}

function applypoolMaximumFeeChanged(
  state: DexReplayState,
  event: Extract<DecodedDexEvent, { kind: "pool.MaximumFeeChanged" }>,
) {
  const p = event.payload;
  const pool = requirePool(state, p.pool_id);
  if (pool.maxFeeBps !== p.previous_bps)
    throw new Error("fee policy history mismatch");
  state.pools.set(p.pool_id, { ...pool, maxFeeBps: p.maximum_bps });
}

function applypoolVersionActivated(
  state: DexReplayState,
  event: Extract<DecodedDexEvent, { kind: "pool.VersionActivated" }>,
) {
  const p = event.payload;
  if (
    p.version !== p.previous_version + 1n ||
    (state.version !== null && state.version !== p.previous_version)
  )
    throw new Error("generation history mismatch");
  state.version = p.version;
}

function applymigrationMigrated(
  state: DexReplayState,
  event: Extract<DecodedDexEvent, { kind: "migration.Migrated" }>,
) {
  const p = event.payload;
  requirePosition(state, p.position_id, p.pool_id);
  if (state.nativeVaults.has(p.vault_id))
    throw new Error("duplicate native vault");
  state.nativeVaults.set(p.vault_id, {
    poolId: p.pool_id,
    launchId: p.launch_id,
    positionId: p.position_id,
    protocolQuoteFees: 0n,
    creatorQuoteFees: 0n,
  });
}

function applymigrationFeesCollected(
  state: DexReplayState,
  event: Extract<DecodedDexEvent, { kind: "migration.FeesCollected" }>,
) {
  const p = event.payload;
  const vault = state.nativeVaults.get(p.vault_id);
  if (!vault) throw new Error("missing native vault history");
  if (
    p.protocol_delta + p.creator_delta !== p.quote ||
    vault.protocolQuoteFees + p.protocol_delta !== p.protocol_total ||
    vault.creatorQuoteFees + p.creator_delta !== p.creator_total
  )
    throw new Error("native fee split mismatch");
  state.nativeVaults.set(p.vault_id, {
    ...vault,
    protocolQuoteFees: p.protocol_total,
    creatorQuoteFees: p.creator_total,
  });
}

function applymigrationProtocolFeesClaimed(
  state: DexReplayState,
  event: Extract<
    DecodedDexEvent,
    { kind: "migration.CreatorFeesClaimed" | "migration.ProtocolFeesClaimed" }
  >,
) {
  const p = event.payload;
  const vault = state.nativeVaults.get(p.vault_id);
  if (!vault) throw new Error("missing native vault history");
  const field =
    event.kind === "migration.CreatorFeesClaimed"
      ? "creatorQuoteFees"
      : "protocolQuoteFees";
  if (p.quote !== vault[field]) throw new Error("native claim mismatch");
  state.nativeVaults.set(p.vault_id, { ...vault, [field]: 0n });
}
