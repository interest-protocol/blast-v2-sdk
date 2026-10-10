import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";
import { sha256 } from "@noble/hashes/sha2.js";

import { suiObjectIdBcs } from "../lib/bcs.ts";
import { normalizeSuiEventPosition } from "../lib/events.ts";
import { requireU64 } from "../lib/integers.ts";
import { assertBoostsTransportChain } from "./math.ts";
import { boostsCheckpointBcs } from "./state.ts";
import type {
  BoostsManifest,
  BoostsProductManifest,
  BoostsTransport,
} from "./types.ts";

export const BOOSTS_ACTIVITY_KINDS = [
  "Minted",
  "Redeemed",
  "Rebalanced",
] as const;
export type BoostsActivityKind = (typeof BOOSTS_ACTIVITY_KINDS)[number];

const u64Bcs = bcs.u64().transform({
  input: (value: bigint) => requireU64("event u64", value),
  output: (value) => BigInt(value),
});

export const boostsActivityEventBcs = {
  Minted: bcs.struct("Minted", {
    vault_id: suiObjectIdBcs,
    deposit: u64Bcs,
    shares: u64Bcs,
    contribution: u64Bcs,
    fee: u64Bcs,
    admin_fee: u64Bcs,
    reserve_fee: u64Bcs,
    reserve_after: u64Bcs,
    admin_cash_after: u64Bcs,
    supply_after: u64Bcs,
    checkpoint: boostsCheckpointBcs,
  }),
  Redeemed: bcs.struct("Redeemed", {
    vault_id: suiObjectIdBcs,
    shares: u64Bcs,
    net: u64Bcs,
    fee: u64Bcs,
    admin_fee: u64Bcs,
    reserve_fee: u64Bcs,
    reserve_after: u64Bcs,
    admin_cash_after: u64Bcs,
    supply_after: u64Bcs,
    checkpoint: boostsCheckpointBcs,
  }),
  Rebalanced: bcs.struct("Rebalanced", {
    vault_id: suiObjectIdBcs,
    equity_before: u64Bcs,
    equity_after: u64Bcs,
    base_before: u64Bcs,
    base_after: u64Bcs,
    increase: bcs.bool(),
    reserve_after: u64Bcs,
    admin_cash_after: u64Bcs,
    supply_after: u64Bcs,
    checkpoint: boostsCheckpointBcs,
  }),
} as const;

type ActivityBase = Readonly<{
  productKey: BoostsProductManifest["productKey"];
  checkpoint: string;
  timestampMs: string | null;
  transactionDigest: string;
  eventIndex: number;
  explorerUrl: string;
}>;

export type BoostsActivity =
  | (ActivityBase & {
      kind: "minted";
      depositAtoms: string;
      sharesAtoms: string;
      contributionAtoms: string;
      feeAtoms: string;
      supplyAfterAtoms: string;
    })
  | (ActivityBase & {
      kind: "redeemed";
      sharesAtoms: string;
      usdcOutAtoms: string;
      feeAtoms: string;
      supplyAfterAtoms: string;
    })
  | (ActivityBase & {
      kind: "rebalanced";
      equityBeforeAtoms: string;
      equityAfterAtoms: string;
      baseBeforeAtoms: string;
      baseAfterAtoms: string;
      increase: boolean;
      supplyAfterAtoms: string;
    });

export type BoostsEventDecodeFailure = Readonly<{
  ok: false;
  code: "NOT_FOR_PRODUCT" | "UNSUPPORTED_EVENT" | "MALFORMED_EVENT";
  message: string;
}>;

export type BoostsEventDecodeResult =
  | Readonly<{ ok: true; activity: BoostsActivity }>
  | BoostsEventDecodeFailure;

