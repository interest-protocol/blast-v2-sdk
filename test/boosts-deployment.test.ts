import assert from "node:assert/strict";
import test from "node:test";

import { BoostsClient } from "@interest-protocol/blast-boosts-sdk/client";
import {
  boostsDeploymentFingerprint,
  validateBoostsDeployment,
} from "@interest-protocol/blast-boosts-sdk/deployment";
import { defineBoostsManifest } from "@interest-protocol/blast-boosts-sdk/manifest";
import type {
  BoostsProductRead,
  BoostsTransport,
} from "@interest-protocol/blast-boosts-sdk/types";
import { BOOSTS_FIXTURE_MANIFEST, fixtureRead } from "./boosts-fixtures.ts";

test("validates all three active products and exact independent caps", async () => {
  const validation = await validateBoostsDeployment(
    new BoostsClient(transport(), BOOSTS_FIXTURE_MANIFEST),
    { requiredNetwork: "testnet" },
  );
  assert.equal(validation.fingerprint.length, 64);
  assert.deepEqual(
    validation.products.map(({ productKey, liveNavCapAtoms }) => [
      productKey,
      liveNavCapAtoms,
    ]),
    [
      ["sui-2x-bull", "1000000000"],
      ["nvda-2x-bull", "1000000000"],
      ["zec-2x-bull", "1000000000"],
    ],
  );
});

test("validates an NVDA-only configured deployment", async () => {
  const manifest = defineBoostsManifest({
    ...BOOSTS_FIXTURE_MANIFEST,
    products: [BOOSTS_FIXTURE_MANIFEST.products[1]],
  });
  const validation = await validateBoostsDeployment(
    new BoostsClient(transport(), manifest),
    { requiredNetwork: "testnet" },
  );

  assert.deepEqual(validation.products, [
    {
      productKey: "nvda-2x-bull",
      vault: manifest.products[0].vault.objectId,
      lifecycle: "active",
      liveNavCapAtoms: "1000000000",
    },
  ]);
});

test("fails startup validation on network unavailable lifecycle or cap mismatch", async () => {
  const client = new BoostsClient(transport(), BOOSTS_FIXTURE_MANIFEST);
  await assert.rejects(
    validateBoostsDeployment(client, { requiredNetwork: "mainnet" }),
    /must target mainnet/,
  );
  await assert.rejects(
    validateBoostsDeployment(
      new BoostsClient(
        transport((key) =>
          key === "nvda-2x-bull"
            ? fixtureRead(key, { lifecycle: "Unwinding" })
            : fixtureRead(key),
        ),
        BOOSTS_FIXTURE_MANIFEST,
      ),
    ),
    /nvda-2x-bull is not active/,
  );
  await assert.rejects(
    validateBoostsDeployment(
      new BoostsClient(
        transport((key) =>
          key === "zec-2x-bull"
            ? fixtureRead(key, { navCapAtoms: 999_999_999n })
            : fixtureRead(key),
        ),
        BOOSTS_FIXTURE_MANIFEST,
      ),
    ),
    /zec-2x-bull live NAV cap is not 1000000000/,
  );
  await assert.rejects(
    validateBoostsDeployment(
      new BoostsClient(
        transport(() => {
          throw new Error("rpc details");
        }),
        BOOSTS_FIXTURE_MANIFEST,
      ),
    ),
    /deployment validation failed/,
  );
  await assert.rejects(
    validateBoostsDeployment(
      new BoostsClient(
        transport(fixtureRead, { packageOriginalId: "0x999" }),
        BOOSTS_FIXTURE_MANIFEST,
      ),
    ),
    /package lineage does not match the manifest/,
  );
  await assert.rejects(
    validateBoostsDeployment(
      new BoostsClient(
        transport(fixtureRead, { shareDecimals: 8 }),
        BOOSTS_FIXTURE_MANIFEST,
      ),
    ),
    /share metadata does not match the manifest/,
  );
});

test("fingerprints normalized deployment identity and changes with any binding", () => {
  const normalized = defineBoostsManifest(BOOSTS_FIXTURE_MANIFEST);
  assert.equal(
    boostsDeploymentFingerprint(normalized),
    boostsDeploymentFingerprint(defineBoostsManifest(BOOSTS_FIXTURE_MANIFEST)),
  );
  const changed = defineBoostsManifest({
    ...BOOSTS_FIXTURE_MANIFEST,
    products: [
      { ...BOOSTS_FIXTURE_MANIFEST.products[0], venueAccount: "0x99" },
      BOOSTS_FIXTURE_MANIFEST.products[1],
      BOOSTS_FIXTURE_MANIFEST.products[2],
    ],
  });
  assert.notEqual(
    boostsDeploymentFingerprint(normalized),
    boostsDeploymentFingerprint(changed),
  );
});

function transport(
  read: (
    key: Parameters<typeof fixtureRead>[0],
  ) => BoostsProductRead = fixtureRead,
  options: Readonly<{
    packageOriginalId?: string;
    shareDecimals?: number;
  }> = {},
): BoostsTransport {
  return {
    readProduct: async (product) => read(product.productKey),
    getChainIdentifier: async () => "fixture-chain",
    getPackageReference: async (packageId) => ({
      packageId,
      originalPackageId:
        options.packageOriginalId ??
        (packageId === BOOSTS_FIXTURE_MANIFEST.adapterPackage.packageId
          ? BOOSTS_FIXTURE_MANIFEST.adapterPackage.originalPackageId
          : BOOSTS_FIXTURE_MANIFEST.productsPackage.originalPackageId),
    }),
    getCoinMetadata: async (coinType) => {
      if (coinType === BOOSTS_FIXTURE_MANIFEST.products[0].collateralType) {
        return { decimals: 6, name: "USD Coin", symbol: "USDC" };
      }
      const product = BOOSTS_FIXTURE_MANIFEST.products.find(
        ({ shareType }) => shareType === coinType,
      );
      return product
        ? {
            decimals: options.shareDecimals ?? 9,
            name: product.name,
            symbol: product.symbol,
          }
        : null;
    },
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
