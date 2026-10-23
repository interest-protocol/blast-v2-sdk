import assert from "node:assert/strict";
import test from "node:test";

import { BoostsClient } from "@interest-protocol/blast-boosts-sdk/client";
import {
  defineBoostsManifest,
  getBoostsProduct,
} from "@interest-protocol/blast-boosts-sdk/manifest";
import {
  decodeBoostsTreasurySupply,
  decodeBoostsVaultObject,
} from "@interest-protocol/blast-boosts-sdk/state";
import type {
  BoostsManifest,
  BoostsProductKey,
  BoostsProductRead,
  BoostsTransport,
} from "@interest-protocol/blast-boosts-sdk/types";
import {
  ADAPTER_ORIGINAL,
  BOOSTS_FIXTURE_MANIFEST,
  fixtureRead,
  PRODUCTS_ORIGINAL,
} from "./boosts-fixtures.ts";

test("validates nonempty canonical Alpha product subsets", () => {
  assert.deepEqual(
    BOOSTS_FIXTURE_MANIFEST.products.map(({ productKey }) => productKey),
    ["sui-2x-bull", "nvda-2x-bull", "zec-2x-bull"],
  );
  assert.deepEqual(
    defineBoostsManifest({
      ...BOOSTS_FIXTURE_MANIFEST,
      products: [BOOSTS_FIXTURE_MANIFEST.products[1]],
    }).products.map(({ productKey }) => productKey),
    ["nvda-2x-bull"],
  );
  assert.throws(
    () =>
      defineBoostsManifest({
        ...BOOSTS_FIXTURE_MANIFEST,
        products: [],
      } as unknown as BoostsManifest),
    /at least one canonical Alpha product/,
  );
  assert.throws(
    () =>
      defineBoostsManifest({
        ...BOOSTS_FIXTURE_MANIFEST,
        products: [
          BOOSTS_FIXTURE_MANIFEST.products[1],
          BOOSTS_FIXTURE_MANIFEST.products[1],
        ],
      }),
    /unique and in canonical Alpha order/,
  );
  assert.throws(
    () =>
      defineBoostsManifest({
        ...BOOSTS_FIXTURE_MANIFEST,
        products: [
          BOOSTS_FIXTURE_MANIFEST.products[2],
          BOOSTS_FIXTURE_MANIFEST.products[1],
        ],
      }),
    /unique and in canonical Alpha order/,
  );
  assert.throws(
    () =>
      defineBoostsManifest({
        ...BOOSTS_FIXTURE_MANIFEST,
        products: [
          {
            ...BOOSTS_FIXTURE_MANIFEST.products[0],
            productKey: "sui-2x-bear",
          },
        ] as unknown as BoostsManifest["products"],
      }),
    /unique and in canonical Alpha order/,
  );
  assert.throws(
    () =>
      defineBoostsManifest({
        ...BOOSTS_FIXTURE_MANIFEST,
        adapterPackage: {
          ...BOOSTS_FIXTURE_MANIFEST.adapterPackage,
          packageId: "0x0",
        },
      }),
    /adapterPackage\.packageId must not be the zero address/,
  );
  const bull = BOOSTS_FIXTURE_MANIFEST.products[0];
  assert.throws(
    () =>
      defineBoostsManifest({
        ...BOOSTS_FIXTURE_MANIFEST,
        products: [
          {
            ...bull,
            productType: `${PRODUCTS_ORIGINAL}::products::SUI_BULL_2X`,
            shareType: `${ADAPTER_ORIGINAL}::blast_boost::BlastBoost<${PRODUCTS_ORIGINAL}::products::SUI_BULL_2X>`,
          },
          BOOSTS_FIXTURE_MANIFEST.products[1],
          BOOSTS_FIXTURE_MANIFEST.products[2],
        ],
      }),
    /unexpected product tag/,
  );
});

test("decodes exact vault identity, lifecycle, supply, and current economics", async () => {
  for (const [moveLifecycle, lifecycle] of [
    ["Active", "active"],
    ["Unwinding", "unwinding"],
    ["Settled", "settled"],
  ] as const) {
    const read = fixtureRead("sui-2x-bull", { lifecycle: moveLifecycle });
    const product = getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, "sui-2x-bull");
    const vault = decodeBoostsVaultObject(
      read.vault,
      product,
      BOOSTS_FIXTURE_MANIFEST.adapterPackage.originalPackageId,
    );
    assert.equal(vault.lifecycle, lifecycle);
    assert.equal(
      decodeBoostsTreasurySupply(
        read.treasuryCap,
        product,
        BOOSTS_FIXTURE_MANIFEST.adapterPackage.originalPackageId,
      ),
      10_000_000_000n,
    );
  }

  const result = await new BoostsClient(
    transport(),
    BOOSTS_FIXTURE_MANIFEST,
  ).getProduct("sui-2x-bull");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.snapshot.economics, {
    shareholderNavAtoms: "10000000",
    sharePrice: { navAtoms: "10000000", supplyAtoms: "10000000000" },
    venueEquityAtoms: "10100000",
    maintenanceReserveAtoms: "100000",
    storedMaintenanceReserveAtoms: "100000",
    notionalAtoms: "20000000",
    leverageBps: "20000",
    health: "healthy",
  });
  assert.deepEqual(result.snapshot.supply, {
    currentAtoms: "10000000000",
    lockedSeedAtoms: "1000000000",
    userEligibleAtoms: "9000000000",
  });
  assert.deepEqual(result.snapshot.capacity, {
    navCapAtoms: "1000000000",
    liveNavCapAtoms: "1000000000",
    usedAtoms: "10000000",
    remainingAtoms: "990000000",
  });
  assert.deepEqual(result.snapshot.availability, {
    read: true,
    mint: true,
    redeem: true,
    rebalance: false,
    code: null,
  });
});

