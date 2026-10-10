import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { itemAt } from "../src/lib/arrays.ts";
import type {
  DecodedPresaleEvent,
  PresaleEventKind,
  PresaleEventPayloads,
} from "../src/presale/events.ts";
import {
  decodePresaleEvent,
  decodePresalePolicyEvent,
  presaleEventBcs,
  presaleEventModules,
  presaleEventSpecs,
  presalePolicyEventSpecs,
} from "../src/presale/events.ts";
import {
  canClosePresaleEarly,
  openEligibility,
  previewClaim,
  previewSettlement,
} from "../src/presale/math.ts";
import {
  createPresaleEventProjection,
  reducePresaleEvent,
} from "../src/presale/reducer.ts";
import { orderedEventFields } from "./abi.ts";

const pkg = normalizeSuiAddress("0x5e");
const meme = normalizeStructTag("0xa::meme::MEME");
const quote = normalizeStructTag("0x2::sui::SUI");
const id = (value: string) => normalizeSuiAddress(value);
const PRESALE = id("0xab");
const VAULT = id("0xba");
const ROUND = id("0xd0");
const ALICE = id("0xa11ce");
const BOB = id("0xb0b");
const NO_FEES = {
  protocol_raise_bps: 0n,
  protocol_token_bps: 0n,
  protocol_lp_fee_meme_bps: 0n,
  protocol_lp_fee_quote_bps: 0n,
};
const TREASURY = id("0x7ea5");
const u64 = (value: bigint) =>
  Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));

let eventIndex = 0;
function suiEvent<Kind extends PresaleEventKind>(
  kind: Kind,
  payload: PresaleEventPayloads[Kind],
  sender = ALICE,
): SuiClientTypes.EventEntry {
  const module = presaleEventModules[kind];
  const venue =
    kind === "VaultCreated" || kind === "PoolTierReserved"
      ? `, ${pkg}::cetus::Venue`
      : "";
  eventIndex += 1;
  return {
    packageId: pkg,
    module,
    sender,
    eventType: `${pkg}::${module}::${kind}<${meme}, ${quote}${venue}>`,
    bcs: presaleEventBcs[kind].serialize(payload).toBytes(),
    json: null,
    checkpoint: "9",
    transactionDigest: `tx-${eventIndex}`,
    eventIndex,
  };
}

function decode<Kind extends PresaleEventKind>(
  kind: Kind,
  payload: PresaleEventPayloads[Kind],
  sender?: string,
): DecodedPresaleEvent {
  return decodePresaleEvent(suiEvent(kind, payload, sender), {
    originalPackageId: pkg,
  });
}

test("event specs match every event frozen in the presale ABI", () => {
  assert.deepEqual(
    orderedModuleEventFields({
      ...presaleEventSpecs,
      ...presalePolicyEventSpecs,
    }),
    orderedModuleEventFields(readFrozenPresaleEventSpecs()),
  );
  assert.equal(Object.keys(presaleEventModules).length, 22);
});

test("decodes an event from bytes laid out in Move field order", () => {
  const event = decodePresaleEvent(
    {
      packageId: pkg,
      module: "blast_presale",
      sender: "0xa11ce",
      eventType: `${pkg}::blast_presale::Committed<${meme}, ${quote}>`,
      bcs: Uint8Array.from([
        ...Buffer.from(PRESALE.slice(2), "hex"),
        ...u64(1n),
        ...u64(501n),
        ...u64(501n),
        ...u64(1n),
      ]),
      json: null,
      checkpoint: "9",
      transactionDigest: "bytes",
      eventIndex: 0,
    },
    { originalPackageId: "0x5e" },
  );
  assert.equal(event.kind, "Committed");
  assert.equal(event.sender, ALICE);
  assert.equal(event.memeType, meme);
  assert.deepEqual(event.payload, {
    presale_id: PRESALE,
    quote: 1n,
    wallet_commitment: 501n,
    total_commitments: 501n,
    participants: 1n,
  });
});

test("rejects events from another package, module, or arity", () => {
  const event = suiEvent("PresaleOpened", {
    presale_id: PRESALE,
    start_ms: 1n,
    end_ms: 2n,
    liquidity_deadline_ms: 3n,
    uncapped_from_ms: 2n,
    hard_cap_from_ms: null,
    partner_id: null,
  });
  const packages = { originalPackageId: pkg };
  for (const eventType of [
    event.eventType.replace(pkg, id("0x99")),
    event.eventType.replace("blast_presale::", "presale_vault::"),
    `${pkg}::blast_presale::PresaleOpened<${meme}>`,
    `${pkg}::blast_presale::Unknown<${meme}, ${quote}>`,
  ]) {
    assert.throws(() => decodePresaleEvent({ ...event, eventType }, packages));
  }
});

