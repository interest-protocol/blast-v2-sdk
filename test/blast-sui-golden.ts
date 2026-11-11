import type { DelayedEventKind } from "@interest-protocol/blast-admin-sdk/events";
import {
  delayedEventBcs,
  delayedEventModule,
} from "@interest-protocol/blast-admin-sdk/events";
import type {
  BlastSuiEventKind,
  BlastSuiEventPackageIdentity,
} from "@interest-protocol/blast-sui-sdk";
import { blastSuiDelayedKeys } from "@interest-protocol/blast-sui-sdk";
import type { BcsType } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import { BLAST_SUI_FIXTURE } from "./fixtures/blast-sui-50b8d59.ts";

/**
 * Golden bytes for blast Sui tests. The vault, receipt and event bytes are
 * the Move-printed fixture at contracts 50b8d59a; read the scenario in
 * `fixtures/blast-sui-50b8d59.move`. Never regenerate them with the SDK
 * layouts under test.
 */
export { BLAST_SUI_FIXTURE };

export const FIXTURE_VAULT_ID = BLAST_SUI_FIXTURE.vaultId;
export const FIXTURE_RECEIPT_ID = BLAST_SUI_FIXTURE.receiptId;
/** Genesis pools: 0 is the bootstrap pool, 1 is listed then removed, 2 is pending. */
export const [FIXTURE_POOL_0, FIXTURE_POOL_1, FIXTURE_POOL_2] =
  BLAST_SUI_FIXTURE.pools as readonly [string, string, string];

export function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export const BLAST_SUI_VAULT_GOLDEN_BYTES = fromHex(BLAST_SUI_FIXTURE.vault);

export const BLAST_SUI_DEPOSIT_RECEIPT_GOLDEN_BYTES = fromHex(
  BLAST_SUI_FIXTURE.receipt,
);

/**
 * Literal native `TreasuryCap` bytes for the two vault child objects (UID,
 * then total supply). The fixture prints no caps; these carry its final
 * supplies, 1 funSUI and 11.608695652 blastSUI.
 */
export const FUN_TREASURY_CAP_GOLDEN_BYTES = fromHex(
  [
    "00000000000000000000000000000000000000000000000000000000000000f1",
    "00ca9a3b00000000",
  ].join(""),
);
export const BLAST_TREASURY_CAP_GOLDEN_BYTES = fromHex(
  [
    "00000000000000000000000000000000000000000000000000000000000000b1",
    "64a3eeb302000000",
  ].join(""),
);

/** The Move-printed BCS of one event payload. */
export function fixtureEventBytes(kind: BlastSuiEventKind): Uint8Array {
  const hex = (BLAST_SUI_FIXTURE.events as Record<string, string>)[kind];
  if (hex === undefined) throw new TypeError(`no fixture event ${kind}`);
  return fromHex(hex);
}

/** A native `blast_events::Event<events::Kind>` entry carrying `bcs`. */
export function blastSuiEventEntry(
  kind: BlastSuiEventKind,
  bcs: Uint8Array,
  packages: BlastSuiEventPackageIdentity,
  eventIndex: number,
): SuiClientTypes.EventEntry {
  const original = normalizeSuiObjectId(packages.originalPackageId);
  return {
    packageId: packages.packageId,
    module: "blast_events",
    sender: "0x16",
    eventType: `${original}::blast_events::Event<${original}::events::${kind}>`,
    bcs,
    json: null,
    checkpoint: "9",
    transactionDigest: `transaction-${eventIndex}`,
    eventIndex,
  };
}

/** A `blast_admin` delayed event entry under one of `blastSuiDelayedKeys`. */
export function blastSuiDelayedEntry(
  kind: DelayedEventKind,
  name: keyof typeof blastSuiDelayedKeys,
  payload: Record<string, unknown>,
  identity: { adminPackageId: string; originalPackageId: string },
  eventIndex: number,
): SuiClientTypes.EventEntry {
  const spec = blastSuiDelayedKeys[name];
  const admin = normalizeSuiAddress(identity.adminPackageId);
  const original = normalizeSuiAddress(identity.originalPackageId);
  return {
    packageId: admin,
    module: delayedEventModule(kind),
    sender: "0x16",
    eventType: `${admin}::${delayedEventModule(kind)}::${kind}<${original}::${spec.key}, ${spec.valueType}>`,
    bcs: (delayedEventBcs(kind, spec) as unknown as BcsType<unknown, unknown>)
      .serialize(payload)
      .toBytes(),
    json: null,
    checkpoint: "10",
    transactionDigest: `delayed-${eventIndex}`,
    eventIndex,
  };
}