test("cap mismatch blocks only mint and eligible supply floors at zero", async () => {
  const read = fixtureRead("sui-2x-bull", {
    navCapAtoms: 999_999_999n,
    currentSupplyAtoms: 0n,
    lockedSharesAtoms: 1_000n,
  });
  const result = await new BoostsClient(
    transport(() => read),
    BOOSTS_FIXTURE_MANIFEST,
  ).getProduct("sui-2x-bull");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.availability.mint, false);
  assert.equal(result.snapshot.availability.redeem, true);
  assert.equal(result.snapshot.availability.code, "CAP_CONFIGURATION_MISMATCH");
  assert.equal(result.snapshot.supply.currentAtoms, "0");
  assert.equal(result.snapshot.supply.userEligibleAtoms, "0");
});

test("classifies corrupted binding, checkpoint, price, and zero NAV without a fake zero snapshot", async () => {
  const base = fixtureRead("sui-2x-bull");
  const cases: Array<[string, BoostsProductRead]> = [
    [
      "BINDING_MISMATCH",
      {
        ...base,
        market: {
          ...base.market,
          binding: { ...base.market.binding, registryId: "0x999" },
        },
      },
    ],
    [
      "CHECKPOINT_DRIFT",
      {
        ...base,
        market: {
          ...base.market,
          checkpoint: { ...base.market.checkpoint, freeCollateral: 1n },
        },
      },
    ],
    [
      "STALE_PRICE",
      {
        ...base,
        market: {
          ...base.market,
          baseOracle: { ...base.market.baseOracle, publishTimeMs: 900_000n },
        },
      },
    ],
    [
      "FUTURE_PRICE",
      {
        ...base,
        market: {
          ...base.market,
          baseOracle: { ...base.market.baseOracle, publishTimeMs: 1_001_001n },
        },
      },
    ],
    [
      "EXCESSIVE_CONFIDENCE",
      {
        ...base,
        market: {
          ...base.market,
          baseOracle: { ...base.market.baseOracle, confidence: 21_000_000n },
        },
      },
    ],
    [
      "MARK_DIVERGENCE",
      { ...base, market: { ...base.market, markPrice: 3_000_000_000n } },
    ],
    [
      "INVALID_NAV",
      { ...base, market: { ...base.market, venueEquityAtoms: 100_000n } },
    ],
  ];

  for (const [code, read] of cases) {
    const result = await new BoostsClient(
      transport(() => read),
      BOOSTS_FIXTURE_MANIFEST,
    ).getProduct("sui-2x-bull");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, code);
      assert.equal(result.observation?.checkpoint, "10");
    }
  }
});

test("accepts contract-clean funding progression and rejects unexplained checkpoint drift", async () => {
  const base = fixtureRead("sui-2x-bull");
  const cleanRates = {
    ...base,
    market: {
      ...base.market,
      checkpoint: { ...base.market.checkpoint, marketFundingLong: 7n },
    },
  };
  const cleanSettlement = {
    ...base,
    market: {
      ...base.market,
      checkpoint: {
        ...base.market.checkpoint,
        allocatedCollateral: 1_000_000_000_000n,
        fundingSnapshotLong: 7n,
        marketFundingLong: 8n,
      },
    },
  };
  for (const read of [cleanRates, cleanSettlement]) {
    const result = await new BoostsClient(
      transport(() => read),
      BOOSTS_FIXTURE_MANIFEST,
    ).getProduct("sui-2x-bull");
    assert.equal(result.ok, true);
  }

  const dirty = {
    ...base,
    market: {
      ...base.market,
      checkpoint: {
        ...base.market.checkpoint,
        allocatedCollateral: 1_000_000_000_000n,
      },
    },
  };
  const result = await new BoostsClient(
    transport(() => dirty),
    BOOSTS_FIXTURE_MANIFEST,
  ).getProduct("sui-2x-bull");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "CHECKPOINT_DRIFT");
});

test("rounds notional and conservative leverage up at atomic boundaries", async () => {
  const base = fixtureRead("sui-2x-bull");
  const read: BoostsProductRead = {
    ...base,
    market: {
      ...base.market,
      venueEquityAtoms: 17n,
      positionBaseAtoms: 1_000_000n,
      baseOracle: { ...base.market.baseOracle, price: 1n, confidence: 0n },
      collateralOracle: {
        ...base.market.collateralOracle,
        price: 3n,
        confidence: 0n,
      },
      markPrice: 1n,
    },
  };
  const result = await new BoostsClient(
    transport(() => read),
    BOOSTS_FIXTURE_MANIFEST,
  ).getProduct("sui-2x-bull");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.economics.shareholderNavAtoms, "1");
  assert.equal(result.snapshot.economics.notionalAtoms, "334");
  assert.equal(result.snapshot.economics.leverageBps, "3340000");
});

function transport(
  read: (productKey: BoostsProductKey) => BoostsProductRead = fixtureRead,
): BoostsTransport {
  return {
    readProduct: async (product) => read(product.productKey),
    getChainIdentifier: async () => "fixture-chain",
    getBalance: async () => "0",
    listEvents: async () => ({
      events: [],
      hasNextPage: false,
      startCursor: null,
      endCursor: null,
    }),
    getIndexedTransaction: async () => null,
  };
}