test("rebuilds a presale, its vault, and a reward round from events", () => {
  const recipients = [id("0xa110c"), id("0xb110c")];
  const events: DecodedPresaleEvent[] = [
    decode("PresaleCreated", {
      presale_id: PRESALE,
      presale_cap_id: id("0xca"),
      treasury_cap_id: id("0x7c"),
      token_supply: 20_001n,
      token_allocation_bps: 5_000n,
      participant_vesting: null,
      liquidity_token_allocation_bps: 1_000n,
      recipients,
      recipient_bps: [2_500n, 1_500n],
      recipient_vesting: [null, null],
      burnable: false,
      raise_target: 1_000n,
      raise_recipients: [],
      raise_recipient_bps: [],
      raise_recipient_vesting: [],
      duration_ms: 100n,
      liquidity_window_ms: 50n,
      eligibility: openEligibility(5_000n, 2n, 500n),
      uncapped: null,
      hard_cap: null,
      migration_witness: `${pkg}::cetus::Witness`,
      fee_recipients: [id("0xc0ffee"), id("0xfee")],
      fee_recipient_bps: [5_000n, 2_000n],
      holder_rewards_bps: 3_000n,
      ...NO_FEES,
      protocol_quote: 0n,
      protocol_tokens: 0n,
    }),
    decode("PresaleOpened", {
      presale_id: PRESALE,
      start_ms: 1_000n,
      end_ms: 1_100n,
      liquidity_deadline_ms: 1_150n,
      uncapped_from_ms: 1_100n,
      hard_cap_from_ms: null,
      partner_id: null,
    }),
    decode(
      "Committed",
      {
        presale_id: PRESALE,
        quote: 1_000n,
        wallet_commitment: 1_000n,
        total_commitments: 1_000n,
        participants: 1n,
      },
      ALICE,
    ),
    decode(
      "Committed",
      {
        presale_id: PRESALE,
        quote: 3_000n,
        wallet_commitment: 3_000n,
        total_commitments: 4_000n,
        participants: 2n,
      },
      BOB,
    ),
    decode("PresaleFunded", {
      presale_id: PRESALE,
      total_commitments: 4_000n,
      accepted_quote: 1_000n,
      refundable_quote: 3_000n,
      token_allocation: 10_001n,
      end_ms: 1_100n,
      liquidity_deadline_ms: 1_150n,
    }),
  ];
  let state = createPresaleEventProjection();
  for (const event of events) state = reducePresaleEvent(state, event);
  let presale = required(state.presales[PRESALE]);
  assert.equal(presale.lifecycle, "Funded");
  assert.deepEqual(presale.commitments, { [ALICE]: 1_000n, [BOB]: 3_000n });
  assert.deepEqual(
    [
      presale.tokenAllocation,
      presale.liquidityTokens,
      presale.recipientTokens,
      presale.quote,
    ],
    [10_001n, 2_000n, 8_000n, 4_000n],
  );

  // Migration, then claims whose amounts the preview predicts from the projection.
  const migration: DecodedPresaleEvent[] = [
    decode("ProtocolFeesPaid", {
      presale_id: PRESALE,
      destination: TREASURY,
      quote: 0n,
      tokens: 0n,
      partner_quote: 0n,
    }),
    decode("RecipientAllocated", {
      presale_id: PRESALE,
      recipient: itemAt(recipients, 0),
      tokens: 5_000n,
      vesting_id: null,
    }),
    decode("RecipientAllocated", {
      presale_id: PRESALE,
      recipient: itemAt(recipients, 1),
      tokens: 3_000n,
      vesting_id: null,
    }),
    decode("PresaleMigrated", {
      presale_id: PRESALE,
      migration_witness: `${pkg}::cetus::Witness`,
      liquidity_quote: 1_000n,
      liquidity_tokens: 2_000n,
      recipient_tokens: 8_000n,
    }),
  ];
  for (const event of migration) state = reducePresaleEvent(state, event);
  for (const [participant, commitment] of [
    [ALICE, 1_000n],
    [BOB, 3_000n],
  ] as const) {
    const expected = previewClaim(
      required(state.presales[PRESALE]),
      commitment,
    );
    state = reducePresaleEvent(
      state,
      decode("Claimed", {
        presale_id: PRESALE,
        participant,
        wallet_commitment: commitment,
        tokens: expected.tokens,
        quote_refund: expected.quoteRefund,
        remaining_participants:
          required(state.presales[PRESALE]).participants - 1n,
        vesting_id: null,
      }),
    );
  }
  presale = required(state.presales[PRESALE]);
  assert.equal(presale.lifecycle, "Migrated");
  assert.deepEqual(presale.commitments, {});
  // `blast_presale_tests`: after both claims custody is [4_000, 0, 0, 0, 0, 0, 0]; each claim
  // released one participant.
  assert.deepEqual(
    [
      presale.totalCommitments,
      presale.participants,
      presale.quote,
      presale.saleTokens,
      presale.liquidityTokens,
      presale.recipientTokens,
    ],
    [4_000n, 0n, 0n, 0n, 0n, 0n],
  );

  const vaultEvents: DecodedPresaleEvent[] = [
    decode("VaultCreated", {
      vault_id: VAULT,
      presale_id: PRESALE,
      pool_id: id("0x90"),
      position_id: id("0x91"),
      liquidity: 1_234n,
      fee_recipients: [id("0xc0ffee"), id("0xfee")],
      fee_recipient_bps: [5_000n, 2_000n],
      holder_rewards_bps: 3_000n,
      protocol_lp_fee_meme_bps: 0n,
      protocol_lp_fee_quote_bps: 0n,
      migration_meme_residual: 1n,
      migration_quote_residual: 0n,
    }),
    decode("FeesCollected", {
      vault_id: VAULT,
      gross_meme: 101n,
      gross_quote: 10n,
      protocol_destination: TREASURY,
      protocol_meme: 0n,
      protocol_quote: 0n,
      fee_recipient_meme: [51n, 20n],
      fee_recipient_quote: [5n, 2n],
      holder_rewards_meme: 30n,
      holder_rewards_quote: 3n,
    }),
    decode("MigrationResidualsClaimed", {
      vault_id: VAULT,
      meme: 1n,
      quote: 0n,
    }),
    decode("ProtocolLpFeesChanged", {
      vault_id: VAULT,
      protocol_lp_fee_meme_bps: 100n,
      protocol_lp_fee_quote_bps: 0n,
    }),
    decode("RoundPublished", {
      vault_id: VAULT,
      round_id: ROUND,
      number: 0n,
      start_checkpoint: 1n,
      end_checkpoint: 10n,
      claim_deadline_ms: 5_000n,
      root: "22".repeat(32),
      manifest_digest: "33".repeat(32),
      leaf_count: 2n,
      meme_amount: 30n,
      quote_amount: 3n,
      meme_unallocated: 0n,
      quote_unallocated: 0n,
      treasury: TREASURY,
      gas_reserve_amount: 0n,
    }),
    decode("RewardClaimed", {
      round_id: ROUND,
      index: 1n,
      beneficiary: BOB,
      meme_amount: 20n,
      quote_amount: 2n,
      meme_remaining: 10n,
      quote_remaining: 1n,
    }),
    decode("RoundClosed", {
      vault_id: VAULT,
      round_id: ROUND,
      number: 0n,
      meme_returned: 10n,
      quote_returned: 1n,
      gas_reserve_returned: 0n,
    }),
  ];
  for (const event of vaultEvents) {
    const next = reducePresaleEvent(state, event);
    assert.equal(reducePresaleEvent(next, event), next, "replay is a no-op");
    state = next;
  }
  assert.equal(required(state.presales[PRESALE]).vaultId, VAULT);
  const vault = required(state.vaults[VAULT]);
  assert.equal(vault.venueType, normalizeStructTag(`${pkg}::cetus::Venue`));
  assert.deepEqual(
    [
      vault.holderRewardsMeme,
      vault.holderRewardsQuote,
      vault.nextRound,
      vault.lastCheckpoint,
      vault.migrationMemeResidual,
    ],
    [10n, 1n, 1n, 10n, 0n],
  );
  assert.deepEqual(vault.feeRecipientMemePaid, [51n, 20n]);
  assert.deepEqual(vault.feeRecipientQuotePaid, [5n, 2n]);
  const round = required(state.rounds[ROUND]);
  assert.deepEqual(round.paidIndexes, { "1": true });
  assert.equal(round.closed, true);
  assert.equal(round.memeRemaining, 0n);
  const twice = ["Committed", "Claimed", "RecipientAllocated"];
  // An unpartnered vault pays Blast at each collection, so it has no partner payout.
  const never = [
    "PoolTierReserved",
    "RaiseAllocated",
    "PresaleCancelled",
    "ProtocolFeesChanged",
    "ProtocolLpFeesPaid",
    "HolderMemePaid",
    "GasReserveSettled",
  ];
  for (const kind of Object.keys(presaleEventModules) as PresaleEventKind[]) {
    const expected = twice.includes(kind) ? 2 : never.includes(kind) ? 0 : 1;
    assert.equal(state.eventCounts[kind], expected, kind);
  }

  const oldRound = structuredClone(required(state.rounds[ROUND]));
  const gapRound = id("0xd1");
  const dailyEvents = [
    decode("RoundPublished", {
      vault_id: VAULT,
      round_id: gapRound,
      number: 1n,
      start_checkpoint: 21n,
      end_checkpoint: 30n,
      claim_deadline_ms: 604_800_000n + 1_000_000n,
      root: "44".repeat(32),
      manifest_digest: "55".repeat(32),
      leaf_count: 1n,
      meme_amount: 0n,
      quote_amount: 1n,
      meme_unallocated: 10n,
      quote_unallocated: 0n,
      treasury: TREASURY,
      gas_reserve_amount: 0n,
    }),
    decode("RewardClaimed", {
      round_id: gapRound,
      index: 0n,
      beneficiary: BOB,
      meme_amount: 0n,
      quote_amount: 1n,
      meme_remaining: 0n,
      quote_remaining: 0n,
    }),
    decode("RoundClosed", {
      vault_id: VAULT,
      round_id: gapRound,
      number: 1n,
      meme_returned: 0n,
      quote_returned: 0n,
      gas_reserve_returned: 0n,
    }),
  ];
  for (const event of dailyEvents) state = reducePresaleEvent(state, event);
  assert.deepEqual(required(state.rounds[ROUND]), oldRound);
  const daily = required(state.rounds[gapRound]);
  assert.deepEqual(
    [daily.startCheckpoint, daily.endCheckpoint, daily.claimDeadlineMs],
    [21n, 30n, 605_800_000n],
  );
  assert.equal(daily.closed, true);
  assert.equal(Object.keys(state.rounds).length, 2);
  assert.equal(required(state.vaults[VAULT]).nextRound, 2n);
  assert.equal(required(state.vaults[VAULT]).lastCheckpoint, 30n);

  // Cancellation refunds every commitment in full.
  const cancelled = required(
    reducePresaleEvent(
      reducePresaleEvent(
        reducePresaleEvent(createPresaleEventProjection(), itemAt(events, 0)),
        itemAt(events, 2),
      ),
      decode("PresaleCancelled", {
        presale_id: PRESALE,
        total_commitments: 1_000n,
        refundable_quote: 1_000n,
      }),
    ).presales[PRESALE],
  );
  assert.equal(cancelled.lifecycle, "Cancelled");
  assert.deepEqual(previewClaim(cancelled, 1_000n), {
    tokens: 0n,
    quoteRefund: 1_000n,
    vesting: null,
  });
});

