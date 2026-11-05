import assert from "node:assert/strict";
import test from "node:test";
import {
  MIGRATORS_ABORTS,
  migratorsAbortName,
} from "@interest-protocol/blast-migrators-sdk/aborts";
import {
  bluefinPoolTierBcs,
  getBluefinPoolTier,
  getCetusPoolCreationCapId,
  getCetusPoolTier,
  venueConfigBcs,
} from "@interest-protocol/blast-migrators-sdk/state";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import { fromHex, normalizeStructTag, toHex } from "@mysten/sui/utils";
import { MEME_A, MIGRATORS } from "./fixtures/migrators-deployment.ts";

type Name = { type: string; bcs: Uint8Array };
type Lookup = { method: string; parentId: string; name: Name };

/** A Core API client holding `fields` (by name type) under the venue config. */
function venueClient(fields: Record<string, Uint8Array | string>) {
  const lookups: Lookup[] = [];
  const find = (method: string, parentId: string, name: Name) => {
    lookups.push({ method, parentId, name });
    const value = fields[name.type];
    if (value === undefined)
      throw new ObjectError("notFound", "missing", { reason: "notFound" });
    return value;
  };
  const client = {
    core: {
      getDynamicField: async ({ parentId, name }: Omit<Lookup, "method">) => ({
        dynamicField: {
          value: {
            type: "",
            bcs: find("getDynamicField", parentId, name) as Uint8Array,
          },
        },
      }),
      getDynamicObjectField: async ({
        parentId,
        name,
      }: Omit<Lookup, "method">) => ({
        object: {
          objectId: find("getDynamicObjectField", parentId, name) as string,
        },
      }),
    },
  } as unknown as ClientWithCoreApi;
  return { client, lookups };
}

const venueConfigId = `0x${"0".repeat(60)}3020`;
const meme = normalizeStructTag(MEME_A);
const key = (venue: string, name: string) =>
  normalizeStructTag(`0x3000::${venue}::${name}<${meme}>`);

test("venue records are VenueConfig dynamic fields keyed by venue-sealed unit structs", async () => {
  const capId = `0x${"ab".repeat(32)}`;
  const { client, lookups } = venueClient({
    [key("cetus", "PoolTierKey")]: fromHex("c8000000"),
    [key("cetus", "CreationCapKey")]: capId,
    // `PoolTier { tick_spacing: 60, fee_rate: 3_000 }`.
    [key("bluefin", "PoolTierKey")]: fromHex("3c000000b80b000000000000"),
  });

  assert.equal(await getCetusPoolTier(client, MIGRATORS, MEME_A), 200);
  assert.equal(
    await getCetusPoolCreationCapId(client, MIGRATORS, MEME_A),
    capId,
  );
  assert.deepEqual(await getBluefinPoolTier(client, MIGRATORS, MEME_A), {
    tickSpacing: 60,
    feeRate: 3_000n,
  });
  assert.deepEqual(
    lookups.map(({ method, parentId, name }) => [
      method,
      parentId,
      name.type,
      toHex(name.bcs),
    ]),
    [
      ["getDynamicField", venueConfigId, key("cetus", "PoolTierKey"), "00"],
      [
        "getDynamicObjectField",
        venueConfigId,
        key("cetus", "CreationCapKey"),
        "00",
      ],
      ["getDynamicField", venueConfigId, key("bluefin", "PoolTierKey"), "00"],
    ],
  );
});

test("an unprepared Meme reads as null; other read errors propagate", async () => {
  const { client } = venueClient({});
  assert.equal(await getCetusPoolTier(client, MIGRATORS, MEME_A), null);
  assert.equal(
    await getCetusPoolCreationCapId(client, MIGRATORS, MEME_A),
    null,
  );
  assert.equal(await getBluefinPoolTier(client, MIGRATORS, MEME_A), null);

  const failing = {
    core: {
      getDynamicField: async () => {
        throw new ObjectError("deleted", "gone", { reason: "deleted" });
      },
      getDynamicObjectField: async () => {
        throw new Error("transport down");
      },
    },
  } as unknown as ClientWithCoreApi;
  await assert.rejects(getCetusPoolTier(failing, MIGRATORS, MEME_A), /gone/);
  await assert.rejects(
    getCetusPoolCreationCapId(failing, MIGRATORS, MEME_A),
    /transport down/,
  );
});

test("VenueConfig and PoolTier layouts follow Move field order", () => {
  assert.deepEqual(
    venueConfigBcs.parse(fromHex("ab".repeat(32))).id.id.bytes,
    `0x${"ab".repeat(32)}`,
  );
  assert.equal(
    toHex(
      bluefinPoolTierBcs
        .serialize({ tick_spacing: 1, fee_rate: 20_000n })
        .toBytes(),
    ),
    "01000000204e000000000000",
  );
});

test("migrators abort codes follow errors.move", () => {
  assert.deepEqual(MIGRATORS_ABORTS, [
    "EInvalidCoinOrder",
    "EPositionPoolMismatch",
    "EWrongCoinPair",
    "EInvalidTier",
    "ESymbolTooLong",
  ]);
  assert.equal(migratorsAbortName(3), "EInvalidTier");
  assert.equal(migratorsAbortName(5), null);
  assert.equal(migratorsAbortName(-1), null);
});
