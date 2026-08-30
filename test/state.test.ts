import assert from "node:assert/strict";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";

import {
  decodeLaunchObject,
  getLaunch,
  launchBcs,
} from "../src/launchpad/state.ts";

const objectId = "0xc";
const metadataCapId = "0xd";
const creator = "0xe";
const migrationWitness = `${"0".repeat(63)}b::adapter::WITNESS`;

const uid = (id: string) => ({ id });
const balance = (value: bigint) => ({ value });
const bps = (value: bigint) => ({ value });

function serializeLaunch(id = objectId): Uint8Array {
  return launchBcs
    .serialize({
      id: uid(id),
      lifecycle: { Live: true },
      sell_burn_bps: bps(100n),
      virtual_quote: 1_000n,
      migration_quote_target: 3_000n,
      quote_fee_bps: bps(100n),
      meme_fee_bps: bps(25n),
      quote_migration_fee_bps: bps(75n),
      protocol_meme_graduation_fee_bps: bps(50n),
      meme_liquidity_provision_bps: bps(2_000n),
      migration_witness: migrationWitness,
      meme_reserve: balance(800_000n),
      real_quote_reserve: balance(500n),
      pending_burn: balance(11n),
      protocol_meme_graduation_fee: balance(5_000n),
      meme_liquidity_provision: balance(200_000n),
      fee_ledger: {
        protocol_meme: balance(1n),
        creator_meme: balance(2n),
        protocol_quote: balance(3n),
        creator_quote: balance(4n),
      },
      metadata_cap: { id: uid(metadataCapId) },
      creator_authority: { identity: { Address: creator } },
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
  assert.equal(state.lifecycle, "Live");
  assert.equal(state.memeReserve, 800_000n);
  assert.equal(state.realQuoteReserve, 500n);
  assert.equal(state.pendingBurn, 11n);
  assert.equal(state.protocolMemeTradeFees, 1n);
  assert.equal(state.creatorQuoteTradeFees, 4n);
  assert.equal(state.metadataCapId?.endsWith("0d"), true);
  assert.deepEqual(state.creatorIdentity, {
    kind: "address",
    address:
      "0x000000000000000000000000000000000000000000000000000000000000000e",
  });
  assert.equal(
    state.migrationWitnessType.endsWith("0b::adapter::WITNESS"),
    true,
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