for (const settle of [false, true]) {
  test(`replays holder and reserve custody through ${settle ? "settlement and close" : "permissionless unsettled close"}`, () => {
    let state = createPresaleEventProjection();
    const apply = (event: DecodedPresaleEvent) => {
      state = reducePresaleEvent(state, event);
      assert.equal(
        reducePresaleEvent(state, event),
        state,
        "replay cannot pay or return twice",
      );
    };
    apply(
      decode("VaultCreated", {
        vault_id: VAULT,
        presale_id: PRESALE,
        pool_id: id("0x9001"),
        position_id: id("0x9051"),
        liquidity: 100n,
        fee_recipients: [],
        fee_recipient_bps: [],
        holder_rewards_bps: 10_000n,
        protocol_lp_fee_meme_bps: 0n,
        protocol_lp_fee_quote_bps: 0n,
        migration_meme_residual: 0n,
        migration_quote_residual: 0n,
      }),
    );
    apply(
      decode("FeesCollected", {
        vault_id: VAULT,
        gross_meme: 40n,
        gross_quote: 1_000n,
        protocol_destination: TREASURY,
        protocol_meme: 0n,
        protocol_quote: 0n,
        fee_recipient_meme: [],
        fee_recipient_quote: [],
        holder_rewards_meme: 40n,
        holder_rewards_quote: 1_000n,
      }),
    );
    apply(
      decode("HolderMemePaid", {
        vault_id: VAULT,
        treasury: TREASURY,
        meme_amount: 40n,
        unallocated_meme_remaining: 0n,
      }),
    );
    apply(
      decode("FeesCollected", {
        vault_id: VAULT,
        gross_meme: 5n,
        gross_quote: 0n,
        protocol_destination: TREASURY,
        protocol_meme: 0n,
        protocol_quote: 0n,
        fee_recipient_meme: [],
        fee_recipient_quote: [],
        holder_rewards_meme: 5n,
        holder_rewards_quote: 0n,
      }),
    );
    apply(
      decode("HolderMemePaid", {
        vault_id: VAULT,
        treasury: TREASURY,
        meme_amount: 5n,
        unallocated_meme_remaining: 0n,
      }),
    );
    assert.equal(required(state.vaults[VAULT]).holderRewardsMeme, 0n);
    const roundId = id("0xd1");
    apply(
      decode("RoundPublished", {
        vault_id: VAULT,
        round_id: roundId,
        number: 0n,
        start_checkpoint: 21n,
        end_checkpoint: 30n,
        claim_deadline_ms: 605_800_000n,
        root: "33".repeat(32),
        manifest_digest: "44".repeat(32),
        leaf_count: 2n,
        meme_amount: 0n,
        quote_amount: 970n,
        meme_unallocated: 0n,
        quote_unallocated: 0n,
        treasury: TREASURY,
        gas_reserve_amount: 30n,
      }),
    );
    const funded = required(state.rounds[roundId]);
    assert.deepEqual(
      [funded.quoteRemaining, funded.gasReserveRemaining, funded.treasury],
      [970n, 30n, TREASURY],
    );
    apply(
      decode("RewardClaimed", {
        round_id: roundId,
        index: 0n,
        beneficiary: ALICE,
        meme_amount: 0n,
        quote_amount: 200n,
        meme_remaining: 0n,
        quote_remaining: 770n,
      }),
    );
    assert.equal(required(state.rounds[roundId]).gasReserveRemaining, 30n);
    if (settle) {
      apply(
        decode("GasReserveSettled", {
          vault_id: VAULT,
          round_id: roundId,
          number: 0n,
          treasury: TREASURY,
          reimbursement_amount: 24n,
          reserve_returned: 6n,
          quote_unallocated: 6n,
        }),
      );
      assert.equal(required(state.rounds[roundId]).quoteRemaining, 770n);
    }
    apply(
      decode("RoundClosed", {
        vault_id: VAULT,
        round_id: roundId,
        number: 0n,
        meme_returned: 0n,
        quote_returned: 770n,
        gas_reserve_returned: settle ? 0n : 30n,
      }),
    );
    const closed = required(state.rounds[roundId]);
    const vault = required(state.vaults[VAULT]);
    assert.deepEqual(
      [closed.quoteRemaining, closed.gasReserveRemaining, closed.closed],
      [0n, 0n, true],
    );
    assert.deepEqual(
      [closed.gasSettled, closed.gasReimbursed, closed.gasReturned],
      [settle, settle ? 24n : 0n, settle ? 6n : 30n],
    );
    assert.equal(
      vault.holderRewardsQuote + 200n + closed.gasReimbursed,
      1_000n,
    );
    assert.deepEqual(
      [vault.holderRewardsMeme, vault.holderMemeTreasuryPaid],
      [0n, 45n],
    );
  });
}

