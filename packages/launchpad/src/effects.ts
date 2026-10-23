import type { SharedObjectReference } from "@interest-protocol/blast-core/sui";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

/**
 * The parts of one executed transaction these readers need: its effects and
 * the types of the objects they touched (Core API `include: { effects: true,
 * objectTypes: true }`). Effects are the authority for created objects, owners,
 * and versions; events never are.
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

/**
 * What a generated Meme package's publication created: the package, the
 * `LaunchTicket<Meme>` its initializer transferred to the publisher, and the
 * `Currency<Meme>` sent to the Coin Registry until `finalize_registration`
 * shares it.
 */
export type MemePublication = {
  packageId: string;
  memeType: string;
  ticket: ObjectVersionReference & { owner: string };
  pendingCurrency: ObjectVersionReference;
};

/** `sui::object::sui_coin_registry_address()`. */
export const COIN_REGISTRY_ID = normalizeSuiObjectId("0xc");

/** Reads a Meme publication's package, ticket, and pending currency from its effects. */
export function readMemePublication(
  result: TransactionEffectsInput,
  launchpadOriginalPackageId: string,
): MemePublication {
  const created = createdObjects(result);
  const packages = created.filter(
    (object) => object.outputState === "PackageWrite",
  );
  if (packages.length !== 1) {
    throw new TypeError("publication must create exactly one package");
  }
  const packageId = normalizeSuiObjectId(packages[0]!.objectId);
  const launchpad = normalizeSuiAddress(launchpadOriginalPackageId);
  const tickets = created.flatMap((object) => {
    const tag = typeOf(result, object.objectId);
    return tag?.address === launchpad &&
      tag.module === "launch_ticket" &&
      tag.name === "LaunchTicket"
      ? [{ object, tag }]
      : [];
  });
  if (tickets.length !== 1) {
    throw new TypeError(
      "publication must create exactly one LaunchTicket of this launchpad",
    );
  }
  const [{ object: ticket, tag: ticketTag }] = tickets as [
    (typeof tickets)[number],
  ];
  const meme = ticketTag.typeParams[0];
  if (
    meme === undefined ||
    typeof meme === "string" ||
    meme.address !== packageId
  ) {
    throw new TypeError("launch ticket is not from the published package");
  }
  const memeType = normalizeStructTag(meme);
  if (ticket.outputOwner?.$kind !== "AddressOwner") {
    throw new TypeError("launch ticket must be address-owned");
  }
  const currencies = created.filter(
    (object) =>
      isCurrencyOf(result, object.objectId, memeType) &&
      object.outputOwner?.$kind === "AddressOwner" &&
      normalizeSuiAddress(object.outputOwner.AddressOwner) === COIN_REGISTRY_ID,
  );
  if (currencies.length !== 1) {
    throw new TypeError(
      "publication must send exactly one Currency<Meme> to the Coin Registry",
    );
  }
  return {
    packageId,
    memeType,
    ticket: {
      ...versionReference(ticket),
      owner: normalizeSuiAddress(ticket.outputOwner.AddressOwner),
    },
    pendingCurrency: versionReference(currencies[0]!),
  };
}

/**
 * Reads the shared `Currency<Meme>` that `coin_registry::finalize_registration`
 * created at its derived address; mutable for `launch::finalize`.
 */
export function readCurrencyRegistration(
  result: TransactionEffectsInput,
  memeType: string,
): SharedObjectReference<true> {
  const meme = normalizeStructTag(memeType);
  const currencies = createdObjects(result).filter(
    (object) =>
      object.outputOwner?.$kind === "Shared" &&
      isCurrencyOf(result, object.objectId, meme),
  );
  if (currencies.length !== 1) {
    throw new TypeError("registration must share exactly one Currency<Meme>");
  }
  return sharedReference(currencies[0]!);
}

/** Reads the one shared `Launch<Meme, Quote>` a creation transaction produced. */
export function readLaunchCreation(
  result: TransactionEffectsInput,
  launchpadOriginalPackageId: string,
): {
  launch: SharedObjectReference<true>;
  memeType: string;
  quoteType: string;
} {
  const launchpad = normalizeSuiAddress(launchpadOriginalPackageId);
  const launches = createdObjects(result).flatMap((object) => {
    const tag = typeOf(result, object.objectId);
    return object.outputOwner?.$kind === "Shared" &&
      tag?.address === launchpad &&
      tag.module === "launch" &&
      tag.name === "Launch" &&
      tag.typeParams.length === 2
      ? [{ object, tag }]
      : [];
  });
  if (launches.length !== 1) {
    throw new TypeError("creation must create exactly one shared Launch");
  }
  const [{ object, tag }] = launches as [(typeof launches)[number]];
  const [meme, quote] = tag.typeParams;
  return {
    launch: sharedReference(object),
    memeType: normalizeStructTag(
      meme as Parameters<typeof normalizeStructTag>[0],
    ),
    quoteType: normalizeStructTag(
      quote as Parameters<typeof normalizeStructTag>[0],
    ),
  };
}

function createdObjects(
  result: TransactionEffectsInput,
): SuiClientTypes.ChangedObject[] {
  if (!result.effects.status.success) {
    throw new TypeError("transaction did not succeed");
  }
  return result.effects.changedObjects.filter(
    (object) => object.idOperation === "Created",
  );
}

function typeOf(result: TransactionEffectsInput, objectId: string) {
  const type =
    result.objectTypes[normalizeSuiObjectId(objectId)] ??
    result.objectTypes[objectId];
  return type === undefined ? undefined : parseStructTag(type);
}

function isCurrencyOf(
  result: TransactionEffectsInput,
  objectId: string,
  memeType: string,
): boolean {
  const tag = typeOf(result, objectId);
  const parameter = tag?.typeParams[0];
  return (
    tag?.address === normalizeSuiAddress("0x2") &&
    tag.module === "coin_registry" &&
    tag.name === "Currency" &&
    parameter !== undefined &&
    normalizeStructTag(parameter) === memeType
  );
}

function versionReference(
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

function sharedReference(
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
