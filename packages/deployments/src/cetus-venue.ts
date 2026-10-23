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
 * The Cetus CLMM adapter for migrated launches. Cetus and Bluefin Spot
 * (`bluefin-venue.ts`, the same contract shape) are the two post-migration
 * venues this SDK trades through; a launch trades only on the venue it
 * recorded. Units are atomic coin units; prices are exact Quote atoms per Meme
 * atom.
 */

/**
 * Cetus CLMM `tick_math::MIN_SQRT_PRICE_X64` and `MAX_SQRT_PRICE_X64`, the
 * bounds on a pool's Q64.64 square-root price. Source: the `tick_math` module
 * constants of Cetus CLMM revision 15 (package `0x260693ec…f084`, original
 * `0x1eabed72…b2fb`), whose bytecode contracts 442116a pin in
 * `sui/launchpad/ptb_tests/fork/snapshot/packages/`. The market-data vectors'
 * `min_sqrt_price_x64` and `max_sqrt_price_x64` parameters are the same values.
 */
export const CETUS_MIN_SQRT_PRICE_X64 = 4_295_048_016n;
export const CETUS_MAX_SQRT_PRICE_X64 = 79_226_673_515_401_279_992_447_579_055n;

const Q128 = 1n << 128n;

/**
 * A Cetus pool's exact price at `sqrtPriceX64`, in Quote atoms per Meme atom:
 * `s² / 2^128` when the Meme is coin A, `2^128 / s²` when it is coin B. No
 * rounding; the market-data vectors pin it with blast-infra.
 */
export function cetusVenuePrice(
  sqrtPriceX64: bigint,
  memeIsCoinA: boolean,
): ExactPrice {
  if (
    sqrtPriceX64 < CETUS_MIN_SQRT_PRICE_X64 ||
    sqrtPriceX64 > CETUS_MAX_SQRT_PRICE_X64
  ) {
    throw new RangeError(
      `sqrt price ${sqrtPriceX64} is outside Cetus's reachable range`,
    );
  }
  const squared = sqrtPriceX64 * sqrtPriceX64;
  return memeIsCoinA ? exactPrice(squared, Q128) : exactPrice(Q128, squared);
}

/** The swap terms of a Cetus `pool::SwapEvent` a trade needs. */
export type CetusSwapTerms = {
  /** Coin A in, coin B out. */
  atob: boolean;
  /** The input, fee included. */
  amountIn: bigint;
  amountOut: bigint;
  /** The whole fee, in the input coin. */
  feeAmount: bigint;
  beforeSqrtPrice: bigint;
  afterSqrtPrice: bigint;
};

