import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { autoLpEventBcs, decodeAutoLpEvent } from "../src/auto-lp/events.ts";
import {
  applyAutoLpEvent,
  createAutoLpReplayState,
} from "../src/auto-lp/reducer.ts";
import { decodeDexEvent, dexEventBcs } from "../src/dex/events.ts";
import { applyDexEvent, createDexReplayState } from "../src/dex/reducer.ts";

const packages = { packageId: "0xd", originalPackageId: "0xc" };
const pair = ["0x3::m::M", "0x2::sui::SUI"];
function event(
  module: string,
  name: string,
  bytes: Uint8Array,
  index: number,
  generics = "",
) {
  return {
    packageId: "0xd",
    module,
    eventType: `0xc::${module}::${name}${generics}`,
    sender: "0x99",
    checkpoint: "1",
    transactionDigest: "digest",
    eventIndex: index,
    json: {},
    bcs: bytes,
  };
}

test("DEX event decoder binds emitter, lineage and generic arity and rejects trailing bytes", () => {
  const bytes = dexEventBcs.pool.PoolCreated.serialize({
    pool_id: "0x20",
    position_id: "0x30",
    meme: 100_000n,
    quote: 100_000n,
    total_shares: 100_000n,
    burn_bps: 0n,
    max_fee_bps: 200n,
    timestamp_seconds: 0n,
  }).toBytes();
  const raw = event("pool", "PoolCreated", bytes, 0, `<${pair.join(",")}>`);
  assert.deepEqual(
    decodeDexEvent(raw, packages).typeArguments,
    pair.map(normalizeStructTag),
  );
  assert.throws(
    () => decodeDexEvent({ ...raw, packageId: "0xe" }, packages),
    /emitter/,
  );
  assert.throws(
    () =>
      decodeDexEvent({ ...raw, eventType: "0xc::pool::PoolCreated" }, packages),
    /arguments/,
  );
  assert.throws(
    () =>
      decodeDexEvent({ ...raw, bcs: new Uint8Array([...bytes, 0]) }, packages),
    /BCS/,
  );
});

test("DEX replay preserves separate fees, checkpoints new LPs, and deduplicates events", () => {
  const state = createDexReplayState();
  const created = decodeDexEvent(
    event(
      "pool",
      "PoolCreated",
      dexEventBcs.pool.PoolCreated.serialize({
        pool_id: "0x20",
        position_id: "0x30",
        meme: 100_000n,
        quote: 100_000n,
        total_shares: 100_000n,
        burn_bps: 0n,
        max_fee_bps: 200n,
        timestamp_seconds: 0n,
      }).toBytes(),
      0,
      `<${pair.join(",")}>`,
    ),
    packages,
  );
  applyDexEvent(state, created);
  const swap = decodeDexEvent(
    event(
      "pool",
      "Swapped",
      dexEventBcs.pool.Swapped.serialize({
        pool_id: "0x20",
        buy: true,
        meme_principal: 50_000n,
        quote_principal: 100_000n,
        quote_fee: 1_000n,
        meme_burn: 0n,
        meme_reserve: 50_000n,
        quote_reserve: 200_000n,
        fee_balance: 1_000n,
        volume_x32: 100_000n << 32n,
        timestamp_seconds: 0n,
      }).toBytes(),
      1,
    ),
    packages,
  );
  applyDexEvent(state, swap);
  applyDexEvent(state, swap);
  const pool = state.pools.get(normalizeSuiAddress("0x20"));
  assert.equal(pool?.quoteFees, 1_000n);
  assert.equal(pool?.quoteReserve, 200_000n);
  assert.equal(
    state.positions.get(normalizeSuiAddress("0x30"))?.shares,
    99_000n,
  );
});

