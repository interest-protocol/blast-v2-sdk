import {
  normalizeStructTag,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import {
  normalizeSharedObjectReference,
  normalizeSuiPackageReference,
} from "../lib/sui.ts";
import type {
  BoostsManifest,
  BoostsProductKey,
  BoostsProductManifest,
} from "./types.ts";
import { BOOSTS_PRODUCT_KEYS } from "./types.ts";

export const BOOSTS_PRODUCT_DEFINITIONS = {
  "sui-2x-bull": {
    name: "SUI 2x Bull",
    symbol: "SUI2L",
    direction: "bull",
    productTag: "SUI_BULL_2X",
  },
  "nvda-2x-bull": {
    name: "NVDA 2x Bull",
    symbol: "NVDA2L",
    direction: "bull",
    productTag: "NVDA_BULL_2X",
  },
  "zec-2x-bull": {
    name: "ZEC 2x Bull",
    symbol: "ZEC2L",
    direction: "bull",
    productTag: "ZEC_BULL_2X",
  },
} as const;

export function defineBoostsManifest(manifest: BoostsManifest): BoostsManifest {
  if (manifest.network !== "mainnet" && manifest.network !== "testnet") {
    throw new RangeError("Boosts network must be mainnet or testnet");
  }
  const chainIdentifier = requiredText(
    "chainIdentifier",
    manifest.chainIdentifier,
  );
  const adapterPackage = normalizeSuiPackageReference(
    "adapterPackage",
    manifest.adapterPackage,
  );
  const productsPackage = normalizeSuiPackageReference(
    "productsPackage",
    manifest.productsPackage,
  );
  const firstProduct = manifest.products[0];
  if (!firstProduct) {
    throw new TypeError(
      "Boosts manifest must contain at least one canonical Alpha product",
    );
  }
  let previousCanonicalIndex = -1;
  for (const { productKey } of manifest.products) {
    const canonicalIndex = BOOSTS_PRODUCT_KEYS.indexOf(productKey);
    if (canonicalIndex <= previousCanonicalIndex) {
      throw new TypeError(
        "Boosts manifest products must be unique and in canonical Alpha order",
      );
    }
    previousCanonicalIndex = canonicalIndex;
  }

  const products: BoostsManifest["products"] = [
    normalizeProduct(
      firstProduct,
      firstProduct.productKey,
      adapterPackage.originalPackageId,
      productsPackage.originalPackageId,
    ),
    ...manifest.products
      .slice(1)
      .map((product) =>
        normalizeProduct(
          product,
          product.productKey,
          adapterPackage.originalPackageId,
          productsPackage.originalPackageId,
        ),
      ),
  ];
  if (
    products.some(
      ({ collateralType }) => collateralType !== products[0].collateralType,
    )
  ) {
    throw new TypeError(
      "Boosts Alpha products must use the same collateral type",
    );
  }

  let explorerTransactionUrlPrefix: string;
  try {
    const url = new URL(manifest.explorerTransactionUrlPrefix);
    if (url.protocol !== "https:") throw new TypeError();
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    explorerTransactionUrlPrefix = url.toString();
  } catch {
    throw new TypeError("explorerTransactionUrlPrefix must be an HTTPS URL");
  }

  return Object.freeze({
    network: manifest.network,
    chainIdentifier,
    adapterPackage,
    productsPackage,
    explorerTransactionUrlPrefix,
    products: Object.freeze(products),
  });
}

export function getBoostsProduct(
  manifest: BoostsManifest,
  productKey: BoostsProductKey,
): BoostsProductManifest {
  const product = manifest.products.find(
    (entry) => entry.productKey === productKey,
  );
  if (!product) throw new RangeError(`unknown Boosts product: ${productKey}`);
  return product;
}

function normalizeProduct(
  product: BoostsProductManifest,
  key: BoostsProductKey,
  adapterOriginalPackageId: string,
  productsOriginalPackageId: string,
): BoostsProductManifest {
  const expected = BOOSTS_PRODUCT_DEFINITIONS[key];
  for (const field of ["name", "symbol", "direction", "productTag"] as const) {
    if (product[field] !== expected[field]) {
      throw new TypeError(`${key}.${field} must be ${expected[field]}`);
    }
  }
  if (product.collateralDecimals !== 6 || product.shareDecimals !== 9) {
    throw new TypeError(`${key} must use 6 collateral and 9 share decimals`);
  }
  if (product.expectedNavCapAtoms !== "1000000000") {
    throw new TypeError(`${key}.expectedNavCapAtoms must be 1000000000`);
  }

  const productType = normalizeStructTag(product.productType);
  const productTag = parseStructTag(productType);
  if (
    productTag.address !== normalizeSuiObjectId(productsOriginalPackageId) ||
    productTag.module !== "blast_boosts_products" ||
    productTag.name !== expected.productTag ||
    productTag.typeParams.length !== 0
  ) {
    throw new TypeError(`${key}.productType has an unexpected product tag`);
  }
  const collateralType = normalizeStructTag(product.collateralType);
  const expectedShareType = normalizeStructTag(
    `${adapterOriginalPackageId}::blast_boost::BlastBoost<${productType}>`,
  );
  if (normalizeStructTag(product.shareType) !== expectedShareType) {
    throw new TypeError(`${key}.shareType is not the adapter BlastBoost type`);
  }

  return Object.freeze({
    ...product,
    productType,
    collateralType,
    shareType: expectedShareType,
    vault: normalizeSharedObjectReference(`${key}.vault`, product.vault, true),
    treasuryCap: objectId(`${key}.treasuryCap`, product.treasuryCap),
    venueAccount: objectId(`${key}.venueAccount`, product.venueAccount),
    registry: objectId(`${key}.registry`, product.registry),
    clearingHouse: objectId(`${key}.clearingHouse`, product.clearingHouse),
    baseOracleStorage: objectId(
      `${key}.baseOracleStorage`,
      product.baseOracleStorage,
    ),
    collateralOracleStorage: objectId(
      `${key}.collateralOracleStorage`,
      product.collateralOracleStorage,
    ),
    baseFeedOrigin: objectId(`${key}.baseFeedOrigin`, product.baseFeedOrigin),
    collateralFeedOrigin: objectId(
      `${key}.collateralFeedOrigin`,
      product.collateralFeedOrigin,
    ),
    protocol: objectId(`${key}.protocol`, product.protocol),
    clock: objectId(`${key}.clock`, product.clock),
  });
}

function objectId(name: string, value: string): string {
  try {
    const normalized = normalizeSuiObjectId(value);
    if (BigInt(normalized) === 0n) throw new TypeError();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Sui object ID`);
  }
}

function requiredText(name: string, value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must not be empty`);
  }
  return value.trim();
}