test("a raise allocation leaves custody the migration's overflow", () => {
  let state = createPresaleEventProjection();
  const created = decode("PresaleCreated", {
    presale_id: PRESALE,
    presale_cap_id: id("0xca"),
    treasury_cap_id: id("0x7c"),
    token_supply: 20_001n,
    token_allocation_bps: 5_000n,
    participant_vesting: null,
    liquidity_token_allocation_bps: 5_000n,
    recipients: [],
    recipient_bps: [],
    recipient_vesting: [],
    burnable: true,
    raise_target: 1_000n,
    raise_recipients: [id("0x5a1e")],
    raise_recipient_bps: [2_000n],
    raise_recipient_vesting: [null],
    duration_ms: 100n,
    liquidity_window_ms: 50n,
    eligibility: openEligibility(5_000n, 1n, 1_000n),
    uncapped: null,
    hard_cap: null,
    migration_witness: `${pkg}::bluefin::Witness`,
    fee_recipients: [],
    fee_recipient_bps: [],
    holder_rewards_bps: 10_000n,
    ...NO_FEES,
    protocol_quote: 0n,
    protocol_tokens: 0n,
  });
  for (const event of [
    created,
    decode("Committed", {
      presale_id: PRESALE,
      quote: 1_200n,
      wallet_commitment: 1_200n,
      total_commitments: 1_200n,
      participants: 1n,
    }),
    decode("PresaleFunded", {
      presale_id: PRESALE,
      total_commitments: 1_200n,
      accepted_quote: 1_000n,
      refundable_quote: 200n,
      token_allocation: 10_001n,
      end_ms: 1_100n,
      liquidity_deadline_ms: 1_150n,
    }),
    decode("RaiseAllocated", {
      presale_id: PRESALE,
      recipient: id("0x5a1e"),
      quote: 200n,
      vesting_id: null,
    }),
    decode("PresaleMigrated", {
      presale_id: PRESALE,
      migration_witness: `${pkg}::bluefin::Witness`,
      liquidity_quote: 800n,
      liquidity_tokens: 10_000n,
      recipient_tokens: 0n,
    }),
  ]) {
    state = reducePresaleEvent(state, event);
  }
  const presale = required(state.presales[PRESALE]);
  assert.deepEqual(presale.raisePayouts, [
    { recipient: id("0x5a1e"), amount: 200n, vesting: null },
  ]);
  assert.deepEqual([presale.quote, presale.liquidityTokens], [200n, 0n]);
});

/**
 * `blast_presale_tests::migration_pays_blast_its_snapshotted_shares_at_the_current_destination`:
 * a sale created under Blast's raise, token, and LP-fee rates.
 */
function feePayingSaleCreated() {
  const recipients = [id("0xa110c"), id("0xb110c")];
  return decode("PresaleCreated", {
    presale_id: PRESALE,
    presale_cap_id: id("0xca"),
    treasury_cap_id: id("0x7c"),
    token_supply: 20_001n,
    token_allocation_bps: 5_000n,
    participant_vesting: null,
    liquidity_token_allocation_bps: 1_000n,
    recipients,
    recipient_bps: [2_500n, 1_000n],
    recipient_vesting: [null, null],
    burnable: false,
    raise_target: 1_000n,
    raise_recipients: [id("0x5a1e")],
    raise_recipient_bps: [2_000n],
    raise_recipient_vesting: [null],
    duration_ms: 100n,
    liquidity_window_ms: 50n,
    eligibility: openEligibility(5_000n, 2n, 500n),
    uncapped: null,
    hard_cap: null,
    migration_witness: `${pkg}::cetus::Witness`,
    fee_recipients: [id("0xc0ffee")],
    fee_recipient_bps: [7_000n],
    holder_rewards_bps: 3_000n,
    protocol_raise_bps: 333n,
    protocol_token_bps: 500n,
    protocol_lp_fee_meme_bps: 1_000n,
    protocol_lp_fee_quote_bps: 2_500n,
    protocol_quote: 33n,
    protocol_tokens: 1_000n,
  });
}

test("tracks Blast's shares from creation through migration, LP fees, and an LP-rate change", () => {
  let state = createPresaleEventProjection();
  for (const event of [
    feePayingSaleCreated(),
    decode("Committed", {
      presale_id: PRESALE,
      quote: 4_000n,
      wallet_commitment: 4_000n,
      total_commitments: 4_000n,
      participants: 1n,
    }),
  ]) {
    state = reducePresaleEvent(state, event);
  }
  let presale = required(state.presales[PRESALE]);
  // The reducer re-derives the supply and raise split; it agrees with the event.
  assert.deepEqual(
    [presale.tokenAllocation, presale.liquidityTokens, presale.recipientTokens],
    [10_001n, 2_000n, 7_000n],
  );
  assert.deepEqual(
    [presale.protocolQuote, presale.protocolTokens],
    [33n, 1_000n],
  );
  assert.deepEqual(presale.raisePayouts, [
    { recipient: id("0x5a1e"), amount: 200n, vesting: null },
  ]);

  for (const event of [
    decode("ProtocolFeesPaid", {
      presale_id: PRESALE,
      destination: TREASURY,
      quote: 33n,
      tokens: 1_000n,
      partner_quote: 0n,
    }),
    decode("RaiseAllocated", {
      presale_id: PRESALE,
      recipient: id("0x5a1e"),
      quote: 200n,
      vesting_id: null,
    }),
    decode("PresaleMigrated", {
      presale_id: PRESALE,
      migration_witness: `${pkg}::cetus::Witness`,
      liquidity_quote: 767n,
      liquidity_tokens: 2_000n,
      recipient_tokens: 7_000n,
    }),
    decode("VaultCreated", {
      vault_id: VAULT,
      presale_id: PRESALE,
      pool_id: id("0x90"),
      position_id: id("0x91"),
      liquidity: 1n,
      fee_recipients: [id("0xc0ffee")],
      fee_recipient_bps: [7_000n],
      holder_rewards_bps: 3_000n,
      protocol_lp_fee_meme_bps: 1_000n,
      protocol_lp_fee_quote_bps: 2_500n,
      migration_meme_residual: 0n,
      migration_quote_residual: 0n,
    }),
    decode("FeesCollected", {
      vault_id: VAULT,
      gross_meme: 101n,
      gross_quote: 10n,
      protocol_destination: TREASURY,
      protocol_meme: 11n,
      protocol_quote: 3n,
      fee_recipient_meme: [63n],
      fee_recipient_quote: [5n],
      holder_rewards_meme: 27n,
      holder_rewards_quote: 2n,
    }),
  ]) {
    state = reducePresaleEvent(state, event);
  }
  presale = required(state.presales[PRESALE]);
  // Only the overflow remains: 4,000 - 33 - 200 - 767.
  assert.deepEqual(
    [presale.quote, presale.protocolTokens, presale.protocolDestination],
    [3_000n, 0n, TREASURY],
  );
  const vault = required(state.vaults[VAULT]);
  assert.deepEqual(
    [
      vault.protocolLpFeeMemeBps,
      vault.protocolLpFeeQuoteBps,
      vault.protocolMemePaid,
      vault.protocolQuotePaid,
    ],
    [1_000n, 2_500n, 11n, 3n],
  );

  // The AdminCap replaces the vault's rates; collections already paid stand.
  state = reducePresaleEvent(
    state,
    decode("ProtocolLpFeesChanged", {
      vault_id: VAULT,
      protocol_lp_fee_meme_bps: 500n,
      protocol_lp_fee_quote_bps: 0n,
    }),
  );
  const changed = required(state.vaults[VAULT]);
  assert.deepEqual(
    [
      changed.protocolLpFeeMemeBps,
      changed.protocolLpFeeQuoteBps,
      changed.protocolMemePaid,
      changed.protocolQuotePaid,
    ],
    [500n, 0n, 11n, 3n],
  );
});

