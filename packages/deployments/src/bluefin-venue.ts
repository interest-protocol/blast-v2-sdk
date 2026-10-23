import {
  suiBalanceBcs,
  suiObjectIdBcs,
  suiUidBcs,
} from "@interest-protocol/blast-core/bcs";
import {
  BASIS_POINTS_DENOMINATOR,
  normalizePositiveU64,
  U64_MAX,
} from "@interest-protocol/blast-core/integers";
import type { SharedObjectReference } from "@interest-protocol/blast-core/sui";
import { sharedObjectReference } from "@interest-protocol/blast-core/sui";
import type { ExactPrice } from "@interest-protocol/blast-launchpad-sdk/market-data";
import {
  exactPrice,
  priceImpactBps,
} from "@interest-protocol/blast-launchpad-sdk/market-data";
import type { LpVaultState } from "@interest-protocol/blast-migrators-sdk/state";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
  SUI_FRAMEWORK_ADDRESS,
} from "@mysten/sui/utils";
import type { ProtocolAccess } from "./identity.ts";
import { deploymentFingerprint } from "./identity.ts";
import type { BlastDeployment, BlastNetwork } from "./types.ts";

/**
 * The Bluefin Spot adapter for migrated launches, the counterpart of the Cetus
 * adapter in `cetus-venue.ts`. Bluefin pools are keyed by their exact type
 * order and the migrators always create `Pool<Meme, Quote>`, so the Meme is
 * coin A. Units are atomic coin units; prices are exact Quote atoms per Meme
 * atom.
 */

/**
 * The bounds on a Bluefin pool's Q64.64 square-root price: integer-mate
 * `tick_math`'s sqrt prices at ticks -443,636 and 443,636, the `min_tick` and
 * `max_tick` of the Bluefin `GlobalConfig` in the contracts 442116a fork
 * snapshot. Contracts 442116a `constants::min_swap_sqrt_price` and
 * `max_swap_sqrt_price`, the lowest and highest limits a Bluefin swap accepts,
 * lie one inside them. The market-data vectors' smallest and largest
 * reachable prices use the same values.
 */
export const BLUEFIN_MIN_SQRT_PRICE_X64 = 4_295_048_016n;
export const BLUEFIN_MAX_SQRT_PRICE_X64 =
  79_226_673_515_401_279_992_447_579_055n;

const Q128 = 1n << 128n;

/**
 * The swap price limits: contracts 442116a `constants::min_swap_sqrt_price`
 * and `max_swap_sqrt_price`, the lowest and highest limits a Bluefin swap
 * accepts. An exact-input swap runs to them and relies on its minimum output.
 */
const MIN_SWAP_SQRT_PRICE_X64 = BLUEFIN_MIN_SQRT_PRICE_X64 + 1n;
const MAX_SWAP_SQRT_PRICE_X64 = BLUEFIN_MAX_SQRT_PRICE_X64 - 1n;

/**
 * A Bluefin pool's exact price at `sqrtPriceX64`, in Quote atoms per Meme
 * atom: `s² / 2^128`, since the Meme is coin A. No rounding; the market-data
 * vectors pin it with blast-infra.
 */
export function bluefinVenuePrice(sqrtPriceX64: bigint): ExactPrice {
  if (
    sqrtPriceX64 < BLUEFIN_MIN_SQRT_PRICE_X64 ||
    sqrtPriceX64 > BLUEFIN_MAX_SQRT_PRICE_X64
  ) {
    throw new RangeError(
      `sqrt price ${sqrtPriceX64} is outside Bluefin's reachable range`,
    );
  }
  return exactPrice(sqrtPriceX64 * sqrtPriceX64, Q128);
}

/** One Bluefin swap seen from the Meme, in atomic units. */
export type BluefinVenueTrade = {
  /** A buy puts Quote in; a sell puts Meme in. */
  side: "buy" | "sell";
  /** A buy's input (fee included), or a sell's output. */
  quoteAmount: bigint;
  /** A buy's output, or a sell's input (fee included). */
  memeAmount: bigint;
  /** The fee in Quote atoms: a buy's whole fee, else zero. */
  quoteFee: bigint;
  /** The fee in Meme atoms: a sell's whole fee, else zero. */
  memeFee: bigint;
  priceBefore: ExactPrice;
  priceAfter: ExactPrice;
};

/**
 * Maps one Bluefin swap to a Meme trade exactly as blast-infra does: the Meme
 * (coin A) going in is a sell, and the fee is in the input coin. Amounts are
 * the event fields unchanged; prices are exact.
 */
