import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

import { decodeOfferObject, offerBcs } from "../src/otc/state.ts";

const pkg = normalizeSuiAddress("0x40");
const offerId = normalizeSuiObjectId("0xc");
const type = `${pkg}::blast_fun_otc::Offer<0x2::sui::SUI, 0xa::usdc::USDC>`;

function content(
  overrides: Partial<Parameters<typeof offerBcs.serialize>[0]> = {},
) {
  return offerBcs
    .serialize({
      id: { id: { bytes: offerId } },
      balance: { value: 400n },
      maker: normalizeSuiAddress("0x5"),
      taker: null,
      partial_fills: true,
      offered_amount: 1_000n,
      wanted_amount: 333n,
      ...overrides,
    })
    .toBytes();
}

test("decodes a shared offer with its coin types and fill progress", () => {
  const state = decodeOfferObject(
    {
      objectId: "0xc",
      initialSharedVersion: 9,
      mutable: true,
      type,
      content: content(),
    },
    "0x40",
  );
  assert.deepEqual(state, {
    objectId: offerId,
    initialSharedVersion: "9",
    mutable: true,
    originalPackageId: pkg,
    offeredType: normalizeStructTag("0x2::sui::SUI"),
    wantedType: normalizeStructTag("0xa::usdc::USDC"),
    balance: 400n,
    maker: normalizeSuiAddress("0x5"),
    taker: null,
    partialFills: true,
    offeredAmount: 1_000n,
    wantedAmount: 333n,
    filled: 600n,
  });
});

test("decodes a restricted offer's taker", () => {
  const state = decodeOfferObject({
    objectId: "0xc",
    initialSharedVersion: 9,
    mutable: true,
    type,
    content: content({ taker: normalizeSuiAddress("0xb") }),
  });
  assert.equal(state.taker, normalizeSuiAddress("0xb"));
});

test("rejects objects that are not this package's offer", () => {
  const object = {
    objectId: "0xc",
    initialSharedVersion: 9,
    mutable: true as const,
    content: content(),
  };
  assert.throws(
    () =>
      decodeOfferObject({
        ...object,
        type: `${pkg}::other::Offer<0x2::sui::SUI, 0xa::usdc::USDC>`,
      }),
    /not an OTC offer/,
  );
  assert.throws(
    () => decodeOfferObject({ ...object, type }, "0x41"),
    /unexpected package/,
  );
  assert.throws(
    () => decodeOfferObject({ ...object, objectId: "0xd", type }),
    /mismatched UID/,
  );
  assert.throws(
    () =>
      decodeOfferObject({
        ...object,
        type,
        content: content({ balance: { value: 1_001n } }),
      }),
    /must not exceed its offered amount/,
  );
});