test("holds a partnered sale's Blast shares from migration until its partner is paid", () => {
  // `blast_presale_tests::a_partnered_sale_pays_its_partner_a_cut_of_blasts_raise_fee_only`.
  const PARTNER = id("0x9a27");
  let state = createPresaleEventProjection();
  for (const event of [
    feePayingSaleCreated(),
    decode("PresaleOpened", {
      presale_id: PRESALE,
      start_ms: 1_000n,
      end_ms: 1_100n,
      liquidity_deadline_ms: 1_150n,
      uncapped_from_ms: 1_100n,
      hard_cap_from_ms: null,
      partner_id: PARTNER,
    }),
    decode("Committed", {
      presale_id: PRESALE,
      quote: 4_000n,
      wallet_commitment: 4_000n,
      total_commitments: 4_000n,
      participants: 1n,
    }),
    decode("RaiseAllocated", {
      presale_id: PRESALE,
      recipient: id("0x5a1e"),
      quote: 200n,
      vesting_id: null,
    }),
    decode("PresaleMigrated", {
      presale_id: PRESALE,
      migration_witness: `${pkg}::cetus::Witness`,
      liquidity_quote: 767n,
      liquidity_tokens: 2_000n,
      recipient_tokens: 7_000n,
    }),
  ]) {
    state = reducePresaleEvent(state, event);
  }
  let presale = required(state.presales[PRESALE]);
  // Migration paid Blast nothing: its 33 Quote are held apart from the 3,000 overflow.
  assert.deepEqual(
    [
      presale.partnerId,
      presale.quote,
      presale.unpaidProtocolQuote,
      presale.protocolTokens,
      presale.protocolDestination,
    ],
    [PARTNER, 3_000n, 33n, 1_000n, null],
  );

  state = reducePresaleEvent(
    state,
    decode("ProtocolFeesPaid", {
      presale_id: PRESALE,
      destination: TREASURY,
      quote: 20n,
      tokens: 1_000n,
      partner_quote: 13n,
    }),
  );
  presale = required(state.presales[PRESALE]);
  assert.deepEqual(
    [
      presale.quote,
      presale.unpaidProtocolQuote,
      presale.partnerQuote,
      presale.protocolTokens,
      presale.protocolDestination,
    ],
    [3_000n, null, 13n, 0n, TREASURY],
  );
});

test("holds a partnered vault's Blast LP fees until its partner is paid", () => {
  // `migration_rewards_tests::anyone_pays_the_partner_its_cut_of_blasts_lp_fees_and_blast_the_rest`.
  let state = createPresaleEventProjection();
  const collected = () =>
    decode("FeesCollected", {
      vault_id: VAULT,
      gross_meme: 101n,
      gross_quote: 10n,
      protocol_destination: null,
      protocol_meme: 11n,
      protocol_quote: 3n,
      fee_recipient_meme: [45n, 18n],
      fee_recipient_quote: [4n, 1n],
      holder_rewards_meme: 27n,
      holder_rewards_quote: 2n,
    });
  for (const event of [
    decode("VaultCreated", {
      vault_id: VAULT,
      presale_id: PRESALE,
      pool_id: id("0x90"),
      position_id: id("0x91"),
      liquidity: 1n,
      fee_recipients: [id("0xc0ffee"), id("0xfee")],
      fee_recipient_bps: [5_000n, 2_000n],
      holder_rewards_bps: 3_000n,
      protocol_lp_fee_meme_bps: 1_000n,
      protocol_lp_fee_quote_bps: 2_500n,
      migration_meme_residual: 0n,
      migration_quote_residual: 0n,
    }),
    collected(),
    collected(),
  ]) {
    state = reducePresaleEvent(state, event);
  }
  let vault = required(state.vaults[VAULT]);
  assert.deepEqual(
    [
      vault.protocolMemeHeld,
      vault.protocolQuoteHeld,
      vault.protocolMemePaid,
      vault.protocolQuotePaid,
      vault.holderRewardsMeme,
    ],
    [22n, 6n, 0n, 0n, 54n],
  );

  // 40% of 22 Meme and 6 Quote is 8.8 and 2.4: the partner takes 8 and 2.
  state = reducePresaleEvent(
    state,
    decode("ProtocolLpFeesPaid", {
      vault_id: VAULT,
      protocol_destination: TREASURY,
      protocol_meme: 14n,
      protocol_quote: 4n,
      partner_meme: 8n,
      partner_quote: 2n,
    }),
  );
  vault = required(state.vaults[VAULT]);
  assert.deepEqual(
    [
      vault.protocolMemeHeld,
      vault.protocolQuoteHeld,
      vault.protocolMemePaid,
      vault.protocolQuotePaid,
      vault.partnerMemePaid,
      vault.partnerQuotePaid,
    ],
    [0n, 0n, 14n, 4n, 8n, 2n],
  );
});