export function bluefinVenueTrade(swap: BluefinSwapTerms): BluefinVenueTrade {
  const buy = !swap.a2b;
  return {
    side: buy ? "buy" : "sell",
    quoteAmount: buy ? swap.amountIn : swap.amountOut,
    memeAmount: buy ? swap.amountOut : swap.amountIn,
    quoteFee: buy ? swap.fee : 0n,
    memeFee: buy ? 0n : swap.fee,
    priceBefore: bluefinVenuePrice(swap.beforeSqrtPrice),
    priceAfter: bluefinVenuePrice(swap.afterSqrtPrice),
  };
}

/** integer-mate `i32::I32`: a tick index as the two's-complement bits of an `i32`. */
const i32Bcs = bcs.struct("I32", { bits: bcs.u32() }).transform({
  input: (tick: number) => ({ bits: tick >>> 0 }),
  output: ({ bits }) => bits | 0,
});

/** BCS layout of Bluefin Spot `events::AssetSwap`, which `pool::swap` emits. */
export const bluefinSwapEventBcs = bcs.struct("AssetSwap", {
  pool_id: suiObjectIdBcs,
  a2b: bcs.bool(),
  amount_in: bcs.u64(),
  amount_out: bcs.u64(),
  pool_coin_a_amount: bcs.u64(),
  pool_coin_b_amount: bcs.u64(),
  fee: bcs.u64(),
  before_liquidity: bcs.u128(),
  after_liquidity: bcs.u128(),
  before_sqrt_price: bcs.u128(),
  after_sqrt_price: bcs.u128(),
  current_tick: i32Bcs,
  exceeded: bcs.bool(),
  sequence_number: bcs.u128(),
});

/** The swap terms of a Bluefin `events::AssetSwap` a trade needs. */
export type BluefinSwapTerms = {
  /** Coin A (the Meme) in, coin B (the Quote) out. */
  a2b: boolean;
  /** The input, fee included. */
  amountIn: bigint;
  amountOut: bigint;
  /** The LP fee plus the protocol fee, in the input coin. */
  fee: bigint;
  beforeSqrtPrice: bigint;
  afterSqrtPrice: bigint;
};

/** One decoded Bluefin `events::AssetSwap`. */
export type BluefinSwapEvent = BluefinSwapTerms & {
  pool: string;
  /** The pool's coin balances after the swap. */
  poolCoinAAmount: bigint;
  poolCoinBAmount: bigint;
  beforeLiquidity: bigint;
  afterLiquidity: bigint;
  /** The pool's tick after the swap. */
  currentTick: number;
  /** True when the pool could fill only part of the input. */
  exceeded: boolean;
  sequenceNumber: bigint;
};

/**
 * Decodes one Bluefin `events::AssetSwap`. Its type must be defined by the
 * Bluefin Spot original package `bluefinOriginalPackageId`, and the BCS must
 * match the layout exactly, trailing bytes included.
 */
export function decodeBluefinSwapEvent(
  event: { eventType: string; bcs: Uint8Array },
  bluefinOriginalPackageId: string,
): BluefinSwapEvent {
  const tag = parseStructTag(event.eventType);
  if (
    tag.address !== normalizeSuiAddress(bluefinOriginalPackageId) ||
    tag.module !== "events" ||
    tag.name !== "AssetSwap" ||
    tag.typeParams.length !== 0
  ) {
    throw new TypeError(
      `${event.eventType} is not a Bluefin events::AssetSwap`,
    );
  }
  const parsed = bluefinSwapEventBcs.parse(event.bcs);
  if (
    bluefinSwapEventBcs.serialize(parsed).toBytes().length !== event.bcs.length
  ) {
    throw new TypeError("AssetSwap BCS has trailing bytes");
  }
  return {
    pool: normalizeSuiObjectId(parsed.pool_id),
    a2b: parsed.a2b,
    amountIn: BigInt(parsed.amount_in),
    amountOut: BigInt(parsed.amount_out),
    poolCoinAAmount: BigInt(parsed.pool_coin_a_amount),
    poolCoinBAmount: BigInt(parsed.pool_coin_b_amount),
    fee: BigInt(parsed.fee),
    beforeLiquidity: BigInt(parsed.before_liquidity),
    afterLiquidity: BigInt(parsed.after_liquidity),
    beforeSqrtPrice: BigInt(parsed.before_sqrt_price),
    afterSqrtPrice: BigInt(parsed.after_sqrt_price),
    currentTick: parsed.current_tick,
    exceeded: parsed.exceeded,
    sequenceNumber: BigInt(parsed.sequence_number),
  };
}

