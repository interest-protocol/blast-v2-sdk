import assert from "node:assert/strict";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";

import {
  decodeLaunchObject,
  getLaunch,
  launchBcs,
} from "../src/launchpad/state.ts";

const objectId = "0xc";
const metadataCapId = "0xd";
const creator = "0xe";
const migrationWitness = `${"0".repeat(63)}b::adapter::WITNESS`;

const uid = (id: string) => ({ id: { bytes: id } });
const balance = (value: bigint) => ({ value });
const feeSplit = {
  creatorBps: 5_000n,
  autoLpBps: 2_000n,
  rewardsBps: 2_000n,
  burnBps: 0n,
  recipients: [
    {
      destination:
        "0x000000000000000000000000000000000000000000000000000000000000000f",
      bps: 1_000n,
    },
  ],
};
const allocationPlan = {
  curveMemeBps: 8_000n,
  lpMemeBps: 1_900n,
  lpQuoteBps: 9_900n,
  recipients: [
    {
      destination:
        "0x000000000000000000000000000000000000000000000000000000000000000a",
      memeBps: 100n,
      quoteBps: 100n,
    },
  ],
};

function serializeLaunch(id = objectId): Uint8Array {
  return launchBcs
    .serialize({
      id: uid(id),
      lifecycle: { MigrationReady: true },
      protection_end_ms: "61000",
      protection_window_ms: 60_000n,
      cumulative_atomic_limit: 10_000n,
      per_transaction_atomic_limit: 5_000n,
      sell_burn_bps: 100n,
      virtual_quote: 1_000n,
      graduation_target: 3_000n,
      quote_fee_bps: 100n,
      meme_fee_bps: 25n,
      migration_witness: migrationWitness,
      pool_tick_spacing: 200,
      pool_fee_rate: 10_000n,
      lp_fee_split: feeSplit,
      atomic_supply: 1_000_000n,
      meme_reserve: balance(800_000n),
      real_quote_reserve: balance(500n),
      pending_burn: balance(11n),
      allocation_plan: allocationPlan,
      allocated_meme: balance(200_000n),
      fee_ledger: {
        protocol_meme: balance(1n),
        creator_meme: balance(2n),
        protocol_quote: balance(3n),
        creator_quote: balance(4n),
      },
      metadata_cap: { id: uid(metadataCapId) },
      creator: { Address: creator },
      curve_fee_cap_id: { bytes: "0x12" },
      blast_metadata_cap_id: { bytes: "0x11" },
    })
    .toBytes();
}

test("decodes the complete launch BCS state", () => {
  const content = serializeLaunch();

  const state = decodeLaunchObject(
    {
      objectId,
      initialSharedVersion: "7",
      mutable: true,
      type: "0x1::launch::Launch<0xa::meme::MEME, 0x2::sui::SUI>",
      content,
    },
    "0x1",
  );

  assert.equal(state.objectId.endsWith("0c"), true);
  assert.equal(state.initialSharedVersion, "7");
  assert.equal(state.mutable, true);
  assert.equal(state.memeType.endsWith("0a::meme::MEME"), true);
  assert.equal(state.quoteType.endsWith("02::sui::SUI"), true);
  assert.equal(state.lifecycle, "MigrationReady");
  assert.equal(state.protectionEndMs, 61_000n);
  assert.deepEqual(state.protection, {
    windowMs: 60_000n,
    cumulativeAtomicLimit: 10_000n,
    perTransactionAtomicLimit: 5_000n,
  });
  assert.equal(state.graduationTarget, 3_000n);
  assert.equal(state.poolTickSpacing, 200);
  assert.equal(state.poolFeeRate, 10_000n);
  assert.deepEqual(state.lpFeeSplit, feeSplit);
  assert.deepEqual(state.allocationPlan, allocationPlan);
  assert.equal(state.atomicSupply, 1_000_000n);
  assert.equal(state.memeReserve, 800_000n);
  assert.equal(state.realQuoteReserve, 500n);
  assert.equal(state.pendingBurn, 11n);
  assert.equal(state.allocatedMeme, 200_000n);
  assert.equal(state.protocolMemeTradeFees, 1n);
  assert.equal(state.creatorQuoteTradeFees, 4n);
  assert.equal(state.metadataCapId.endsWith("0d"), true);
  assert.equal(state.curveFeeCapId, normalizeSuiObjectId("0x12"));
  assert.equal(
    state.blastMetadataCapId,
    "0x0000000000000000000000000000000000000000000000000000000000000011",
  );
  assert.deepEqual(state.creatorRecipient, {
    kind: "address",
    address:
      "0x000000000000000000000000000000000000000000000000000000000000000e",
  });
  assert.equal(
    state.migrationWitnessType,
    normalizeStructTag(migrationWitness),
  );
});

test("preserves the initial shared version returned by the Core API", async () => {
  const client = {
    core: {
      getObject: async () => ({
        object: {
          objectId,
          owner: {
            $kind: "Shared",
            Shared: { initialSharedVersion: "7" },
          },
          type: "0x1::launch::Launch<0xa::meme::MEME, 0x2::sui::SUI>",
          content: serializeLaunch(),
        },
      }),
    },
  } as unknown as ClientWithCoreApi;

  const state = await getLaunch(client, objectId, "0x1");

  assert.deepEqual(
    {
      objectId: state.objectId,
      initialSharedVersion: state.initialSharedVersion,
      mutable: state.mutable,
    },
    {
      objectId:
        "0x000000000000000000000000000000000000000000000000000000000000000c",
      initialSharedVersion: "7",
      mutable: true,
    },
  );
});

test("rejects a launch object whose embedded UID does not match", () => {
  const content = serializeLaunch("0xf");

  assert.throws(
    () =>
      decodeLaunchObject({
        objectId,
        initialSharedVersion: "7",
        mutable: true,
        type: "0x1::launch::Launch<0xa::meme::MEME, 0x2::sui::SUI>",
        content,
      }),
    /mismatched UID/,
  );
});
