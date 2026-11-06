import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeVaultEvent,
  vaultDelayedKeys,
  vaultEventBcs,
} from "@interest-protocol/blast-vault-sdk/events";
import { fromHex, toHex } from "@mysten/sui/utils";
import {
  deployment,
  eventEntry,
  fixture,
  moveTypeName,
  vaultDelayedEvent,
  vaultEvent,
} from "./vault-helpers.ts";

test("decodes each Move-emitted vault event with its type arguments", () => {
  const created = vaultEvent("VaultCreated");
  assert.equal(created.kind, "VaultCreated");
  assert.equal(created.memeType, fixture.memeType);
  assert.equal(created.quoteType, fixture.quoteType);
  assert.equal(created.venue, fixture.venue);
  assert.deepEqual(
    { ...created.payload, terms: created.payload.terms.residuals },
    {
      vault_id: fixture.vaultId,
      pool_id: fixture.poolId,
      position_id:
        "0xd05f6de254fc218a4bb4b8e9c10f97eb1ab43d8c317135867d6099b6b9109bd4",
      liquidity: 123_456_789n,
      terms: "Owner",
      residual_meme_amount: 7n,
      residual_quote_amount: 11n,
    },
  );
  const collected = vaultEvent("FeesCollected");
  assert.equal(collected.venue, null);
  // 15% and 10% rounded up, then 40/20/20/10/10 by largest remainder.
  assert.deepEqual(collected.payload, {
    vault_id: fixture.vaultId,
    gross_meme_amount: 1_000_003n,
    gross_quote_amount: 2_000_007n,
    protocol_meme_amount: 150_001n,
    protocol_quote_amount: 200_001n,
    route_meme_amounts: [340_001n, 170_001n, 170_000n, 85_000n, 85_000n],
    route_quote_amounts: [720_002n, 360_001n, 360_001n, 180_001n, 180_001n],
  });
  assert.deepEqual(vaultEvent("OwnerBalancesClaimed").payload, {
    vault_id: fixture.vaultId,
    meme_amount: 7n + 340_001n,
    quote_amount: 11n + 720_002n,
  });
  assert.equal(
    vaultEvent("AutoLpPositionOpened").payload.vault_id,
    fixture.vaultId,
  );
  assert.deepEqual(vaultEvent("AutoLiquidityAdded").payload, {
    vault_id: fixture.vaultId,
    meme_amount: 170_001n - 13n,
    quote_amount: 360_001n - 17n,
    auto_lp_meme_pending: 13n,
    auto_lp_quote_pending: 17n,
  });
  assert.deepEqual(vaultEvent("BuybackBurned").payload, {
    vault_id: fixture.vaultId,
    quote_spent: 99_000n,
    meme_burned: 5_000n,
    burn_quote_pending: 180_001n - 99_000n,
  });
  const published = vaultEvent("RoundPublished").payload;
  assert.deepEqual(
    { ...published, root: published.root.length },
    {
      vault_id: fixture.vaultId,
      round_id: fixture.roundId,
      number: 0n,
      start_checkpoint: 10n,
      end_checkpoint: 100n,
      claim_deadline_at_ms: fixture.clockMs,
      root: 64,
      manifest_digest: `${"0".repeat(63)}1`,
      leaf_count: 1n,
      meme_amount: 100_000n,
      quote_amount: 200_000n,
      meme_unallocated: 170_000n - 100_000n,
      quote_unallocated: 360_001n - 220_000n,
      treasury: fixture.treasury,
      gas_reserve_amount: 20_000n,
    },
  );
  assert.deepEqual(vaultEvent("RewardClaimed").payload, {
    round_id: fixture.roundId,
    index: 0n,
    beneficiary: fixture.alice,
    meme_amount: 100_000n,
    quote_amount: 200_000n,
    meme_remaining: 0n,
    quote_remaining: 0n,
  });
  assert.deepEqual(vaultEvent("GasReserveSettled").payload, {
    vault_id: fixture.vaultId,
    round_id: fixture.roundId,
    number: 0n,
    treasury: fixture.treasury,
    reimbursement_amount: 5_000n,
    reserve_returned: 15_000n,
    quote_unallocated: 140_001n + 15_000n,
  });
  assert.deepEqual(vaultEvent("RoundClosed").payload, {
    vault_id: fixture.vaultId,
    round_id: fixture.roundId,
    number: 0n,
    meme_returned: 0n,
    quote_returned: 0n,
    gas_reserve_returned: 0n,
  });
});