test("replaces a scheduled sale's Blast rates and amounts before the start", () => {
  // `blast_presale_tests::the_admin_can_replace_a_sales_rates_before_it_starts`.
  const changed = decode("ProtocolFeesChanged", {
    presale_id: PRESALE,
    protocol_raise_bps: 1_000n,
    protocol_token_bps: 250n,
    protocol_lp_fee_meme_bps: 100n,
    protocol_lp_fee_quote_bps: 200n,
    protocol_quote: 100n,
    protocol_tokens: 500n,
    token_allocation: 10_501n,
  });
  let state = createPresaleEventProjection();
  for (const event of [
    feePayingSaleCreated(),
    decode("PresaleOpened", {
      presale_id: PRESALE,
      start_ms: 1_000n,
      end_ms: 1_100n,
      liquidity_deadline_ms: 1_150n,
      uncapped_from_ms: 1_100n,
      hard_cap_from_ms: null,
      partner_id: null,
    }),
    changed,
  ]) {
    state = reducePresaleEvent(state, event);
  }
  assert.equal(reducePresaleEvent(state, changed), state);

  const presale = required(state.presales[PRESALE]);
  assert.equal(presale.startMs, 1_000n);
  assert.deepEqual(presale.protocolFees, {
    raiseBps: 1_000n,
    tokenBps: 250n,
    lpFeeMemeBps: 100n,
    lpFeeQuoteBps: 200n,
  });
  // Blast's 500 freed tokens joined the sale allocation; recipients and the LP are unchanged.
  assert.deepEqual(
    [
      presale.protocolQuote,
      presale.protocolTokens,
      presale.tokenAllocation,
      presale.saleTokens,
      presale.liquidityTokens,
      presale.recipientTokens,
    ],
    [100n, 500n, 10_501n, 10_501n, 2_000n, 7_000n],
  );
});

test("carries vesting terms from creation and schedule IDs from migration and claims", () => {
  const vesting = { cliffMs: 100n, periodMs: 50n, periods: 4n };
  const recipients = [id("0xa110c"), id("0xb110c")];
  const SCHEDULE = id("0x5c4ed");
  const RAISE_SCHEDULE = id("0x5c4ee");
  const PARTICIPANT_SCHEDULE = id("0x5c4ef");
  let state = createPresaleEventProjection();
  for (const event of [
    decode("PresaleCreated", {
      presale_id: PRESALE,
      presale_cap_id: id("0xca"),
      treasury_cap_id: id("0x7c"),
      token_supply: 20_001n,
      token_allocation_bps: 5_000n,
      participant_vesting: vesting,
      liquidity_token_allocation_bps: 1_000n,
      recipients,
      recipient_bps: [2_500n, 1_500n],
      recipient_vesting: [vesting, null],
      burnable: false,
      raise_target: 1_000n,
      raise_recipients: [id("0x5a1e")],
      raise_recipient_bps: [2_000n],
      raise_recipient_vesting: [vesting],
      duration_ms: 100n,
      liquidity_window_ms: 50n,
      eligibility: openEligibility(5_000n, 2n, 500n),
      uncapped: null,
      hard_cap: null,
      migration_witness: `${pkg}::cetus::Witness`,
      fee_recipients: [id("0xc0ffee")],
      fee_recipient_bps: [7_000n],
      holder_rewards_bps: 3_000n,
      ...NO_FEES,
      protocol_quote: 0n,
      protocol_tokens: 0n,
    }),
    decode("RaiseAllocated", {
      presale_id: PRESALE,
      recipient: id("0x5a1e"),
      quote: 200n,
      vesting_id: RAISE_SCHEDULE,
    }),
    decode("RecipientAllocated", {
      presale_id: PRESALE,
      recipient: itemAt(recipients, 0),
      tokens: 5_000n,
      vesting_id: SCHEDULE,
    }),
    decode("RecipientAllocated", {
      presale_id: PRESALE,
      recipient: itemAt(recipients, 1),
      tokens: 3_000n,
      vesting_id: null,
    }),
    decode("Claimed", {
      presale_id: PRESALE,
      participant: ALICE,
      wallet_commitment: 1_000n,
      tokens: 2_500n,
      quote_refund: 0n,
      remaining_participants: 0n,
      vesting_id: PARTICIPANT_SCHEDULE,
    }),
  ]) {
    state = reducePresaleEvent(state, event);
  }
  const presale = required(state.presales[PRESALE]);
  assert.deepEqual(presale.participantVesting, vesting);
  assert.deepEqual(presale.participantVestingIds, {
    [ALICE]: PARTICIPANT_SCHEDULE,
  });
  assert.deepEqual(
    presale.recipientAllocations.map((share) => share.vesting),
    [vesting, null],
  );
  assert.deepEqual(
    presale.recipientPayouts.map((payout) => payout.vesting),
    [vesting, null],
  );
  assert.deepEqual(presale.raisePayouts, [
    { recipient: id("0x5a1e"), amount: 200n, vesting },
  ]);
  assert.deepEqual(presale.feeRecipients, [
    { recipient: id("0xc0ffee"), bps: 7_000n, vesting: null },
  ]);
  assert.deepEqual(presale.recipientVestingIds, {
    [itemAt(recipients, 0)]: SCHEDULE,
  });
  assert.deepEqual(presale.raiseVestingIds, { [id("0x5a1e")]: RAISE_SCHEDULE });
});

test("a vault without a presale links no presale and is projected on its own", () => {
  const ZERO = id("0x0");
  let state = createPresaleEventProjection();
  state = reducePresaleEvent(
    state,
    decode("VaultCreated", {
      vault_id: VAULT,
      presale_id: ZERO,
      pool_id: id("0x90"),
      position_id: id("0x91"),
      liquidity: 77n,
      fee_recipients: [id("0xc0ffee")],
      fee_recipient_bps: [10_000n],
      holder_rewards_bps: 0n,
      protocol_lp_fee_meme_bps: 500n,
      protocol_lp_fee_quote_bps: 500n,
      migration_meme_residual: 0n,
      migration_quote_residual: 0n,
    }),
  );
  assert.deepEqual(state.presales, {});
  const vault = required(state.vaults[VAULT]);
  assert.equal(vault.presaleId, ZERO);
  assert.equal(vault.venueType, normalizeStructTag(`${pkg}::cetus::Venue`));
  assert.equal(vault.liquidity, 77n);
});

test("rejects the retired blast_presale_admin events: Blast's ACL administers the presale", () => {
  const event: SuiClientTypes.EventEntry = {
    packageId: pkg,
    module: "blast_presale_admin",
    sender: ALICE,
    eventType: `${pkg}::blast_presale_admin::AdminCapRevoked`,
    bcs: Uint8Array.from(Buffer.from(id("0xadc").slice(2), "hex")),
    json: null,
    checkpoint: "9",
    transactionDigest: "admin",
    eventIndex: 0,
  };
  assert.throws(
    () => decodePresalePolicyEvent(event, { originalPackageId: pkg }),
    /unexpected presale policy event/,
  );
});

