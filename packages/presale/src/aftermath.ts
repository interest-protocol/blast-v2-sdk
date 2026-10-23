import { suiObjectIdBcs, u64Bcs } from "@interest-protocol/blast-core/bcs";
import type { SuiEventPosition } from "@interest-protocol/blast-core/events";
import {
  normalizeSuiEventPosition,
  suiEventId,
} from "@interest-protocol/blast-core/events";
import type {
  SharedObjectIdentity,
  SharedObjectReference,
} from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

// The Aftermath DAO-pool vendor package `blast_aftermath_dao_presale`
// (contracts ADR 0104): a partner's one-off migrator that creates
// `blast_presale` sales with its `AdminCap` and migrates each funded sale into
// a 50/50 Aftermath weighted pool wrapped in Aftermath's DAO-fee pool.

/** The vendor package's only module. */
export const AFTERMATH_PRESALE_MODULE = "blast_aftermath_dao_presale";

/**
 * Where the vendor package and the Aftermath objects its `migrate` takes live.
 * The package is immutable and published once, so its ID also names its
 * types. The Aftermath objects are configuration; `AFTERMATH_MAINNET_OBJECTS`
 * records the ones the package was reviewed against.
 */
export type AftermathPresaleDeployment = Readonly<{
  /** The published `blast_aftermath_dao_presale` package. */
  packageId: string;
  /** Aftermath AMM `pool_registry::PoolRegistry`, taken mutably. */
  poolRegistry: SharedObjectIdentity;
  /** Aftermath DAO-fee pools `version::Version`, taken read-only. */
  daoFeeVersion: SharedObjectIdentity;
}>;

/**
 * The Aftermath mainnet objects the vendor package's README records (as of
 * 2026-09-02), with the initial shared versions read from mainnet. Documented
 * defaults only: pass others to `defineAftermathPresaleDeployment` if
 * Aftermath moves them.
 */
export const AFTERMATH_MAINNET_OBJECTS = Object.freeze({
  poolRegistry: Object.freeze({
    objectId:
      "0xfcc774493db2c45c79f688f88d28023a3e7d98e4ee9f48bbf5c7990f651577ae",
    initialSharedVersion: "6808332",
  }),
  daoFeeVersion: Object.freeze({
    objectId:
      "0xb4bfb0f917f12ad2a772bea9b4f22431f6f5f9653162c3ae6fae5b99b21392b7",
    initialSharedVersion: "293243902",
  }),
});

/**
 * Normalizes and freezes the vendor configuration. `poolRegistry` and
 * `daoFeeVersion` default to `AFTERMATH_MAINNET_OBJECTS`.
 */
export function defineAftermathPresaleDeployment(options: {
  packageId: string;
  poolRegistry?: SharedObjectIdentity;
  daoFeeVersion?: SharedObjectIdentity;
}): AftermathPresaleDeployment {
  const { packageId } = normalizeSuiPackageReference("aftermath", {
    packageId: options.packageId,
    originalPackageId: options.packageId,
  });
  return Object.freeze({
    packageId,
    poolRegistry: Object.freeze(
      normalizeSharedObjectIdentity(
        "aftermath.poolRegistry",
        options.poolRegistry ?? AFTERMATH_MAINNET_OBJECTS.poolRegistry,
      ),
    ),
    daoFeeVersion: Object.freeze(
      normalizeSharedObjectIdentity(
        "aftermath.daoFeeVersion",
        options.daoFeeVersion ?? AFTERMATH_MAINNET_OBJECTS.daoFeeVersion,
      ),
    ),
  });
}

/**
 * `<packageId>::blast_aftermath_dao_presale::Witness`: the migration witness
 * its sales record and the `CreationPolicy` must allow.
 */
export function aftermathWitnessType(packageId: string): string {
  return normalizeStructTag(
    `${normalizeSuiAddress(packageId)}::${AFTERMATH_PRESALE_MODULE}::Witness`,
  );
}

// === Coin order ===

