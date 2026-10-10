import { normalizeSuiObjectId } from "@mysten/sui/utils";
import { sha256 } from "@noble/hashes/sha2.js";
import type { BoostsClient } from "./client.ts";
import type {
  BoostsManifest,
  BoostsProductKey,
  BoostsProductSnapshotV1,
} from "./types.ts";

export type BoostsDeploymentValidation = Readonly<{
  fingerprint: string;
  network: BoostsManifest["network"];
  chainIdentifier: string;
  products: readonly [ValidatedBoostsProduct, ...ValidatedBoostsProduct[]];
}>;

type ValidatedBoostsProduct = Readonly<{
  productKey: BoostsProductKey;
  vault: string;
  lifecycle: "active";
  liveNavCapAtoms: "1000000000";
}>;

/**
 * Reads every configured product before a runtime is allowed to serve or sign.
 * The underlying client validates the full package/type/object/venue/oracle
 * binding; this release gate additionally requires every configured product
 * to be active and have its exact independent Alpha cap.
 */
export async function validateBoostsDeployment(
  client: BoostsClient,
  options: Readonly<{ requiredNetwork?: BoostsManifest["network"] }> = {},
): Promise<BoostsDeploymentValidation> {
  const manifest = client.manifest;
  if (options.requiredNetwork && manifest.network !== options.requiredNetwork) {
    throw new TypeError(
      `Boosts deployment must target ${options.requiredNetwork}`,
    );
  }
  // Complete the stateful observation before issuing the independent
  // package/metadata reads. Public gRPC endpoints may throttle the much
  // heavier simulation when all of these requests start together, masking a
  // healthy deployment as DATA_UNAVAILABLE.
  const results = await client.getProducts();
  const [
    adapterPackage,
    productsPackage,
    collateralMetadata,
    ...shareMetadata
  ] = await Promise.all([
    client.getPackageReference(manifest.adapterPackage.packageId),
    client.getPackageReference(manifest.productsPackage.packageId),
    client.getCoinMetadata(manifest.products[0].collateralType),
    ...manifest.products.map((product) =>
      client.getCoinMetadata(product.shareType),
    ),
  ]);
  validatePackageLineage(
    "adapterPackage",
    adapterPackage,
    manifest.adapterPackage,
  );
  validatePackageLineage(
    "productsPackage",
    productsPackage,
    manifest.productsPackage,
  );
  if (collateralMetadata?.decimals !== 6) {
    throw new TypeError(
      "Boosts collateral metadata must exist with 6 decimals",
    );
  }
  manifest.products.forEach((product, index) => {
    const metadata = shareMetadata[index];
    if (
      metadata?.decimals !== 9 ||
      metadata.name !== product.name ||
      metadata.symbol !== product.symbol
    ) {
      throw new TypeError(
        `${product.productKey} share metadata does not match the manifest`,
      );
    }
  });
  const [firstResult, ...remainingResults] = results;
  const products: BoostsDeploymentValidation["products"] = [
    validateConfiguredResult(firstResult, manifest.products[0].productKey),
    ...remainingResults.map((result, index) =>
      validateConfiguredResult(
        result,
        manifest.products[index + 1]?.productKey,
      ),
    ),
  ];

  return Object.freeze({
    fingerprint: boostsDeploymentFingerprint(manifest),
    network: manifest.network,
    chainIdentifier: manifest.chainIdentifier,
    products: Object.freeze(products),
  });
}

function validateConfiguredResult(
  result: Awaited<ReturnType<BoostsClient["getProduct"]>>,
  expectedKey: BoostsProductKey | undefined,
): ValidatedBoostsProduct {
  if (!expectedKey || !result.ok) {
    throw new TypeError(
      result.ok
        ? "Boosts deployment contains an unexpected product"
        : `Boosts deployment validation failed for ${result.productKey}: ${result.code}`,
    );
  }
  return validateProduct(result.snapshot, expectedKey);
}

function validatePackageLineage(
  name: string,
  actual: BoostsManifest["adapterPackage"],
  expected: BoostsManifest["adapterPackage"],
): void {
  if (
    normalizeSuiObjectId(actual.packageId) !==
      normalizeSuiObjectId(expected.packageId) ||
    normalizeSuiObjectId(actual.originalPackageId) !==
      normalizeSuiObjectId(expected.originalPackageId)
  ) {
    throw new TypeError(
      `${name} current/original package lineage does not match the manifest`,
    );
  }
}

/** Deterministic identity fingerprint; it is not live-state evidence. */
export function boostsDeploymentFingerprint(manifest: BoostsManifest): string {
  const identity = JSON.stringify({
    network: manifest.network,
    chainIdentifier: manifest.chainIdentifier,
    adapterPackage: manifest.adapterPackage,
    productsPackage: manifest.productsPackage,
    products: manifest.products.map((product) => ({
      productKey: product.productKey,
      productType: product.productType,
      collateralType: product.collateralType,
      shareType: product.shareType,
      vault: product.vault,
      treasuryCap: product.treasuryCap,
      venueAccount: product.venueAccount,
      registry: product.registry,
      clearingHouse: product.clearingHouse,
      baseOracleStorage: product.baseOracleStorage,
      collateralOracleStorage: product.collateralOracleStorage,
      baseFeedOrigin: product.baseFeedOrigin,
      collateralFeedOrigin: product.collateralFeedOrigin,
      protocol: product.protocol,
      clock: product.clock,
      collateralDecimals: product.collateralDecimals,
      shareDecimals: product.shareDecimals,
      expectedNavCapAtoms: product.expectedNavCapAtoms,
    })),
  });
  return Array.from(sha256(new TextEncoder().encode(identity)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function validateProduct(
  snapshot: BoostsProductSnapshotV1,
  expectedKey: BoostsProductKey,
): ValidatedBoostsProduct {
  if (snapshot.identity.productKey !== expectedKey) {
    throw new TypeError(
      `Boosts deployment product order mismatch at ${expectedKey}`,
    );
  }
  if (snapshot.lifecycle !== "active") {
    throw new TypeError(`${expectedKey} is not active`);
  }
  if (
    snapshot.capacity.navCapAtoms !== "1000000000" ||
    snapshot.capacity.liveNavCapAtoms !== "1000000000"
  ) {
    throw new TypeError(`${expectedKey} live NAV cap is not 1000000000`);
  }
  return Object.freeze({
    productKey: expectedKey,
    vault: snapshot.identity.vault,
    lifecycle: "active",
    liveNavCapAtoms: "1000000000",
  });
}