const tableBcs = bcs.struct("Table", { id: suiUidBcs, size: bcs.u64() });

/**
 * BCS layout of Bluefin Spot `pool::Pool<CoinA, CoinB>`, whole, from the
 * pinned interface (`BluefinSpot` rev 91ce930, `pool`, `tick`, and `oracle`).
 */
export const bluefinPoolBcs = bcs.struct("Pool", {
  id: suiUidBcs,
  name: bcs.string(),
  coin_a: suiBalanceBcs,
  coin_b: suiBalanceBcs,
  fee_rate: bcs.u64(),
  protocol_fee_share: bcs.u64(),
  fee_growth_global_coin_a: bcs.u128(),
  fee_growth_global_coin_b: bcs.u128(),
  protocol_fee_coin_a: bcs.u64(),
  protocol_fee_coin_b: bcs.u64(),
  ticks_manager: bcs.struct("TickManager", {
    tick_spacing: bcs.u32(),
    ticks: tableBcs,
    bitmap: tableBcs,
  }),
  observations_manager: bcs.struct("ObservationManager", {
    observations: bcs.vector(
      bcs.struct("Observation", {
        timestamp: bcs.u64(),
        tick_cumulative: bcs.struct("I64", { bits: bcs.u64() }),
        seconds_per_liquidity_cumulative: bcs.u256(),
        initialized: bcs.bool(),
      }),
    ),
    observation_index: bcs.u64(),
    observation_cardinality: bcs.u64(),
    observation_cardinality_next: bcs.u64(),
  }),
  current_sqrt_price: bcs.u128(),
  current_tick_index: i32Bcs,
  liquidity: bcs.u128(),
  reward_infos: bcs.vector(
    bcs.struct("PoolRewardInfo", {
      reward_coin_symbol: bcs.string(),
      reward_coin_decimals: bcs.u8(),
      reward_coin_type: bcs.string(),
      last_update_time: bcs.u64(),
      ended_at_seconds: bcs.u64(),
      total_reward: bcs.u64(),
      total_reward_allocated: bcs.u64(),
      reward_per_seconds: bcs.u128(),
      reward_growth_global: bcs.u128(),
    }),
  ),
  is_paused: bcs.bool(),
  icon_url: bcs.string(),
  position_index: bcs.u128(),
  sequence_number: bcs.u128(),
});

/** A Bluefin pool's identity, coins in pool order, tier, and current state. */
export type BluefinPoolState = SharedObjectReference<true> & {
  /** The Bluefin Spot original package that defines the pool type. */
  originalPackageId: string;
  coinTypeA: string;
  coinTypeB: string;
  balanceA: bigint;
  balanceB: bigint;
  tickSpacing: number;
  /** Fee in millionths of the input. */
  feeRate: bigint;
  liquidity: bigint;
  currentSqrtPrice: bigint;
  /** A paused pool refuses every swap. */
  isPaused: boolean;
};

/** Decodes a shared Bluefin `pool::Pool` of the Bluefin Spot original package. */
export function decodeBluefinPoolObject(
  object: {
    objectId: string;
    initialSharedVersion: number | string;
    type: string;
    content: Uint8Array;
  },
  bluefinOriginalPackageId: string,
): BluefinPoolState {
  const tag = parseStructTag(object.type);
  const [coinA, coinB] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(bluefinOriginalPackageId) ||
    tag.module !== "pool" ||
    tag.name !== "Pool" ||
    tag.typeParams.length !== 2 ||
    typeof coinA !== "object" ||
    typeof coinB !== "object"
  ) {
    throw new TypeError(
      `object ${object.objectId} is not a Bluefin pool::Pool`,
    );
  }
  const parsed = bluefinPoolBcs.parse(object.content);
  if (
    bluefinPoolBcs.serialize(parsed).toBytes().length !== object.content.length
  ) {
    throw new TypeError(`Bluefin pool ${object.objectId} has trailing bytes`);
  }
  const objectId = normalizeSuiObjectId(object.objectId);
  if (normalizeSuiObjectId(parsed.id.id.bytes) !== objectId) {
    throw new TypeError(`Bluefin pool ${object.objectId} has a mismatched UID`);
  }
  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    mutable: true,
    originalPackageId: tag.address,
    coinTypeA: normalizeStructTag(coinA),
    coinTypeB: normalizeStructTag(coinB),
    balanceA: BigInt(parsed.coin_a.value),
    balanceB: BigInt(parsed.coin_b.value),
    tickSpacing: parsed.ticks_manager.tick_spacing,
    feeRate: BigInt(parsed.fee_rate),
    liquidity: BigInt(parsed.liquidity),
    currentSqrtPrice: BigInt(parsed.current_sqrt_price),
    isPaused: parsed.is_paused,
  };
}

