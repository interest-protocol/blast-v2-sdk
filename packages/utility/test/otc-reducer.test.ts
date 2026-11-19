import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

import type { DecodedOtcEvent, OtcEventPayloads } from "../src/otc/events.ts";
import { createOtcProjection, reduceOtcEvent } from "../src/otc/reducer.ts";

const offerId = normalizeSuiObjectId("0xc");
const maker = normalizeSuiAddress("0x5");
const taker = normalizeSuiAddress("0x6");

test("replays partial fills to filled, then a zero-refund cancel", () => {
  const events = [
    created(),
    taken(taker, 400n, 134n),
    taken(taker, 600n, 200n),
    canceled(maker, 0n),
  ];
  let projection = createOtcProjection();
  for (const event of events) {
    projection = reduceOtcEvent(projection, event);
    assert.strictEqual(reduceOtcEvent(projection, event), projection);
  }
  assert.deepEqual(projection.offers[offerId], {
    offerId,
    offeredType: normalizeStructTag("0x2::sui::SUI"),
    wantedType: normalizeStructTag("0xa::usdc::USDC"),
    maker,
    taker: null,
    partialFills: true,
    offeredAmount: 1_000n,
    wantedAmount: 333n,
    remaining: 0n,
    paidTotal: 334n,
    fills: 2,
    status: "canceled",
  });
});

test("marks an offer filled once nothing remains", () => {
  let projection = reduceOtcEvent(createOtcProjection(), created());
  projection = reduceOtcEvent(projection, taken(taker, 1_000n, 333n));
  assert.equal(projection.offers[offerId]!.status, "filled");
  assert.throws(
    () => reduceOtcEvent(projection, taken(taker, 1n, 1n)),
    /is not open/,
  );
});

test("rejects takes the contract would have refused", () => {
  const open = reduceOtcEvent(createOtcProjection(), created());
  assert.throws(
    () => reduceOtcEvent(open, taken(taker, 10n, 3n)),
    /does not match the offer rate/,
  );
  assert.throws(
    () => reduceOtcEvent(open, taken(taker, 1_001n, 334n)),
    /exceeds the remaining escrow/,
  );
  const allOrNothing = reduceOtcEvent(
    createOtcProjection(),
    created({ partial_fills: false }),
  );
  assert.throws(
    () => reduceOtcEvent(allOrNothing, taken(taker, 10n, 4n)),
    /partly taken/,
  );
  const restricted = reduceOtcEvent(
    createOtcProjection(),
    created({ taker: normalizeSuiAddress("0xb") }),
  );
  assert.throws(
    () => reduceOtcEvent(restricted, taken(taker, 10n, 4n)),
    /not the named taker/,
  );
});

test("rejects cancels by anyone but the maker or with a wrong refund", () => {
  const open = reduceOtcEvent(createOtcProjection(), created());
  assert.throws(
    () => reduceOtcEvent(open, canceled(taker, 1_000n)),
    /only the maker/,
  );
  assert.throws(
    () => reduceOtcEvent(open, canceled(maker, 999n)),
    /refund must equal/,
  );
  assert.throws(
    () => reduceOtcEvent(createOtcProjection(), canceled(maker, 0n)),
    /unknown OTC offer/,
  );
});

let nextEventIndex = 0;

function created(
  overrides: Partial<OtcEventPayloads["OfferCreated"]> = {},
): DecodedOtcEvent {
  return event("OfferCreated", maker, {
    offer_id: offerId,
    offered_type: normalizeStructTag("0x2::sui::SUI"),
    wanted_type: normalizeStructTag("0xa::usdc::USDC"),
    taker: null,
    partial_fills: true,
    offered_amount: 1_000n,
    wanted_amount: 333n,
    ...overrides,
  });
}

function taken(sender: string, amount: bigint, paid: bigint): DecodedOtcEvent {
  return event("OfferTaken", sender, { offer_id: offerId, amount, paid });
}

function canceled(sender: string, refund: bigint): DecodedOtcEvent {
  return event("OfferCanceled", sender, { offer_id: offerId, refund });
}

function event<Name extends DecodedOtcEvent["name"]>(
  name: Name,
  sender: string,
  payload: OtcEventPayloads[Name],
): DecodedOtcEvent {
  const eventIndex = nextEventIndex++;
  return {
    source: "otc",
    name,
    payload,
    emitterPackageId: normalizeSuiObjectId("0x40"),
    sender,
    position: {
      checkpoint: BigInt(eventIndex + 1),
      transactionDigest: `otc-${eventIndex}`,
      eventIndex,
    },
  } as DecodedOtcEvent;
}