/** One Cetus swap seen from the Meme, in atomic units. */
export type CetusVenueTrade = {
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
 * Maps one Cetus swap to a Meme trade exactly as blast-infra does: the Meme
 * going in is a sell, and the fee is in the input coin. Amounts are the event
 * fields unchanged; prices are exact.
 */
export function cetusVenueTrade(
  swap: CetusSwapTerms,
  memeIsCoinA: boolean,
): CetusVenueTrade {
  const side = swap.atob === memeIsCoinA ? "sell" : "buy";
  const buy = side === "buy";
  return {
    side,
    quoteAmount: buy ? swap.amountIn : swap.amountOut,
    memeAmount: buy ? swap.amountOut : swap.amountIn,
    quoteFee: buy ? swap.feeAmount : 0n,
    memeFee: buy ? 0n : swap.feeAmount,
    priceBefore: cetusVenuePrice(swap.beforeSqrtPrice, memeIsCoinA),
    priceAfter: cetusVenuePrice(swap.afterSqrtPrice, memeIsCoinA),
  };
}

/** BCS layout of Cetus CLMM v15 `pool::SwapEvent`. */
export const cetusSwapEventBcs = bcs.struct("SwapEvent", {
  atob: bcs.bool(),
  pool: suiObjectIdBcs,
  partner: suiObjectIdBcs,
  amount_in: bcs.u64(),
  amount_out: bcs.u64(),
  ref_amount: bcs.u64(),
  fee_amount: bcs.u64(),
  vault_a_amount: bcs.u64(),
  vault_b_amount: bcs.u64(),
  before_sqrt_price: bcs.u128(),
  after_sqrt_price: bcs.u128(),
  steps: bcs.u64(),
});

/** One decoded Cetus `pool::SwapEvent`; every path of a Cetus swap emits one. */
export type CetusSwapEvent = CetusSwapTerms & {
  pool: string;
  /** The partner paid `refAmount`; `0x0` for none. */
  partner: string;
  /** The partner's referral share of `feeAmount`. */
  refAmount: bigint;
  /** The pool's coin balances after the swap. */
  vaultAAmount: bigint;
  vaultBAmount: bigint;
  steps: bigint;
};

/**
 * Decodes one Cetus `pool::SwapEvent`. Its type must be defined by the Cetus
 * CLMM original package `cetusOriginalPackageId`, and the BCS must match the
 * layout exactly, trailing bytes included.
 */
export function decodeCetusSwapEvent(
  event: { eventType: string; bcs: Uint8Array },
  cetusOriginalPackageId: string,
): CetusSwapEvent {
  const tag = parseStructTag(event.eventType);
  if (
    tag.address !== normalizeSuiAddress(cetusOriginalPackageId) ||
    tag.module !== "pool" ||
    tag.name !== "SwapEvent" ||
    tag.typeParams.length !== 0
  ) {
    throw new TypeError(`${event.eventType} is not a Cetus pool::SwapEvent`);
  }
  const parsed = cetusSwapEventBcs.parse(event.bcs);
  if (
    cetusSwapEventBcs.serialize(parsed).toBytes().length !== event.bcs.length
  ) {
    throw new TypeError("SwapEvent BCS has trailing bytes");
  }
  return {
    atob: parsed.atob,
    pool: normalizeSuiObjectId(parsed.pool),
    partner: normalizeSuiObjectId(parsed.partner),
    amountIn: BigInt(parsed.amount_in),
    amountOut: BigInt(parsed.amount_out),
    refAmount: BigInt(parsed.ref_amount),
    feeAmount: BigInt(parsed.fee_amount),
    vaultAAmount: BigInt(parsed.vault_a_amount),
    vaultBAmount: BigInt(parsed.vault_b_amount),
    beforeSqrtPrice: BigInt(parsed.before_sqrt_price),
    afterSqrtPrice: BigInt(parsed.after_sqrt_price),
    steps: BigInt(parsed.steps),
  };
}

/**
 * BCS prefix of Cetus CLMM v15 `pool::Pool<CoinA, CoinB>`, the fields this
 * adapter reads. Later fields (ticks, rewarders, positions) are not decoded;
 * blast-infra reads the same prefix.
 */
export const cetusPoolPrefixBcs = bcs.struct("Pool", {
  id: suiUidBcs,
  coin_a: suiBalanceBcs,
  coin_b: suiBalanceBcs,
  tick_spacing: bcs.u32(),
  fee_rate: bcs.u64(),
  liquidity: bcs.u128(),
  current_sqrt_price: bcs.u128(),
});

/** A Cetus pool's identity, coins in Cetus order, tier, and current state. */
export type CetusPoolState = SharedObjectReference<true> & {
  /** The Cetus CLMM original package that defines the pool type. */
  originalPackageId: string;
  coinTypeA: string;
  coinTypeB: string;
  balanceA: bigint;
  balanceB: bigint;
  tickSpacing: number;
  /** Fee in millionths of the input, fixed by the tick spacing. */
  feeRate: bigint;
  liquidity: bigint;
  currentSqrtPrice: bigint;
};

/** Decodes a shared Cetus `pool::Pool` of the Cetus CLMM original package. */
export function decodeCetusPoolObject(
  object: {
    objectId: string;
    initialSharedVersion: number | string;
    type: string;
    content: Uint8Array;
  },
  cetusOriginalPackageId: string,
): CetusPoolState {
  const tag = parseStructTag(object.type);
  const [coinA, coinB] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(cetusOriginalPackageId) ||
    tag.module !== "pool" ||
    tag.name !== "Pool" ||
    tag.typeParams.length !== 2 ||
    typeof coinA !== "object" ||
    typeof coinB !== "object"
  ) {
    throw new TypeError(`object ${object.objectId} is not a Cetus pool::Pool`);
  }
  const parsed = cetusPoolPrefixBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (normalizeSuiObjectId(parsed.id.id.bytes) !== objectId) {
    throw new TypeError(`Cetus pool ${object.objectId} has a mismatched UID`);
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
    tickSpacing: parsed.tick_spacing,
    feeRate: BigInt(parsed.fee_rate),
    liquidity: BigInt(parsed.liquidity),
    currentSqrtPrice: BigInt(parsed.current_sqrt_price),
  };
}