/** Reads and decodes a shared Bluefin pool. */
export async function getBluefinPool(
  client: ClientWithCoreApi,
  objectId: string,
  bluefinOriginalPackageId: string,
): Promise<BluefinPoolState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`Bluefin pool ${object.objectId} is not shared`);
  }
  return decodeBluefinPoolObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      type: object.type,
      content: object.content,
    },
    bluefinOriginalPackageId,
  );
}

/** Why the adapter refuses a route, a quote, or a transaction. */
export type BluefinVenueRejection =
  | "deployment-mismatch"
  | "foreign-lineage"
  | "route-substitution"
  | "unsupported-tier"
  | "signing-disabled"
  | "venue-unavailable"
  | "expired-quote"
  | "invalid-quote"
  | "effects-mismatch";

export class BluefinVenueError extends Error {
  readonly code: BluefinVenueRejection;

  constructor(code: BluefinVenueRejection, message: string) {
    super(message);
    this.name = "BluefinVenueError";
    this.code = code;
  }
}

/**
 * A migrated launch's Bluefin route: the deployment it belongs to, the
 * Bluefin Spot lineage and config it calls, and the one pool its vault
 * recorded, `Pool<Meme, Quote>`.
 */
export type BluefinVenueRoute = Readonly<{
  venue: "bluefin";
  network: BlastNetwork;
  deploymentFingerprint: string;
  /** The Bluefin Spot revision calls target. */
  bluefinPackageId: string;
  /** The Bluefin Spot original package that defines pool and event types. */
  bluefinOriginalPackageId: string;
  bluefinConfig: SharedObjectReference<false>;
  vaultId: string;
  pool: SharedObjectReference<true>;
  /** Coin A. */
  memeType: string;
  /** Coin B. */
  quoteType: string;
  tickSpacing: number;
  feeRate: bigint;
}>;

/**
 * Resolves a migrated launch's recorded Bluefin route and fails closed unless
 * every link holds: the deployment records the Bluefin lineage and admits the
 * launch's tier; the launch migrated through this deployment's `bluefin`
 * adapter; the pool is a Bluefin `Pool<Meme, Quote>` of the launch's coins at
 * that tier; and it is the pool the launch's vault recorded. Read `vault` with
 * the deployment's migrators package (`getLpVault`) and `pool` with
 * `getBluefinPool`.
 */
export function resolveBluefinVenueRoute(options: {
  deployment: BlastDeployment;
  launch: {
    memeType: string;
    quoteType: string;
    migrationWitnessType: string;
    poolTickSpacing: number;
    poolFeeRate: bigint;
  };
  vault: Pick<LpVaultState, "objectId" | "poolId" | "memeType" | "quoteType">;
  pool: BluefinPoolState;
}): BluefinVenueRoute {
  const { deployment, launch, vault, pool } = options;
  const bluefin = deployment.packages.bluefinSpot;
  const bluefinConfig = deployment.sharedObjects.bluefin?.config;
  const migrators = deployment.packages.migrators;
  if (!bluefin || !bluefinConfig || !migrators) {
    throw new BluefinVenueError(
      "deployment-mismatch",
      "the deployment records no migrators or Bluefin lineage",
    );
  }
  const witness = parseStructTag(launch.migrationWitnessType);
  if (witness.address !== migrators.originalPackageId) {
    throw new BluefinVenueError(
      "foreign-lineage",
      "the launch migrated through another migrators package",
    );
  }
  if (witness.module !== "bluefin" || witness.name !== "Witness") {
    throw new BluefinVenueError(
      "route-substitution",
      `the launch recorded ${witness.module}::${witness.name}, not Bluefin`,
    );
  }
  if (
    !admitsBluefinTier(deployment, launch.poolTickSpacing, launch.poolFeeRate)
  ) {
    throw new BluefinVenueError(
      "unsupported-tier",
      `the deployment admits no Bluefin tier ${launch.poolTickSpacing}/${launch.poolFeeRate}`,
    );
  }
  if (pool.originalPackageId !== bluefin.originalPackageId) {
    throw new BluefinVenueError(
      "foreign-lineage",
      `pool ${pool.objectId} is not a pool of the deployment's Bluefin`,
    );
  }
  const memeType = normalizeStructTag(launch.memeType);
  const quoteType = normalizeStructTag(launch.quoteType);
  if (
    normalizeSuiObjectId(vault.poolId) !== pool.objectId ||
    normalizeStructTag(vault.memeType) !== memeType ||
    normalizeStructTag(vault.quoteType) !== quoteType ||
    pool.coinTypeA !== memeType ||
    pool.coinTypeB !== quoteType ||
    pool.tickSpacing !== launch.poolTickSpacing ||
    pool.feeRate !== launch.poolFeeRate
  ) {
    throw new BluefinVenueError(
      "route-substitution",
      `pool ${pool.objectId} is not the launch's recorded Bluefin pool`,
    );
  }
  return Object.freeze({
    venue: "bluefin",
    network: deployment.network,
    deploymentFingerprint: deploymentFingerprint(deployment),
    bluefinPackageId: bluefin.packageId,
    bluefinOriginalPackageId: bluefin.originalPackageId,
    bluefinConfig: sharedObjectReference(bluefinConfig, false),
    vaultId: normalizeSuiObjectId(vault.objectId),
    pool: sharedObjectReference(
      {
        objectId: pool.objectId,
        initialSharedVersion: pool.initialSharedVersion,
      },
      true,
    ),
    memeType,
    quoteType,
    tickSpacing: pool.tickSpacing,
    feeRate: pool.feeRate,
  });
}

