import assert from "node:assert/strict";
import test from "node:test";

import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { OtcEventName } from "../src/otc/events.ts";
import {
  decodeOtcEvent,
  otcEventBcs,
  otcEventFields,
} from "../src/otc/events.ts";
import { frozenAbi } from "./support.ts";

const packages = { packageId: "0x40", originalPackageId: "0x40" };

test("decoder layouts match the frozen ABI's event fields in order", async () => {
  const abi = await frozenAbi("otc-v1.json");
  const frozen = abi.package.modules.blast_fun_otc!.events;
  assert.deepEqual(
    Object.keys(otcEventBcs).sort(),
    frozen.map((event) => event.name).sort(),
  );
  for (const event of frozen) {
    assert.deepEqual(
      Object.keys(otcEventFields[event.name as OtcEventName]),
      event.fields.map((field) => field.name),
      event.name,
    );
  }
});

test("decodes each OTC event with its sender and position", () => {
  const created = decodeOtcEvent(
    entry("OfferCreated", {
      offer_id: "0xc",
      offered_type: "0x2::sui::SUI",
      wanted_type: "0xa::usdc::USDC",
      taker: "0xb",
      partial_fills: true,
      offered_amount: 1_000n,
      wanted_amount: 333n,
    }),
    packages,
  );
  assert.equal(created.name, "OfferCreated");
  assert.equal(created.sender, normalizeSuiAddress("0x5"));
  if (created.name !== "OfferCreated") return;
  assert.equal(
    created.payload.offered_type,
    normalizeStructTag("0x2::sui::SUI"),
  );
  assert.equal(created.payload.taker, normalizeSuiAddress("0xb"));
  assert.equal(created.payload.wanted_amount, 333n);

  const taken = decodeOtcEvent(
    entry("OfferTaken", { offer_id: "0xc", amount: 10n, paid: 4n }),
    packages,
  );
  assert.deepEqual(taken.payload, {
    offer_id: normalizeSuiAddress("0xc"),
    amount: 10n,
    paid: 4n,
  });
  assert.equal(taken.position.eventIndex, 0);
});

test("rejects events from another package or module", () => {
  const event = entry("OfferTaken", { offer_id: "0xc", amount: 1n, paid: 1n });
  assert.throws(
    () => decodeOtcEvent({ ...event, packageId: "0x41" }, packages),
    /unexpected emitter package/,
  );
  assert.throws(
    () =>
      decodeOtcEvent(
        { ...event, eventType: "0x40::other::OfferTaken" },
        packages,
      ),
    /unexpected event type/,
  );
  assert.throws(
    () =>
      decodeOtcEvent(
        { ...event, eventType: "0x40::blast_fun_otc::OfferExpired" },
        packages,
      ),
    /unsupported OTC event name/,
  );
});

function entry<Name extends OtcEventName>(
  name: Name,
  payload: Parameters<(typeof otcEventBcs)[Name]["serialize"]>[0],
): SuiClientTypes.EventEntry {
  const layout = otcEventBcs[name] as unknown as {
    serialize: (value: unknown) => { toBytes(): Uint8Array };
  };
  return {
    packageId: "0x40",
    module: "blast_fun_otc",
    sender: "0x5",
    eventType: `0x40::blast_fun_otc::${name}`,
    bcs: layout.serialize(payload).toBytes(),
    json: null,
    checkpoint: "7",
    transactionDigest: "digest",
    eventIndex: 0,
  } as unknown as SuiClientTypes.EventEntry;
}
