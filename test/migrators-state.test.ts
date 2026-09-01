import assert from "node:assert/strict";
import test from "node:test";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";

import {
  AFTERMATH_DEFAULT_POLICY,
  aftermathPolicyBcs,
  decodeLpVaultObject,
  getAftermathPolicy,
  getLpVault,
  getVenueTier,
  lpVaultBcs,
  venueTierBcs,
} from "../src/migrators/state.ts";

const objectId = "0xc";
const poolId = "0xd";
const originalPackageId = "0x321";
const uid = (id: string) => ({ id: { bytes: id } });
const balance = (value: bigint) => ({ value });

function serializeVault(id = objectId): Uint8Array {
  return lpVaultBcs
    .serialize({
      id: uid(id),
      pool_id: { bytes: poolId },
      fee_ledger: {
        protocol_meme: balance(1n),
        creator_meme: balance(2n),
        protocol_quote: balance(3n),
        creator_quote: balance(4n),
      },
    })
    .toBytes();
}

test("decodes LP-vault identity, pool, types, and atomic fee totals", () => {
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

  assert.equal(vault.objectId.endsWith("0c"), true);
  assert.equal(vault.poolId.endsWith("0d"), true);
  assert.equal(vault.memeType.endsWith("0a::meme::MEME"), true);
  assert.equal(vault.quoteType.endsWith("02::sui::SUI"), true);
  assert.deepEqual(
    [
      vault.protocolMemeFees,
      vault.creatorMemeFees,
      vault.protocolQuoteFees,
      vault.creatorQuoteFees,
    ],
    [1n, 2n, 3n, 4n],
  );
});

test("reads an LP vault through the transport-neutral Core API", async () => {
  const client = {
    core: {
      getObject: async () => ({
        object: {
          objectId,
          owner: {
            $kind: "Shared",
            Shared: { initialSharedVersion: "7" },
          },
          type: `${originalPackageId}::vault::LpVault<0xa::meme::MEME, 0x2::sui::SUI>`,
          content: serializeVault(),
        },
      }),
    },
  } as unknown as ClientWithCoreApi;

  const vault = await getLpVault(client, objectId, originalPackageId);

  assert.equal(vault.initialSharedVersion, "7");
  assert.equal(vault.mutable, true);
});

test("reads a pinned venue tier using original-package type identity", async () => {
  let request: unknown;
  const client = {
    core: {
      getDynamicField: async (options: unknown) => {
        request = options;
        return {
          dynamicField: {
            value: {
              type: `${originalPackageId}::venue_config::Tier`,
              bcs: venueTierBcs
                .serialize({ tick_spacing: 100, fee_rate: 30_000n })
                .toBytes(),
            },
          },
        };
      },
    },
  } as unknown as ClientWithCoreApi;

  const tier = await getVenueTier(client, "0xe", "cetus", originalPackageId);

  assert.deepEqual(tier, {
    venue: "cetus",
    tickSpacing: 100,
    feeRate: 30_000,
    source: "override",
  });
  assert.match(
    String((request as { name: { type: string } }).name.type),
    /::venue_config::TierKey<.*::cetus::Venue>$/,
  );
});

test("uses the documented venue default only when the tier field is absent", async () => {
  const client = {
    core: {
      getDynamicField: async () => {
        throw new ObjectError("notExists", "missing", {
          reason: "notFound",
        });
      },
    },
  } as unknown as ClientWithCoreApi;

  assert.deepEqual(
    await getVenueTier(client, "0xe", "bluefin", originalPackageId),
    {
      venue: "bluefin",
      tickSpacing: 200,
      feeRate: 10_000,
      source: "default",
    },
  );
});

test("reads a pinned Aftermath policy using its module-owned sealed key", async () => {
  let request: unknown;
  const client = {
    core: {
      getDynamicField: async (options: unknown) => {
        request = options;
        return {
          dynamicField: {
            value: {
              type: `${originalPackageId}::aftermath::AftermathPolicy`,
              bcs: aftermathPolicyBcs
                .serialize({
                  meme_weight: 600_000_000_000_000_000n,
                  quote_weight: 400_000_000_000_000_000n,
                  swap_in_fee: 20_000_000_000_000_000n,
                })
                .toBytes(),
            },
          },
        };
      },
    },
  } as unknown as ClientWithCoreApi;

  const policy = await getAftermathPolicy(client, "0xe", originalPackageId);

  assert.deepEqual(policy, {
    memeWeight: 600_000_000_000_000_000n,
    quoteWeight: 400_000_000_000_000_000n,
    swapInFee: 20_000_000_000_000_000n,
    source: "override",
  });
  assert.match(
    String((request as { name: { type: string } }).name.type),
    /::aftermath::PolicyKey$/,
  );
});

test("uses the compiled Aftermath policy only when its field is absent", async () => {
  const client = {
    core: {
      getDynamicField: async () => {
        throw new ObjectError("notExists", "missing", {
          reason: "notFound",
        });
      },
    },
  } as unknown as ClientWithCoreApi;

  assert.equal(
    await getAftermathPolicy(client, "0xe", originalPackageId),
    AFTERMATH_DEFAULT_POLICY,
  );
});

test("rejects a corrupt pinned Aftermath policy", async () => {
  const client = {
    core: {
      getDynamicField: async () => ({
        dynamicField: {
          value: {
            type: `${originalPackageId}::aftermath::AftermathPolicy`,
            bcs: aftermathPolicyBcs
              .serialize({
                meme_weight: 500_000_000_000_000_000n,
                quote_weight: 499_000_000_000_000_000n,
                swap_in_fee: 20_000_000_000_000_000n,
              })
              .toBytes(),
          },
        },
      }),
    },
  } as unknown as ClientWithCoreApi;

  await assert.rejects(
    getAftermathPolicy(client, "0xe", originalPackageId),
    /sum to 100%/,
  );
});

test("does not hide transport or corrupt tier errors as defaults", async () => {
  const client = {
    core: {
      getDynamicField: async () => {
        throw new ObjectError("deleted", "deleted", { reason: "deleted" });
      },
    },
  } as unknown as ClientWithCoreApi;

  await assert.rejects(
    getVenueTier(client, "0xe", "mmt", originalPackageId),
    /deleted/,
  );
});