test("decodes fee-policy and creation-policy events, which have no type arguments", () => {
  const packages = { originalPackageId: pkg };
  const entry = (
    eventType: string,
    bytes: number[],
  ): SuiClientTypes.EventEntry => ({
    packageId: pkg,
    module: eventType.split("::")[1] ?? "",
    sender: ALICE,
    eventType,
    bcs: Uint8Array.from(bytes),
    json: null,
    checkpoint: "9",
    transactionDigest: "fees",
    eventIndex: 0,
  });
  const changed = decodePresalePolicyEvent(
    entry(`${pkg}::fee_policy::FeesChanged`, [
      ...u64(333n),
      ...u64(500n),
      ...u64(1_000n),
      ...u64(2_500n),
    ]),
    packages,
  );
  assert.equal(changed.kind, "FeesChanged");
  assert.deepEqual(changed.payload, {
    raise_bps: 333n,
    token_bps: 500n,
    lp_fee_meme_bps: 1_000n,
    lp_fee_quote_bps: 2_500n,
  });
  const destination = decodePresalePolicyEvent(
    entry(`${pkg}::fee_policy::DestinationChanged`, [
      ...Buffer.from(TREASURY.slice(2), "hex"),
    ]),
    packages,
  );
  assert.deepEqual(destination.payload, { destination: TREASURY });
  const witness = `${pkg.slice(2)}::cetus::Witness`;
  const typeName = (name: string) => [name.length, ...Buffer.from(name)];
  const listed = decodePresalePolicyEvent(
    entry(`${pkg}::creation_policy::MigrationWitnessSet`, [
      ...typeName(witness),
      1,
    ]),
    packages,
  );
  assert.equal(listed.kind, "MigrationWitnessSet");
  assert.deepEqual(listed.payload, {
    migration_witness: `0x${witness}`,
    allowed: true,
  });
  const delisted = decodePresalePolicyEvent(
    entry(`${pkg}::creation_policy::QuoteSet`, [
      ...typeName(quote.slice(2)),
      0,
    ]),
    packages,
  );
  assert.deepEqual(delisted.payload, { quote, allowed: false });
  const partner = id("0x9a27");
  const added = decodePresalePolicyEvent(
    entry(`${pkg}::creation_policy::PartnerAdded`, [
      ...Buffer.from(partner.slice(2), "hex"),
    ]),
    packages,
  );
  assert.equal(added.kind, "PartnerAdded");
  assert.deepEqual(added.payload, { partner_id: partner });
  const removed = decodePresalePolicyEvent(
    entry(`${pkg}::creation_policy::PartnerRemoved`, [
      ...Buffer.from(partner.slice(2), "hex"),
      ...u64(604_801_000n),
    ]),
    packages,
  );
  assert.deepEqual(removed.payload, {
    partner_id: partner,
    accepted_until_ms: 604_801_000n,
  });
  for (const eventType of [
    `${id("0x99")}::fee_policy::FeesChanged`,
    `${pkg}::blast_presale::FeesChanged`,
    `${pkg}::fee_policy::QuoteSet`,
    `${pkg}::fee_policy::FeesChanged<${meme}>`,
  ]) {
    assert.throws(() =>
      decodePresalePolicyEvent(entry(eventType, []), packages),
    );
  }
});

/** Each module's events, with every event's fields in declaration order. */
function orderedModuleEventFields(
  modules: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
  >,
): Record<string, Record<string, [string, string][]>> {
  return Object.fromEntries(
    Object.entries(modules).map(([module, events]) => [
      module,
      orderedEventFields(events),
    ]),
  );
}

function readFrozenPresaleEventSpecs(): Record<
  string,
  Record<string, Record<string, string>>
