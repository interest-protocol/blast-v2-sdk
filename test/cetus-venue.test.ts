import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import {
  fromBase64,
  fromHex,
  normalizeSuiObjectId,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";

import type { DeploymentRuntimeObservation } from "../src/deployments/index.ts";
import {
  defineBlastDeployment,
  deploymentFingerprint,
  evaluateProtocolAccess,
} from "../src/deployments/index.ts";
import type { BlastDeploymentInput } from "../src/deployments/types.ts";
import type {
  CetusProviderQuote,
  CetusQuoteRequest,
} from "../src/migrators/cetus-venue.ts";
import {
  buildCetusSwapTransaction,
  CETUS_MAX_SQRT_PRICE_X64,
  CETUS_MIN_SQRT_PRICE_X64,
  CetusVenueError,
  cetusVenuePrice,
  decodeCetusPoolObject,
  decodeCetusSwapEvent,
  getCetusPool,
  normalizeCetusQuote,
  quoteCetusSwap,
  reconcileCetusSwap,
  resolveCetusVenueRoute,
} from "../src/migrators/cetus-venue.ts";
import {
  BLAST_CETUS,
  CETUS_LINEAGE,
  MAINNET_CETUS_SWAPS,
} from "./fixtures/cetus-venue.ts";
import { NON_PRODUCTION_MANIFEST } from "./fixtures/non-production-deployment.ts";

/**
 * The non-production manifest re-pointed at the blast-infra venue fixture:
 * its migrators package, the Cetus lineage, and the one admitted Cetus tier.
 */
const manifest = {
  ...NON_PRODUCTION_MANIFEST,
  packages: {
    ...NON_PRODUCTION_MANIFEST.packages,
    migrators: {
      packageId: BLAST_CETUS.migratorsPackageId,
      originalPackageId: BLAST_CETUS.migratorsPackageId,
    },
    cetusClmm: {
      packageId: CETUS_LINEAGE.packageId,
      originalPackageId: CETUS_LINEAGE.originalPackageId,
    },
  },
  sharedObjects: {
    ...NON_PRODUCTION_MANIFEST.sharedObjects,
    cetusConfig: CETUS_LINEAGE.globalConfig,
  },
  routes: [{ venue: "cetus", tiers: [{ tickSpacing: 200, feeRate: "10000" }] }],
} satisfies BlastDeploymentInput;
const deployment = defineBlastDeployment(manifest);
const launch = {
  memeType: BLAST_CETUS.memeType,
  quoteType: BLAST_CETUS.quoteType,
  migrationWitnessType: `${BLAST_CETUS.migratorsPackageId}::cetus::Witness`,
  poolTickSpacing: 200,
  poolFeeRate: 10_000n,
};
const vault = {
  objectId: BLAST_CETUS.vaultId,
  poolId: BLAST_CETUS.pool.objectId,
  memeType: BLAST_CETUS.memeType,
  quoteType: BLAST_CETUS.quoteType,
};

const poolObject = {
  objectId: BLAST_CETUS.pool.objectId,
  initialSharedVersion: BLAST_CETUS.pool.initialSharedVersion,
  type: BLAST_CETUS.pool.type,
  content: fromHex(BLAST_CETUS.pool.content),
};

test("decodes mainnet Cetus swaps exactly as GraphQL renders them", () => {
  for (const swap of MAINNET_CETUS_SWAPS) {
    const event = decodeCetusSwapEvent(
      { eventType: swap.eventType, bcs: fromHex(swap.bcs) },
      CETUS_LINEAGE.originalPackageId,
    );
    assert.deepEqual(
      {
        atob: event.atob,
        pool: event.pool,
        partner: event.partner,
        amount_in: event.amountIn.toString(),
        amount_out: event.amountOut.toString(),
        ref_amount: event.refAmount.toString(),
        fee_amount: event.feeAmount.toString(),
        vault_a_amount: event.vaultAAmount.toString(),
        vault_b_amount: event.vaultBAmount.toString(),
        before_sqrt_price: event.beforeSqrtPrice.toString(),
        after_sqrt_price: event.afterSqrtPrice.toString(),
        steps: event.steps.toString(),
      },
      swap.json,
      swap.transactionDigest,
    );
  }
});

test("refuses a swap event from another package or with trailing bytes", () => {
  const [swap] = MAINNET_CETUS_SWAPS;
  const foreign = swap.eventType.replace(
    CETUS_LINEAGE.originalPackageId,
    `0x${"9".repeat(64)}`,
  );
  assert.throws(
    () =>
      decodeCetusSwapEvent(
        { eventType: foreign, bcs: fromHex(swap.bcs) },
        CETUS_LINEAGE.originalPackageId,
      ),
    /not a Cetus pool::SwapEvent/,
  );
  assert.throws(
    () =>
      decodeCetusSwapEvent(
        { eventType: swap.eventType, bcs: fromHex(`${swap.bcs}00`) },
        CETUS_LINEAGE.originalPackageId,
      ),
    /trailing/,
  );
});

test("decodes the migrated Cetus pool's coins, tier, liquidity, and price", () => {
  const pool = decodeCetusPoolObject(
    poolObject,
    CETUS_LINEAGE.originalPackageId,
  );
  const buy = decodeCetusSwapEvent(
    {
      eventType: `${CETUS_LINEAGE.originalPackageId}::pool::SwapEvent`,
      bcs: fromHex(BLAST_CETUS.buy.bcs),
    },
    CETUS_LINEAGE.originalPackageId,
  );
  assert.equal(pool.objectId, BLAST_CETUS.pool.objectId);
  assert.equal(
    pool.initialSharedVersion,
    BLAST_CETUS.pool.initialSharedVersion,
  );
  assert.equal(pool.mutable, true);
  assert.equal(pool.originalPackageId, CETUS_LINEAGE.originalPackageId);
  assert.equal(pool.coinTypeA, BLAST_CETUS.quoteType);
  assert.equal(pool.coinTypeB, BLAST_CETUS.memeType);
  assert.equal(pool.tickSpacing, BLAST_CETUS.pool.checks.tickSpacing);
  // Cetus fixes tick spacing 200 at a 1% fee (contracts migrators DEPENDENCIES.md).
  assert.equal(pool.feeRate, 10_000n);
  assert.equal(pool.liquidity, BigInt(BLAST_CETUS.pool.checks.liquidity));
  // The first swap after migration starts at the pool's price.
  assert.equal(pool.currentSqrtPrice, buy.beforeSqrtPrice);
});

test("reads a shared Cetus pool through the Core API", async () => {
  const client = (owner: object) =>
    ({
      core: {
        getObject: async (options: { objectId: string }) => {
          assert.equal(options.objectId, BLAST_CETUS.pool.objectId);
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
    Shared: { initialSharedVersion: BLAST_CETUS.pool.initialSharedVersion },
  };
  assert.deepEqual(
    await getCetusPool(
      client(shared),
      BLAST_CETUS.pool.objectId,
      CETUS_LINEAGE.originalPackageId,
    ),
    decodeCetusPoolObject(poolObject, CETUS_LINEAGE.originalPackageId),
  );
  await assert.rejects(
    getCetusPool(
      client({ $kind: "AddressOwner", AddressOwner: BLAST_CETUS.buy.sender }),
      BLAST_CETUS.pool.objectId,
      CETUS_LINEAGE.originalPackageId,
    ),
    /not shared/,
  );
});

test("refuses a pool of another package, another type, or another object", () => {
  const foreign = `0x${"9".repeat(64)}`;
  assert.throws(
    () =>
      decodeCetusPoolObject(
        {
          ...poolObject,
          type: poolObject.type.replace(
            CETUS_LINEAGE.originalPackageId,
            foreign,
          ),
        },
        CETUS_LINEAGE.originalPackageId,
      ),
    /not a Cetus pool::Pool/,
  );
  assert.throws(
    () =>
      decodeCetusPoolObject(
        {
          ...poolObject,
          type: poolObject.type.replace("::pool::Pool<", "::pool::Other<"),
        },
        CETUS_LINEAGE.originalPackageId,
      ),
    /not a Cetus pool::Pool/,
  );
  assert.throws(
    () =>
      decodeCetusPoolObject(
        { ...poolObject, objectId: BLAST_CETUS.vaultId },
        CETUS_LINEAGE.originalPackageId,
      ),
    /mismatched UID/,
  );
});

test("resolves the launch's recorded Cetus route through its vault's pool", () => {
  const pool = decodeCetusPoolObject(
    poolObject,
    CETUS_LINEAGE.originalPackageId,
  );
  const route = resolveCetusVenueRoute({ deployment, launch, vault, pool });
  assert.deepEqual(route, {
    venue: "cetus",
    network: "localnet",
    deploymentFingerprint: deploymentFingerprint(deployment),
    cetusPackageId: CETUS_LINEAGE.packageId,
    cetusOriginalPackageId: CETUS_LINEAGE.originalPackageId,
    cetusConfig: { ...CETUS_LINEAGE.globalConfig, mutable: false },
    vaultId: BLAST_CETUS.vaultId,
    pool: {
      objectId: BLAST_CETUS.pool.objectId,
      initialSharedVersion: BLAST_CETUS.pool.initialSharedVersion,
      mutable: true,
    },
    memeType: BLAST_CETUS.memeType,
    quoteType: BLAST_CETUS.quoteType,
    coinTypeA: BLAST_CETUS.quoteType,
    coinTypeB: BLAST_CETUS.memeType,
    memeIsCoinA: false,
    tickSpacing: 200,
    feeRate: 10_000n,
  });
});

test("refuses a route outside the deployment's Cetus lineage and tiers", () => {
  const pool = decodeCetusPoolObject(
    poolObject,
    CETUS_LINEAGE.originalPackageId,
  );
  const foreign = `0x${"9".repeat(64)}`;
  const rejects = (
    code: string,
    options: Partial<Parameters<typeof resolveCetusVenueRoute>[0]>,
  ) =>
    assert.throws(
      () =>
        resolveCetusVenueRoute({ deployment, launch, vault, pool, ...options }),
      (error) => error instanceof CetusVenueError && error.code === code,
      code,
    );

  const { cetusClmm: _, ...packages } = manifest.packages;
  rejects("deployment-mismatch", {
    deployment: defineBlastDeployment({ ...manifest, packages }),
  });
  rejects("foreign-lineage", {
    launch: { ...launch, migrationWitnessType: `${foreign}::cetus::Witness` },
  });
  rejects("foreign-lineage", { pool: { ...pool, originalPackageId: foreign } });
  rejects("route-substitution", {
    launch: {
      ...launch,
      migrationWitnessType: `${BLAST_CETUS.migratorsPackageId}::bluefin::Witness`,
    },
  });
  rejects("route-substitution", { vault: { ...vault, poolId: foreign } });
  rejects("route-substitution", {
    pool: { ...pool, coinTypeA: "0x2::sui::SUI" },
  });
  rejects("route-substitution", { pool: { ...pool, tickSpacing: 60 } });
  rejects("unsupported-tier", {
    launch: { ...launch, poolTickSpacing: 60, poolFeeRate: 2_500n },
  });
});

const pool = decodeCetusPoolObject(poolObject, CETUS_LINEAGE.originalPackageId);
const route = resolveCetusVenueRoute({ deployment, launch, vault, pool });
const buyEvent = decodeCetusSwapEvent(
  {
    eventType: `${CETUS_LINEAGE.originalPackageId}::pool::SwapEvent`,
    bcs: fromHex(BLAST_CETUS.buy.bcs),
  },
  CETUS_LINEAGE.originalPackageId,
);
/** The fixture's buy: 500,000 USDC atoms in, as the pool then filled it. */
const buyRequest: CetusQuoteRequest = {
  side: "buy",
  amountIn: 500_000n,
  slippageBps: 100n,
  validForMs: 30_000n,
  sender: BLAST_CETUS.buy.sender,
  balances: { quote: 1_000_000n, meme: 0n },
};
const buyProviderQuote: CetusProviderQuote = {
  poolId: BLAST_CETUS.pool.objectId,
  a2b: true,
  byAmountIn: true,
  amountIn: buyEvent.amountIn,
  amountOut: buyEvent.amountOut,
  feeAmount: buyEvent.feeAmount,
  afterSqrtPrice: buyEvent.afterSqrtPrice,
  isExceed: false,
  quotedAtMs: 1_790_338_000_000n,
};

test("normalizes a provider quote into exact reviewable terms", async () => {
  const requests: unknown[] = [];
  const quote = await quoteCetusSwap({
    route,
    pool,
    request: buyRequest,
    transport: async (request) => {
      requests.push(request);
      return buyProviderQuote;
    },
  });
  assert.deepEqual(requests, [
    { route, a2b: true, byAmountIn: true, amount: 500_000n },
  ]);
  assert.deepEqual(quote, {
    venue: "cetus",
    network: "localnet",
    deploymentFingerprint: deploymentFingerprint(deployment),
    route,
    side: "buy",
    a2b: true,
    inputType: BLAST_CETUS.quoteType,
    outputType: BLAST_CETUS.memeType,
    amountIn: 500_000n,
    amountOut: 4_134_974_719_718_610n,
    // floor(4,134,974,719,718,610 x 9,900 / 10,000)
    minimumOut: 4_093_624_972_521_423n,
    slippageBps: 100n,
    feeAmount: 5_000n,
    priceBefore: cetusVenuePrice(pool.currentSqrtPrice, false),
    priceAfter: cetusVenuePrice(buyEvent.afterSqrtPrice, false),
    // floor(|after - before| x 10,000 / before) of the exact prices
    priceImpactBps: 449n,
    quotedAtMs: 1_790_338_000_000n,
    expiresAtMs: 1_790_338_030_000n,
    sender: BLAST_CETUS.buy.sender,
    balances: { quote: 1_000_000n, meme: 0n },
  });
  const withoutPrice = normalizeCetusQuote({
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
    providerQuote: Partial<CetusProviderQuote>,
    request: Partial<CetusQuoteRequest> = {},
    quotedPool = pool,
  ) =>
    assert.throws(
      () =>
        normalizeCetusQuote({
          route,
          pool: quotedPool,
          request: { ...buyRequest, ...request },
          providerQuote: { ...buyProviderQuote, ...providerQuote },
        }),
      (error) => error instanceof CetusVenueError && error.code === code,
      `${code} ${JSON.stringify(Object.keys({ ...providerQuote, ...request }))}`,
    );

  rejects("route-substitution", { poolId: BLAST_CETUS.vaultId });
  rejects(
    "route-substitution",
    {},
    {},
    { ...pool, objectId: BLAST_CETUS.vaultId },
  );
  rejects("invalid-quote", { a2b: false });
  rejects("invalid-quote", { byAmountIn: false });
  rejects("invalid-quote", { isExceed: true });
  rejects("invalid-quote", { amountIn: 499_999n });
  rejects("invalid-quote", { feeAmount: 500_001n });
  rejects("invalid-quote", { amountOut: 1n });
  rejects("invalid-quote", {}, { slippageBps: 10_000n });
  rejects("invalid-quote", {}, { validForMs: 0n });
  rejects("invalid-quote", {}, { balances: { quote: 499_999n, meme: 0n } });
});

/** A node's report of the manifest's chain and shared objects, each of its expected type. */
function runtimeFor(input: BlastDeploymentInput): DeploymentRuntimeObservation {
  const original = (name: string) => input.packages[name]!.originalPackageId;
  const types: Record<string, string> = {
    packageVersion: `${original("launchpad")}::package_version::PackageVersion`,
    launchConfig: `${original("launchpad")}::launch_config::LaunchConfig`,
    runtimeConfig: `${original("launchpad")}::runtime_config::RuntimeConfig`,
    acl: `${original("admin")}::blast_acl::ACL`,
    migratorsPackageVersion: `${original("migrators")}::package_version::PackageVersion`,
    lpFeePolicy: `${original("migrators")}::lp_fee_policy::LpFeePolicy`,
    venueConfig: `${original("migrators")}::venue_config::VenueConfig`,
    cetusConfig: `${original("cetusClmm")}::config::GlobalConfig`,
  };
  return {
    chainIdentifier: input.chainIdentifier,
    sharedObjects: Object.fromEntries(
      Object.entries(input.sharedObjects).map(([name, identity]) => [
        name,
        {
          objectId: identity.objectId,
          type: types[name]!,
          initialSharedVersion: String(identity.initialSharedVersion),
        },
      ]),
    ),
  };
}

const access = evaluateProtocolAccess({
  manifest,
  mode: "non-production",
  runtime: runtimeFor(manifest),
});
const buyQuote = normalizeCetusQuote({
  route,
  pool,
  request: buyRequest,
  providerQuote: buyProviderQuote,
});
const beforeExpiry = buyQuote.expiresAtMs - 1n;

test("builds the quoted buy as one exact-input Cetus flash swap", () => {
  assert.equal(access.signing, "enabled");
  const tx = buildCetusSwapTransaction({
    access,
    route,
    quote: buyQuote,
    nowMs: beforeExpiry,
  });
  const data = tx.getData();
  const [coinA, coinB] = [BLAST_CETUS.quoteType, BLAST_CETUS.memeType];
  assert.equal(data.sender, BLAST_CETUS.buy.sender);
  assert.deepEqual(
    data.commands.map((command) =>
      command.$kind === "MoveCall"
        ? `${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}<${command.MoveCall.typeArguments.join(",")}>`
        : command.$kind,
    ),
    [
      "$Intent",
      `${normalizeSuiObjectId("0x2")}::coin::into_balance<${coinA}>`,
      `${CETUS_LINEAGE.packageId}::pool::flash_swap<${coinA},${coinB}>`,
      `${CETUS_LINEAGE.packageId}::pool::swap_pay_amount<${coinA},${coinB}>`,
      `${normalizeSuiObjectId("0x2")}::balance::split<${coinA}>`,
      `${normalizeSuiObjectId("0x2")}::balance::destroy_zero<${coinA}>`,
      `${normalizeSuiObjectId("0x2")}::balance::zero<${coinB}>`,
      `${CETUS_LINEAGE.packageId}::pool::repay_flash_swap<${coinA},${coinB}>`,
      `${normalizeSuiObjectId("0x2")}::balance::destroy_zero<${coinA}>`,
      `${normalizeSuiObjectId("0x2")}::coin::from_balance<${coinB}>`,
      "SplitCoins",
      "MergeCoins",
      "TransferObjects",
    ],
  );
  const intent = data.commands[0]!;
  assert.ok(intent.$kind === "$Intent");
  assert.deepEqual(intent.$Intent.data, {
    type: coinA,
    balance: 500_000n,
    outputKind: "coin",
  });
  const flashSwap = data.commands[2]!;
  assert.ok(flashSwap.$kind === "MoveCall");
  assert.deepEqual(
    flashSwap.MoveCall.arguments.map((argument) => describe(tx, argument)),
    [
      `shared:${CETUS_LINEAGE.globalConfig.objectId}@1574190`,
      `shared-mut:${BLAST_CETUS.pool.objectId}@${BLAST_CETUS.pool.initialSharedVersion}`,
      "bool:true",
      "bool:true",
      "u64:500000",
      `u128:${CETUS_MIN_SQRT_PRICE_X64}`,
      `shared:${SUI_CLOCK_OBJECT_ID}@1`,
    ],
  );
  const split = data.commands[10]!;
  assert.ok(split.$kind === "SplitCoins");
  assert.deepEqual(
    describe(tx, split.SplitCoins.amounts[0]!, "u64"),
    "u64:4093624972521423",
  );
  const transfer = data.commands[12]!;
  assert.ok(transfer.$kind === "TransferObjects");
  assert.equal(
    describe(tx, transfer.TransferObjects.address, "address"),
    `address:${BLAST_CETUS.buy.sender}`,
  );
});

test("builds a sell with the opposite direction and price limit", () => {
  const sellQuote = normalizeCetusQuote({
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
      a2b: false,
      amountIn: 1_000n,
      amountOut: 900n,
      feeAmount: 10n,
      afterSqrtPrice: null,
    },
  });
  const tx = buildCetusSwapTransaction({
    access,
    route,
    quote: sellQuote,
    nowMs: beforeExpiry,
  });
  const calls = tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall] : [],
    );
  const flashSwap = calls.find((call) => call.function === "flash_swap")!;
  assert.deepEqual(
    flashSwap.arguments.slice(2, 6).map((argument) => describe(tx, argument)),
    ["bool:false", "bool:true", "u64:1000", `u128:${CETUS_MAX_SQRT_PRICE_X64}`],
  );
  assert.deepEqual(
    calls
      .map(
        (call) =>
          `${call.module}::${call.function}<${call.typeArguments.join(",")}>`,
      )
      .slice(4),
    [
      `balance::destroy_zero<${BLAST_CETUS.memeType}>`,
      `balance::zero<${BLAST_CETUS.quoteType}>`,
      `pool::repay_flash_swap<${BLAST_CETUS.quoteType},${BLAST_CETUS.memeType}>`,
      `balance::destroy_zero<${BLAST_CETUS.memeType}>`,
      `coin::from_balance<${BLAST_CETUS.quoteType}>`,
    ],
  );
});

test("refuses to build before signing unless deployment, lineage, tier, route, expiry, and quote hold", () => {
  const rejects = (
    code: string,
    options: Partial<Parameters<typeof buildCetusSwapTransaction>[0]>,
  ) =>
    assert.throws(
      () =>
        buildCetusSwapTransaction({
          access,
          route,
          quote: buyQuote,
          nowMs: beforeExpiry,
          ...options,
        }),
      (error) => error instanceof CetusVenueError && error.code === code,
      code,
    );
  const foreign = `0x${"9".repeat(64)}`;

  rejects("signing-disabled", {
    access: evaluateProtocolAccess({ manifest, mode: "non-production" }),
  });
  const otherManifest = {
    ...manifest,
    routes: [{ venue: "cetus", tiers: [{ tickSpacing: 60, feeRate: "2500" }] }],
  } satisfies BlastDeploymentInput;
  rejects("deployment-mismatch", {
    access: evaluateProtocolAccess({
      manifest: otherManifest,
      mode: "non-production",
      runtime: runtimeFor(otherManifest),
    }),
  });
  rejects("foreign-lineage", {
    route: { ...route, cetusOriginalPackageId: foreign },
  });
  rejects("foreign-lineage", {
    route: {
      ...route,
      cetusConfig: { ...route.cetusConfig, objectId: foreign },
    },
  });
  rejects("unsupported-tier", { route: { ...route, tickSpacing: 60 } });
  rejects("route-substitution", {
    quote: {
      ...buyQuote,
      route: { ...route, pool: { ...route.pool, objectId: foreign } },
    },
  });
  rejects("route-substitution", { quote: { ...buyQuote, a2b: false } });
  rejects("expired-quote", { nowMs: buyQuote.expiresAtMs });
  rejects("invalid-quote", { quote: { ...buyQuote, minimumOut: 0n } });
  rejects("invalid-quote", {
    quote: { ...buyQuote, minimumOut: buyQuote.amountOut + 1n },
  });
});

function describe(
  tx: Transaction,
  argument: Parameters<Transaction["object"]>[0] | object,
  pureType: "u64" | "address" | null = null,
): string {
  const arg = argument as { $kind: string; Input?: number };
  assert.equal(arg.$kind, "Input");
  const input = tx.getData().inputs[arg.Input!]!;
  if (input.$kind === "Object" && input.Object.$kind === "SharedObject") {
    const shared = input.Object.SharedObject;
    return `${shared.mutable ? "shared-mut" : "shared"}:${shared.objectId}@${shared.initialSharedVersion}`;
  }
  assert.ok(input.$kind === "Pure");
  const bytes = fromBase64(input.Pure.bytes);
  if (pureType === "address") return `address:${bcs.Address.parse(bytes)}`;
  if (pureType === "u64" || bytes.length === 8)
    return `u64:${bcs.u64().parse(bytes)}`;
  if (bytes.length === 16) return `u128:${bcs.u128().parse(bytes)}`;
  return `bool:${bcs.bool().parse(bytes)}`;
}

/** A completed fixture swap as the Core API returns it with `include: { events: true }`. */
function completed(swap: typeof BLAST_CETUS.buy | typeof BLAST_CETUS.sell) {
  return {
    digest: swap.transactionDigest,
    status: { success: true as const, error: null },
    events: [
      {
        packageId: CETUS_LINEAGE.packageId,
        module: "pool",
        sender: swap.sender,
        eventType: `${CETUS_LINEAGE.originalPackageId}::pool::SwapEvent`,
        bcs: fromHex(swap.bcs),
        json: null,
      },
    ],
  };
}

const sellEvent = decodeCetusSwapEvent(
  completed(BLAST_CETUS.sell).events[0]!,
  CETUS_LINEAGE.originalPackageId,
);
const sellQuote = normalizeCetusQuote({
  route,
  pool: { ...pool, currentSqrtPrice: sellEvent.beforeSqrtPrice },
  request: {
    side: "sell",
    amountIn: BigInt(BLAST_CETUS.sell.checks.amountIn),
    slippageBps: 50n,
    validForMs: 30_000n,
    sender: BLAST_CETUS.sell.sender,
    balances: { quote: 0n, meme: BigInt(BLAST_CETUS.sell.checks.amountIn) },
  },
  providerQuote: {
    poolId: BLAST_CETUS.pool.objectId,
    a2b: false,
    byAmountIn: true,
    amountIn: sellEvent.amountIn,
    amountOut: sellEvent.amountOut,
    feeAmount: sellEvent.feeAmount,
    afterSqrtPrice: sellEvent.afterSqrtPrice,
    isExceed: false,
    quotedAtMs: 1_790_338_060_000n,
  },
});

test("reconciles the fixture's completed Cetus buy and sell into exact trade facts", () => {
  assert.deepEqual(reconcileCetusSwap(completed(BLAST_CETUS.buy), buyQuote), {
    venue: "cetus",
    digest: "5k33Q4EUqK1job8VbtKThLzKj68EoUepNjm9kXXg1qNs",
    eventIndex: 0,
    sender: BLAST_CETUS.buy.sender,
    pool: BLAST_CETUS.pool.objectId,
    memeType: BLAST_CETUS.memeType,
    quoteType: BLAST_CETUS.quoteType,
    side: "buy",
    quoteAmount: 500_000n,
    memeAmount: 4_134_974_719_718_610n,
    // 1% of the input, in USDC
    quoteFee: 5_000n,
    memeFee: 0n,
    priceBefore: cetusVenuePrice(pool.currentSqrtPrice, false),
    priceAfter: cetusVenuePrice(buyEvent.afterSqrtPrice, false),
    partner: normalizeSuiObjectId("0x0"),
    refAmount: 0n,
  });
  const sell = reconcileCetusSwap(completed(BLAST_CETUS.sell), sellQuote);
  assert.deepEqual(
    {
      side: sell.side,
      memeAmount: sell.memeAmount,
      quoteAmount: sell.quoteAmount,
      memeFee: sell.memeFee,
      quoteFee: sell.quoteFee,
      digest: sell.digest,
    },
    {
      side: "sell",
      memeAmount: 14_805_321_558_750_365n,
      quoteAmount: 1_662_556n,
      // ceil(1% of the input), in Meme
      memeFee: 148_053_215_587_504n,
      quoteFee: 0n,
      digest: "7PFrpxq5miWGiBfZstjAa85KGNP4cPzMnnJcaY71ESXf",
    },
  );
  // The sell starts where the buy left the pool.
  assert.deepEqual(
    sell.priceBefore,
    cetusVenuePrice(buyEvent.afterSqrtPrice, false),
  );
});

test("refuses completed effects that are not the quoted swap", () => {
  const buy = completed(BLAST_CETUS.buy);
  const [event] = buy.events;
  const rejects = (
    transaction: ReturnType<typeof completed>,
    quote = buyQuote,
  ) =>
    assert.throws(
      () => reconcileCetusSwap(transaction, quote),
      (error) =>
        error instanceof CetusVenueError && error.code === "effects-mismatch",
    );

  rejects({
    ...buy,
    status: { success: false, error: { $kind: "Unknown", message: "aborted" } },
  } as unknown as ReturnType<typeof completed>);
  rejects({ ...buy, events: [] });
  rejects({ ...buy, events: [event!, event!] });
  rejects({
    ...buy,
    events: [{ ...event!, eventType: `0x${"9".repeat(64)}::pool::SwapEvent` }],
  });
  rejects(completed(BLAST_CETUS.sell));
  rejects({ ...buy, events: [{ ...event!, sender: BLAST_CETUS.sell.sender }] });
  rejects(buy, { ...buyQuote, amountIn: 499_999n });
  rejects(buy, { ...buyQuote, minimumOut: buyEvent.amountOut + 1n });
  rejects(buy, {
    ...buyQuote,
    route: { ...route, pool: { ...route.pool, objectId: BLAST_CETUS.vaultId } },
  });
});