/** Reads and decodes a shared Cetus pool. */
export async function getCetusPool(
  client: ClientWithCoreApi,
  objectId: string,
  cetusOriginalPackageId: string,
): Promise<CetusPoolState> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`Cetus pool ${object.objectId} is not shared`);
  }
  return decodeCetusPoolObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      type: object.type,
      content: object.content,
    },
    cetusOriginalPackageId,
  );
}

/** Why the adapter refuses a route, a quote, or a transaction. */
export type CetusVenueRejection =
  | "deployment-mismatch"
  | "foreign-lineage"
  | "route-substitution"
  | "unsupported-tier"
  | "signing-disabled"
  | "venue-unavailable"
  | "expired-quote"
  | "invalid-quote"
  | "effects-mismatch";

export class CetusVenueError extends Error {
  readonly code: CetusVenueRejection;

  constructor(code: CetusVenueRejection, message: string) {
    super(message);
    this.name = "CetusVenueError";
    this.code = code;
  }
}

/**
 * A migrated launch's Cetus route: the deployment it belongs to, the Cetus
 * lineage and config it calls, and the one pool its vault recorded, with the
 * coins in Cetus order.
 */
export type CetusVenueRoute = Readonly<{
  venue: "cetus";
  network: BlastNetwork;
  deploymentFingerprint: string;
  /** The Cetus CLMM revision calls target. */
  cetusPackageId: string;
  /** The Cetus CLMM original package that defines pool and event types. */
  cetusOriginalPackageId: string;
  cetusConfig: SharedObjectReference<false>;
  vaultId: string;
  pool: SharedObjectReference<true>;
  memeType: string;
  quoteType: string;
  coinTypeA: string;
  coinTypeB: string;
  memeIsCoinA: boolean;
  tickSpacing: number;
  feeRate: bigint;
}>;

/**
 * Resolves a migrated launch's recorded Cetus route and fails closed unless
 * every link holds: the deployment records the Cetus lineage and admits the
 * launch's tier; the launch migrated through this deployment's `cetus`
 * adapter; the pool is a Cetus pool of the launch's coins at that tier; and it
 * is the pool the launch's vault recorded. Read `vault` with the deployment's
 * migrators package (`getLpVault`) and `pool` with `getCetusPool`.
 */