/**
 * Mirrors the vendor's `sorts_before<SaleToken, Quote>`: whether the sale
 * token is the Aftermath pool's first coin. Aftermath orders a pool's coins
 * by the bytes of their `type_name::with_defining_ids` names (64 hex digits,
 * no `0x`), a strict prefix first. Pass original (defining) type addresses.
 * Equal types return false, as in Move.
 */
export function aftermathSaleTokenFirst(
  memeType: string,
  quoteType: string,
): boolean {
  return definingTypeName(memeType) < definingTypeName(quoteType);
}

/** The pool's two coin types, `[coin_1, coin_2]`, in Aftermath's order. */
export function aftermathPoolCoinTypes(
  memeType: string,
  quoteType: string,
): [string, string] {
  const meme = normalizeStructTag(memeType);
  const quote = normalizeStructTag(quoteType);
  return aftermathSaleTokenFirst(meme, quote) ? [meme, quote] : [quote, meme];
}

/**
 * `type_name::with_defining_ids` text: every address as 64 hex digits without
 * `0x`. The names are ASCII, so JavaScript's code-unit order is their byte
 * order.
 */
function definingTypeName(type: string): string {
  return normalizeStructTag(parseStructTag(type)).replace(
    /0x([0-9a-f]{64})/g,
    "$1",
  );
}

// === Events ===

/** Both events the vendor package emits, in Move field order. */
export const aftermathPresaleEventSpecs = {
  [AFTERMATH_PRESALE_MODULE]: {
    PoolCreationReserved: {
      presale_id: "id",
      pool_creation_id: "id",
    },
    Migrated: {
      presale_id: "id",
      pool_id: "id",
      dao_fee_pool_id: "id",
      owner_cap_id: "id",
      lp_coin_id: "id",
      lp: "u64",
    },
  },
} as const satisfies Record<
  string,
  Record<string, Record<string, "id" | "u64">>
>;

type AftermathSpecs =
  (typeof aftermathPresaleEventSpecs)[typeof AFTERMATH_PRESALE_MODULE];
export type AftermathPresaleEventKind = keyof AftermathSpecs;

export type AftermathPresaleEventPayloads = {
  [Kind in AftermathPresaleEventKind]: {
    -readonly [Field in keyof AftermathSpecs[Kind]]: AftermathSpecs[Kind][Field] extends "u64"
      ? bigint
      : string;
  };
};

const FIELD_BCS = {
  id: suiObjectIdBcs as BcsType<unknown>,
  u64: u64Bcs as BcsType<unknown>,
};

export const aftermathPresaleEventBcs = Object.fromEntries(
  Object.entries(aftermathPresaleEventSpecs[AFTERMATH_PRESALE_MODULE]).map(
    ([kind, spec]) => [
      kind,
      bcs.struct(
        kind,
        Object.fromEntries(
          Object.entries(spec).map(([field, descriptor]) => [
            field,
            FIELD_BCS[descriptor],
          ]),
        ),
      ),
    ],
  ),
) as unknown as {
  [Kind in AftermathPresaleEventKind]: BcsType<
    AftermathPresaleEventPayloads[Kind],
    AftermathPresaleEventPayloads[Kind]
  >;
};

export type DecodedAftermathPresaleEvent = {
  [Kind in AftermathPresaleEventKind]: {
    source: "aftermath-presale";
    kind: Kind;
    payload: AftermathPresaleEventPayloads[Kind];
    /** The fresh Aftermath LP coin type, the events' `Lp` argument. */
    lpType: string;
    /** The sale's `SaleToken`. */
    memeType: string;
    quoteType: string;
    sender: string;
    position: SuiEventPosition;
  };
}[AftermathPresaleEventKind];

/**
 * Decodes one `<packageId>::blast_aftermath_dao_presale::<Kind><Lp, SaleToken,
 * Quote>` event.
 */