function admitsBluefinTier(
  deployment: BlastDeployment,
  tickSpacing: number,
  feeRate: bigint,
): boolean {
  return deployment.routes.some(
    (route) =>
      route.venue === "bluefin" &&
      route.tiers.some(
        (tier) =>
          tier.tickSpacing === tickSpacing && BigInt(tier.feeRate) === feeRate,
      ),
  );
}

/** One exact-input swap a trader asks the adapter to quote. */
export type BluefinQuoteRequest = {
  /** A buy puts Quote in; a sell puts Meme in. */
  side: "buy" | "sell";
  /** The exact input in atoms, fee included. */
  amountIn: bigint;
  /** Accepted shortfall below the quoted output, in basis points under 10,000. */
  slippageBps: bigint;
  /** How long after the provider quoted the quote may be signed, in ms. */
  validForMs: bigint;
  sender: string;
  /** The sender's balances in atoms, carried for review. */
  balances: { quote: bigint; meme: bigint };
};

/**
 * One exact-input quote from any Bluefin quote provider (a devInspect of
 * `pool::calculate_swap_results`, the Bluefin SDK, or a service), in Bluefin
 * terms.
 */
export type BluefinProviderQuote = {
  poolId: string;
  a2b: boolean;
  byAmountIn: boolean;
  /** The input the swap consumes, fee included. */
  amountIn: bigint;
  amountOut: bigint;
  /** The fee, in the input coin. */
  feeAmount: bigint;
  /** The pool's price after the swap; null when the provider omits it. */
  afterSqrtPrice: bigint | null;
  /** True when the pool cannot fill the whole input. */
  isExceed: boolean;
  /** When the provider quoted, in ms since the Unix epoch. */
  quotedAtMs: bigint;
};

/** Fetches one provider quote; the transport is the caller's choice. */
export type BluefinQuoteTransport = (request: {
  route: BluefinVenueRoute;
  a2b: boolean;
  byAmountIn: true;
  amount: bigint;
}) => Promise<BluefinProviderQuote>;

/** A quote in exact atoms, ready for review and for `buildBluefinSwapTransaction`. */
export type BluefinVenueQuote = Readonly<{
  venue: "bluefin";
  network: BlastNetwork;
  deploymentFingerprint: string;
  route: BluefinVenueRoute;
  side: "buy" | "sell";
  /** True for a sell: the Meme is coin A. */
  a2b: boolean;
  inputType: string;
  outputType: string;
  /** Exact input, fee included; the transaction spends all of it or aborts. */
  amountIn: bigint;
  amountOut: bigint;
  /**
   * `floor(amountOut * (10,000 - slippageBps) / 10,000)` output atoms, at
   * least 1; the transaction aborts below it. Rounding down never makes the
   * bound stricter than the trader's slippage.
   */
  minimumOut: bigint;
  slippageBps: bigint;
  /** The fee in the input coin, included in `amountIn`. */
  feeAmount: bigint;
  priceBefore: ExactPrice;
  priceAfter: ExactPrice | null;
  /** `floor(|after - before| * 10,000 / before)` of the exact prices, in basis points. */
  priceImpactBps: bigint | null;
  quotedAtMs: bigint;
  /** `quotedAtMs + validForMs`; the builder refuses the quote from then on. */
  expiresAtMs: bigint;
  sender: string;
  balances: Readonly<{ quote: bigint; meme: bigint }>;
}>;