export function resolveCetusVenueRoute(options: {
  deployment: BlastDeployment;
  launch: {
    memeType: string;
    quoteType: string;
    migrationWitnessType: string;
    poolTickSpacing: number;
    poolFeeRate: bigint;
  };
  vault: Pick<LpVaultState, "objectId" | "poolId" | "memeType" | "quoteType">;
  pool: CetusPoolState;
}): CetusVenueRoute {
  const { deployment, launch, vault, pool } = options;
  const cetus = deployment.packages.cetusClmm;
  const cetusConfig = deployment.sharedObjects.cetus?.config;
  const migrators = deployment.packages.migrators;
  if (!cetus || !cetusConfig || !migrators) {
    throw new CetusVenueError(
      "deployment-mismatch",
      "the deployment records no migrators or Cetus lineage",
    );
  }
  const witness = parseStructTag(launch.migrationWitnessType);
  if (witness.address !== migrators.originalPackageId) {
    throw new CetusVenueError(
      "foreign-lineage",
      "the launch migrated through another migrators package",
    );
  }
  if (witness.module !== "cetus" || witness.name !== "Witness") {
    throw new CetusVenueError(
      "route-substitution",
      `the launch recorded ${witness.module}::${witness.name}, not Cetus`,
    );
  }
  if (
    !admitsCetusTier(deployment, launch.poolTickSpacing, launch.poolFeeRate)
  ) {
    throw new CetusVenueError(
      "unsupported-tier",
      `the deployment admits no Cetus tier ${launch.poolTickSpacing}/${launch.poolFeeRate}`,
    );
  }
  if (pool.originalPackageId !== cetus.originalPackageId) {
    throw new CetusVenueError(
      "foreign-lineage",
      `pool ${pool.objectId} is not a pool of the deployment's Cetus`,
    );
  }
  const memeType = normalizeStructTag(launch.memeType);
  const quoteType = normalizeStructTag(launch.quoteType);
  const memeIsCoinA =
    pool.coinTypeA === memeType && pool.coinTypeB === quoteType;
  const coinsMatch =
    memeIsCoinA ||
    (pool.coinTypeA === quoteType && pool.coinTypeB === memeType);
  if (
    normalizeSuiObjectId(vault.poolId) !== pool.objectId ||
    normalizeStructTag(vault.memeType) !== memeType ||
    normalizeStructTag(vault.quoteType) !== quoteType ||
    !coinsMatch ||
    pool.tickSpacing !== launch.poolTickSpacing ||
    pool.feeRate !== launch.poolFeeRate
  ) {
    throw new CetusVenueError(
      "route-substitution",
      `pool ${pool.objectId} is not the launch's recorded Cetus pool`,
    );
  }
  return Object.freeze({
    venue: "cetus",
    network: deployment.network,
    deploymentFingerprint: deploymentFingerprint(deployment),
    cetusPackageId: cetus.packageId,
    cetusOriginalPackageId: cetus.originalPackageId,
    cetusConfig: sharedObjectReference(cetusConfig, false),
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
    coinTypeA: pool.coinTypeA,
    coinTypeB: pool.coinTypeB,
    memeIsCoinA,
    tickSpacing: pool.tickSpacing,
    feeRate: pool.feeRate,
  });
}

function admitsCetusTier(
  deployment: BlastDeployment,
  tickSpacing: number,
  feeRate: bigint,
): boolean {
  return deployment.routes.some(
    (route) =>
      route.venue === "cetus" &&
      route.tiers.some(
        (tier) =>
          tier.tickSpacing === tickSpacing && BigInt(tier.feeRate) === feeRate,
      ),
  );
}

