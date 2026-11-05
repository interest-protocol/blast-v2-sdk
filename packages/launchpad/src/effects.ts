import type {
  ObjectVersionReference,
  TransactionEffectsInput,
} from "@interest-protocol/blast-core/effects";
import {
  createdObjects,
  readPendingCurrency,
  readPublishedPackage,
  readSealedTreasuryCap,
  sharedReference,
  typeOf,
} from "@interest-protocol/blast-core/effects";
import type { SharedObjectReference } from "@interest-protocol/blast-core/sui";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

/**
 * What a generated Meme package's publication created: the package, the
 * `LaunchTicket<Meme>` and the `SealedTreasuryCap<Meme>` its initializer
 * transferred to the publisher, and the `Currency<Meme>` sent to the Coin
 * Registry until `finalize_registration` shares it. `createLaunch` takes the
 * ticket and the sealed cap together; no raw `TreasuryCap` leaves the
 * publication.
 */
export type MemePublication = {
  packageId: string;
  memeType: string;
  ticket: ObjectVersionReference & { owner: string };
  sealedTreasuryCap: ObjectVersionReference & { owner: string };
  pendingCurrency: ObjectVersionReference;
};

/**
 * Reads a Meme publication's package, ticket, sealed treasury cap and pending
 * currency from its effects. `deployment` names the launchpad and core
 * packages whose types the ticket and the seal carry (a
 * `LaunchpadDeployment` is one).
 */
export function readMemePublication(
  result: TransactionEffectsInput,
  deployment: {
    originalPackageId: string;
    core: { originalPackageId: string };
  },
): MemePublication {
  const created = createdObjects(result);
  const packageId = readPublishedPackage(created);
  const launchpad = normalizeSuiAddress(deployment.originalPackageId);
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
  const owner = normalizeSuiAddress(ticket.outputOwner.AddressOwner);
  const sealedTreasuryCap = readSealedTreasuryCap(
    result,
    created,
    deployment.core.originalPackageId,
    memeType,
    owner,
    "beside the ticket",
  );
  return {
    packageId,
    memeType,
    ticket: { ...versionReferenceOf(ticket), owner },
    sealedTreasuryCap,
    pendingCurrency: readPendingCurrency(result, created, memeType),
  };
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

function versionReferenceOf(
  object: Parameters<typeof sharedReference>[0],
): ObjectVersionReference {
  if (object.outputVersion === null || object.outputDigest === null) {
    throw new TypeError(`object ${object.objectId} has no output version`);
  }
  return {
    objectId: normalizeSuiAddress(object.objectId),
    version: object.outputVersion,
    digest: object.outputDigest,
  };
}
