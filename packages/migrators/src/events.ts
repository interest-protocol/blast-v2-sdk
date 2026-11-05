import { suiObjectIdBcs, u64Bcs } from "@interest-protocol/blast-core/bcs";
import type { SuiEventPosition } from "@interest-protocol/blast-core/events";
import { normalizeSuiEventPosition } from "@interest-protocol/blast-core/events";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from "@mysten/sui/utils";
import type { MigratorsDeployment } from "./transactions.ts";

/**
 * The two `blast_migrators::events` structs, in Move field order, each typed
 * `<Meme, Quote>`: the pool tier a venue records while preparing a pair.
 * Vault creation, fee collection, auto-LP, buybacks and holder rewards are
 * the vault package's events; versions and upgrades are the admin package's.
 */
export const migratorsEventBcs = {
  /** The Meme's one Cetus `PoolCreationCap` and the tick spacing its migration uses. */
  CetusPoolReserved: bcs.struct("CetusPoolReserved", {
    pool_creation_cap_id: suiObjectIdBcs,
    tick_spacing: bcs.u32(),
  }),
  BluefinPoolTierRecorded: bcs.struct("BluefinPoolTierRecorded", {
    tick_spacing: bcs.u32(),
    fee_rate: u64Bcs,
  }),
};

export type MigratorsEventKind = keyof typeof migratorsEventBcs;

export type MigratorsEventPayloads = {
  [Kind in MigratorsEventKind]: ReturnType<
    (typeof migratorsEventBcs)[Kind]["parse"]
  >;
};

export type DecodedMigratorsEvent = {
  [Kind in MigratorsEventKind]: {
    source: "migrators";
    kind: Kind;
    memeType: string;
    quoteType: string;
    payload: MigratorsEventPayloads[Kind];
    sender: string;
    position: SuiEventPosition;
  };
}[MigratorsEventKind];

/** Decodes one `<migrators original>::events::<Kind><Meme, Quote>`. */
export function decodeMigratorsEvent(
  event: SuiClientTypes.EventEntry,
  migrators: Pick<MigratorsDeployment, "originalPackageId">,
): DecodedMigratorsEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as MigratorsEventKind;
  const [meme, quote, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(migrators.originalPackageId) ||
    tag.module !== "events" ||
    !Object.hasOwn(migratorsEventBcs, kind) ||
    meme === undefined ||
    quote === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(`unexpected migrators event type ${event.eventType}`);
  }
  return {
    source: "migrators",
    kind,
    memeType: normalizeStructTag(meme),
    quoteType: normalizeStructTag(quote),
    payload: migratorsEventBcs[kind].parse(event.bcs),
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedMigratorsEvent;
}
