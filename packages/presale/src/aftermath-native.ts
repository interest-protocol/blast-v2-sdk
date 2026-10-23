import { suiObjectIdBcs } from "@interest-protocol/blast-core/bcs";
import type { SuiEventPosition } from "@interest-protocol/blast-core/events";
import {
  normalizeSuiEventPosition,
  suiEventId,
} from "@interest-protocol/blast-core/events";
import type {
  SharedObjectIdentity,
  SharedObjectReference,
} from "@interest-protocol/blast-core/sui";
import { normalizeSharedObjectIdentity } from "@interest-protocol/blast-core/sui";
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

/** Native adapter module inside the versioned presale package (FinalizeTicket ABI). */
const AFTERMATH_NATIVE_MODULE = "aftermath";

// === Events ===

/** Both events the native adapter emits, in Move field order. */
export const nativeAftermathEventSpecs = {
  [AFTERMATH_NATIVE_MODULE]: {
    PoolCreationReserved: {
      presale_id: "id",
      pool_creation_id: "id",
      create_pool_cap_id: "id",
    },
    DaoFeePoolCreated: {
      vault_id: "id",
      pool_id: "id",
      dao_fee_pool_id: "id",
      owner_cap_id: "id",
      lp_coin_id: "id",
    },
  },
} as const satisfies Record<string, Record<string, Record<string, "id">>>;

type AftermathSpecs =
  (typeof nativeAftermathEventSpecs)[typeof AFTERMATH_NATIVE_MODULE];
export type NativeAftermathEventKind = keyof AftermathSpecs;

export type NativeAftermathEventPayloads = {
  [Kind in NativeAftermathEventKind]: {
    -readonly [Field in keyof AftermathSpecs[Kind]]: string;
  };
};

const FIELD_BCS = {
  id: suiObjectIdBcs as BcsType<unknown>,
};

export const nativeAftermathEventBcs = Object.fromEntries(
  Object.entries(nativeAftermathEventSpecs[AFTERMATH_NATIVE_MODULE]).map(
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
  [Kind in NativeAftermathEventKind]: BcsType<
    NativeAftermathEventPayloads[Kind],
    NativeAftermathEventPayloads[Kind]
  >;
};

export type DecodedNativeAftermathEvent = {
  [Kind in NativeAftermathEventKind]: {
    source: "native-aftermath";
    kind: Kind;
    payload: NativeAftermathEventPayloads[Kind];
    /** The fresh Aftermath LP coin type, the events' `Lp` argument. */
    lpType: string;
    /** The sale's `SaleToken`. */
    memeType: string;
    quoteType: string;
    sender: string;
    position: SuiEventPosition;
  };
}[NativeAftermathEventKind];

/**
 * Decodes one `<originalPackageId>::aftermath::<Kind><Lp, SaleToken,
 * Quote>` event.
 */
export function decodeNativeAftermathEvent(
  event: SuiClientTypes.EventEntry,
  packages: { originalPackageId: string },
): DecodedNativeAftermathEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as NativeAftermathEventKind;
  const [lpType, memeType, quoteType, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(packages.originalPackageId) ||
    tag.module !== AFTERMATH_NATIVE_MODULE ||
    !Object.hasOwn(nativeAftermathEventBcs, kind) ||
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
    source: "native-aftermath",
    kind,
    payload: nativeAftermathEventBcs[kind].parse(event.bcs),
    lpType: normalizeStructTag(lpType),
    memeType: normalizeStructTag(memeType),
    quoteType: normalizeStructTag(quoteType),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedNativeAftermathEvent;
}

export function nativeAftermathEventId(
  event: DecodedNativeAftermathEvent,
): string {
  return suiEventId(event.position);
}

// === The sale's pool-creation binding ===

/**
 * A sale's Aftermath binding: the shared `PoolCreation<Lp, Meme, Quote>` that `finalize`
 * reserved for it and only its `migrate` consumes. `poolCreation` is the
 * by-value (mutable) shared input `migrateNativeAftermath` takes; null once the
 * migration consumed it.
 */
export type NativeAftermathPoolCreation = {
  presaleId: string;
  poolCreationId: string;
  createPoolCapId: string;
  /** The fresh LP coin, `migrate`'s first type argument. */
  lpType: string;
  memeType: string;
  quoteType: string;
  poolCreation: SharedObjectReference<true> | null;
};

/**
 * The capability begins with its UID; its type-name field follows this prefix.
 */
const poolCreationPrefixBcs = bcs.struct("PoolCreation", {
  id: suiObjectIdBcs,
  presale_id: suiObjectIdBcs,
  create_pool_cap_id: suiObjectIdBcs,
});

export type NativeAftermathPoolCreationObject = {
  objectId: string;
  initialSharedVersion: number | string;
  type: string;
  content: Uint8Array;
};

/**
 * Decodes a native `PoolCreation<Lp, Meme, Quote>` including the reserved capability UID.
 */
export function decodeNativeAftermathPoolCreationObject(
  object: NativeAftermathPoolCreationObject,
  originalPackageId: string,
): Pick<
  NativeAftermathPoolCreation,
  | "presaleId"
  | "poolCreationId"
  | "createPoolCapId"
  | "lpType"
  | "memeType"
  | "quoteType"
  | "poolCreation"
> {
  const tag = parseStructTag(object.type);
  const [lpType, memeType, quoteType, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(originalPackageId) ||
    tag.module !== AFTERMATH_NATIVE_MODULE ||
    tag.name !== "PoolCreation" ||
    lpType === undefined ||
    memeType === undefined ||
    quoteType === undefined ||
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
    createPoolCapId: parsed.create_pool_cap_id,
    memeType: normalizeStructTag(memeType),
    quoteType: normalizeStructTag(quoteType),
    lpType: normalizeStructTag(lpType),
    poolCreation: { ...identity, mutable: true },
  };
}

/**
 * Reads a `PoolCreation` by ID; null once a migration consumed it. Throws if
 * the object exists but is not this package's `PoolCreation`.
 */
export async function getNativeAftermathPoolCreation(
  client: ClientWithCoreApi,
  objectId: string,
  originalPackageId: string,
): Promise<ReturnType<typeof decodeNativeAftermathPoolCreationObject> | null> {
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
  return decodeNativeAftermathPoolCreationObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      type: object.type,
      content: object.content,
    },
    originalPackageId,
  );
}