test("AutoLP replay retains executor and unspent custody without inventing payouts", () => {
  const state = createAutoLpReplayState();
  applyAutoLpEvent(
    state,
    decodeAutoLpEvent(
      event(
        "vault",
        "Enrolled",
        autoLpEventBcs.vault.Enrolled.serialize({
          vault_id: "0x40",
          pool_id: "0x20",
          creator_cap_id: "0x31",
          position_id: "0x32",
          executor: "0x99",
        }).toBytes(),
        0,
      ),
      packages,
    ),
  );
  applyAutoLpEvent(
    state,
    decodeAutoLpEvent(
      event(
        "vault",
        "Contributed",
        autoLpEventBcs.vault.Contributed.serialize({
          vault_id: "0x40",
          meme: 10_000n,
          quote: 30_000n,
          meme_total: 10_000n,
          quote_total: 30_000n,
        }).toBytes(),
        1,
      ),
      packages,
    ),
  );
  applyAutoLpEvent(
    state,
    decodeAutoLpEvent(
      event(
        "vault",
        "Compounded",
        autoLpEventBcs.vault.Compounded.serialize({
          vault_id: "0x40",
          meme: 10_000n,
          quote: 10_000n,
          shares: 10_000n,
          meme_total: 0n,
          quote_total: 20_000n,
        }).toBytes(),
        2,
      ),
      packages,
    ),
  );
  const vault = state.vaults.get(normalizeSuiAddress("0x40"));
  assert.equal(vault?.quoteAmount, 20_000n);
  assert.equal(vault?.executor, normalizeSuiAddress("0x99"));
  assert.equal(vault?.shares, 10_000n);
});

test("DEX replay matches Move's mixed swap, liquidity and claim vector including native fees", () => {
  const state = createDexReplayState();
  let index = 0;
  const apply = (
    module: "pool" | "migration",
    name: string,
    bytes: Uint8Array,
    generics = "",
  ) => {
    const decoded = decodeDexEvent(
      event(module, name, bytes, index++, generics),
      packages,
    );
    applyDexEvent(state, decoded);
  };
  apply(
    "pool",
    "PoolCreated",
    dexEventBcs.pool.PoolCreated.serialize({
      pool_id: "0x20",
      position_id: "0x30",
      meme: 100_000n,
      quote: 100_000n,
      total_shares: 100_000n,
      burn_bps: 0n,
      max_fee_bps: 200n,
      timestamp_seconds: 0n,
    }).toBytes(),
    `<${pair.join(",")}>`,
  );
  apply(
    "migration",
    "Migrated",
    dexEventBcs.migration.Migrated.serialize({
      launch_id: "0x10",
      pool_id: "0x20",
      vault_id: "0x40",
      position_id: "0x30",
      meme: 100_000n,
      quote: 100_000n,
    }).toBytes(),
  );
  apply(
    "pool",
    "Swapped",
    dexEventBcs.pool.Swapped.serialize({
      pool_id: "0x20",
      buy: true,
      meme_principal: 50_000n,
      quote_principal: 100_000n,
      quote_fee: 1_000n,
      meme_burn: 0n,
      meme_reserve: 50_000n,
      quote_reserve: 200_000n,
      fee_balance: 1_000n,
      volume_x32: 100_000n << 32n,
      timestamp_seconds: 0n,
    }).toBytes(),
  );
  apply(
    "pool",
    "PositionCreated",
    dexEventBcs.pool.PositionCreated.serialize({
      pool_id: "0x20",
      position_id: "0x31",
    }).toBytes(),
  );
  apply(
    "pool",
    "LiquidityChanged",
    dexEventBcs.pool.LiquidityChanged.serialize({
      pool_id: "0x20",
      position_id: "0x31",
      added: true,
      shares: 10_000n,
      meme: 5_000n,
      quote: 20_000n,
      total_shares: 110_000n,
    }).toBytes(),
  );
  apply(
    "pool",
    "Swapped",
    dexEventBcs.pool.Swapped.serialize({
      pool_id: "0x20",
      buy: false,
      meme_principal: 55_000n,
      quote_principal: 110_000n,
      quote_fee: 2_200n,
      meme_burn: 0n,
      meme_reserve: 110_000n,
      quote_reserve: 110_000n,
      fee_balance: 3_200n,
      volume_x32: 100_000n << 32n,
      timestamp_seconds: 0n,
    }).toBytes(),
  );
  apply(
    "pool",
    "LiquidityChanged",
    dexEventBcs.pool.LiquidityChanged.serialize({
      pool_id: "0x20",
      position_id: "0x31",
      added: false,
      shares: 10_000n,
      meme: 10_000n,
      quote: 10_000n,
      total_shares: 100_000n,
    }).toBytes(),
  );
  apply(
    "pool",
    "FeesClaimed",
    dexEventBcs.pool.FeesClaimed.serialize({
      pool_id: "0x20",
      position_id: "0x31",
      quote: 199n,
    }).toBytes(),
  );
  apply(
    "pool",
    "FeesClaimed",
    dexEventBcs.pool.FeesClaimed.serialize({
      pool_id: "0x20",
      position_id: "0x30",
      quote: 2969n,
    }).toBytes(),
  );
  apply(
    "migration",
    "FeesCollected",
    dexEventBcs.migration.FeesCollected.serialize({
      vault_id: "0x40",
      quote: 2969n,
      protocol_share_bps: 1000n,
      protocol_delta: 297n,
      creator_delta: 2672n,
      protocol_total: 297n,
      creator_total: 2672n,
    }).toBytes(),
  );
  apply(
    "migration",
    "CreatorFeesClaimed",
    dexEventBcs.migration.CreatorFeesClaimed.serialize({
      vault_id: "0x40",
      quote: 2672n,
    }).toBytes(),
  );
  apply(
    "migration",
    "ProtocolFeesClaimed",
    dexEventBcs.migration.ProtocolFeesClaimed.serialize({
      vault_id: "0x40",
      quote: 297n,
    }).toBytes(),
  );
  apply(
    "pool",
    "PositionClosed",
    dexEventBcs.pool.PositionClosed.serialize({
      pool_id: "0x20",
      position_id: "0x31",
    }).toBytes(),
  );
  const before = structuredClone(state);
  assert.throws(
    () =>
      apply(
        "pool",
        "MaximumFeeChanged",
        dexEventBcs.pool.MaximumFeeChanged.serialize({
          pool_id: "0x20",
          previous_bps: 300n,
          maximum_bps: 500n,
        }).toBytes(),
      ),
    /history mismatch/,
  );
  assert.deepEqual(state, before);
  apply(
    "pool",
    "MaximumFeeChanged",
    dexEventBcs.pool.MaximumFeeChanged.serialize({
      pool_id: "0x20",
      previous_bps: 200n,
      maximum_bps: 500n,
    }).toBytes(),
  );
  apply(
    "pool",
    "VersionActivated",
    dexEventBcs.pool.VersionActivated.serialize({
      previous_version: 1n,
      version: 2n,
    }).toBytes(),
  );
  const pool = state.pools.get(normalizeSuiAddress("0x20"));
  assert.equal(pool?.memeReserve, 100_000n);
  assert.equal(pool?.quoteReserve, 100_000n);
  assert.equal(pool?.quoteFees, 32n);
  assert.equal(state.positions.size, 1);
  assert.equal(state.version, 2n);
  assert.equal(
    state.nativeVaults.get(normalizeSuiAddress("0x40"))?.creatorQuoteFees,
    0n,
  );
});