export function decodeBoostsActivityEvent(
  event: SuiClientTypes.EventEntry,
  manifest: BoostsManifest,
  product: BoostsProductManifest,
  timestampMs: string | null = null,
): BoostsEventDecodeResult {
  try {
    if (
      normalizeSuiObjectId(event.packageId) !==
        normalizeSuiObjectId(manifest.adapterPackage.packageId) ||
      event.module !== "blast_events"
    ) {
      return failure(
        "NOT_FOR_PRODUCT",
        "event emitter is not the configured adapter package",
      );
    }
    const originalPackage = normalizeSuiAddress(
      manifest.adapterPackage.originalPackageId,
    );
    const envelope = parseStructTag(event.eventType);
    if (
      envelope.address !== originalPackage ||
      envelope.module !== "blast_events" ||
      envelope.name !== "Event" ||
      envelope.typeParams.length !== 1
    ) {
      return failure(
        "MALFORMED_EVENT",
        "event has an unexpected adapter envelope",
      );
    }
    const payload = envelope.typeParams[0];
    if (
      payload === undefined ||
      typeof payload === "string" ||
      payload.address !== originalPackage ||
      payload.module !== "events" ||
      payload.typeParams.length !== 1
    ) {
      return failure(
        "MALFORMED_EVENT",
        "event has an unexpected adapter payload type",
      );
    }
    const payloadProduct = payload.typeParams[0];
    if (
      payloadProduct === undefined ||
      normalizedType(payloadProduct) !== normalizeStructTag(product.productType)
    ) {
      return failure(
        "NOT_FOR_PRODUCT",
        "event belongs to another product type",
      );
    }
    if (!BOOSTS_ACTIVITY_KINDS.includes(payload.name as BoostsActivityKind)) {
      return failure(
        "UNSUPPORTED_EVENT",
        `unsupported Boosts activity event ${payload.name}`,
      );
    }

    const kind = payload.name as BoostsActivityKind;
    const decoded = boostsActivityEventBcs[kind].parse(event.bcs) as Record<
      string,
      unknown
    >;
    if (
      normalizeSuiObjectId(decoded.vault_id as string) !==
      normalizeSuiObjectId(product.vault.objectId)
    ) {
      return failure("NOT_FOR_PRODUCT", "event belongs to another vault");
    }
    const position = normalizeSuiEventPosition(event);
    const base: ActivityBase = {
      productKey: product.productKey,
      checkpoint: position.checkpoint.toString(),
      timestampMs: normalizeOptionalU64("event timestamp", timestampMs),
      transactionDigest: position.transactionDigest,
      eventIndex: position.eventIndex,
      explorerUrl: new URL(
        encodeURIComponent(position.transactionDigest),
        manifest.explorerTransactionUrlPrefix,
      ).toString(),
    };
    if (kind === "Minted") {
      return {
        ok: true,
        activity: {
          ...base,
          kind: "minted",
          depositAtoms: atom(decoded.deposit),
          sharesAtoms: atom(decoded.shares),
          contributionAtoms: atom(decoded.contribution),
          feeAtoms: atom(decoded.fee),
          supplyAfterAtoms: atom(decoded.supply_after),
        },
      };
    }
    if (kind === "Redeemed") {
      return {
        ok: true,
        activity: {
          ...base,
          kind: "redeemed",
          sharesAtoms: atom(decoded.shares),
          usdcOutAtoms: atom(decoded.net),
          feeAtoms: atom(decoded.fee),
          supplyAfterAtoms: atom(decoded.supply_after),
        },
      };
    }
    return {
      ok: true,
      activity: {
        ...base,
        kind: "rebalanced",
        equityBeforeAtoms: atom(decoded.equity_before),
        equityAfterAtoms: atom(decoded.equity_after),
        baseBeforeAtoms: atom(decoded.base_before),
        baseAfterAtoms: atom(decoded.base_after),
        increase: decoded.increase as boolean,
        supplyAfterAtoms: atom(decoded.supply_after),
      },
    };
  } catch (error) {
    return failure(
      "MALFORMED_EVENT",
      error instanceof Error ? error.message : "malformed Boosts event",
    );
  }
}

export type BoostsActivityPage = Readonly<{
  items: readonly BoostsActivity[];
  nextCursor: string | null;
  decoderErrors: readonly Readonly<{
    code: Exclude<BoostsEventDecodeFailure["code"], "NOT_FOR_PRODUCT">;
    transactionDigest: string;
    eventIndex: number;
    message: string;
  }>[];
}>;

export async function queryBoostsActivity(
  transport: BoostsTransport,
  manifest: BoostsManifest,
  product: BoostsProductManifest,
  options: Readonly<{
    limit?: number;
    cursor?: string | null;
    maxScanPages?: number;
  }> = {},
): Promise<BoostsActivityPage> {
  await assertBoostsTransportChain(transport, manifest);
  const { limit, maxScanPages } = normalizeActivityOptions(options);
  const decodedCursor = options.cursor
    ? decodeCursor(options.cursor, manifest, product)
    : null;
  const matches: BoostsActivity[] = [];
  const decoderErrors: Array<BoostsActivityPage["decoderErrors"][number]> = [];
  let before = decodedCursor?.before ?? null;
  let hasNextPage = false;
  let scans = 0;

  while (matches.length < limit && scans < maxScanPages) {
    const page = await scanActivityPage(
      transport,
      manifest,
      product,
      before,
      limit - matches.length,
    );
    scans += 1;
    matches.push(...page.matches);
    decoderErrors.push(...page.decoderErrors);
    before = page.endCursor;
    hasNextPage = page.hasNextPage;
    if (!page.hasNextPage || page.endCursor === null) break;
  }

  const nextCursor =
    hasNextPage && before !== null
      ? encodeCursor({
          version: 2,
          network: manifest.network,
          chainIdentifier: manifest.chainIdentifier,
          productKey: product.productKey,
          vault: product.vault.objectId,
          adapterPackageId: manifest.adapterPackage.packageId,
          adapterOriginalPackageId: manifest.adapterPackage.originalPackageId,
          before,
        })
      : null;
  return { items: matches, nextCursor, decoderErrors };
}

function normalizeActivityOptions(
  options: Readonly<{ limit?: number; maxScanPages?: number }>,
): { limit: number; maxScanPages: number } {
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new RangeError("Boosts activity limit must be between 1 and 25");
  }
  const maxScanPages = options.maxScanPages ?? 6;
  if (
    !Number.isInteger(maxScanPages) ||
    maxScanPages < 1 ||
    maxScanPages > 10
  ) {
    throw new RangeError(
      "Boosts activity maxScanPages must be between 1 and 10",
    );
  }
  return { limit, maxScanPages };
}