/**
 * The binding a `PoolCreationReserved` event records for `presaleId`, or null
 * when none of `events` reserves it. Events from any other package are
 * skipped, so pass a transaction's or an indexer's whole list.
 */
export function nativeAftermathReservationOf(
  events: readonly Pick<SuiClientTypes.Event, "eventType" | "bcs">[],
  presaleId: string,
  originalPackageId: string,
): Omit<NativeAftermathPoolCreation, "poolCreation"> | null {
  const presale = normalizeSuiObjectId(presaleId);
  const address = normalizeSuiAddress(originalPackageId);
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
      tag.module !== AFTERMATH_NATIVE_MODULE ||
      tag.name !== "PoolCreationReserved" ||
      lpType === undefined ||
      memeType === undefined ||
      quoteType === undefined ||
      extra.length > 0
    ) {
      continue;
    }
    const payload = nativeAftermathEventBcs.PoolCreationReserved.parse(
      event.bcs,
    );
    if (payload.presale_id !== presale) continue;
    return {
      presaleId: presale,
      poolCreationId: payload.pool_creation_id,
      createPoolCapId: payload.create_pool_cap_id,
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
export async function findNativeAftermathPoolCreation(
  client: ClientWithCoreApi,
  options: {
    presaleId: string;
    originalPackageId: string;
    creationDigest?: string;
    pageLimit?: number;
  },
): Promise<NativeAftermathPoolCreation | null> {
  const { presaleId, originalPackageId } = options;
  const reservation =
    options.creationDigest === undefined
      ? await scanNativeReservations(
          client,
          presaleId,
          originalPackageId,
          options.pageLimit,
        )
      : nativeAftermathReservationOf(
          await transactionEvents(client, options.creationDigest),
          presaleId,
          originalPackageId,
        );
  if (!reservation) return null;
  const object = await getNativeAftermathPoolCreation(
    client,
    reservation.poolCreationId,
    originalPackageId,
  );
  if (
    object &&
    (object.presaleId !== reservation.presaleId ||
      object.lpType !== reservation.lpType ||
      object.memeType !== reservation.memeType ||
      object.quoteType !== reservation.quoteType ||
      object.createPoolCapId !== reservation.createPoolCapId)
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

async function scanNativeReservations(
  client: ClientWithCoreApi,
  presaleId: string,
  originalPackageId: string,
  limit?: number,
): Promise<Omit<NativeAftermathPoolCreation, "poolCreation"> | null> {
  const eventType = `${normalizeSuiAddress(originalPackageId)}::${AFTERMATH_NATIVE_MODULE}::PoolCreationReserved`;
  let after: string | null = null;
  for (;;) {
    const page = await client.core.listEvents({
      filter: { eventType },
      after,
      ...(limit === undefined ? {} : { limit }),
    });
    const found = nativeAftermathReservationOf(
      page.events,
      presaleId,
      originalPackageId,
    );
    if (found) return found;
    if (!page.hasNextPage || page.endCursor === null) return null;
    after = page.endCursor;
  }
}
