import type { SuiClientTypes } from "@mysten/sui/client";
import type { Transaction, TransactionResult } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
  SUI_FRAMEWORK_ADDRESS,
} from "@mysten/sui/utils";
import type { SharedObjectIdentity, SharedObjectReference } from "./sui.ts";
import { normalizeSharedObjectIdentity } from "./sui.ts";

// Effects readers shared by every generated-package publication: a product's
// coin package creates its currency through the product, which seals the
// `TreasuryCap` under `blast_core::sealed_treasury_cap`, and sends the
// `Currency` to the Coin Registry. Effects are the authority for created
// objects, owners and versions; events never are.

/**
 * The parts of one executed transaction these readers need: its effects and
 * the types of the objects they touched (Core API `include: { effects: true,
 * objectTypes: true }`).
 */
export type TransactionEffectsInput = {
  effects: SuiClientTypes.TransactionEffects;
  objectTypes: Readonly<Record<string, string>>;
};

/** An owned or receiving object at one version. */
export type ObjectVersionReference = {
  objectId: string;
  version: string;
  digest: string;
};

/** `sui::object::sui_coin_registry_address()`. */
export const COIN_REGISTRY_ID = normalizeSuiObjectId("0xc");

/** The objects a successful transaction created. */
export function createdObjects(
  result: TransactionEffectsInput,
): SuiClientTypes.ChangedObject[] {
  if (!result.effects.status.success) {
    throw new TypeError("transaction did not succeed");
  }
  return result.effects.changedObjects.filter(
    (object) => object.idOperation === "Created",
  );
}

/** The one package a publication created. */
export function readPublishedPackage(
  created: readonly SuiClientTypes.ChangedObject[],
): string {
  const packages = created.filter(
    (object) => object.outputState === "PackageWrite",
  );
  if (packages.length !== 1) {
    throw new TypeError("publication must create exactly one package");
  }
  return normalizeSuiObjectId(packages[0]!.objectId);
}

/** The parsed type of a touched object, or undefined for a package. */
export function typeOf(
  result: TransactionEffectsInput,
  objectId: string,
): ReturnType<typeof parseStructTag> | undefined {
  const type =
    result.objectTypes[normalizeSuiObjectId(objectId)] ??
    result.objectTypes[objectId];
  return type === undefined || type === "package"
    ? undefined
    : parseStructTag(type);
}

/** Whether the object is `0x2::coin_registry::Currency<coinType>`. */
export function isCurrencyOf(
  result: TransactionEffectsInput,
  objectId: string,
  coinType: string,
): boolean {
  const tag = typeOf(result, objectId);
  const parameter = tag?.typeParams[0];
  return (
    tag?.address === normalizeSuiAddress(SUI_FRAMEWORK_ADDRESS) &&
    tag.module === "coin_registry" &&
    tag.name === "Currency" &&
    tag.typeParams.length === 1 &&
    parameter !== undefined &&
    normalizeStructTag(parameter) === coinType
  );
}

/**
 * The `<core>::sealed_treasury_cap::SealedTreasuryCap<Coin>` objects a
 * publication created, each with its sealed coin type, in effects order.
 */
export function sealedTreasuryCaps(
  result: TransactionEffectsInput,
  created: readonly SuiClientTypes.ChangedObject[],
  coreOriginalPackageId: string,
): { object: SuiClientTypes.ChangedObject; coinType: string }[] {
  const core = normalizeSuiAddress(coreOriginalPackageId);
  return created.flatMap((object) => {
    const tag = typeOf(result, object.objectId);
    const parameter = tag?.typeParams[0];
    return tag?.address === core &&
      tag.module === "sealed_treasury_cap" &&
      tag.name === "SealedTreasuryCap" &&
      parameter !== undefined &&
      typeof parameter !== "string"
      ? [{ object, coinType: normalizeStructTag(parameter) }]
      : [];
  });
}

/**
 * The one sealed `TreasuryCap<coinType>` a publication sent to `owner`;
 * `where` names the expectation in the error.
 */
