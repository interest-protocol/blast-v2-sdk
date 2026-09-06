import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSuiObjectId } from "@mysten/sui/utils";
import {
  autoLpVaultBcs,
  decodeAutoLpVault,
  previewAutoLpCompound,
} from "../src/auto-lp/state.ts";
import {
  decodeDexPool,
  decodeDexPosition,
  dexPoolBcs,
  dexPositionBcs,
} from "../src/dex/state.ts";

const uid = (bytes: string) => ({ id: { bytes } });
const pair = "0x3::m::M,0x2::sui::SUI";
const poolContent = () =>
  dexPoolBcs
    .serialize({
      id: uid("0x20"),
      meme: { value: 100_000n },
      quote: { value: 100_000n },
      quote_fees: { value: 100n },
      total_shares: 100_000n,
      fee_growth_x64: 0n,
      volume_x32: 0n,
      last_trade_seconds: 0n,
      volume_target: 100_000n,
      max_fee_bps: 200n,
      burn_bps: 0n,
    })
    .toBytes();
const poolObject = () => ({
  objectId: "0x20",
  type: `0xc::pool::Pool<${pair}>`,
  content: poolContent(),
  initialSharedVersion: "9",
});

test("DEX decodes canonical pool reserves and rejects UID, type or lineage mismatch", () => {
  const state = decodeDexPool(poolObject(), "0xc");
  assert.equal(state.memeReserve, 100_000n);
  assert.equal(state.quoteFees, 100n);
  assert.equal(state.originalPackageId, normalizeSuiObjectId("0xc"));
  assert.throws(() => decodeDexPool(poolObject(), "0xd"), /package/);
  assert.throws(
    () => decodeDexPool({ ...poolObject(), objectId: "0x21" }, "0xc"),
    /UID/,
  );
  assert.throws(
    () =>
      decodeDexPool(
        { ...poolObject(), type: `0xc::pool::Position<${pair}>` },
        "0xc",
      ),
    /type/,
  );
});

test("DEX owned position preserves fee fractions and binds its pool", () => {
  const content = dexPositionBcs
    .serialize({
      id: uid("0x30"),
      pool_id: { bytes: "0x20" },
      shares: 99_000n,
      fee_checkpoint_x64: 0n,
      fees_owed: 19n,
      fee_fraction_x64: 42n,
    })
    .toBytes();
  const position = decodeDexPosition(
    { objectId: "0x30", type: `0xc::pool::Position<${pair}>`, content },
    "0xc",
  );
  assert.equal(position.feesOwed, 19n);
  assert.equal(position.feeFractionX64, 42n);
  assert.equal(position.poolId, normalizeSuiObjectId("0x20"));
});

test("AutoLP snapshot previews retained excess including unclaimed position fees", () => {
  const content = autoLpVaultBcs
    .serialize({
      id: uid("0x40"),
      pool_id: { bytes: "0x20" },
      executor: "0x99",
      meme: { value: 10_000n },
      quote: { value: 30_000n },
    })
    .toBytes();
  const vault = decodeAutoLpVault(
    {
      objectId: "0x40",
      type: `0xb::vault::Vault<${pair}>`,
      content,
      initialSharedVersion: "10",
    },
    "0xb",
  );
  const pool = decodeDexPool(poolObject(), "0xc");
  const position = {
    poolId: pool.objectId,
    shares: 0n,
    feeCheckpointX64: 0n,
    feesOwed: 50n,
    feeFractionX64: 0n,
  };
  const preview = previewAutoLpCompound(vault, pool, position);
  assert.equal(preview.shares, 10_000n);
  assert.equal(preview.quoteRefund, 20_050n);
  assert.equal(preview.ownQuoteFees, 50n);
  assert.equal(preview.willSkip, false);
  assert.throws(
    () =>
      previewAutoLpCompound(
        { ...vault, poolId: normalizeSuiObjectId("0x21") },
        pool,
        position,
      ),
    /pool/,
  );
});

test("canonical pool lookup encodes Move TypeName without 0x prefixes", async () => {
  const { getCanonicalDexPool, dexFactoryBcs } = await import(
    "../src/dex/state.ts"
  );
  const { suiIdBcs } = await import("../src/lib/bcs.ts");
  const { bcs } = await import("@mysten/sui/bcs");
  const factory = {
    objectId: "0xf",
    type: "0xc::pool::Factory",
    content: dexFactoryBcs
      .serialize({
        id: uid("0xf"),
        version: 1n,
        pools: { id: uid("0x50"), size: 1n },
      })
      .toBytes(),
  };
  const client = {
    core: {
      getObject: async ({ objectId }: { objectId: string }) => ({
        object: {
          ...(objectId === normalizeSuiObjectId("0xf")
            ? factory
            : poolObject()),
          owner: { $kind: "Shared", Shared: { initialSharedVersion: "9" } },
        },
      }),
      getDynamicField: async ({
        parentId,
        name,
      }: {
        parentId: string;
        name: { type: string; bcs: Uint8Array };
      }) => {
        assert.equal(parentId, normalizeSuiObjectId("0x50"));
        assert.equal(
          bcs.string().parse(name.bcs),
          `${"3".padStart(64, "0")}::m::M`,
        );
        return {
          dynamicField: {
            value: {
              type: "0x2::object::ID",
              bcs: suiIdBcs.serialize({ bytes: "0x20" }).toBytes(),
            },
          },
        };
      },
    },
  } as unknown as import("@mysten/sui/client").ClientWithCoreApi;
  assert.equal(
    (await getCanonicalDexPool(client, "0xf", "0x3::m::M", "0xc")).objectId,
    normalizeSuiObjectId("0x20"),
  );
});

