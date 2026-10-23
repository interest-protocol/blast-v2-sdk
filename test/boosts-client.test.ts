import assert from "node:assert/strict";
import test from "node:test";
import { BoostsClient } from "@interest-protocol/blast-boosts-sdk/client";
import type { BoostsTransport } from "@interest-protocol/blast-boosts-sdk/types";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  BOOSTS_FIXTURE_MANIFEST,
  fixtureEvent,
  fixtureRead,
} from "./boosts-fixtures.ts";

test("reads all Alpha products and five exact wallet balances without a signer", async () => {
  const balanceRequests: Array<{ owner: string; coinType: string }> = [];
  const transport = baseTransport({
    getBalance: async (input) => {
      balanceRequests.push(input);
      return String(balanceRequests.length);
    },
  });
  const client = new BoostsClient(transport, BOOSTS_FIXTURE_MANIFEST);
  const products = await client.getProducts();
  assert.deepEqual(
    products.map((result) => result.ok && result.snapshot.identity.productKey),
    ["sui-2x-bull", "nvda-2x-bull", "zec-2x-bull"],
  );
  const balances = await client.getWalletBalances("0xbeef");
  assert.deepEqual(
    [
      balances.suiAtoms,
      balances.usdcAtoms,
      balances.productSharesAtoms["sui-2x-bull"],
      balances.productSharesAtoms["nvda-2x-bull"],
      balances.productSharesAtoms["zec-2x-bull"],
    ],
    ["1", "2", "3", "4", "5"],
  );
  assert.equal(balanceRequests.length, 5);
});

test("reads only the configured NVDA product and wallet balance", async () => {
  const balanceRequests: Array<{ owner: string; coinType: string }> = [];
  const client = new BoostsClient(
    baseTransport({
      getBalance: async (input) => {
        balanceRequests.push(input);
        return String(balanceRequests.length);
      },
    }),
    {
      ...BOOSTS_FIXTURE_MANIFEST,
      products: [BOOSTS_FIXTURE_MANIFEST.products[1]],
    },
  );

  const products = await client.getProducts();
  assert.deepEqual(
    products.map((result) => result.ok && result.snapshot.identity.productKey),
    ["nvda-2x-bull"],
  );
  const balances = await client.getWalletBalances("0xbeef");
  assert.deepEqual(balances.productSharesAtoms, { "nvda-2x-bull": "3" });
  assert.equal(balanceRequests.length, 3);
});

test("rejects wallet reads from a contradictory chain", async () => {
  const client = new BoostsClient(
    baseTransport({ getChainIdentifier: async () => "wrong-chain" }),
    BOOSTS_FIXTURE_MANIFEST,
  );
  await assert.rejects(
    client.getWalletBalances("0xbeef"),
    /wrong network or chain/,
  );
});

test("sanitizes transport failures as retryable data unavailability", async () => {
  const secret = "https://rpc.example/?token=do-not-leak";
  const client = new BoostsClient(
    baseTransport({
      readProduct: async () => {
        throw new Error(secret);
      },
    }),
    BOOSTS_FIXTURE_MANIFEST,
  );
  const result = await client.getProduct("sui-2x-bull");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "DATA_UNAVAILABLE");
    assert.equal(result.retryable, true);
    assert.equal(
      result.message,
      "Boosts product data is temporarily unavailable",
    );
    assert.equal(result.message.includes(secret), false);
  }
});

test("waits until both matching effects and an exact event are indexed", async () => {
  let calls = 0;
  const entry = fixtureEvent("sui-2x-bull", "Minted");
  const event: SuiClientTypes.Event = entry;
  const transport = baseTransport({
    getIndexedTransaction: async () => {
      calls += 1;
      if (calls === 1) return null;
      if (calls === 2) {
        return {
          digest: "target",
          checkpoint: "101",
          events: [event],
          changedObjectIds: [],
        };
      }
      return {
        digest: "target",
        checkpoint: "101",
        events: [event],
        changedObjectIds: [BOOSTS_FIXTURE_MANIFEST.products[0].vault.objectId],
      };
    },
  });
  const result = await new BoostsClient(
    transport,
    BOOSTS_FIXTURE_MANIFEST,
  ).waitForIndexedVisibility("sui-2x-bull", "target", {
    timeoutMs: 1_000,
    pollScheduleMs: [0],
  });
  assert.equal(calls, 3);
  assert.equal(result.transactionDigest, "target");
  assert.equal(result.activity.kind, "minted");
});

test("checks chain identity before indexed waits", async () => {
  let polled = false;
  const client = new BoostsClient(
    baseTransport({
      getChainIdentifier: async () => "wrong-chain",
      getIndexedTransaction: async () => {
        polled = true;
        return null;
      },
    }),
    BOOSTS_FIXTURE_MANIFEST,
  );
  await assert.rejects(
    client.waitForIndexedVisibility("sui-2x-bull", "target"),
    /wrong network or chain/,
  );
  assert.equal(polled, false);
});

test("removes an abort listener after an indexed-wait delay completes", async () => {
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    reason: undefined,
    throwIfAborted() {},
    addEventListener(type: string) {
      if (type === "abort") added += 1;
    },
    removeEventListener(type: string) {
      if (type === "abort") removed += 1;
    },
  } as unknown as AbortSignal;
  const event: SuiClientTypes.Event = fixtureEvent("sui-2x-bull", "Minted");
  const client = new BoostsClient(
    baseTransport({
      getIndexedTransaction: async () => ({
        digest: "target",
        checkpoint: "101",
        events: [event],
        changedObjectIds: [BOOSTS_FIXTURE_MANIFEST.products[0].vault.objectId],
      }),
    }),
    BOOSTS_FIXTURE_MANIFEST,
  );
  await client.waitForIndexedVisibility("sui-2x-bull", "target", {
    timeoutMs: 1_000,
    pollScheduleMs: [1],
    signal,
  });
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

function baseTransport(
  overrides: Partial<BoostsTransport> = {},
): BoostsTransport {
  return {
    readProduct: async (product) => fixtureRead(product.productKey),
    getChainIdentifier: async () => "fixture-chain",
    getBalance: async () => "0",
    listEvents: async () => ({
      events: [],
      hasNextPage: false,
      startCursor: null,
      endCursor: null,
    }),
    getIndexedTransaction: async () => null,
    ...overrides,
  };
}