export function readSealedTreasuryCap(
  result: TransactionEffectsInput,
  created: readonly SuiClientTypes.ChangedObject[],
  coreOriginalPackageId: string,
  coinType: string,
  owner: string,
  where: string,
): ObjectVersionReference & { owner: string } {
  const caps = sealedTreasuryCaps(result, created, coreOriginalPackageId)
    .filter(
      (cap) =>
        cap.coinType === coinType &&
        cap.object.outputOwner?.$kind === "AddressOwner" &&
        normalizeSuiAddress(cap.object.outputOwner.AddressOwner) === owner,
    )
    .map(({ object }) => object);
  const [cap] = caps;
  if (caps.length !== 1 || !cap) {
    throw new TypeError(
      `publication must send exactly one SealedTreasuryCap<Coin> ${where}`,
    );
  }
  return { ...versionReference(cap), owner };
}

/** The one `Currency<coinType>` a publication sent to the Coin Registry address. */
export function readPendingCurrency(
  result: TransactionEffectsInput,
  created: readonly SuiClientTypes.ChangedObject[],
  coinType: string,
): ObjectVersionReference {
  const currencies = created.filter(
    (object) =>
      isCurrencyOf(result, object.objectId, coinType) &&
      object.outputOwner?.$kind === "AddressOwner" &&
      normalizeSuiAddress(object.outputOwner.AddressOwner) === COIN_REGISTRY_ID,
  );
  if (currencies.length !== 1) {
    throw new TypeError(
      "publication must send exactly one Currency<Coin> to the Coin Registry",
    );
  }
  return versionReference(currencies[0]!);
}

/**
 * Reads the shared `Currency<coinType>` that
 * `coin_registry::finalize_registration` created at its derived address;
 * mutable for the product's `finalize`.
 */
export function readCurrencyRegistration(
  result: TransactionEffectsInput,
  coinType: string,
): SharedObjectReference<true> {
  const coin = normalizeStructTag(coinType);
  const currencies = createdObjects(result).filter(
    (object) =>
      object.outputOwner?.$kind === "Shared" &&
      isCurrencyOf(result, object.objectId, coin),
  );
  if (currencies.length !== 1) {
    throw new TypeError("registration must share exactly one Currency<Coin>");
  }
  return sharedReference(currencies[0]!);
}

/**
 * `0x2::coin_registry::finalize_registration<Coin>(registry, currency)`:
 * shares a published coin's pending `Currency` from the Coin Registry
 * address (`readPendingCurrency`). Anyone may run it; `coinRegistry` is the
 * shared registry `0xc` with its initial shared version, so it builds
 * offline.
 */
export function finalizeCurrencyRegistration(options: {
  coinType: string;
  currency: ObjectVersionReference;
  coinRegistry: SharedObjectIdentity;
}): (tx: Transaction) => TransactionResult {
  const coinType = normalizeStructTag(options.coinType);
  const currency = {
    objectId: normalizeSuiObjectId(options.currency.objectId),
    version: options.currency.version,
    digest: options.currency.digest,
  };
  const coinRegistry = normalizeSharedObjectIdentity(
    "coinRegistry",
    options.coinRegistry,
  );
  return (tx) =>
    tx.moveCall({
      target: `${SUI_FRAMEWORK_ADDRESS}::coin_registry::finalize_registration`,
      typeArguments: [coinType],
      arguments: [
        tx.sharedObjectRef({ ...coinRegistry, mutable: true }),
        tx.receivingRef(currency),
      ],
    });
}

/** An owned object's ID, output version and digest. */
export function versionReference(
  object: SuiClientTypes.ChangedObject,
): ObjectVersionReference {
  if (object.outputVersion === null || object.outputDigest === null) {
    throw new TypeError(`object ${object.objectId} has no output version`);
  }
  return {
    objectId: normalizeSuiObjectId(object.objectId),
    version: object.outputVersion,
    digest: object.outputDigest,
  };
}

/** A shared object's identity, borrowed mutably. */
export function sharedReference(
  object: SuiClientTypes.ChangedObject,
): SharedObjectReference<true> {
  if (object.outputOwner?.$kind !== "Shared") {
    throw new TypeError(`object ${object.objectId} is not shared`);
  }
  return {
    objectId: normalizeSuiObjectId(object.objectId),
    initialSharedVersion: object.outputOwner.Shared.initialSharedVersion,
    mutable: true,
  };
}
