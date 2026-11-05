import assert from "node:assert/strict";
import test from "node:test";
import {
  blastMigrators,
  MigratorsClient,
} from "@interest-protocol/blast-migrators-sdk/client";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { fromHex, normalizeStructTag } from "@mysten/sui/utils";
import { MEME_A, MIGRATORS } from "./fixtures/migrators-deployment.ts";

const tiers: Record<string, Uint8Array> = {
  [normalizeStructTag(`0x3000::cetus::PoolTierKey<${MEME_A}>`)]:
    fromHex("c8000000"),
  [normalizeStructTag(`0x3000::bluefin::PoolTierKey<${MEME_A}>`)]: fromHex(
    "3c000000b80b000000000000",
  ),
};

const core = {
  core: {
    getDynamicField: async ({ name }: { name: { type: string } }) => ({
      dynamicField: { value: { type: "", bcs: tiers[name.type] } },
    }),
    getDynamicObjectField: async () => ({ object: { objectId: "0xcab" } }),
  },
} as unknown as ClientWithCoreApi;

test("blastMigrators registers a deployment-bound client", async () => {
  const registration = blastMigrators(MIGRATORS);
  assert.equal(registration.name, "blastMigrators");
  assert.equal(blastMigrators({ ...MIGRATORS, name: "venues" }).name, "venues");

  const client = registration.register(core);
  assert.ok(client instanceof MigratorsClient);
  assert.equal(
    client.call.deployment.venueConfig.objectId,
    `0x${"0".repeat(60)}3020`,
  );
  assert.deepEqual(client.tx.call.deployment, client.call.deployment);
  assert.equal(await client.getCetusPoolTier(MEME_A), 200);
  assert.equal(
    await client.getCetusPoolCreationCapId(MEME_A),
    `0x${"0".repeat(61)}cab`,
  );
  assert.deepEqual(await client.getBluefinPoolTier(MEME_A), {
    tickSpacing: 60,
    feeRate: 3_000n,
  });
});
