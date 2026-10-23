import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rewardRoundBcs } from "@interest-protocol/blast-core/rewards/state";
import {
  allocationPlanBcs,
  feeSplitBcs,
  protocolAllocationBcs,
} from "@interest-protocol/blast-launchpad-sdk/allocation";
import {
  launchBcs,
  launchConfigBcs,
} from "@interest-protocol/blast-launchpad-sdk/state";
import {
  lpFeePolicyBcs,
  lpFeeSharePairBcs,
  lpVaultBcs,
} from "@interest-protocol/blast-migrators-sdk/state";
import type { BcsType } from "@mysten/sui/bcs";

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
  burnBps: 0n,
  recipients: [],
};
const plan = {
  curveMemeBps: 0n,
  lpMemeBps: 0n,
  lpQuoteBps: 0n,
  protocolMemeBps: 0n,
  protocolQuoteBps: 0n,
  recipients: [],
};

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
    [
      "launchpad",
      "allocation",
      "ProtocolAllocation",
      protocolAllocationBcs as never,
      { memeBps: 0n, quoteBps: 0n },
    ],
    [
      "launchpad",
      "launch_config",
      "LaunchConfig",
      launchConfigBcs as never,
      {
        id: uid("0x1"),
        meme_decimals: [],
        quotes: { id: uid("0x2"), size: 0n },
        quote_fee_bps: 0n,
        meme_fee_bps: 0n,
        migration_witnesses: [],
        protocol_allocation: { meme_bps: 0n, quote_bps: 0n },
        creation_fee: 0n,
      },
    ],
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
    opening_round_ms: 0n,
    opening_round_bids: 0n,
    opening_round_quote: balance,
    opening_round_meme: balance,
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
      protocol_sui: balance,
    },
    metadata_cap: { id: uid("0x2") },
    creator: null,
    curve_fee_cap_id: null,
    blast_metadata_cap_id: null,
    partner_id: null,
  };
}

function vault() {
  return {
    id: uid("0x1"),
    pool_id: { bytes: "0x2" },
    partner_id: null,
    protocol_meme_residual: balance,
    protocol_quote_residual: balance,
    unpaid_protocol_meme: balance,
    unpaid_protocol_quote: balance,
    fee_split: feeSplit,
    creator_meme: balance,
    creator_quote: balance,
    auto_lp_meme: balance,
    auto_lp_quote: balance,
    rewards_meme: balance,
    rewards_quote: balance,
    burn_quote: balance,
    next_round: 0n,
    last_checkpoint: null,
  };
}

function round() {
  return {
    id: uid("0x1"),
    vault: { bytes: "0x2" },
    number: 0n,
    root: [],
    leaf_count: 0n,
    claimed: [],
    meme: balance,
    quote: balance,
  };
}
