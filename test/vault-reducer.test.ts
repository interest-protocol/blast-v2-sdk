import assert from "node:assert/strict";
import test from "node:test";
import type { DecodedProtocolFeesPaid } from "@interest-protocol/blast-core/protocol-fees";
import type { RewardProof } from "@interest-protocol/blast-core/rewards/allocations";
import {
  assertRoundMatchesManifest,
  createVaultEventProjection,
  pendingRewardAllocations,
  previewFeesCollected,
  reduceVaultEvent,
} from "@interest-protocol/blast-vault-sdk/reducer";
import { decodeVaultObject } from "@interest-protocol/blast-vault-sdk/state";
import { fromHex } from "@mysten/sui/utils";
import {
  deployment,
  fixture,
  id,
  vaultDelayedEvent,
  vaultEvent,
  vaultType,
} from "./vault-helpers.ts";

const finalVault = () =>
  decodeVaultObject(
    {
      objectId: fixture.vaultId,
      initialSharedVersion: 5,
      type: vaultType,
      content: fromHex(fixture.objects.vault),
    },
    deployment,
  );

/** The fixture's events in emission order. */
const history = () => [
  vaultEvent("VaultCreated"),
  vaultEvent("FeesCollected"),
  vaultEvent("OwnerBalancesClaimed"),
  vaultEvent("AutoLpPositionOpened"),
  vaultEvent("AutoLiquidityAdded"),
  vaultEvent("BuybackBurned"),
  vaultEvent("RoundPublished"),
  vaultEvent("RewardClaimed"),
  vaultEvent("GasReserveSettled"),
  vaultEvent("RoundClosed"),
  vaultEvent("FeesCollected2"),
  vaultDelayedEvent("FeeSplitScheduled"),
  vaultDelayedEvent("ProtocolBpsScheduled"),
  vaultDelayedEvent("RoundScheduled"),
];

test("replaying the Move events rebuilds the vault object's balances and proposals", () => {
  const events = history();
  const projection = events.reduce(
    reduceVaultEvent,
    createVaultEventProjection(),
  );
  const vault = projection.vaults[fixture.vaultId];
  assert.ok(vault);
  const object = finalVault();
  for (const key of [
    "memeType",
    "quoteType",
    "poolId",
    "terms",
    "feeSplit",
    "feeSplitDelayMs",
    "pendingFeeSplit",
    "protocolBps",
    "protocolBpsDelayMs",
    "pendingProtocolBps",
    "ownerMeme",
    "ownerQuote",
    "autoLpMeme",
    "autoLpQuote",
    "rewardsMeme",
    "rewardsQuote",
    "burnQuote",
    "nextRound",
    "lastCheckpoint",
    "roundDelayMs",
    "pendingRoundPublication",
  ] as const) {
    assert.deepEqual(vault[key], object[key], key);
  }
  assert.equal(vault.protocolMeme, object.protocol.meme);
  assert.equal(vault.protocolQuote, object.protocol.quote);
  assert.equal(vault.venue, fixture.venue);
  assert.equal(vault.liquidity, 123_456_789n);
  assert.equal(
    vault.autoLpPositionId,
    vaultEvent("AutoLpPositionOpened").payload.position_id,
  );
  assert.deepEqual(vault.rounds["0"], {
    roundId: fixture.roundId,
    number: 0n,
    startCheckpoint: 10n,
    endCheckpoint: 100n,
    claimDeadlineAtMs: fixture.clockMs,
    root: vaultEvent("RoundPublished").payload.root,
    manifestDigest: `${"0".repeat(63)}1`,
    leafCount: 1n,
    treasury: fixture.treasury,
    memeRemaining: 0n,
    quoteRemaining: 0n,
    claimedIndexes: { "0": true },
    gasReserveAmount: 20_000n,
    gasReimbursed: 5_000n,
    closed: true,
  });
  assert.deepEqual(projection.roundVaults, {
    [fixture.roundId]: fixture.vaultId,
  });
  assert.equal(
    events.reduce(reduceVaultEvent, projection),
    projection,
    "replaying applied events changes nothing",
  );
});

test("events of an unknown vault or round change nothing", () => {
  const empty = createVaultEventProjection();
  const after = reduceVaultEvent(empty, vaultEvent("FeesCollected"));
  assert.deepEqual(after.vaults, {});
  assert.deepEqual(
    reduceVaultEvent(after, vaultEvent("RewardClaimed")).vaults,
    {},
  );
});

test("ProtocolFeesPaid of the vault's ledger empties Blast's held fees", () => {
  const before = history()
    .slice(0, 2)
    .reduce(reduceVaultEvent, createVaultEventProjection());
  assert.equal(before.vaults[fixture.vaultId]?.protocolMeme, 150_001n);
  const paid: DecodedProtocolFeesPaid = {
    source: "core",
    kind: "ProtocolFeesPaid",
    memeType: fixture.memeType,
    quoteType: fixture.quoteType,
    payload: {
      package_witness: `${fixture.vaultOriginalPackageId}::vault::VaultWitness`,
      origin: fixture.vaultId,
      treasury: fixture.treasury,
      meme_amount: 105_001n,
      quote_amount: 140_001n,
      sui_amount: 0n,
      partner_id: id("0x75"),
      partner_meme_amount: 45_000n,
      partner_quote_amount: 60_000n,
      partner_sui_amount: 0n,
    },
    sender: id("0x5e"),
    position: { checkpoint: 10n, transactionDigest: "paid", eventIndex: 0 },
  };
  const after = reduceVaultEvent(before, paid).vaults[fixture.vaultId];
  assert.equal(after?.protocolMeme, 0n);
  assert.equal(after?.protocolQuote, 0n);
});

test("previewFeesCollected mirrors split_fees for both Move collections", () => {
  const vault = finalVault();
  for (const kind of ["FeesCollected", "FeesCollected2"] as const) {
    const { vault_id: _, ...expected } = vaultEvent(kind).payload;
    assert.deepEqual(
      previewFeesCollected(
        vault,
        expected.gross_meme_amount,
        expected.gross_quote_amount,
      ),
      expected,
      kind,
    );
  }
  assert.equal(previewFeesCollected(vault, 0n, 0n), null);
});

test("pending allocations follow the round's claimed bitmap", () => {
  const round = {
    vaultId: fixture.vaultId,
    number: 3n,
    root: "ab".repeat(32),
    leafCount: 3,
    claimedBitmap: [0b010n],
  };
  const allocation = (index: number): RewardProof => ({
    index: index.toString(),
    beneficiary: id(`0x${index + 1}`),
    memeAmount: "1",
    quoteAmount: "0",
    proof: [],
  });
  const manifest = {
    vaultId: fixture.vaultId,
    number: "3",
    root: "ab".repeat(32),
    allocations: [allocation(0), allocation(1), allocation(2)],
  };
  assert.deepEqual(
    pendingRewardAllocations(round, manifest).map(({ index }) => index),
    ["0", "2"],
  );
  assert.throws(
    () => assertRoundMatchesManifest(round, { ...manifest, number: "4" }),
    /does not match/,
  );
  assert.throws(
    () =>
      assertRoundMatchesManifest(round, {
        ...manifest,
        allocations: manifest.allocations.slice(1),
      }),
    /does not match/,
  );
});
