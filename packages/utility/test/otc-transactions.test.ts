import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { OtcDeployment } from "../src/otc/transactions.ts";
import { OtcTransactions } from "../src/otc/transactions.ts";
import {
  commandKinds,
  moveCalls,
  moveFunctions,
  shared,
  sharedInputs,
} from "./support.ts";

const deployment: OtcDeployment = { packageId: "0x123" };
const SUI = "0x2::sui::SUI";
const USDC = "0xa::usdc::USDC";

test("escrows, creates, and shares an offer in one transaction", () => {
  const tx = new OtcTransactions(deployment).createOffer({
    offeredType: SUI,
    wantedType: USDC,
    offeredAmount: 1_000n,
    wantedAmount: 333n,
    taker: "0xb",
    partialFills: true,
  });

  assert.deepEqual(moveFunctions(tx), [
    "blast_fun_otc::new",
    "blast_fun_otc::share",
  ]);
  const [created, share] = moveCalls(tx);
  assert.deepEqual(created!.typeArguments, [
    normalizeStructTag(SUI),
    normalizeStructTag(USDC),
  ]);
  assert.deepEqual(pureValues(tx, created!), [
    bcs.u64().serialize(333n).toBytes(),
    bcs.option(bcs.Address).serialize(normalizeSuiAddress("0xb")).toBytes(),
    bcs.bool().serialize(true).toBytes(),
  ]);
  assert.deepEqual(share!.arguments[0], {
    $kind: "Result",
    Result: commandKinds(tx).indexOf("blast_fun_otc::new"),
  });
});

test("an open offer encodes no taker", () => {
  const tx = new OtcTransactions(deployment).createOffer({
    offeredType: SUI,
    wantedType: USDC,
    offeredAmount: 1n,
    wantedAmount: 1n,
    partialFills: false,
  });
  assert.deepEqual(
    pureValues(tx, moveCalls(tx)[0]!)[1],
    bcs.option(bcs.Address).serialize(null).toBytes(),
  );
});

test("takes at the quoted cost, destroys the empty payment, and routes the coins", () => {
  const offer = {
    ...shared("0xc", "9", true),
    offeredType: SUI,
    wantedType: USDC,
    offeredAmount: 1_000n,
    wantedAmount: 333n,
    balance: 1_000n,
    partialFills: true,
    taker: null,
  };
  const tx = new OtcTransactions(deployment).take({
    offer,
    amount: 10n,
    recipient: "0xe",
  });

  assert.deepEqual(commandKinds(tx).slice(-3), [
    "blast_fun_otc::take",
    "coin::destroy_zero",
    "TransferObjects",
  ]);
  const take = moveCalls(tx).find((call) => call.function === "take")!;
  assert.deepEqual(pureValues(tx, take), [bcs.u64().serialize(10n).toBytes()]);
  assert.deepEqual(sharedInputs(tx), [
    {
      objectId: normalizeSuiAddress("0xc"),
      initialSharedVersion: "9",
      mutable: true,
    },
  ]);
  const destroy = moveCalls(tx).find(
    (call) => call.function === "destroy_zero",
  )!;
  assert.deepEqual(destroy.typeArguments, [normalizeStructTag(USDC)]);
  assert.deepEqual(destroy.arguments[0], take.arguments[2]);
});

test("rejects a take the contract would abort before signing", () => {
  const sdk = new OtcTransactions(deployment);
  const offer = {
    ...shared("0xc", "9", true),
    offeredType: SUI,
    wantedType: USDC,
    offeredAmount: 100n,
    wantedAmount: 100n,
    balance: 100n,
    partialFills: false,
    taker: "0xb",
  };
  assert.throws(
    () => sdk.take({ offer, amount: 100n, recipient: "0xe", sender: "0xc" }),
    /not the taker/,
  );
  assert.throws(
    () => sdk.take({ offer, amount: 50n, recipient: "0xe" }),
    /taken in full/,
  );
});

test("cancels and returns the escrow to the recipient", () => {
  const tx = new OtcTransactions(deployment).cancel({
    ...shared("0xc", "9", true),
    offeredType: SUI,
    wantedType: USDC,
    recipient: "0xe",
  });
  assert.deepEqual(commandKinds(tx), [
    "blast_fun_otc::cancel",
    "TransferObjects",
  ]);
});

test("rejects shapes the contract rejects", () => {
  const sdk = new OtcTransactions(deployment);
  const base = {
    offeredType: SUI,
    wantedType: USDC,
    offeredAmount: 1n,
    wantedAmount: 1n,
    partialFills: false,
  };
  assert.throws(
    () => sdk.createOffer({ ...base, wantedType: "0x02::sui::SUI" }),
    /different types/,
  );
  assert.throws(
    () => sdk.createOffer({ ...base, taker: "0x0" }),
    /zero address/,
  );
  assert.throws(() => sdk.createOffer({ ...base, offeredAmount: 0n }));
  assert.throws(() => sdk.createOffer({ ...base, wantedAmount: 0n }));
  assert.throws(
    () =>
      sdk.cancel({
        ...shared("0xc", "9", false),
        offeredType: SUI,
        wantedType: USDC,
        recipient: "0xe",
      } as unknown as Parameters<typeof sdk.cancel>[0]),
    /offer\.mutable must be true/,
  );
});

function pureValues(
  tx: Transaction,
  call: ReturnType<typeof moveCalls>[number],
): Uint8Array[] {
  const inputs = tx.getData().inputs;
  return call.arguments.flatMap((argument) => {
    if (argument.$kind !== "Input") return [];
    const input = inputs[argument.Input];
    return input?.$kind === "Pure"
      ? [Uint8Array.from(Buffer.from(input.Pure.bytes, "base64"))]
      : [];
  });
}
