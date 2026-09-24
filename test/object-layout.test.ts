import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { BcsType } from "@mysten/sui/bcs";
import { rewardRoundBcs } from "../src/holder-rewards/state.ts";
import { allocationPlanBcs, feeSplitBcs } from "../src/launchpad/allocation.ts";
import { launchBcs } from "../src/launchpad/state.ts";
import {
  lpFeePolicyBcs,
  lpFeeSharePairBcs,
  lpVaultBcs,
} from "../src/migrators/state.ts";

type FrozenStruct = { name: string; fields: { name: string }[] };
type Artifact = {
  packages: Record<
    string,
    { modules: Record<string, { structs: FrozenStruct[] }> }
  >;
};

const artifact = JSON.parse(
  readFileSync(
    new URL("../abi/production-launchpad-v1.json", import.meta.url),
    "utf8",
  ),
) as Artifact;

const uid = (id: string) => ({ id: { bytes: id } });
const balance = { value: 0n };
const feeSplit = {
  creatorBps: 10_000n,
  autoLpBps: 0n,
  rewardsBps: 0n,
  recipients: [],
};
const plan = { channels: [], meme: [], quote: [] };

/**
 * A BCS struct reads its fields in declaration order, so the keys of a parsed
 * value list the SDK layout; they must be the frozen Move fields in order.
 */
test("SDK object layouts follow the frozen Move field order", () => {
  const layouts: [
    string,
    string,
    string,
    BcsType<unknown, unknown>,
    unknown,
  ][] = [
    ["launchpad", "launch", "Launch", launchBcs as never, launch()],
    [
      "launchpad",
      "allocation",
      "AllocationPlan",
      allocationPlanBcs as never,
      plan,
    ],
    ["launchpad", "allocation", "FeeSplit", feeSplitBcs as never, feeSplit],
    ["migrators", "vault", "LpVault", lpVaultBcs as never, vault()],
    [
      "migrators",
      "lp_fee_policy",
      "LpFeePolicy",
      lpFeePolicyBcs as never,
      {
        id: uid("0x1"),
        destination: "0x2",
        defaults: { meme_bps: 0n, quote_bps: 0n },
        coins: { id: uid("0x3"), size: 0n },
      },
    ],
    [
      "migrators",
      "lp_fee_policy",
      "SharePair",
      lpFeeSharePairBcs as never,
      { meme_bps: 0n, quote_bps: 0n },
    ],
    [
      "migrators",
      "blast_holder_rewards",
      "Round",
      rewardRoundBcs as never,
      round(),
    ],
  ];
  for (const [packageName, moduleName, structName, schema, value] of layouts) {
    const frozen = artifact.packages[packageName]?.modules[
      moduleName
    ]?.structs.find(({ name }) => name === structName);
    assert.ok(frozen, `${structName} is frozen`);
    const parsed = schema.parse(schema.serialize(value).toBytes());
    assert.deepEqual(
      Object.keys(parsed as object).map(snakeCase),
      frozen.fields.map(({ name }) => name),
      structName,
    );
  }
});

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function launch() {
  return {
    id: uid("0x1"),
    lifecycle: { Live: true },
    public_start_ms: null,
    protection_end_ms: null,
    pre_share_buy_completed: false,
    protection_window_ms: 0n,
    cumulative_sender_bps: 0n,
    cumulative_atomic_limit: 0n,
    per_transaction_bps: 0n,
    per_transaction_atomic_limit: 0n,
    sell_burn_bps: 0n,
    virtual_quote: 0n,
    graduation_target: 0n,
    quote_fee_bps: 0n,
    meme_fee_bps: 0n,
    migration_witness: "0x2::m::W",
    pool_tick_spacing: 0,
    pool_fee_rate: 0n,
    lp_fee_split: feeSplit,
    atomic_supply: 0n,
    meme_reserve: balance,
    real_quote_reserve: balance,
    pending_burn: balance,
    allocation_plan: plan,
    allocated_meme: balance,
    fee_ledger: {
      protocol_meme: balance,
      creator_meme: balance,
      protocol_quote: balance,
      creator_quote: balance,
    },
    metadata_cap: { id: uid("0x2") },
    creator_authority: null,
    curve_fee_cap_id: null,
    blast_metadata_cap_id: null,
  };
}

function vault() {
  return {
    id: uid("0x1"),
    pool_id: { bytes: "0x2" },
    protocol_meme_residual: balance,
    protocol_quote_residual: balance,
    generation: 0n,
    fee_split: feeSplit,
    creator_meme: balance,
    creator_quote: balance,
    auto_lp_meme: balance,
    auto_lp_quote: balance,
    rewards_meme: balance,
    rewards_quote: balance,
    next_round: 0n,
    last_checkpoint: null,
  };
}

function round() {
  return {
    id: uid("0x1"),
    vault: { bytes: "0x2" },
    number: 0n,
    start_checkpoint: 0n,
    end_checkpoint: 0n,
    root: [],
    manifest_digest: [],
    leaf_count: 0n,
    claimed: [],
    meme: balance,
    quote: balance,
  };
}