> {
  const artifact = JSON.parse(
    readFileSync(
      new URL("../abi/production-presale-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    packages: {
      presale: {
        modules: Record<
          string,
          {
            events: Array<{
              name: string;
              fields: Array<{ name: string; type: unknown }>;
            }>;
          }
        >;
      };
    };
  };
  const specs: Record<string, Record<string, Record<string, string>>> = {};
  for (const [module, { events }] of Object.entries(
    artifact.packages.presale.modules,
  )) {
    if (events.length === 0) continue;
    specs[module] = Object.fromEntries(
      events.map((event) => [
        event.name,
        Object.fromEntries(
          event.fields.map((field) => [field.name, descriptor(field.type)]),
        ),
      ]),
    );
  }
  return specs;
}

function descriptor(type: unknown): string {
  if (["u32", "u64", "u128", "bool", "address"].includes(String(type))) {
    return String(type);
  }
  const record = type as Record<string, unknown>;
  if (record.vector === "u8") return "bytes";
  if (record.vector === "u64") return "u64Vector";
  if (record.vector === "address") return "addressVector";
  const vector = JSON.stringify(record.vector ?? null);
  if (vector.includes('"Option"') && vector.includes('"VestingTerms"')) {
    return "vestingVector";
  }
  const datatype = record.Datatype as {
    name: string;
    type_arguments: unknown[];
  };
  const name = datatype.name;
  if (name === "ID") return "id";
  if (name === "TypeName") return "typeName";
  if (name === "EligibilityPolicy") return "eligibility";
  const option = name === "Option" && optionDescriptor(datatype);
  if (option) return option;
  throw new TypeError(`unsupported ABI event field ${JSON.stringify(type)}`);
}

/** The descriptor of an `Option<T>` field, by `T`: a primitive or a datatype. */
function optionDescriptor(datatype: {
  type_arguments: unknown[];
}): string | undefined {
  const argument = (datatype.type_arguments[0] as { argument: unknown })
    .argument;
  if (argument === "address") return "optionAddress";
  if (argument === "u64") return "optionU64";
  return OPTION_DESCRIPTORS[
    (argument as { Datatype: { name: string } }).Datatype.name
  ];
}

/** The event descriptor of each `Option<T>` an event carries, by `T`. */
const OPTION_DESCRIPTORS: Record<string, string | undefined> = {
  UncappedPhase: "optionUncapped",
  HardCap: "optionHardCap",
  ID: "optionId",
  VestingTerms: "optionVesting",
};

function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

test("records a venue's pool tier by sale token, apart from the sale", () => {
  const tier = decode("PoolTierReserved", {
    tick_spacing: 200,
    pool_fee_rate: 10_000n,
  });
  assert.equal(tier.venueType, normalizeStructTag(`${pkg}::cetus::Venue`));
  const state = reducePresaleEvent(createPresaleEventProjection(), tier);
  assert.deepEqual(state.poolTiers[normalizeStructTag(meme)], {
    venueType: normalizeStructTag(`${pkg}::cetus::Venue`),
    quoteType: normalizeStructTag(quote),
    tickSpacing: 200,
    poolFeeRate: 10_000n,
  });
  // The tier event names its venue; without one it is rejected.
  const event = suiEvent("PoolTierReserved", {
    tick_spacing: 200,
    pool_fee_rate: 10_000n,
  });
  assert.throws(() =>
    decodePresaleEvent(
      {
        ...event,
        eventType: `${pkg}::venue_config::PoolTierReserved<${meme}, ${quote}>`,
      },
      { originalPackageId: pkg },
    ),
  );
});

/** A `PresaleCreated` for `PRESALE` with the given hard cap and witness. */
function createdPayload(
  overrides: Partial<PresaleEventPayloads["PresaleCreated"]> = {},
): PresaleEventPayloads["PresaleCreated"] {
  return {
    presale_id: PRESALE,
    presale_cap_id: id("0xca"),
    treasury_cap_id: id("0x7c"),
    token_supply: 20_001n,
    token_allocation_bps: 5_000n,
    participant_vesting: null,
    liquidity_token_allocation_bps: 1_000n,
    recipients: [id("0xa110c")],
    recipient_bps: [4_000n],
    recipient_vesting: [null],
    burnable: false,
    raise_target: 1_000n,
    raise_recipients: [],
    raise_recipient_bps: [],
    raise_recipient_vesting: [],
    duration_ms: 100n,
    liquidity_window_ms: 50n,
    eligibility: openEligibility(5_000n, 2n, 500n),
    uncapped: null,
    hard_cap: null,
    migration_witness: `${pkg}::cetus::Witness`,
    fee_recipients: [id("0xc0ffee")],
    fee_recipient_bps: [7_000n],
    holder_rewards_bps: 3_000n,
    ...NO_FEES,
    protocol_quote: 0n,
    protocol_tokens: 0n,
    ...overrides,
  };
}

test("an early close: PresaleFunded moves the end and LP deadline PresaleOpened scheduled", () => {
  const hardCap = { startsAfterMs: 20n, closesWhenFilled: true };
  let state = createPresaleEventProjection();
  for (const event of [
    decode("PresaleCreated", createdPayload({ hard_cap: hardCap })),
    decode("PresaleOpened", {
      presale_id: PRESALE,
      start_ms: 1_000n,
      end_ms: 1_100n,
      liquidity_deadline_ms: 1_150n,
      uncapped_from_ms: 1_100n,
      hard_cap_from_ms: 1_020n,
      partner_id: null,
    }),
    decode("Committed", {
      presale_id: PRESALE,
      quote: 1_000n,
      wallet_commitment: 1_000n,
      total_commitments: 1_000n,
      participants: 1n,
    }),
  ]) {
    state = reducePresaleEvent(state, event);
  }
  const open = required(state.presales[PRESALE]);
  assert.deepEqual(open.hardCap, {
    startsAfterMs: 20n,
    closesWhenFilled: true,
  });
  assert.equal(open.hardCapFromMs, 1_020n);
  assert.deepEqual([open.endMs, open.liquidityDeadlineMs], [1_100n, 1_150n]);
  // The raise is full under a hard cap that closes when filled: settle at 1_040.
  assert.equal(canClosePresaleEarly(open, 1_019n), false);
  assert.equal(canClosePresaleEarly(open, 1_040n), true);
  const settlement = previewSettlement(open, 1_040n);
  assert.ok(settlement.outcome === "Funded");
  assert.deepEqual(
    [settlement.endMs, settlement.liquidityDeadlineMs],
    [1_040n, 1_090n],
  );

  state = reducePresaleEvent(
    state,
    decode("PresaleFunded", {
      presale_id: PRESALE,
      total_commitments: 1_000n,
      accepted_quote: 1_000n,
      refundable_quote: 0n,
      token_allocation: 10_001n,
      end_ms: settlement.endMs,
      liquidity_deadline_ms: settlement.liquidityDeadlineMs,
    }),
  );
  const funded = required(state.presales[PRESALE]);
  assert.equal(funded.lifecycle, "Funded");
  // The event's actual values replace the scheduled ones.
  assert.deepEqual(
    [funded.endMs, funded.liquidityDeadlineMs],
    [1_040n, 1_090n],
  );
  // The LP deadline that gates `cancel_unlaunched` is the early one.
  assert.equal(funded.liquidityDeadlineMs < open.liquidityDeadlineMs, true);
});

test("keys pool tiers by sale token in either coin order; an Aftermath sale has none", () => {
  const vendor = id("0xaf7e");
  const lp = normalizeStructTag(`${vendor}::lp_coin::LP_COIN`);
  // 0x1 sorts before SUI's 0x2, 0xa after it: both pool coin orders.
  const memeFirst = normalizeStructTag("0x1::meme::MEME");
  const memeSecond = normalizeStructTag("0xa::meme::MEME");
  const typed = (
    event: SuiClientTypes.EventEntry,
    module: string,
    kind: string,
    types: string,
  ): DecodedPresaleEvent =>
    decodePresaleEvent(
      { ...event, eventType: `${pkg}::${module}::${kind}<${types}>` },
      { originalPackageId: pkg },
    );
  const tier = (saleToken: string, tickSpacing: number) =>
    typed(
      suiEvent("PoolTierReserved", {
        tick_spacing: tickSpacing,
        pool_fee_rate: 2_500n,
      }),
      "venue_config",
      "PoolTierReserved",
      `${saleToken}, ${quote}, ${pkg}::cetus::Venue`,
    );
  const aftermathCreated = (saleToken: string, presaleId: string) =>
    typed(
      suiEvent(
        "PresaleCreated",
        createdPayload({
          presale_id: presaleId,
          migration_witness: `${vendor}::blast_aftermath_dao_presale::Witness`,
          fee_recipients: [id("0x7ea5")],
          fee_recipient_bps: [10_000n],
          holder_rewards_bps: 0n,
        }),
      ),
      "blast_presale",
      "PresaleCreated",
      `${saleToken}, ${quote}`,
    );

  let state = createPresaleEventProjection();
  state = reducePresaleEvent(state, tier(memeFirst, 60));
  state = reducePresaleEvent(state, tier(memeSecond, 200));
  // The tier event's first type argument is the sale token, whatever the pool's order.
  assert.equal(state.poolTiers[memeFirst]?.tickSpacing, 60);
  assert.equal(state.poolTiers[memeSecond]?.tickSpacing, 200);
  assert.equal(state.poolTiers[quote], undefined);

  const aftermathFirst = normalizeStructTag("0x1::other::OTHER");
  const aftermathSecond = normalizeStructTag("0xb::other::OTHER");
  for (const [saleToken, presaleId] of [
    [aftermathFirst, id("0xaf1")],
    [aftermathSecond, id("0xaf2")],
  ] as const) {
    state = reducePresaleEvent(state, aftermathCreated(saleToken, presaleId));
    const sale = required(state.presales[presaleId]);
    assert.equal(sale.memeType, saleToken);
    assert.equal(sale.quoteType, quote);
    // The vendor's pool has no CLMM tier, and no PoolTierReserved precedes it.
    assert.equal(state.poolTiers[sale.memeType], undefined);
    assert.deepEqual(sale.feeRecipients, [
      { recipient: id("0x7ea5"), bps: 10_000n, vesting: null },
    ]);
  }
  assert.equal(Object.keys(state.poolTiers).length, 2);
  // Its vendor events are typed <Lp, SaleToken, Quote>, never a presale event.
  assert.throws(() =>
    typed(
      suiEvent("PresaleCreated", createdPayload()),
      "blast_aftermath_dao_presale",
      "PoolCreationReserved",
      `${lp}, ${aftermathFirst}, ${quote}`,
    ),
  );
});