export function decodeAftermathPresaleEvent(
  event: SuiClientTypes.EventEntry,
  packages: { packageId: string },
): DecodedAftermathPresaleEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as AftermathPresaleEventKind;
  const [lpType, memeType, quoteType, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(packages.packageId) ||
    tag.module !== AFTERMATH_PRESALE_MODULE ||
    !Object.hasOwn(aftermathPresaleEventBcs, kind) ||
    lpType === undefined ||
    memeType === undefined ||
    quoteType === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(
      `unexpected Aftermath presale event type ${event.eventType}`,
    );
  }
  return {
    source: "aftermath-presale",
    kind,
    payload: aftermathPresaleEventBcs[kind].parse(event.bcs),
    lpType: normalizeStructTag(lpType),
    memeType: normalizeStructTag(memeType),
    quoteType: normalizeStructTag(quoteType),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedAftermathPresaleEvent;
}

export function aftermathPresaleEventId(
  event: DecodedAftermathPresaleEvent,
): string {
  return suiEventId(event.position);
}

// === The sale's pool-creation binding ===

/**
 * A sale's Aftermath binding: the shared `PoolCreation<Lp>` that `new`
 * reserved for it and only its `migrate` consumes. `poolCreation` is the
 * by-value (mutable) shared input `migrateAftermath` takes; null once the
 * migration consumed it.
 */
export type AftermathPoolCreation = {
  presaleId: string;
  poolCreationId: string;
  /** The fresh LP coin, `migrate`'s first type argument. */
  lpType: string;
  memeType: string;
  quoteType: string;
  poolCreation: SharedObjectReference<true> | null;
};

/**
 * Leading fields of `PoolCreation<Lp>`; its `create_pool_cap` follows, which
 * the SDK does not read.
 */
const poolCreationPrefixBcs = bcs.struct("PoolCreation", {
  id: suiObjectIdBcs,
  presale_id: suiObjectIdBcs,
});

export type AftermathPoolCreationObject = {
  objectId: string;
  initialSharedVersion: number | string;
  type: string;
  content: Uint8Array;
};

/**
 * Decodes a `<packageId>::blast_aftermath_dao_presale::PoolCreation<Lp>`. The
 * object has no `SaleToken` or `Quote`, so those come back empty; read them
 * from the sale or the `PoolCreationReserved` event.
 */
export function decodeAftermathPoolCreationObject(
  object: AftermathPoolCreationObject,
  packageId: string,
): Pick<
  AftermathPoolCreation,
  "presaleId" | "poolCreationId" | "lpType" | "poolCreation"
> {
  const tag = parseStructTag(object.type);
  const [lpType, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(packageId) ||
    tag.module !== AFTERMATH_PRESALE_MODULE ||
    tag.name !== "PoolCreation" ||
    lpType === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(
      `object ${object.objectId} is not an Aftermath PoolCreation`,
    );
  }
  const parsed = poolCreationPrefixBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (parsed.id !== objectId) {
    throw new TypeError(`object ${object.objectId} has a mismatched UID`);
  }
  const identity = normalizeSharedObjectIdentity(
    "poolCreation",
    object as SharedObjectIdentity,
  );
  return {
    presaleId: parsed.presale_id,
    poolCreationId: objectId,
    lpType: normalizeStructTag(lpType),
    poolCreation: { ...identity, mutable: true },
  };
}

/**
 * Reads a `PoolCreation` by ID; null once a migration consumed it. Throws if
 * the object exists but is not this package's `PoolCreation`.
 */
export async function getAftermathPoolCreation(
  client: ClientWithCoreApi,
  objectId: string,
  packageId: string,
): Promise<ReturnType<typeof decodeAftermathPoolCreationObject> | null> {
  let object: SuiClientTypes.Object<{ content: true }>;
  try {
    ({ object } = await client.core.getObject({
      objectId,
      include: { content: true },
    }));
  } catch (error) {
    // `migrate` deletes it; transports report that as deleted or not found.
    if (
      error instanceof ObjectError &&
      (error.reason === "deleted" || error.reason === "notFound")
    ) {
      return null;
    }
    throw error;
  }
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`object ${object.objectId} is not shared`);
  }
  return decodeAftermathPoolCreationObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      type: object.type,
      content: object.content,
    },
    packageId,
  );
}

