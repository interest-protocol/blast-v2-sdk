import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";

import { getOpeningRoundBid } from "../src/launchpad/state.ts";
import {
  decodeLpVaultObject,
  getLpFeePolicy,
  getLpFeeShares,
  getLpVault,
  lpFeePolicyBcs,
  lpFeeSharePairBcs,
  lpVaultBcs,
} from "../src/migrators/state.ts";

const objectId = "0xc";
const poolId = "0xd";
const originalPackageId = "0x321";
const uid = (id: string) => ({ id: { bytes: id } });
const balance = (value: bigint) => ({ value });
const feeSplit = {
  creatorBps: 6_000n,
  autoLpBps: 2_000n,
  rewardsBps: 1_000n,
  burnBps: 1_000n,
  recipients: [],
};
const notFound = () =>
  new ObjectError("notExists", "missing", { reason: "notFound" });

function serializeVault(id = objectId): Uint8Array {
  return lpVaultBcs
    .serialize({
      id: uid(id),
      pool_id: { bytes: poolId },
      protocol_meme_residual: balance(5n),
      protocol_quote_residual: balance(6n),
      generation: 2n,
      fee_split: feeSplit,
      creator_meme: balance(1n),
      creator_quote: balance(2n),
      auto_lp_meme: balance(3n),
      auto_lp_quote: balance(4n),
      rewards_meme: balance(7n),
      rewards_quote: balance(8n),
      burn_quote: balance(9n),
      next_round: 3n,
      last_checkpoint: 99n,
    })
    .toBytes();
}

test("decodes LP-vault custody, split generation, and every balance", () => {
  const vault = decodeLpVaultObject(
    {
      objectId,
      initialSharedVersion: "7",
      mutable: true,
      type: `${originalPackageId}::vault::LpVault<0xa::meme::MEME, 0x2::sui::SUI>`,
      content: serializeVault(),
    },
    originalPackageId,
  );

  assert.equal(vault.objectId, normalizeSuiObjectId(objectId));
  assert.equal(vault.poolId, normalizeSuiObjectId(poolId));
  assert.equal(vault.memeType.endsWith("0a::meme::MEME"), true);
  assert.equal(vault.quoteType.endsWith("02::sui::SUI"), true);
  assert.deepEqual(
    {
      protocolMemeResidual: vault.protocolMemeResidual,
      protocolQuoteResidual: vault.protocolQuoteResidual,
      generation: vault.generation,
      feeSplit: vault.feeSplit,
      creatorMeme: vault.creatorMeme,
      creatorQuote: vault.creatorQuote,
      autoLpMeme: vault.autoLpMeme,
      autoLpQuote: vault.autoLpQuote,
      rewardsMeme: vault.rewardsMeme,
      rewardsQuote: vault.rewardsQuote,
      burnQuote: vault.burnQuote,
      nextRound: vault.nextRound,
      lastCheckpoint: vault.lastCheckpoint,
    },
    {
      protocolMemeResidual: 5n,
      protocolQuoteResidual: 6n,
      generation: 2n,
      feeSplit,
      creatorMeme: 1n,
      creatorQuote: 2n,
      autoLpMeme: 3n,
      autoLpQuote: 4n,
      rewardsMeme: 7n,
      rewardsQuote: 8n,
      burnQuote: 9n,
      nextRound: 3n,
      lastCheckpoint: 99n,
    },
  );
});

test("rejects a vault from another package or with a mismatched UID", () => {
  const object = {
    objectId,
    initialSharedVersion: "7",
    mutable: true as const,
    type: `${originalPackageId}::vault::LpVault<0xa::meme::MEME, 0x2::sui::SUI>`,
    content: serializeVault("0xf"),
  };
  assert.throws(
    () => decodeLpVaultObject(object, originalPackageId),
    /mismatched UID/,
  );
  assert.throws(
    () => decodeLpVaultObject({ ...object, content: serializeVault() }, "0x9"),
    /unexpected package/,
  );
});

test("reads a shared vault through the Core API", async () => {
  const client = {
    core: {
      getObject: async () => ({
        object: {
          objectId,
          owner: { $kind: "Shared", Shared: { initialSharedVersion: "7" } },
          type: `${originalPackageId}::vault::LpVault<0xa::meme::MEME, 0x2::sui::SUI>`,
          content: serializeVault(),
        },
      }),
    },
  } as unknown as ClientWithCoreApi;

  const vault = await getLpVault(client, objectId, originalPackageId);
  assert.equal(vault.initialSharedVersion, "7");
});

test("reads the LP-fee policy and resolves a coin's own pair before the defaults", async () => {
  const policyId = normalizeSuiObjectId("0x40");
  const tableId = normalizeSuiObjectId("0x41");
  const memeType = "0xa::meme::MEME";
  const requested: unknown[] = [];
  const client = {
    core: {
      getObject: async () => ({
        object: {
          objectId: policyId,
          owner: { $kind: "Shared", Shared: { initialSharedVersion: "18" } },
          type: `${originalPackageId}::lp_fee_policy::LpFeePolicy`,
          content: lpFeePolicyBcs
            .serialize({
              id: uid(policyId),
              destination: "0xb1a57",
              defaults: { meme_bps: 1_000n, quote_bps: 2_000n },
              coins: { id: uid(tableId), size: 1n },
            })
            .toBytes(),
        },
      }),
      getDynamicField: async (request: unknown) => {
        requested.push(request);
        if (requested.length > 1) throw notFound();
        return {
          dynamicField: {
            value: {
              bcs: lpFeeSharePairBcs
                .serialize({ meme_bps: 500n, quote_bps: 600n })
                .toBytes(),
            },
          },
        };
      },
    },
  } as unknown as ClientWithCoreApi;

  const policy = await getLpFeePolicy(client, policyId, originalPackageId);
  assert.equal(policy.protocolDestination, normalizeSuiAddress("0xb1a57"));
  assert.deepEqual(policy.defaultShares, { memeBps: 1_000n, quoteBps: 2_000n });
  assert.equal(policy.coinSharesTableId, tableId);
  assert.deepEqual(await getLpFeeShares(client, policy, memeType), {
    memeBps: 500n,
    quoteBps: 600n,
    source: "coin",
  });
  assert.deepEqual(requested[0], {
    parentId: tableId,
    name: {
      type: "0x1::type_name::TypeName",
      bcs: bcs
        .string()
        .serialize(
          "000000000000000000000000000000000000000000000000000000000000000a::meme::MEME",
        )
        .toBytes(),
    },
  });
  assert.deepEqual(await getLpFeeShares(client, policy, memeType), {
    memeBps: 1_000n,
    quoteBps: 2_000n,
    source: "default",
  });
});

test("reads a bidder's undelivered opening-round bid, zero without one", async () => {
  let found = true;
  const client = {
    core: {
      getDynamicField: async (request: { name: { type: string } }) => {
        assert.equal(
          request.name.type,
          `${normalizeSuiAddress("0x1")}::launch::OpeningRoundBidKey`,
        );
        if (!found) throw notFound();
        return {
          dynamicField: { value: { bcs: bcs.u64().serialize(42n).toBytes() } },
        };
      },
    },
  } as unknown as ClientWithCoreApi;

  assert.equal(await getOpeningRoundBid(client, "0xc", "0xa", "0x1"), 42n);
  found = false;
  assert.equal(await getOpeningRoundBid(client, "0xc", "0xa", "0x1"), 0n);
});