/** One exact-input swap a trader asks the adapter to quote. */
export type CetusQuoteRequest = {
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
 * One exact-input quote from any Cetus quote provider (a devInspect of
 * `pool::calculate_swap_result`, the Cetus SDK, or a service), in Cetus terms.
 */
export type CetusProviderQuote = {
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
export type CetusQuoteTransport = (request: {
  route: CetusVenueRoute;
  a2b: boolean;
  byAmountIn: true;
  amount: bigint;
}) => Promise<CetusProviderQuote>;

/** A quote in exact atoms, ready for review and for `buildCetusSwapTransaction`. */
export type CetusVenueQuote = Readonly<{
  venue: "cetus";
  network: BlastNetwork;
  deploymentFingerprint: string;
  route: CetusVenueRoute;
  side: "buy" | "sell";
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
export async function quoteCetusSwap(options: {
  route: CetusVenueRoute;
  pool: CetusPoolState;
  request: CetusQuoteRequest;
  transport: CetusQuoteTransport;
}): Promise<CetusVenueQuote> {
  const { route, request } = options;
  const providerQuote = await options.transport({
    route,
    a2b: swapA2b(route, request.side),
    byAmountIn: true,
    amount: request.amountIn,
  });
  return normalizeCetusQuote({ ...options, providerQuote });
}

/**
 * Checks a provider quote against the route, the current `pool`, and the
 * request, and states it in exact atoms. The provider must quote the route's
 * pool, in the request's direction, for exactly the requested input, filled.
 */
export function normalizeCetusQuote(options: {
  route: CetusVenueRoute;
  pool: CetusPoolState;
  request: CetusQuoteRequest;
  providerQuote: CetusProviderQuote;
}): CetusVenueQuote {
  const { route, pool, request, providerQuote: provided } = options;
  const a2b = swapA2b(route, request.side);
  requireProviderQuote(options, a2b);
  const buy = request.side === "buy";
  const minimumOut =
    (provided.amountOut * (BASIS_POINTS_DENOMINATOR - request.slippageBps)) /
    BASIS_POINTS_DENOMINATOR;
  if (minimumOut === 0n) {
    throw new CetusVenueError(
      "invalid-quote",
      "the minimum output rounds to zero",
    );
  }
  const priceBefore = cetusVenuePrice(pool.currentSqrtPrice, route.memeIsCoinA);
  const priceAfter =
    provided.afterSqrtPrice === null
      ? null
      : cetusVenuePrice(provided.afterSqrtPrice, route.memeIsCoinA);
  return Object.freeze({
    venue: "cetus",
    network: route.network,
    deploymentFingerprint: route.deploymentFingerprint,
    route,
    side: request.side,
    a2b,
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
  options: Parameters<typeof normalizeCetusQuote>[0],
  a2b: boolean,
): void {
  const { route, pool, request, providerQuote: provided } = options;
  if (
    normalizeSuiObjectId(provided.poolId) !== route.pool.objectId ||
    pool.objectId !== route.pool.objectId
  ) {
    throw new CetusVenueError(
      "route-substitution",
      "the quote is not for the route's pool",
    );
  }
  const invalid = (message: string) =>
    new CetusVenueError("invalid-quote", message);
  if (provided.a2b !== a2b || !provided.byAmountIn || provided.isExceed) {
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
 * Builds the quoted swap as one Cetus exact-input flash swap in the route's
 * pool, after checking, in order: signing is enabled and Cetus is available
 * (`access.venues.cetus`); the access, route, and
 * quote name one deployment; the route matches the deployment's Cetus lineage
 * and admitted tiers; the quote is for this route; it has not expired at
 * `nowMs` and is not dated after it; and its amounts are consistent. The transaction aborts unless it
 * spends exactly `amountIn` and returns at least `minimumOut`, which goes to
 * the quote's sender. Simulate it with the Core API before signing and pass
 * the result to `reconcileCetusSwap`.
 */
export function buildCetusSwapTransaction(options: {
  access: ProtocolAccess;
  route: CetusVenueRoute;
  quote: CetusVenueQuote;
  nowMs: bigint;
}): Transaction {
  const { route, quote } = options;
  const a2b = requireBuildable(options);

  const { coinTypeA, coinTypeB } = route;
  const [inputType, outputType] = a2b
    ? [coinTypeA, coinTypeB]
    : [coinTypeB, coinTypeA];
  const cetusCall = (name: string) => `${route.cetusPackageId}::pool::${name}`;
  const pair = [coinTypeA, coinTypeB];
  const framework = (name: string) => `${SUI_FRAMEWORK_ADDRESS}::${name}`;

  const tx = new Transaction();
  tx.setSender(quote.sender);
  const cetusConfig = tx.sharedObjectRef(route.cetusConfig);
  const pool = tx.sharedObjectRef(route.pool);
  const input = tx.moveCall({
    target: framework("coin::into_balance"),
    typeArguments: [inputType],
    arguments: [tx.coin({ type: inputType, balance: quote.amountIn })],
  });
  const [balanceA, balanceB, receipt] = tx.moveCall({
    target: cetusCall("flash_swap"),
    typeArguments: pair,
    arguments: [
      cetusConfig,
      pool,
      tx.pure.bool(a2b),
      tx.pure.bool(true),
      tx.pure.u64(quote.amountIn),
      tx.pure.u128(a2b ? CETUS_MIN_SQRT_PRICE_X64 : CETUS_MAX_SQRT_PRICE_X64),
      tx.object.clock(),
    ],
  });
  const payAmount = tx.moveCall({
    target: cetusCall("swap_pay_amount"),
    typeArguments: pair,
    arguments: [receipt!],
  });
  const paid = tx.moveCall({
    target: framework("balance::split"),
    typeArguments: [inputType],
    arguments: [input, payAmount],
  });
  // Aborts unless the pool took the whole input.
  tx.moveCall({
    target: framework("balance::destroy_zero"),
    typeArguments: [inputType],
    arguments: [input],
  });
  const nothing = tx.moveCall({
    target: framework("balance::zero"),
    typeArguments: [outputType],
  });
  tx.moveCall({
    target: cetusCall("repay_flash_swap"),
    typeArguments: pair,
    arguments: [
      cetusConfig,
      pool,
      a2b ? paid : nothing,
      a2b ? nothing : paid,
      receipt!,
    ],
  });
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
  // Splitting `minimumOut` aborts when the output is smaller.
  const [floor] = tx.splitCoins(output, [tx.pure.u64(quote.minimumOut)]);
  tx.mergeCoins(output, [floor!]);
  tx.transferObjects([output], quote.sender);
  return tx;
}

/** The exact trade facts of one completed Cetus swap, for projections and execution. */
export type CetusSwapFacts = Readonly<
  CetusVenueTrade & {
    venue: "cetus";
    digest: string;
    eventIndex: number;
    sender: string;
    pool: string;
    memeType: string;
    quoteType: string;
    /** The partner paid `refAmount` from the fee; `0x0` for none. */
    partner: string;
    refAmount: bigint;
  }
>;

/**
 * Reconciles a completed (executed or simulated) transaction, read with
 * `include: { events: true }`, against the quote it was built from. It must
 * have succeeded and hold exactly one `SwapEvent` of the route's Cetus lineage
 * in the route's pool, from the quote's sender, in its direction, spending
 * exactly `amountIn` and returning at least `minimumOut`. The event's amounts
 * are the facts; the quote never overrides them.
 */
export function reconcileCetusSwap(
  transaction: Pick<
    SuiClientTypes.Transaction<{ events: true }>,
    "digest" | "status" | "events"
  >,
  quote: CetusVenueQuote,
): CetusSwapFacts {
  const mismatch = (message: string) =>
    new CetusVenueError("effects-mismatch", message);
  if (!transaction.status.success) {
    throw mismatch(`transaction ${transaction.digest} did not succeed`);
  }
  const { route } = quote;
  const swapType = normalizeStructTag(
    `${route.cetusOriginalPackageId}::pool::SwapEvent`,
  );
  const swaps = transaction.events.flatMap((event, eventIndex) => {
    if (normalizeStructTag(event.eventType) !== swapType) return [];
    const swap = decodeCetusSwapEvent(event, route.cetusOriginalPackageId);
    return swap.pool === route.pool.objectId
      ? [{ swap, eventIndex, sender: normalizeSuiAddress(event.sender) }]
      : [];
  });
  if (swaps.length !== 1) {
    throw mismatch(
      `transaction ${transaction.digest} holds ${swaps.length} swaps in the route's pool`,
    );
  }
  const [{ swap, eventIndex, sender }] = swaps as [(typeof swaps)[number]];
  if (
    sender !== quote.sender ||
    swap.atob !== quote.a2b ||
    swap.amountIn !== quote.amountIn ||
    swap.amountOut < quote.minimumOut
  ) {
    throw mismatch(`transaction ${transaction.digest} is not the quoted swap`);
  }
  return Object.freeze({
    venue: "cetus",
    digest: transaction.digest,
    eventIndex,
    sender,
    pool: swap.pool,
    memeType: route.memeType,
    quoteType: route.quoteType,
    ...cetusVenueTrade(swap, route.memeIsCoinA),
    partner: swap.partner,
    refAmount: swap.refAmount,
  });
}

/** The builder's pre-signing checks, in order; returns the swap direction. */
function requireBuildable(
  options: Parameters<typeof buildCetusSwapTransaction>[0],
): boolean {
  const { access, route, quote } = options;
  if (access.signing !== "enabled") {
    throw new CetusVenueError(
      "signing-disabled",
      "protocol signing is disabled for this deployment",
    );
  }
  if (!access.venues.cetus.available) {
    throw new CetusVenueError(
      "venue-unavailable",
      `Cetus is unavailable: ${access.venues.cetus.reasons.map(({ code }) => code).join(", ")}`,
    );
  }
  const { deployment, fingerprint } = access;
  if (
    route.deploymentFingerprint !== fingerprint ||
    quote.deploymentFingerprint !== fingerprint ||
    route.network !== deployment.network ||
    quote.network !== deployment.network
  ) {
    throw new CetusVenueError(
      "deployment-mismatch",
      "the route or quote belongs to another deployment",
    );
  }
  const cetus = deployment.packages.cetusClmm;
  const config = deployment.sharedObjects.cetus?.config;
  if (
    cetus?.packageId !== route.cetusPackageId ||
    cetus.originalPackageId !== route.cetusOriginalPackageId ||
    config?.objectId !== route.cetusConfig.objectId ||
    String(config.initialSharedVersion) !==
      String(route.cetusConfig.initialSharedVersion)
  ) {
    throw new CetusVenueError(
      "foreign-lineage",
      "the route does not call the deployment's Cetus",
    );
  }
  if (!admitsCetusTier(deployment, route.tickSpacing, route.feeRate)) {
    throw new CetusVenueError(
      "unsupported-tier",
      `the deployment admits no Cetus tier ${route.tickSpacing}/${route.feeRate}`,
    );
  }
  const a2b = swapA2b(route, quote.side);
  if (!sameRoute(route, quote.route) || quote.a2b !== a2b) {
    throw new CetusVenueError(
      "route-substitution",
      "the quote is not for the recorded route",
    );
  }
  if (options.nowMs >= quote.expiresAtMs) {
    throw new CetusVenueError("expired-quote", "the quote has expired");
  }
  if (quote.quotedAtMs > options.nowMs) {
    throw new CetusVenueError(
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
    throw new CetusVenueError(
      "invalid-quote",
      "the quote's amounts are inconsistent",
    );
  }
  return a2b;
}

function sameRoute(left: CetusVenueRoute, right: CetusVenueRoute): boolean {
  return (
    left.venue === right.venue &&
    left.network === right.network &&
    left.deploymentFingerprint === right.deploymentFingerprint &&
    left.cetusPackageId === right.cetusPackageId &&
    left.cetusOriginalPackageId === right.cetusOriginalPackageId &&
    left.cetusConfig.objectId === right.cetusConfig.objectId &&
    left.vaultId === right.vaultId &&
    left.pool.objectId === right.pool.objectId &&
    String(left.pool.initialSharedVersion) ===
      String(right.pool.initialSharedVersion) &&
    left.memeType === right.memeType &&
    left.quoteType === right.quoteType &&
    left.coinTypeA === right.coinTypeA &&
    left.coinTypeB === right.coinTypeB &&
    left.memeIsCoinA === right.memeIsCoinA &&
    left.tickSpacing === right.tickSpacing &&
    left.feeRate === right.feeRate
  );
}

/** Coin A goes in when the input coin is coin A: Quote for a buy, Meme for a sell. */
function swapA2b(route: CetusVenueRoute, side: "buy" | "sell"): boolean {
  return (side === "sell") === route.memeIsCoinA;
}

function isU64(value: bigint): boolean {
  return value >= 0n && value <= U64_MAX;
}
