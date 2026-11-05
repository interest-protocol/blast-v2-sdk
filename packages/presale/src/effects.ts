import type {
  ObjectVersionReference,
  TransactionEffectsInput,
} from "@interest-protocol/blast-core/effects";
import {
  createdObjects,
  readPendingCurrency,
  readPublishedPackage,
  sealedTreasuryCaps,
  versionReference,
} from "@interest-protocol/blast-core/effects";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

/**
 * What a generated sale-token package's publication created: the package,
 * the `SealedTreasuryCap<SaleToken>` its initializer transferred to the
 * publisher, and the `Currency<SaleToken>` sent to the Coin Registry until
 * `finalize_registration` shares it. `createPresale` takes the sealed cap;
 * no raw `TreasuryCap` leaves the publication.
 */
export type PresaleCoinPublication = {
  packageId: string;
  saleTokenType: string;
  sealedTreasuryCap: ObjectVersionReference & { owner: string };
  pendingCurrency: ObjectVersionReference;
};

/**
 * Reads a sale-token publication's package, sealed treasury cap and pending
 * currency from its effects. `deployment` names the core package whose seal
 * the cap carries (a `PresaleDeployment` is one).
 */
export function readPresaleCoinPublication(
  result: TransactionEffectsInput,
  deployment: { core: { originalPackageId: string } },
): PresaleCoinPublication {
  const created = createdObjects(result);
  const packageId = readPublishedPackage(created);
  const caps = sealedTreasuryCaps(
    result,
    created,
    deployment.core.originalPackageId,
  ).filter((cap) => parseStructTag(cap.coinType).address === packageId);
  const [cap] = caps;
  if (caps.length !== 1 || !cap) {
    throw new TypeError(
      "publication must create exactly one SealedTreasuryCap of the published package",
    );
  }
  if (cap.object.outputOwner?.$kind !== "AddressOwner") {
    throw new TypeError("sealed treasury cap must be address-owned");
  }
  const owner = normalizeSuiAddress(cap.object.outputOwner.AddressOwner);
  return {
    packageId,
    saleTokenType: cap.coinType,
    sealedTreasuryCap: { ...versionReference(cap.object), owner },
    pendingCurrency: readPendingCurrency(result, created, cap.coinType),
  };
}
