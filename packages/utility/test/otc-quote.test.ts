import assert from "node:assert/strict";
import test from "node:test";

import { maxTakeForPayment, quoteTake, takeCost } from "../src/otc/quote.ts";

const offer = {
  offeredAmount: 1_000n,
  wantedAmount: 333n,
  balance: 1_000n,
  partialFills: true,
  taker: null,
};

test("a full take costs exactly the wanted amount", () => {
  assert.equal(takeCost(offer, 1_000n), 333n);
  assert.deepEqual(quoteTake(offer, 1_000n), { amount: 1_000n, paid: 333n });
});

test("a partial fill rounds up for the maker and never pays below the rate", () => {
  // 1 * 333 / 1000 = 0.333, rounded up.
  assert.equal(takeCost(offer, 1n), 1n);
  assert.equal(takeCost(offer, 3n), 1n);
  assert.equal(takeCost(offer, 4n), 2n);
  for (let amount = 1n; amount <= offer.offeredAmount; amount += 37n) {
    const paid = takeCost(offer, amount);
    assert.ok(paid * offer.offeredAmount >= amount * offer.wantedAmount);
    assert.ok((paid - 1n) * offer.offeredAmount < amount * offer.wantedAmount);
  }
});

test("maxTakeForPayment is the largest amount the payment covers", () => {
  for (const payment of [0n, 1n, 2n, 100n, 332n, 333n, 10_000n]) {
    const amount = maxTakeForPayment(offer, payment);
    assert.ok(takeCost(offer, amount) <= payment);
    assert.ok(takeCost(offer, amount + 1n) > payment);
  }
});

test("quoteTake applies take's guards in the contract's order", () => {
  const restricted = { ...offer, taker: "0xb" };
  // The taker check runs before the amount checks, as in the contract.
  assert.throws(() => quoteTake(restricted, 0n, "0xc"), /not the taker/);
  assert.deepEqual(quoteTake(restricted, 10n, "0x0b"), {
    amount: 10n,
    paid: 4n,
  });
  assert.throws(() => quoteTake(offer, 0n), /amount must be a positive u64/);
  assert.throws(() => quoteTake(offer, 1_001n), /exceeds the offer balance/);
  assert.throws(
    () => quoteTake({ ...offer, partialFills: false }, 999n),
    /taken in full/,
  );
  assert.throws(
    () => quoteTake({ ...offer, balance: 0n, partialFills: false }, 1n),
    /exceeds the offer balance/,
  );
});

test("rejects terms the contract could never store", () => {
  assert.throws(() => takeCost({ ...offer, offeredAmount: 0n }, 1n));
  assert.throws(() => takeCost({ ...offer, wantedAmount: 0n }, 1n));
  assert.throws(() => maxTakeForPayment(offer, -1n));
});