/** Asks `transport` for the route's exact-input quote and normalizes it. */
export async function quoteBluefinSwap(options: {
  route: BluefinVenueRoute;
  pool: BluefinPoolState;
  request: BluefinQuoteRequest;
  transport: BluefinQuoteTransport;
}): Promise<BluefinVenueQuote> {
  const { route, request } = options;
  const providerQuote = await options.transport({
    route,
    a2b: request.side === "sell",
    byAmountIn: true,
    amount: request.amountIn,
  });
  return normalizeBluefinQuote({ ...options, providerQuote });
}

/**
 * Checks a provider quote against the route, the current `pool`, and the
 * request, and states it in exact atoms. The provider must quote the route's
 * unpaused pool, in the request's direction, for exactly the requested input,
 * filled.
 */
export function normalizeBluefinQuote(options: {
  route: BluefinVenueRoute;
  pool: BluefinPoolState;
  request: BluefinQuoteRequest;
  providerQuote: BluefinProviderQuote;
}): BluefinVenueQuote {
  const { route, pool, request, providerQuote: provided } = options;
  requireProviderQuote(options);
  const buy = request.side === "buy";
  const minimumOut =
    (provided.amountOut * (BASIS_POINTS_DENOMINATOR - request.slippageBps)) /
    BASIS_POINTS_DENOMINATOR;
  if (minimumOut === 0n) {
    throw new BluefinVenueError(
      "invalid-quote",
      "the minimum output rounds to zero",
    );
  }
  const priceBefore = bluefinVenuePrice(pool.currentSqrtPrice);
  const priceAfter =
    provided.afterSqrtPrice === null
      ? null
      : bluefinVenuePrice(provided.afterSqrtPrice);
  return Object.freeze({
    venue: "bluefin",
    network: route.network,
    deploymentFingerprint: route.deploymentFingerprint,
    route,
    side: request.side,
    a2b: !buy,
    inputType: buy ? route.quoteType : route.memeType,
    outputType: buy ? route.memeType : route.quoteType,
    amountIn: request.amountIn,
    amountOut: provided.amountOut,
    minimumOut,
    slippageBps: request.slippageBps,
    feeAmount: provided.feeAmount,
    priceBefore,
    priceAfter,
    priceImpactBps:
      priceAfter === null ? null : priceImpactBps(priceBefore, priceAfter),
    quotedAtMs: provided.quotedAtMs,
    expiresAtMs: provided.quotedAtMs + request.validForMs,
    sender: normalizeSuiAddress(request.sender),
    balances: Object.freeze({ ...request.balances }),
  });
}

function requireProviderQuote(
  options: Parameters<typeof normalizeBluefinQuote>[0],
): void {
  const { route, pool, request, providerQuote: provided } = options;
  if (
    normalizeSuiObjectId(provided.poolId) !== route.pool.objectId ||
    pool.objectId !== route.pool.objectId
  ) {
    throw new BluefinVenueError(
      "route-substitution",
      "the quote is not for the route's pool",
    );
  }
  const invalid = (message: string) =>
    new BluefinVenueError("invalid-quote", message);
  if (pool.isPaused) throw invalid("the pool is paused");
  if (
    provided.a2b !== (request.side === "sell") ||
    !provided.byAmountIn ||
    provided.isExceed
  ) {
    throw invalid("the provider did not quote the requested exact-input swap");
  }
  if (!isU64(request.amountIn) || request.amountIn === 0n) {
    throw invalid("amountIn must be a positive u64");
  }
  if (provided.amountIn !== request.amountIn) {
    throw invalid("the provider quoted a different input");
  }
  if (!isU64(provided.amountOut) || provided.feeAmount > provided.amountIn) {
    throw invalid("the provider quote's amounts are impossible");
  }
  if (
    request.slippageBps < 0n ||
    request.slippageBps >= BASIS_POINTS_DENOMINATOR
  ) {
    throw invalid("slippageBps must be below 10,000");
  }
  if (request.validForMs <= 0n) throw invalid("validForMs must be positive");
  const inputBalance =
    request.side === "buy" ? request.balances.quote : request.balances.meme;
  if (inputBalance < request.amountIn) {
    throw invalid("the sender's balance does not cover amountIn");
  }
}