test("every vault event layout re-encodes the Move bytes exactly", () => {
  for (const [name, hex] of Object.entries(fixture.events)) {
    const kind = (
      name === "FeesCollected2" ? "FeesCollected" : name
    ) as keyof typeof vaultEventBcs;
    const schema = vaultEventBcs[kind] as unknown as {
      parse(bytes: Uint8Array): Record<string, unknown>;
      serialize(value: unknown): { toBytes(): Uint8Array };
    };
    const parsed = schema.parse(fromHex(hex));
    const terms = parsed.terms as { packageWitness: string } | undefined;
    const value = terms
      ? {
          ...parsed,
          terms: {
            ...terms,
            packageWitness: moveTypeName(terms.packageWitness),
          },
        }
      : parsed;
    assert.equal(toHex(schema.serialize(value).toBytes()), hex, name);
  }
  assert.equal(Object.keys(vaultEventBcs).length, 10);
});

test("rejects another package, module, unknown kind or venue arity", () => {
  const type = (address: string, module: string, name: string, args: string) =>
    `${address}::${module}::${name}<${args}>`;
  const pair = `${fixture.memeType}, ${fixture.quoteType}`;
  const bad = [
    type("0xbad", "blast_vault_events", "FeesCollected", pair),
    type(fixture.vaultOriginalPackageId, "vault", "FeesCollected", pair),
    type(fixture.vaultOriginalPackageId, "blast_vault_events", "Unknown", pair),
    type(
      fixture.vaultOriginalPackageId,
      "blast_vault_events",
      "VaultCreated",
      pair,
    ),
    type(
      fixture.vaultOriginalPackageId,
      "blast_vault_events",
      "FeesCollected",
      `${pair}, ${fixture.venue}`,
    ),
  ];
  for (const eventType of bad) {
    assert.throws(
      () =>
        decodeVaultEvent(
          eventEntry(eventType, fixture.events.FeesCollected),
          deployment,
        ),
      /unexpected vault event type/,
      eventType,
    );
  }
});

test("decodes the vault's delayed proposals by key", () => {
  const split = vaultDelayedEvent("FeeSplitScheduled");
  assert.equal(split.name, "FeeSplit");
  assert.equal(split.kind, "DelayedScheduled");
  assert.deepEqual(split.payload, {
    parent: fixture.vaultId,
    key: null,
    value: { routes: [{ destination: { kind: "Owner" }, bps: 10_000n }] },
    delay_ms: 172_800_000n,
    ready_at_ms: fixture.clockMs + 172_800_000n,
  });
  const bps = vaultDelayedEvent("ProtocolBpsScheduled");
  assert.equal(bps.name, "ProtocolBps");
  assert.deepEqual(bps.payload.value, { meme_bps: 500n, quote_bps: 700n });
  const round = vaultDelayedEvent("RoundScheduled");
  assert.equal(round.name, "RoundPublication");
  assert.equal(round.kind, "ActionScheduled");
  assert.ok(round.kind === "ActionScheduled");
  assert.equal(round.payload.change.kind, "Action");
  assert.ok(round.payload.change.kind === "Action");
  assert.equal(round.payload.change.action.number, 1n);
  assert.equal(round.payload.ready_at_ms, fixture.clockMs + 7_200_000n);
  assert.deepEqual(
    Object.values(vaultDelayedKeys).map((spec) => [spec.key, spec.family]),
    [
      ["vault::FeeSplitKey", "setting"],
      ["vault::ProtocolBpsKey", "setting"],
      ["vault::RoundPublicationKey", "action"],
      ["blast_vault_package::WitnessesKey", "set"],
    ],
  );
});
