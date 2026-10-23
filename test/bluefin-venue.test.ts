import assert from "node:assert/strict";
import test from "node:test";
import {
  defineBlastDeployment,
  deploymentFingerprint,
  evaluateProtocolAccess,
} from "@interest-protocol/blast-deployments-sdk";
import type {
  BluefinProviderQuote,
  BluefinQuoteRequest,
} from "@interest-protocol/blast-deployments-sdk/bluefin-venue";
import {
  BluefinVenueError,
  bluefinVenuePrice,
  buildBluefinSwapTransaction,
  decodeBluefinPoolObject,
  decodeBluefinSwapEvent,
  getBluefinPool,
  normalizeBluefinQuote,
  quoteBluefinSwap,
  reconcileBluefinSwap,
  resolveBluefinVenueRoute,
} from "@interest-protocol/blast-deployments-sdk/bluefin-venue";
import type { BlastDeploymentInput } from "@interest-protocol/blast-deployments-sdk/types";
import * as migrators from "@interest-protocol/blast-sdk/migrators";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import {
  fromBase64,
  fromHex,
  normalizeSuiObjectId,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";
import {
  BLAST_BLUEFIN,
  MAINNET_BLUEFIN_SWAPS,
} from "./fixtures/bluefin-venue.ts";
import { NON_PRODUCTION_MANIFEST } from "./fixtures/non-production-deployment.ts";
import { runtimeFor, VENUE_LINEAGE } from "./fixtures/venue-deployment.ts";

const BLUEFIN = VENUE_LINEAGE.packages.bluefinSpot;
const BLUEFIN_CONFIG = VENUE_LINEAGE.sharedObjects.bluefin.config;
const FOREIGN = `0x${"9".repeat(64)}`;

/**
 * The non-production manifest re-pointed at the blast-infra venue fixture:
 * its migrators package, the Bluefin Spot lineage, and the launch's tier.
 */
const manifest = {
  ...NON_PRODUCTION_MANIFEST,
  packages: {
    ...NON_PRODUCTION_MANIFEST.packages,
    migrators: {
      packageId: BLAST_BLUEFIN.migratorsPackageId,
      originalPackageId: BLAST_BLUEFIN.migratorsPackageId,
    },
    bluefinSpot: BLUEFIN,
  },
  sharedObjects: {
    ...NON_PRODUCTION_MANIFEST.sharedObjects,
    bluefin: { config: BLUEFIN_CONFIG },
  },
  routes: [
    {
      venue: "bluefin",
      tiers: [{ tickSpacing: 60, feeRate: BLAST_BLUEFIN.feeRate }],
    },
  ],
} satisfies BlastDeploymentInput;
const deployment = defineBlastDeployment(manifest);
const launch = {
  memeType: BLAST_BLUEFIN.memeType,
  quoteType: BLAST_BLUEFIN.quoteType,
  migrationWitnessType: `${BLAST_BLUEFIN.migratorsPackageId}::bluefin::Witness`,
  poolTickSpacing: BLAST_BLUEFIN.tickSpacing,
  poolFeeRate: BigInt(BLAST_BLUEFIN.feeRate),
};
const vault = {
  objectId: BLAST_BLUEFIN.vaultId,
  poolId: BLAST_BLUEFIN.pool.objectId,
  memeType: BLAST_BLUEFIN.memeType,
  quoteType: BLAST_BLUEFIN.quoteType,
};

test("decodes mainnet Bluefin swaps exactly as GraphQL renders them", () => {
  for (const swap of MAINNET_BLUEFIN_SWAPS) {
    const event = decodeBluefinSwapEvent(
      { eventType: swap.eventType, bcs: fromHex(swap.bcs) },
      BLUEFIN.originalPackageId,
    );
    assert.deepEqual(
      {
        pool_id: event.pool,
        a2b: event.a2b,
        amount_in: event.amountIn.toString(),
        amount_out: event.amountOut.toString(),
        pool_coin_a_amount: event.poolCoinAAmount.toString(),
        pool_coin_b_amount: event.poolCoinBAmount.toString(),
        fee: event.fee.toString(),
        before_liquidity: event.beforeLiquidity.toString(),
        after_liquidity: event.afterLiquidity.toString(),
        before_sqrt_price: event.beforeSqrtPrice.toString(),
        after_sqrt_price: event.afterSqrtPrice.toString(),
        // integer-mate `I32` bits are the two's complement of the tick.
        current_tick: { bits: event.currentTick >>> 0 },
        exceeded: event.exceeded,
        sequence_number: event.sequenceNumber.toString(),
      },
      swap.json,
      `${swap.transactionDigest}#${swap.eventIndex}`,
    );
  }
  const [, negative] = MAINNET_BLUEFIN_SWAPS;
  assert.ok(
    decodeBluefinSwapEvent(
      { eventType: negative.eventType, bcs: fromHex(negative.bcs) },
      BLUEFIN.originalPackageId,
    ).currentTick < 0,
  );
});

test("refuses a swap event from another package, of another type, or with trailing bytes", () => {
  const [swap] = MAINNET_BLUEFIN_SWAPS;
  const decode = (eventType: string, bcs: string) =>
    decodeBluefinSwapEvent(
      { eventType, bcs: fromHex(bcs) },
      BLUEFIN.originalPackageId,
    );
  assert.throws(
    () =>
      decode(
        swap.eventType.replace(
          BLUEFIN.originalPackageId,
          `0x${"9".repeat(64)}`,
        ),
        swap.bcs,
      ),
    /not a Bluefin events::AssetSwap/,
  );
  assert.throws(
    () =>
      decode(swap.eventType.replace("::AssetSwap", "::FlashSwap"), swap.bcs),
    /not a Bluefin events::AssetSwap/,
  );
  assert.throws(() => decode(swap.eventType, `${swap.bcs}00`), /trailing/);
});

const poolObject = {
  objectId: BLAST_BLUEFIN.pool.objectId,
  initialSharedVersion: BLAST_BLUEFIN.pool.initialSharedVersion,
  type: BLAST_BLUEFIN.pool.type,
  content: fromHex(BLAST_BLUEFIN.pool.content),
};
const swapType = `${BLUEFIN.originalPackageId}::events::AssetSwap`;

test("decodes the migrated Bluefin pool's coins, tier, liquidity, and price", () => {
  const pool = decodeBluefinPoolObject(poolObject, BLUEFIN.originalPackageId);
  const buy = decodeBluefinSwapEvent(
    { eventType: swapType, bcs: fromHex(BLAST_BLUEFIN.buy.bcs) },
    BLUEFIN.originalPackageId,
  );
  assert.equal(pool.objectId, BLAST_BLUEFIN.pool.objectId);
  assert.equal(
    pool.initialSharedVersion,
    BLAST_BLUEFIN.pool.initialSharedVersion,
  );
  assert.equal(pool.mutable, true);
  assert.equal(pool.originalPackageId, BLUEFIN.originalPackageId);
  assert.equal(pool.coinTypeA, BLAST_BLUEFIN.memeType);
  assert.equal(pool.coinTypeB, BLAST_BLUEFIN.quoteType);
  assert.equal(pool.tickSpacing, BLAST_BLUEFIN.pool.checks.tickSpacing);
  assert.equal(pool.feeRate, BigInt(BLAST_BLUEFIN.feeRate));
  assert.equal(pool.liquidity, BigInt(BLAST_BLUEFIN.pool.checks.liquidity));
  assert.equal(pool.isPaused, false);
  // The first swap after migration starts at the pool's price, liquidity,
  // and Meme balance; the buy takes its Meme out of that balance.
  assert.equal(pool.currentSqrtPrice, buy.beforeSqrtPrice);
  assert.equal(pool.liquidity, buy.beforeLiquidity);
  assert.equal(pool.balanceA - buy.amountOut, buy.poolCoinAAmount);
});

test("reads a shared Bluefin pool through the Core API", async () => {
  const client = (owner: object) =>
    ({
      core: {
        getObject: async (options: { objectId: string }) => {
          assert.equal(options.objectId, BLAST_BLUEFIN.pool.objectId);
          return {
            object: {
              objectId: poolObject.objectId,
              type: poolObject.type,
              content: poolObject.content,
              owner,
            },
          };
        },
      },
    }) as unknown as ClientWithCoreApi;
  const shared = {
    $kind: "Shared",
    Shared: { initialSharedVersion: BLAST_BLUEFIN.pool.initialSharedVersion },
  };
  assert.deepEqual(
    await getBluefinPool(
      client(shared),
      BLAST_BLUEFIN.pool.objectId,
      BLUEFIN.originalPackageId,
    ),
    decodeBluefinPoolObject(poolObject, BLUEFIN.originalPackageId),
  );
  await assert.rejects(
    getBluefinPool(
      client({ $kind: "AddressOwner", AddressOwner: BLAST_BLUEFIN.buy.sender }),
      BLAST_BLUEFIN.pool.objectId,
      BLUEFIN.originalPackageId,
    ),
    /not shared/,
  );
});

test("refuses a pool of another package, type, or object, or with trailing bytes", () => {
  const rejects = (
    object: Partial<Parameters<typeof decodeBluefinPoolObject>[0]>,
    message: RegExp,
  ) =>
    assert.throws(
      () =>
        decodeBluefinPoolObject(
          { ...poolObject, ...object },
          BLUEFIN.originalPackageId,
        ),
      message,
    );
  rejects(
    {
      type: poolObject.type.replace(
        BLUEFIN.originalPackageId,
        `0x${"9".repeat(64)}`,
      ),
    },
    /not a Bluefin pool::Pool/,
  );
  rejects(
    { type: poolObject.type.replace("::pool::Pool<", "::pool::Other<") },
    /not a Bluefin pool::Pool/,
  );
  rejects({ objectId: BLAST_BLUEFIN.vaultId }, /mismatched UID/);
  rejects(
    { content: fromHex(`${BLAST_BLUEFIN.pool.content}00`) },
    /trailing bytes/,
  );
});

test("resolves the launch's recorded Bluefin route through its vault's pool", () => {
  const pool = decodeBluefinPoolObject(poolObject, BLUEFIN.originalPackageId);
  assert.deepEqual(
    resolveBluefinVenueRoute({ deployment, launch, vault, pool }),
    {
      venue: "bluefin",
      network: "mainnet",
      deploymentFingerprint: deploymentFingerprint(deployment),
      bluefinPackageId: BLUEFIN.packageId,
      bluefinOriginalPackageId: BLUEFIN.originalPackageId,
      bluefinConfig: { ...BLUEFIN_CONFIG, mutable: false },
      vaultId: BLAST_BLUEFIN.vaultId,
      pool: {
        objectId: BLAST_BLUEFIN.pool.objectId,
        initialSharedVersion: BLAST_BLUEFIN.pool.initialSharedVersion,
        mutable: true,
      },
      memeType: BLAST_BLUEFIN.memeType,
      quoteType: BLAST_BLUEFIN.quoteType,
      tickSpacing: 60,
      feeRate: 3_000n,
    },
  );
});

test("refuses a route outside the deployment's Bluefin lineage and tiers", () => {
  const pool = decodeBluefinPoolObject(poolObject, BLUEFIN.originalPackageId);
  const rejects = (
    code: string,
    options: Partial<Parameters<typeof resolveBluefinVenueRoute>[0]>,
  ) =>
    assert.throws(
      () =>
        resolveBluefinVenueRoute({
          deployment,
          launch,
          vault,
          pool,
          ...options,
        }),
      (error) => error instanceof BluefinVenueError && error.code === code,
      code,
    );

  const { bluefinSpot: _spot, ...packages } = manifest.packages;
  const { bluefin: _bluefin, ...sharedObjects } = manifest.sharedObjects;
  rejects("deployment-mismatch", {
    deployment: defineBlastDeployment({ ...manifest, packages, sharedObjects }),
  });
  rejects("foreign-lineage", {
    launch: { ...launch, migrationWitnessType: `${FOREIGN}::bluefin::Witness` },
  });
  rejects("foreign-lineage", { pool: { ...pool, originalPackageId: FOREIGN } });
  rejects("route-substitution", {
    launch: {
      ...launch,
      migrationWitnessType: `${BLAST_BLUEFIN.migratorsPackageId}::cetus::Witness`,
    },
  });
  rejects("route-substitution", { vault: { ...vault, poolId: FOREIGN } });
  rejects("route-substitution", {
    vault: { ...vault, memeType: BLAST_BLUEFIN.quoteType },
  });
  // A pool of the launch's coins in the other order is not a migrated pool.
  rejects("route-substitution", {
    pool: {
      ...pool,
      coinTypeA: BLAST_BLUEFIN.quoteType,
      coinTypeB: BLAST_BLUEFIN.memeType,
    },
  });
  rejects("route-substitution", { pool: { ...pool, tickSpacing: 200 } });
  rejects("route-substitution", { pool: { ...pool, feeRate: 2_500n } });
  rejects("unsupported-tier", {
    launch: { ...launch, poolTickSpacing: 200, poolFeeRate: 10_000n },
  });
});

const pool = decodeBluefinPoolObject(poolObject, BLUEFIN.originalPackageId);
const route = resolveBluefinVenueRoute({ deployment, launch, vault, pool });
const buyEvent = decodeBluefinSwapEvent(
  { eventType: swapType, bcs: fromHex(BLAST_BLUEFIN.buy.bcs) },
  BLUEFIN.originalPackageId,
);
/** The fixture's buy: 500,000,000 MIST in, as the pool then filled it. */
const buyRequest: BluefinQuoteRequest = {
  side: "buy",
  amountIn: 500_000_000n,
  slippageBps: 100n,
  validForMs: 30_000n,
  sender: BLAST_BLUEFIN.buy.sender,
  balances: { quote: 1_000_000_000n, meme: 0n },
};
const buyProviderQuote: BluefinProviderQuote = {
  poolId: BLAST_BLUEFIN.pool.objectId,
  a2b: false,
  byAmountIn: true,
  amountIn: buyEvent.amountIn,
  amountOut: buyEvent.amountOut,
  feeAmount: buyEvent.fee,
  afterSqrtPrice: buyEvent.afterSqrtPrice,
  isExceed: false,
  quotedAtMs: 1_790_338_300_000n,
};

test("normalizes a provider quote into exact reviewable terms", async () => {
  const requests: unknown[] = [];
  const quote = await quoteBluefinSwap({
    route,
    pool,
    request: buyRequest,
    transport: async (request) => {
      requests.push(request);
      return buyProviderQuote;
    },
  });
  assert.deepEqual(requests, [
    { route, a2b: false, byAmountIn: true, amount: 500_000_000n },
  ]);
  assert.deepEqual(quote, {
    venue: "bluefin",
    network: "mainnet",
    deploymentFingerprint: deploymentFingerprint(deployment),
    route,
    side: "buy",
    a2b: false,
    inputType: BLAST_BLUEFIN.quoteType,
    outputType: BLAST_BLUEFIN.memeType,
    amountIn: 500_000_000n,
    amountOut: 4_163_571_224_476n,
    // floor(4,163,571,224,476 x 9,900 / 10,000)
    minimumOut: 4_121_935_512_231n,
    slippageBps: 100n,
    // 0.3% of the input, in SUI
    feeAmount: 1_500_000n,
    priceBefore: bluefinVenuePrice(199_621_782_694_844_687n),
    priceAfter: bluefinVenuePrice(204_094_207_803_750_223n),
    // floor(|after - before| x 10,000 / before) of the exact prices
    priceImpactBps: 453n,
    quotedAtMs: 1_790_338_300_000n,
    expiresAtMs: 1_790_338_330_000n,
    sender: BLAST_BLUEFIN.buy.sender,
    balances: { quote: 1_000_000_000n, meme: 0n },
  });
  const withoutPrice = normalizeBluefinQuote({
    route,
    pool,
    request: buyRequest,
    providerQuote: { ...buyProviderQuote, afterSqrtPrice: null },
  });
  assert.equal(withoutPrice.priceAfter, null);
  assert.equal(withoutPrice.priceImpactBps, null);
});

test("refuses a provider quote that is not the requested exact-input swap", () => {
  const rejects = (
    code: string,
    providerQuote: Partial<BluefinProviderQuote>,
    request: Partial<BluefinQuoteRequest> = {},
    quotedPool = pool,
  ) =>
    assert.throws(
      () =>
        normalizeBluefinQuote({
          route,
          pool: quotedPool,
          request: { ...buyRequest, ...request },
          providerQuote: { ...buyProviderQuote, ...providerQuote },
        }),
      (error) => error instanceof BluefinVenueError && error.code === code,
      `${code} ${JSON.stringify(Object.keys({ ...providerQuote, ...request }))}`,
    );

  rejects("route-substitution", { poolId: BLAST_BLUEFIN.vaultId });
  rejects(
    "route-substitution",
    {},
    {},
    { ...pool, objectId: BLAST_BLUEFIN.vaultId },
  );
  rejects("invalid-quote", {}, {}, { ...pool, isPaused: true });
  rejects("invalid-quote", { a2b: true });
  rejects("invalid-quote", { byAmountIn: false });
  rejects("invalid-quote", { isExceed: true });
  rejects("invalid-quote", { amountIn: 499_999_999n });
  rejects("invalid-quote", { feeAmount: 500_000_001n });
  rejects("invalid-quote", { amountOut: 1n });
  rejects("invalid-quote", {}, { slippageBps: 10_000n });
  rejects("invalid-quote", {}, { validForMs: 0n });
  rejects("invalid-quote", {}, { balances: { quote: 499_999_999n, meme: 0n } });
});

const access = evaluateProtocolAccess({
  manifest,
  mode: "non-production",
  runtime: runtimeFor(manifest),
});
const buyQuote = normalizeBluefinQuote({
  route,
  pool,
  request: buyRequest,
  providerQuote: buyProviderQuote,
});
const beforeExpiry = buyQuote.expiresAtMs - 1n;
const framework = (call: string) => `${normalizeSuiObjectId("0x2")}::${call}`;

function moveCalls(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.map((command) =>
      command.$kind === "MoveCall"
        ? `${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}<${command.MoveCall.typeArguments.join(",")}>`
        : command.$kind,
    );
}

test("builds the quoted buy as one exact-input Bluefin swap", () => {
  assert.equal(access.signing, "enabled");
  assert.equal(access.venues.bluefin.available, true);
  const tx = buildBluefinSwapTransaction({
    access,
    route,
    quote: buyQuote,
    nowMs: beforeExpiry,
  });
  const data = tx.getData();
  const { memeType: meme, quoteType: quote } = BLAST_BLUEFIN;
  assert.equal(data.sender, BLAST_BLUEFIN.buy.sender);
  assert.deepEqual(moveCalls(tx), [
    "$Intent",
    `${framework("coin::into_balance")}<${quote}>`,
    `${framework("balance::zero")}<${meme}>`,
    `${BLUEFIN.packageId}::pool::swap<${meme},${quote}>`,
    `${framework("balance::destroy_zero")}<${quote}>`,
    `${framework("coin::from_balance")}<${meme}>`,
    "TransferObjects",
  ]);
  const intent = data.commands[0]!;
  assert.ok(intent.$kind === "$Intent");
  // A SUI input is split from the gas coin.
  assert.deepEqual(intent.$Intent.data, {
    type: "gas",
    balance: 500_000_000n,
    outputKind: "coin",
  });
  const swap = data.commands[3]!;
  assert.ok(swap.$kind === "MoveCall");
  assert.deepEqual(
    swap.MoveCall.arguments.map((argument) => describeArgument(tx, argument)),
    [
      `shared:${SUI_CLOCK_OBJECT_ID}@1`,
      `shared:${BLUEFIN_CONFIG.objectId}@${BLUEFIN_CONFIG.initialSharedVersion}`,
      `shared-mut:${BLAST_BLUEFIN.pool.objectId}@${BLAST_BLUEFIN.pool.initialSharedVersion}`,
      // balance_a: nothing; balance_b: the whole Quote input
      "result:2",
      "result:1",
      "bool:false",
      "bool:true",
      "u64:500000000",
      // amount_limit: the minimum output; Bluefin aborts below it
      "u64:4121935512231",
      // contracts 442116a `constants::max_swap_sqrt_price`
      "u128:79226673515401279992447579054",
    ],
  );
  const destroy = data.commands[4]!;
  const output = data.commands[5]!;
  assert.ok(destroy.$kind === "MoveCall" && output.$kind === "MoveCall");
  assert.deepEqual(destroy.MoveCall.arguments, [
    { $kind: "NestedResult", NestedResult: [3, 1] },
  ]);
  assert.deepEqual(output.MoveCall.arguments, [
    { $kind: "NestedResult", NestedResult: [3, 0] },
  ]);
  const transfer = data.commands[6]!;
  assert.ok(transfer.$kind === "TransferObjects");
  assert.equal(
    describeArgument(tx, transfer.TransferObjects.address, "address"),
    `address:${BLAST_BLUEFIN.buy.sender}`,
  );
});

test("builds a sell with the opposite direction and price limit", () => {
  const sellQuote = normalizeBluefinQuote({
    route,
    pool,
    request: {
      ...buyRequest,
      side: "sell",
      amountIn: 1_000n,
      balances: { quote: 0n, meme: 1_000n },
    },
    providerQuote: {
      ...buyProviderQuote,
      a2b: true,
      amountIn: 1_000n,
      amountOut: 900n,
      feeAmount: 3n,
      afterSqrtPrice: null,
    },
  });
  const tx = buildBluefinSwapTransaction({
    access,
    route,
    quote: sellQuote,
    nowMs: beforeExpiry,
  });
  const { memeType: meme, quoteType: quote } = BLAST_BLUEFIN;
  assert.deepEqual(moveCalls(tx), [
    "$Intent",
    `${framework("coin::into_balance")}<${meme}>`,
    `${framework("balance::zero")}<${quote}>`,
    `${BLUEFIN.packageId}::pool::swap<${meme},${quote}>`,
    `${framework("balance::destroy_zero")}<${meme}>`,
    `${framework("coin::from_balance")}<${quote}>`,
    "TransferObjects",
  ]);
  const data = tx.getData();
  const swap = data.commands[3]!;
  assert.ok(swap.$kind === "MoveCall");
  assert.deepEqual(
    swap.MoveCall.arguments
      .slice(3)
      .map((argument) => describeArgument(tx, argument)),
    [
      "result:1",
      "result:2",
      "bool:true",
      "bool:true",
      "u64:1000",
      // floor(900 x 9,900 / 10,000)
      "u64:891",
      // contracts 442116a `constants::min_swap_sqrt_price`
      "u128:4295048017",
    ],
  );
  const destroy = data.commands[4]!;
  const output = data.commands[5]!;
  assert.ok(destroy.$kind === "MoveCall" && output.$kind === "MoveCall");
  assert.deepEqual(destroy.MoveCall.arguments, [
    { $kind: "NestedResult", NestedResult: [3, 0] },
  ]);
  assert.deepEqual(output.MoveCall.arguments, [
    { $kind: "NestedResult", NestedResult: [3, 1] },
  ]);
});

test("refuses to build before signing unless deployment, lineage, tier, route, expiry, and quote hold", () => {
  const rejects = (
    code: string,
    options: Partial<Parameters<typeof buildBluefinSwapTransaction>[0]>,
  ) =>
    assert.throws(
      () =>
        buildBluefinSwapTransaction({
          access,
          route,
          quote: buyQuote,
          nowMs: beforeExpiry,
          ...options,
        }),
      (error) => error instanceof BluefinVenueError && error.code === code,
      code,
    );

  rejects("signing-disabled", {
    access: evaluateProtocolAccess({ manifest, mode: "non-production" }),
  });
  // A Bluefin config of another lineage leaves core signing on but Bluefin off.
  const foreignConfig = runtimeFor(manifest);
  foreignConfig.sharedObjects["bluefin.config"]!.type =
    `${FOREIGN}::config::GlobalConfig`;
  const bluefinOff = evaluateProtocolAccess({
    manifest,
    mode: "non-production",
    runtime: foreignConfig,
  });
  assert.equal(bluefinOff.signing, "enabled");
  rejects("venue-unavailable", { access: bluefinOff });
  const otherManifest = {
    ...manifest,
    routes: [
      { venue: "bluefin", tiers: [{ tickSpacing: 200, feeRate: "10000" }] },
    ],
  } satisfies BlastDeploymentInput;
  rejects("deployment-mismatch", {
    access: evaluateProtocolAccess({
      manifest: otherManifest,
      mode: "non-production",
      runtime: runtimeFor(otherManifest),
    }),
  });
  rejects("foreign-lineage", {
    route: { ...route, bluefinPackageId: FOREIGN },
  });
  rejects("foreign-lineage", {
    route: { ...route, bluefinOriginalPackageId: FOREIGN },
  });
  rejects("foreign-lineage", {
    route: {
      ...route,
      bluefinConfig: { ...route.bluefinConfig, objectId: FOREIGN },
    },
  });
  rejects("unsupported-tier", { route: { ...route, tickSpacing: 200 } });
  rejects("route-substitution", {
    quote: {
      ...buyQuote,
      route: { ...route, pool: { ...route.pool, objectId: FOREIGN } },
    },
  });
  rejects("route-substitution", { quote: { ...buyQuote, a2b: true } });
  rejects("expired-quote", { nowMs: buyQuote.expiresAtMs });
  // A provider clock ahead of ours would stretch the validity window.
  rejects("invalid-quote", { nowMs: buyQuote.quotedAtMs - 1n });
  rejects("invalid-quote", { quote: { ...buyQuote, minimumOut: 0n } });
  rejects("invalid-quote", {
    quote: { ...buyQuote, minimumOut: buyQuote.amountOut + 1n },
  });
});

type FixtureSwap =
  | typeof BLAST_BLUEFIN.buy
  | typeof BLAST_BLUEFIN.sell
  | typeof BLAST_BLUEFIN.flashBuy;

/** A completed fixture swap as the Core API returns it with `include: { events: true }`. */
function completed(swap: FixtureSwap, name = "AssetSwap") {
  return {
    digest: swap.transactionDigest,
    status: { success: true as const, error: null },
    events: [
      {
        packageId: BLUEFIN.packageId,
        module: "pool",
        sender: swap.sender,
        eventType: `${BLUEFIN.originalPackageId}::events::${name}`,
        bcs: fromHex(swap.bcs),
        json: null,
      },
    ],
  };
}

const sellEvent = decodeBluefinSwapEvent(
  completed(BLAST_BLUEFIN.sell).events[0]!,
  BLUEFIN.originalPackageId,
);
const sellQuote = normalizeBluefinQuote({
  route,
  pool: { ...pool, currentSqrtPrice: sellEvent.beforeSqrtPrice },
  request: {
    side: "sell",
    amountIn: BigInt(BLAST_BLUEFIN.sell.checks.amountIn),
    slippageBps: 50n,
    validForMs: 30_000n,
    sender: BLAST_BLUEFIN.sell.sender,
    balances: { quote: 0n, meme: BigInt(BLAST_BLUEFIN.sell.checks.amountIn) },
  },
  providerQuote: {
    poolId: BLAST_BLUEFIN.pool.objectId,
    a2b: true,
    byAmountIn: true,
    amountIn: sellEvent.amountIn,
    amountOut: sellEvent.amountOut,
    feeAmount: sellEvent.fee,
    afterSqrtPrice: sellEvent.afterSqrtPrice,
    isExceed: false,
    quotedAtMs: 1_790_338_360_000n,
  },
});

test("reconciles the fixture's completed Bluefin buy and sell into exact trade facts", () => {
  assert.deepEqual(
    reconcileBluefinSwap(completed(BLAST_BLUEFIN.buy), buyQuote),
    {
      venue: "bluefin",
      digest: "E1YaP5pjHt1daBn5qP1utnQCDPB2KqpNQNfBSJhCW23a",
      eventIndex: 0,
      sender: BLAST_BLUEFIN.buy.sender,
      pool: BLAST_BLUEFIN.pool.objectId,
      memeType: BLAST_BLUEFIN.memeType,
      quoteType: BLAST_BLUEFIN.quoteType,
      side: "buy",
      quoteAmount: 500_000_000n,
      memeAmount: 4_163_571_224_476n,
      // 0.3% of the input, in SUI
      quoteFee: 1_500_000n,
      memeFee: 0n,
      priceBefore: bluefinVenuePrice(199_621_782_694_844_687n),
      priceAfter: bluefinVenuePrice(204_094_207_803_750_223n),
    },
  );
  assert.deepEqual(
    reconcileBluefinSwap(completed(BLAST_BLUEFIN.sell), sellQuote),
    {
      venue: "bluefin",
      digest: "4adyBxGTJ1FTPfQdLRYqUbRZUqyzNKAqQ8xm2F7DuTu5",
      eventIndex: 0,
      sender: BLAST_BLUEFIN.sell.sender,
      pool: BLAST_BLUEFIN.pool.objectId,
      memeType: BLAST_BLUEFIN.memeType,
      quoteType: BLAST_BLUEFIN.quoteType,
      side: "sell",
      quoteAmount: 1_002_500_151n,
      memeAmount: 8_592_919_806_171n,
      quoteFee: 0n,
      // ceil(0.3% of the input), in Meme
      memeFee: 25_778_759_419n,
      // The sell starts where the buy left the pool.
      priceBefore: bluefinVenuePrice(204_094_207_803_750_223n),
      priceAfter: bluefinVenuePrice(195_100_011_520_861_240n),
    },
  );
});

test("refuses completed effects that are not the quoted swap", () => {
  const buy = completed(BLAST_BLUEFIN.buy);
  const [event] = buy.events;
  const flash = completed(BLAST_BLUEFIN.flashBuy, "FlashSwap").events[0]!;
  const rejects = (
    transaction: ReturnType<typeof completed>,
    quote = buyQuote,
  ) =>
    assert.throws(
      () => reconcileBluefinSwap(transaction, quote),
      (error) =>
        error instanceof BluefinVenueError && error.code === "effects-mismatch",
    );

  rejects({
    ...buy,
    status: { success: false, error: { $kind: "Unknown", message: "aborted" } },
  } as unknown as ReturnType<typeof completed>);
  rejects({ ...buy, events: [] });
  rejects({ ...buy, events: [event!, event!] });
  // Another swap in the route's pool, through flash_swap, is not the quote.
  rejects({ ...buy, events: [event!, flash] });
  rejects(completed(BLAST_BLUEFIN.flashBuy, "FlashSwap"));
  rejects({
    ...buy,
    events: [{ ...event!, eventType: `${FOREIGN}::events::AssetSwap` }],
  });
  rejects(completed(BLAST_BLUEFIN.sell));
  rejects({
    ...buy,
    events: [{ ...event!, sender: BLAST_BLUEFIN.sell.sender }],
  });
  rejects(buy, { ...buyQuote, amountIn: 499_999_999n });
  rejects(buy, { ...buyQuote, minimumOut: buyEvent.amountOut + 1n });
  rejects(buy, {
    ...buyQuote,
    route: {
      ...route,
      pool: { ...route.pool, objectId: BLAST_BLUEFIN.vaultId },
    },
  });
});

function describeArgument(
  tx: Transaction,
  argument: Parameters<Transaction["object"]>[0] | object,
  pureType: "address" | null = null,
): string {
  const arg = argument as { $kind: string; Input?: number; Result?: number };
  if (arg.$kind === "Result") return `result:${arg.Result}`;
  assert.equal(arg.$kind, "Input");
  const input = tx.getData().inputs[arg.Input!]!;
  if (input.$kind === "Object" && input.Object.$kind === "SharedObject") {
    const shared = input.Object.SharedObject;
    return `${shared.mutable ? "shared-mut" : "shared"}:${shared.objectId}@${shared.initialSharedVersion}`;
  }
  assert.ok(input.$kind === "Pure");
  const bytes = fromBase64(input.Pure.bytes);
  if (pureType === "address") return `address:${bcs.Address.parse(bytes)}`;
  if (bytes.length === 8) return `u64:${bcs.u64().parse(bytes)}`;
  if (bytes.length === 16) return `u128:${bcs.u128().parse(bytes)}`;
  return `bool:${bcs.bool().parse(bytes)}`;
}

test("exports the Bluefin adapter from the migrators entry point", () => {
  assert.equal(migrators.resolveBluefinVenueRoute, resolveBluefinVenueRoute);
  assert.equal(migrators.quoteBluefinSwap, quoteBluefinSwap);
  assert.equal(
    migrators.buildBluefinSwapTransaction,
    buildBluefinSwapTransaction,
  );
  assert.equal(migrators.reconcileBluefinSwap, reconcileBluefinSwap);
  assert.equal(migrators.BluefinVenueError, BluefinVenueError);
});
