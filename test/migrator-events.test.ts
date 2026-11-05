import assert from "node:assert/strict";
import test from "node:test";
import type { DecodedMigratorsEvent } from "@interest-protocol/blast-migrators-sdk/events";
import {
  decodeMigratorsEvent,
  migratorsEventBcs,
} from "@interest-protocol/blast-migrators-sdk/events";
import {
  createVenueReservationProjection,
  reduceVenueReservationEvent,
} from "@interest-protocol/blast-migrators-sdk/reducer";
import type { SuiClientTypes } from "@mysten/sui/client";
import { fromHex, normalizeStructTag } from "@mysten/sui/utils";
import {
  MEME_A,
  MEME_B,
  MIGRATORS,
  SUI,
} from "./fixtures/migrators-deployment.ts";

const capId = `0x${"ab".repeat(32)}`;
const original = `0x${"0".repeat(60)}3000`;

/**
 * Literal BCS of each payload in Move field order: `CetusPoolReserved
 * { pool_creation_cap_id, tick_spacing: 200 }` and `BluefinPoolTierRecorded
 * { tick_spacing: 60, fee_rate: 3_000 }`.
 */
const PAYLOADS = {
  CetusPoolReserved: `${"ab".repeat(32)}c8000000`,
  BluefinPoolTierRecorded: "3c000000b80b000000000000",
} as const;

function eventEntry(
  kind: keyof typeof PAYLOADS,
  memeType: string,
  overrides: Partial<SuiClientTypes.EventEntry> = {},
  index = 0,
): SuiClientTypes.EventEntry {
  return {
    packageId: original,
    module: "cetus",
    sender: "0x5e",
    eventType: `${original}::events::${kind}<${memeType}, ${SUI}>`,
    bcs: fromHex(PAYLOADS[kind]),
    json: null,
    checkpoint: "9",
    transactionDigest: "3DMw2pd63RaysZcHVVPotVjXBaXvfcBTuHVkwwb1QVxx",
    eventIndex: index,
    ...overrides,
  } as SuiClientTypes.EventEntry;
}

test("decodes the two blast_migrators::events payloads with their pair", () => {
  assert.deepEqual(Object.keys(migratorsEventBcs), [
    "CetusPoolReserved",
    "BluefinPoolTierRecorded",
  ]);
  const cetus = decodeMigratorsEvent(
    eventEntry("CetusPoolReserved", MEME_A),
    MIGRATORS,
  );
  assert.equal(cetus.source, "migrators");
  assert.equal(cetus.kind, "CetusPoolReserved");
  assert.equal(cetus.memeType, normalizeStructTag(MEME_A));
  assert.equal(cetus.quoteType, normalizeStructTag(SUI));
  assert.deepEqual(cetus.payload, {
    pool_creation_cap_id: capId,
    tick_spacing: 200,
  });
  assert.equal(cetus.sender, `0x${"0".repeat(62)}5e`);
  assert.equal(cetus.position.eventIndex, 0);

  const bluefin = decodeMigratorsEvent(
    eventEntry("BluefinPoolTierRecorded", MEME_B),
    MIGRATORS,
  );
  assert.equal(bluefin.kind, "BluefinPoolTierRecorded");
  assert.deepEqual(bluefin.payload, { tick_spacing: 60, fee_rate: 3_000n });
});

test("rejects events of another package, module, kind or arity", () => {
  for (const eventType of [
    `0x3001::events::CetusPoolReserved<${MEME_A}, ${SUI}>`,
    `${original}::cetus::CetusPoolReserved<${MEME_A}, ${SUI}>`,
    `${original}::events::VaultCreated<${MEME_A}, ${SUI}>`,
    `${original}::events::CetusPoolReserved<${MEME_A}>`,
    `${original}::events::CetusPoolReserved<${MEME_A}, ${SUI}, ${SUI}>`,
  ]) {
    assert.throws(
      () =>
        decodeMigratorsEvent(
          eventEntry("CetusPoolReserved", MEME_A, { eventType }),
          MIGRATORS,
        ),
      /unexpected migrators event type/,
      eventType,
    );
  }
});

test("the venue reservation projection matches the VenueConfig records and replays once", () => {
  const events: DecodedMigratorsEvent[] = [
    decodeMigratorsEvent(eventEntry("CetusPoolReserved", MEME_A), MIGRATORS),
    decodeMigratorsEvent(
      eventEntry("BluefinPoolTierRecorded", MEME_B, {}, 1),
      MIGRATORS,
    ),
  ];
  const state = [...events, ...events].reduce(
    reduceVenueReservationEvent,
    createVenueReservationProjection(),
  );
  assert.deepEqual(state, {
    appliedEventIds: {
      "3DMw2pd63RaysZcHVVPotVjXBaXvfcBTuHVkwwb1QVxx:0": true,
      "3DMw2pd63RaysZcHVVPotVjXBaXvfcBTuHVkwwb1QVxx:1": true,
    },
    cetus: {
      [normalizeStructTag(MEME_A)]: {
        quoteType: normalizeStructTag(SUI),
        poolCreationCapId: capId,
        tickSpacing: 200,
      },
    },
    bluefin: {
      [normalizeStructTag(MEME_B)]: {
        quoteType: normalizeStructTag(SUI),
        tickSpacing: 60,
        feeRate: 3_000n,
      },
    },
  });
});