test("AutoLP children use original-package unit keys and validate the sealed position binding", async () => {
  const { getAutoLpPosition, getAutoLpCreatorCap } = await import(
    "../src/auto-lp/state.ts"
  );
  const { suiUidBcs } = await import("../src/lib/bcs.ts");
  const vault = {
    objectId: "0x40",
    type: `0xb::vault::Vault<${pair}>`,
    content: autoLpVaultBcs
      .serialize({
        id: uid("0x40"),
        pool_id: { bytes: "0x20" },
        executor: "0x99",
        meme: { value: 0n },
        quote: { value: 0n },
      })
      .toBytes(),
    owner: { $kind: "Shared", Shared: { initialSharedVersion: "9" } },
  };
  let wrongPool = false;
  const client = {
    core: {
      getObject: async () => ({ object: vault }),
      getDynamicObjectField: async ({
        parentId,
        name,
      }: {
        parentId: string;
        name: { type: string; bcs: Uint8Array };
      }) => {
        assert.equal(parentId, normalizeSuiObjectId("0x40"));
        assert.deepEqual(name.bcs, Uint8Array.of(0));
        assert.ok(
          name.type.startsWith(`${normalizeSuiObjectId("0xb")}::vault::`),
        );
        if (name.type.endsWith("CreatorCapKey"))
          return {
            object: {
              objectId: "0x31",
              type: "0x1a::creator_authority::CreatorCap<0x3::m::M>",
              content: suiUidBcs.serialize(uid("0x31")).toBytes(),
            },
          };
        return {
          object: {
            objectId: "0x30",
            type: `0xc::pool::Position<${pair}>`,
            content: dexPositionBcs
              .serialize({
                id: uid("0x30"),
                pool_id: { bytes: wrongPool ? "0x21" : "0x20" },
                shares: 0n,
                fee_checkpoint_x64: 0n,
                fees_owed: 0n,
                fee_fraction_x64: 0n,
              })
              .toBytes(),
          },
        };
      },
    },
  } as unknown as import("@mysten/sui/client").ClientWithCoreApi;
  assert.equal(
    (await getAutoLpPosition(client, "0x40", "0xb", "0xc")).poolId,
    normalizeSuiObjectId("0x20"),
  );
  assert.equal(
    (await getAutoLpCreatorCap(client, "0x40", "0xb", "0x1a")).objectId,
    "0x31",
  );
  wrongPool = true;
  await assert.rejects(
    getAutoLpPosition(client, "0x40", "0xb", "0xc"),
    /pool or pair/,
  );
});

test("native migration position discovery binds the original unit key and pool", async () => {
  const { getNativeLpPosition, nativeLpVaultBcs } = await import(
    "../src/dex/state.ts"
  );
  const zero = { value: 0n };
  const vault = {
    objectId: "0x40",
    type: `0xc::migration::LockedLpVault<${pair}>`,
    content: nativeLpVaultBcs
      .serialize({
        id: uid("0x40"),
        pool_id: { bytes: "0x20" },
        fees: {
          protocol_meme: zero,
          creator_meme: zero,
          protocol_quote: zero,
          creator_quote: zero,
        },
      })
      .toBytes(),
    owner: { $kind: "Shared", Shared: { initialSharedVersion: "9" } },
  };
  let wrongPool = false;
  const client = {
    core: {
      getObject: async () => ({ object: vault }),
      getDynamicObjectField: async ({
        parentId,
        name,
      }: {
        parentId: string;
        name: { type: string; bcs: Uint8Array };
      }) => {
        assert.equal(parentId, normalizeSuiObjectId("0x40"));
        assert.equal(
          name.type,
          `${normalizeSuiObjectId("0xc")}::migration::PositionKey`,
        );
        assert.deepEqual(name.bcs, Uint8Array.of(0));
        return {
          object: {
            objectId: "0x30",
            type: `0xc::pool::Position<${pair}>`,
            content: dexPositionBcs
              .serialize({
                id: uid("0x30"),
                pool_id: { bytes: wrongPool ? "0x21" : "0x20" },
                shares: 99_000n,
                fee_checkpoint_x64: 0n,
                fees_owed: 0n,
                fee_fraction_x64: 0n,
              })
              .toBytes(),
          },
        };
      },
    },
  } as unknown as import("@mysten/sui/client").ClientWithCoreApi;
  assert.equal(
    (await getNativeLpPosition(client, "0x40", "0xc")).shares,
    99_000n,
  );
  wrongPool = true;
  await assert.rejects(
    getNativeLpPosition(client, "0x40", "0xc"),
    /pool or pair/,
  );
});