/**
 * The binding a `PoolCreationReserved` event records for `presaleId`, or null
 * when none of `events` reserves it. Events from any other package are
 * skipped, so pass a transaction's or an indexer's whole list.
 */
export function aftermathReservationOf(
  events: readonly Pick<SuiClientTypes.Event, "eventType" | "bcs">[],
  presaleId: string,
  packageId: string,
): Omit<AftermathPoolCreation, "poolCreation"> | null {
  const presale = normalizeSuiObjectId(presaleId);
  const address = normalizeSuiAddress(packageId);
  for (const event of events) {
    let tag: ReturnType<typeof parseStructTag>;
    try {
      tag = parseStructTag(event.eventType);
    } catch {
      continue;
    }
    const [lpType, memeType, quoteType, ...extra] = tag.typeParams;
    if (
      tag.address !== address ||
      tag.module !== AFTERMATH_PRESALE_MODULE ||
      tag.name !== "PoolCreationReserved" ||
      lpType === undefined ||
      memeType === undefined ||
      quoteType === undefined ||
      extra.length > 0
    ) {
      continue;
    }
    const payload = aftermathPresaleEventBcs.PoolCreationReserved.parse(
      event.bcs,
    );
    if (payload.presale_id !== presale) continue;
    return {
      presaleId: presale,
      poolCreationId: payload.pool_creation_id,
      lpType: normalizeStructTag(lpType),
      memeType: normalizeStructTag(memeType),
      quoteType: normalizeStructTag(quoteType),
    };
  }
  return null;
}

/**
 * Finds `presaleId`'s Aftermath binding from its `PoolCreationReserved` event
 * and reads its `PoolCreation`. Pass `creationDigest`, the digest of the
 * transaction that created the sale (the `PresaleCreated` event's), to read
 * that one transaction's events; otherwise the package's
 * `PoolCreationReserved` events are scanned oldest first, `pageLimit` per
 * page. Null when the sale has no reservation: it is not an Aftermath sale,
 * or the digest is not its creation's. `poolCreation` is null once the sale
 * migrated.
 */
export async function findAftermathPoolCreation(
  client: ClientWithCoreApi,
  options: {
    presaleId: string;
    packageId: string;
    creationDigest?: string;
    pageLimit?: number;
  },
): Promise<AftermathPoolCreation | null> {
  const { presaleId, packageId } = options;
  const reservation =
    options.creationDigest === undefined
      ? await scanReservations(client, presaleId, packageId, options.pageLimit)
      : aftermathReservationOf(
          await transactionEvents(client, options.creationDigest),
          presaleId,
          packageId,
        );
  if (!reservation) return null;
  const object = await getAftermathPoolCreation(
    client,
    reservation.poolCreationId,
    packageId,
  );
  if (
    object &&
    (object.presaleId !== reservation.presaleId ||
      object.lpType !== reservation.lpType)
  ) {
    throw new TypeError(
      `PoolCreation ${reservation.poolCreationId} does not match its reservation`,
    );
  }
  return { ...reservation, poolCreation: object?.poolCreation ?? null };
}

async function transactionEvents(
  client: ClientWithCoreApi,
  digest: string,
): Promise<SuiClientTypes.Event[]> {
  const result = await client.core.getTransaction({
    digest,
    include: { events: true },
  });
  const transaction = result.Transaction ?? result.FailedTransaction;
  return transaction.events ?? [];
}

async function scanReservations(
  client: ClientWithCoreApi,
  presaleId: string,
  packageId: string,
  limit?: number,
): Promise<Omit<AftermathPoolCreation, "poolCreation"> | null> {
  const eventType = `${normalizeSuiAddress(packageId)}::${AFTERMATH_PRESALE_MODULE}::PoolCreationReserved`;
  let after: string | null = null;
  for (;;) {
    const page = await client.core.listEvents({
      filter: { eventType },
      after,
      ...(limit === undefined ? {} : { limit }),
    });
    const found = aftermathReservationOf(page.events, presaleId, packageId);
    if (found) return found;
    if (!page.hasNextPage || page.endCursor === null) return null;
    after = page.endCursor;
  }
}
