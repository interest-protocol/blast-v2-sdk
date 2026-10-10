import assert from "node:assert/strict";
import test from "node:test";

import type { SuiClientTypes } from "@mysten/sui/client";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  decodeBoostsActivityEvent,
  queryBoostsActivity,
} from "../src/boosts/events.ts";
import { getBoostsProduct } from "../src/boosts/manifest.ts";
import type { BoostsTransport } from "../src/boosts/types.ts";
import {
  ADAPTER_ORIGINAL,
  BOOSTS_FIXTURE_MANIFEST,
  fixtureEvent,
} from "./boosts-fixtures.ts";

const bull = getBoostsProduct(BOOSTS_FIXTURE_MANIFEST, "sui-2x-bull");

test("decodes exact Minted, Redeemed, and Rebalanced facts", () => {
  const minted = decodeBoostsActivityEvent(
    fixtureEvent("sui-2x-bull", "Minted"),
    BOOSTS_FIXTURE_MANIFEST,
    bull,
    "1234",
  );
  assert.equal(minted.ok, true);
  if (minted.ok) {
    assert.equal(minted.activity.kind, "minted");
    assert.equal(minted.activity.checkpoint, "100");
    assert.equal(minted.activity.timestampMs, "1234");
    assert.equal(
      minted.activity.explorerUrl,
      "https://explorer.example/tx/digest-0",
    );
  }
  assert.equal(
    decodeBoostsActivityEvent(
      fixtureEvent("sui-2x-bull", "Redeemed"),
      BOOSTS_FIXTURE_MANIFEST,
      bull,
    ).ok,
    true,
  );
  assert.equal(
    decodeBoostsActivityEvent(
      fixtureEvent("sui-2x-bull", "Rebalanced"),
      BOOSTS_FIXTURE_MANIFEST,
      bull,
    ).ok,
    true,
  );
});

test("fails cross-package, cross-product, cross-vault, unknown, and malformed events closed", () => {
  const valid = fixtureEvent("sui-2x-bull", "Minted");
  const cases: Array<[string, SuiClientTypes.EventEntry]> = [
    ["NOT_FOR_PRODUCT", { ...valid, packageId: "0x999" }],
    ["NOT_FOR_PRODUCT", fixtureEvent("nvda-2x-bull", "Minted")],
    [
      "NOT_FOR_PRODUCT",
      fixtureEvent("sui-2x-bull", "Minted", 0, { vault_id: "0x999" }),
    ],
    [
      "UNSUPPORTED_EVENT",
      {
        ...valid,
        eventType: `${ADAPTER_ORIGINAL}::blast_events::Event<${ADAPTER_ORIGINAL}::events::MintedV2<${bull.productType}>>`,
      },
    ],
    ["MALFORMED_EVENT", { ...valid, bcs: new Uint8Array([255]) }],
  ];
  for (const [code, event] of cases) {
    const result = decodeBoostsActivityEvent(
      event,
      BOOSTS_FIXTURE_MANIFEST,
      bull,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, code);
  }
});

test("pages at 25 from fresh upstream events and rejects cursor-injected rows", async () => {
  const requests: SuiClientTypes.ListEventsOptions[] = [];
  const events = Array.from({ length: 52 }, (_, index) =>
    fixtureEvent("sui-2x-bull", "Minted", index),
  );
  const transport = eventTransport(async (input) => {
    requests.push(input);
    const start = input.before === null ? 0 : Number(input.before);
    const end = Math.min(start + (input.limit ?? 0), events.length);
    return {
      events: events.slice(start, end),
      hasNextPage: end < events.length,
      startCursor: String(start),
      endCursor: String(end),
    };
  });

  const pageOne = await queryBoostsActivity(
    transport,
    BOOSTS_FIXTURE_MANIFEST,
    bull,
  );
  assert.equal(pageOne.items.length, 25);
  const cursor = pageOne.nextCursor;
  assert.ok(cursor);
  const pageTwo = await queryBoostsActivity(
    transport,
    BOOSTS_FIXTURE_MANIFEST,
    bull,
    { cursor },
  );
  assert.equal(pageTwo.items.length, 25);
  assert.ok(pageTwo.nextCursor);
  assert.equal(requests.length, 2);
  const pageThree = await queryBoostsActivity(
    transport,
    BOOSTS_FIXTURE_MANIFEST,
    bull,
    { cursor: pageTwo.nextCursor },
  );
  assert.equal(pageThree.items.length, 2);
  assert.equal(pageThree.nextCursor, null);
  assert.deepEqual(
    requests.map(({ before, limit }) => ({ before, limit })),
    [
      { before: null, limit: 25 },
      { before: "25", limit: 25 },
      { before: "50", limit: 25 },
    ],
  );
  assert.deepEqual(Object.keys(cursorPayload(cursor)).sort(), [
    "adapterOriginalPackageId",
    "adapterPackageId",
    "before",
    "chainIdentifier",
    "network",
    "productKey",
    "vault",
    "version",
  ]);
  const forged = cursorWith({
    ...cursorPayload(cursor),
    buffer: pageOne.items,
  });
  await assert.rejects(
    queryBoostsActivity(transport, BOOSTS_FIXTURE_MANIFEST, bull, {
      cursor: forged,
    }),
    /cursor/,
  );
  await assert.rejects(
    queryBoostsActivity(transport, BOOSTS_FIXTURE_MANIFEST, bull, {
      cursor: `${cursor.slice(0, -1)}x`,
    }),
    /cursor/,
  );
});

test("rejects activity reads from another chain before querying events", async () => {
  let queried = false;
  const transport = eventTransport(async () => {
    queried = true;
    throw new Error("must not query");
  });
  transport.getChainIdentifier = async () => "wrong-chain";
  await assert.rejects(
    queryBoostsActivity(transport, BOOSTS_FIXTURE_MANIFEST, bull),
    /wrong network or chain/,
  );
  assert.equal(queried, false);
});

test("isolates malformed event diagnostics and bounds upstream scans", async () => {
  let calls = 0;
  const malformed = {
    ...fixtureEvent("sui-2x-bull", "Minted"),
    bcs: new Uint8Array([255]),
  };
  const transport = eventTransport(async () => {
    calls += 1;
    return {
      events: calls === 1 ? [malformed] : [],
      hasNextPage: true,
      startCursor: "start",
      endCursor: `page-${calls}`,
    };
  });
  const page = await queryBoostsActivity(
    transport,
    BOOSTS_FIXTURE_MANIFEST,
    bull,
    { maxScanPages: 2 },
  );
  assert.equal(calls, 2);
  assert.equal(page.items.length, 0);
  assert.equal(page.decoderErrors.length, 1);
  assert.equal(page.decoderErrors[0]?.code, "MALFORMED_EVENT");
  assert.ok(page.nextCursor);
});

function eventTransport(
  listEvents: BoostsTransport["listEvents"],
): BoostsTransport {
  return {
    readProduct: async () => {
      throw new Error("unused");
    },
    getChainIdentifier: async () => "fixture-chain",
    getBalance: async () => "0",
    listEvents,
    getIndexedTransaction: async () => null,
    getCheckpointTimestampMs: async (checkpoint) =>
      String(BigInt(checkpoint) * 1_000n),
  };
}

function cursorPayload(cursor: string): Record<string, unknown> {
  const encoded = cursor.split(".")[0];
  assert.ok(encoded);
  return JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

function cursorWith(value: Record<string, unknown>): string {
  const payload = JSON.stringify(value);
  const digest = Array.from(
    sha256(new TextEncoder().encode(payload)).slice(0, 8),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${Buffer.from(payload).toString("base64url")}.${digest}`;
}