test("historical replay admits only explicitly trusted package generations with original type lineage", () => {
  const bytes = dexEventBcs.pool.VersionActivated.serialize({
    previous_version: 1n,
    version: 2n,
  }).toBytes();
  const raw = {
    ...event("pool", "VersionActivated", bytes, 0),
    packageId: "0xe",
  };
  const lineage = { ...packages, historicalPackageIds: ["0xe"] };
  assert.equal(
    decodeDexEvent(raw, lineage).emitterPackageId,
    normalizeSuiAddress("0xe"),
  );
  assert.throws(() => decodeDexEvent(raw, packages), /emitter/);
  assert.throws(
    () => decodeDexEvent({ ...raw, packageId: "0xf" }, lineage),
    /emitter/,
  );
  assert.throws(
    () =>
      decodeDexEvent(
        { ...raw, eventType: "0xe::pool::VersionActivated" },
        lineage,
      ),
    /type package/,
  );
  const autoBytes = autoLpEventBcs.vault.VersionActivated.serialize({
    previous_version: 1n,
    version: 2n,
  }).toBytes();
  assert.equal(
    decodeAutoLpEvent(
      { ...event("vault", "VersionActivated", autoBytes, 1), packageId: "0xe" },
      lineage,
    ).emitterPackageId,
    normalizeSuiAddress("0xe"),
  );
});