/**
 * Builds the quoted swap as one Bluefin `pool::swap` in the route's pool,
 * after checking, in order: signing is enabled and Bluefin is available
 * (`access.venues.bluefin`); the access, route, and quote name one deployment;
 * the route matches the deployment's Bluefin lineage and admitted tiers; the
 * quote is for this route; it has not expired at `nowMs` and is not dated
 * after it; and its amounts are consistent. The swap takes `minimumOut` as its
 * `amount_limit`, so Bluefin aborts below it; the transaction also aborts
 * unless the swap spent exactly `amountIn`, and sends the output to the
 * quote's sender. Simulate it with the Core API before signing and pass the
 * result to `reconcileBluefinSwap`.
 */
export function buildBluefinSwapTransaction(options: {
  access: ProtocolAccess;
  route: BluefinVenueRoute;
  quote: BluefinVenueQuote;
  nowMs: bigint;
}): Transaction {
  const { route, quote } = options;
  requireBuildable(options);

  // The route fixes the coin order: the Meme (coin A) goes in on a sell.
  const { a2b } = quote;
  const [inputType, outputType] = a2b
    ? [route.memeType, route.quoteType]
    : [route.quoteType, route.memeType];
  const framework = (name: string) => `${SUI_FRAMEWORK_ADDRESS}::${name}`;

  const tx = new Transaction();
  tx.setSender(quote.sender);
  const input = tx.moveCall({
    target: framework("coin::into_balance"),
    typeArguments: [inputType],
    arguments: [tx.coin({ type: inputType, balance: quote.amountIn })],
  });
  const nothing = tx.moveCall({
    target: framework("balance::zero"),
    typeArguments: [outputType],
  });
  const [balanceA, balanceB] = tx.moveCall({
    target: `${route.bluefinPackageId}::pool::swap`,
    typeArguments: [route.memeType, route.quoteType],
    arguments: [
      tx.object.clock(),
      tx.sharedObjectRef(route.bluefinConfig),
      tx.sharedObjectRef(route.pool),
      a2b ? input : nothing,
      a2b ? nothing : input,
      tx.pure.bool(a2b),
      tx.pure.bool(true),
      tx.pure.u64(quote.amountIn),
      tx.pure.u64(quote.minimumOut),
      tx.pure.u128(a2b ? MIN_SWAP_SQRT_PRICE_X64 : MAX_SWAP_SQRT_PRICE_X64),
    ],
  });
  // Aborts unless the pool took the whole input.
  tx.moveCall({
    target: framework("balance::destroy_zero"),
    typeArguments: [inputType],
    arguments: [a2b ? balanceA! : balanceB!],
  });
  const output = tx.moveCall({
    target: framework("coin::from_balance"),
    typeArguments: [outputType],
    arguments: [a2b ? balanceB! : balanceA!],
  });
  tx.transferObjects([output], quote.sender);
  return tx;
}

/** The exact trade facts of one completed Bluefin swap, for projections and execution. */
export type BluefinSwapFacts = Readonly<
  BluefinVenueTrade & {
    venue: "bluefin";
    digest: string;
    eventIndex: number;
    sender: string;
    pool: string;
    memeType: string;
    quoteType: string;
  }
>;

/**
 * Reconciles a completed (executed or simulated) transaction, read with
 * `include: { events: true }`, against the quote it was built from. It must
 * have succeeded and hold exactly one swap of the route's Bluefin lineage in
 * the route's pool: an `AssetSwap` (a `FlashSwap` there is another swap), from
 * the quote's sender, in its direction, spending exactly `amountIn` and
 * returning at least `minimumOut`. The event's amounts are the facts; the
 * quote never overrides them.
 */
export function reconcileBluefinSwap(
  transaction: Pick<
    SuiClientTypes.Transaction<{ events: true }>,
    "digest" | "status" | "events"
  >,
  quote: BluefinVenueQuote,
): BluefinSwapFacts {
  const mismatch = (message: string) =>
    new BluefinVenueError("effects-mismatch", message);
  if (!transaction.status.success) {
    throw mismatch(`transaction ${transaction.digest} did not succeed`);
  }
  const { route } = quote;
  const swapType = (name: string) =>
    normalizeStructTag(`${route.bluefinOriginalPackageId}::events::${name}`);
  const swaps = transaction.events.flatMap((event, eventIndex) => {
    const type = normalizeStructTag(event.eventType);
    if (type !== swapType("AssetSwap") && type !== swapType("FlashSwap")) {
      return [];
    }
    // Both events open with the pool's ID.
    const pool = suiObjectIdBcs.parse(event.bcs.subarray(0, 32));
    return normalizeSuiObjectId(pool) === route.pool.objectId
      ? [{ event, eventIndex }]
      : [];
  });
  if (swaps.length !== 1) {
    throw mismatch(
      `transaction ${transaction.digest} holds ${swaps.length} swaps in the route's pool`,
    );
  }
  const [{ event, eventIndex }] = swaps as [(typeof swaps)[number]];
  if (normalizeStructTag(event.eventType) !== swapType("AssetSwap")) {
    throw mismatch(`transaction ${transaction.digest} is not a pool::swap`);
  }
  const swap = decodeBluefinSwapEvent(event, route.bluefinOriginalPackageId);
  const sender = normalizeSuiAddress(event.sender);
  if (
    sender !== quote.sender ||
    swap.a2b !== quote.a2b ||
    swap.amountIn !== quote.amountIn ||
    swap.amountOut < quote.minimumOut
  ) {
    throw mismatch(`transaction ${transaction.digest} is not the quoted swap`);
  }
  return Object.freeze({
    venue: "bluefin",
    digest: transaction.digest,
    eventIndex,
    sender,
    pool: swap.pool,
    memeType: route.memeType,
    quoteType: route.quoteType,
    ...bluefinVenueTrade(swap),
  });
}