async function scanActivityPage(
  transport: BoostsTransport,
  manifest: BoostsManifest,
  product: BoostsProductManifest,
  before: string | null,
  limit: number,
): Promise<{
  matches: BoostsActivity[];
  decoderErrors: Array<BoostsActivityPage["decoderErrors"][number]>;
  endCursor: string | null;
  hasNextPage: boolean;
}> {
  const page = await transport.listEvents({
    filter: {
      emitModule: `${manifest.adapterPackage.packageId}::blast_events`,
    },
    limit,
    before,
    order: "descending",
  });
  if (page.events.length > limit) {
    throw new TypeError("Sui event page exceeded the requested limit");
  }
  const timestamps = await checkpointTimestamps(transport, page.events);
  const matches: BoostsActivity[] = [];
  const decoderErrors: Array<BoostsActivityPage["decoderErrors"][number]> = [];
  for (const event of page.events) {
    const result = decodeBoostsActivityEvent(
      event,
      manifest,
      product,
      timestamps.get(event.checkpoint ?? "") ?? null,
    );
    if (result.ok) matches.push(result.activity);
    else if (result.code !== "NOT_FOR_PRODUCT") {
      decoderErrors.push({
        code: result.code,
        transactionDigest: event.transactionDigest,
        eventIndex: event.eventIndex,
        message: result.message,
      });
    }
  }
  return {
    matches,
    decoderErrors,
    endCursor: page.endCursor,
    hasNextPage: page.hasNextPage,
  };
}

type ActivityCursor = {
  version: 2;
  network: BoostsManifest["network"];
  chainIdentifier: string;
  productKey: BoostsProductManifest["productKey"];
  vault: string;
  adapterPackageId: string;
  adapterOriginalPackageId: string;
  before: string;
};

function encodeCursor(cursor: ActivityCursor): string {
  const payload = JSON.stringify(cursor);
  return `${base64UrlEncode(payload)}.${checksum(payload)}`;
}

function decodeCursor(
  cursor: string,
  manifest: BoostsManifest,
  product: BoostsProductManifest,
): ActivityCursor {
  const [encoded, digest, extra] = cursor.split(".");
  if (!encoded || !digest || extra !== undefined)
    throw new TypeError("invalid Boosts activity cursor");
  const payload = base64UrlDecode(encoded);
  if (checksum(payload) !== digest)
    throw new TypeError("invalid Boosts activity cursor checksum");
  const value = JSON.parse(payload) as ActivityCursor;
  const keys = Object.keys(value).sort().join(",");
  if (
    keys !==
      "adapterOriginalPackageId,adapterPackageId,before,chainIdentifier,network,productKey,vault,version" ||
    value.version !== 2 ||
    value.network !== manifest.network ||
    value.chainIdentifier !== manifest.chainIdentifier ||
    value.productKey !== product.productKey ||
    normalizeSuiObjectId(value.vault) !==
      normalizeSuiObjectId(product.vault.objectId) ||
    normalizeSuiObjectId(value.adapterPackageId) !==
      normalizeSuiObjectId(manifest.adapterPackage.packageId) ||
    normalizeSuiObjectId(value.adapterOriginalPackageId) !==
      normalizeSuiObjectId(manifest.adapterPackage.originalPackageId) ||
    typeof value.before !== "string" ||
    value.before.length === 0
  ) {
    throw new TypeError(
      "Boosts activity cursor does not match this product query",
    );
  }
  return value;
}

async function checkpointTimestamps(
  transport: BoostsTransport,
  events: readonly SuiClientTypes.EventEntry[],
): Promise<Map<string, string | null>> {
  const checkpoints = [
    ...new Set(
      events
        .map(({ checkpoint }) => checkpoint)
        .filter((value): value is string => value !== null),
    ),
  ];
  const getTimestamp = transport.getCheckpointTimestampMs?.bind(transport);
  if (!getTimestamp) return new Map();
  return new Map(
    await Promise.all(
      checkpoints.map(
        async (checkpoint) =>
          [checkpoint, await getTimestamp(checkpoint)] as const,
      ),
    ),
  );
}

function normalizedType(
  type: ReturnType<typeof parseStructTag>["typeParams"][number],
): string {
  return typeof type === "string" ? type : normalizeStructTag(type);
}

function atom(value: unknown): string {
  if (typeof value !== "bigint")
    throw new TypeError("event amount is not a bigint");
  return requireU64("event amount", value).toString();
}

function normalizeOptionalU64(
  name: string,
  value: string | null,
): string | null {
  if (value === null) return null;
  return requireU64(name, BigInt(value)).toString();
}

function failure(
  code: BoostsEventDecodeFailure["code"],
  message: string,
): BoostsEventDecodeFailure {
  return { ok: false, code, message };
}

function checksum(value: string): string {
  return Array.from(
    sha256(new TextEncoder().encode(value)).slice(0, 8),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}