/** The builder's pre-signing checks, in order. */
function requireBuildable(
  options: Parameters<typeof buildBluefinSwapTransaction>[0],
): void {
  const { access, route, quote } = options;
  if (access.signing !== "enabled") {
    throw new BluefinVenueError(
      "signing-disabled",
      "protocol signing is disabled for this deployment",
    );
  }
  if (!access.venues.bluefin.available) {
    throw new BluefinVenueError(
      "venue-unavailable",
      `Bluefin is unavailable: ${access.venues.bluefin.reasons.map(({ code }) => code).join(", ")}`,
    );
  }
  const { deployment, fingerprint } = access;
  if (
    route.deploymentFingerprint !== fingerprint ||
    quote.deploymentFingerprint !== fingerprint ||
    route.network !== deployment.network ||
    quote.network !== deployment.network
  ) {
    throw new BluefinVenueError(
      "deployment-mismatch",
      "the route or quote belongs to another deployment",
    );
  }
  const bluefin = deployment.packages.bluefinSpot;
  const config = deployment.sharedObjects.bluefin?.config;
  if (
    bluefin?.packageId !== route.bluefinPackageId ||
    bluefin.originalPackageId !== route.bluefinOriginalPackageId ||
    config?.objectId !== route.bluefinConfig.objectId ||
    String(config.initialSharedVersion) !==
      String(route.bluefinConfig.initialSharedVersion)
  ) {
    throw new BluefinVenueError(
      "foreign-lineage",
      "the route does not call the deployment's Bluefin",
    );
  }
  if (!admitsBluefinTier(deployment, route.tickSpacing, route.feeRate)) {
    throw new BluefinVenueError(
      "unsupported-tier",
      `the deployment admits no Bluefin tier ${route.tickSpacing}/${route.feeRate}`,
    );
  }
  if (!sameRoute(route, quote.route) || quote.a2b !== (quote.side === "sell")) {
    throw new BluefinVenueError(
      "route-substitution",
      "the quote is not for the recorded route",
    );
  }
  if (options.nowMs >= quote.expiresAtMs) {
    throw new BluefinVenueError("expired-quote", "the quote has expired");
  }
  if (quote.quotedAtMs > options.nowMs) {
    throw new BluefinVenueError(
      "invalid-quote",
      "the quote is dated after nowMs, which would stretch its validity",
    );
  }
  if (
    !isU64(quote.amountIn) ||
    quote.amountIn === 0n ||
    !isU64(quote.amountOut) ||
    quote.minimumOut < 1n ||
    quote.minimumOut > quote.amountOut
  ) {
    throw new BluefinVenueError(
      "invalid-quote",
      "the quote's amounts are inconsistent",
    );
  }
}

function sameRoute(left: BluefinVenueRoute, right: BluefinVenueRoute): boolean {
  return (
    left.venue === right.venue &&
    left.network === right.network &&
    left.deploymentFingerprint === right.deploymentFingerprint &&
    left.bluefinPackageId === right.bluefinPackageId &&
    left.bluefinOriginalPackageId === right.bluefinOriginalPackageId &&
    left.bluefinConfig.objectId === right.bluefinConfig.objectId &&
    left.vaultId === right.vaultId &&
    left.pool.objectId === right.pool.objectId &&
    String(left.pool.initialSharedVersion) ===
      String(right.pool.initialSharedVersion) &&
    left.memeType === right.memeType &&
    left.quoteType === right.quoteType &&
    left.tickSpacing === right.tickSpacing &&
    left.feeRate === right.feeRate
  );
}

function isU64(value: bigint): boolean {
  return value >= 0n && value <= U64_MAX;
}
