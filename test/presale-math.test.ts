import assert from "node:assert/strict";
import test from "node:test";

import { itemAt } from "@interest-protocol/blast-core/arrays";
import { U64_MAX } from "@interest-protocol/blast-core/integers";
import type {
  CommitPreviewInput,
  PresaleCreationConfig,
} from "@interest-protocol/blast-presale-sdk/math";
import {
  allowlistedEligibility,
  apportionRaise,
  apportionSupply,
  canClosePresaleEarly,
  MIN_LIQUIDITY_WINDOW_DURATION_MS,
  openEligibility,
  PresaleAbortError,
  presaleWindows,
  previewClaim,
  previewCommit,
  previewPresaleCreation,
  previewSettlement,
  uncappedForAnyone,
  uncappedForEligible,
} from "@interest-protocol/blast-presale-sdk/math";
import type { RecipientShare } from "@interest-protocol/blast-presale-sdk/state";
import { normalizeSuiAddress } from "@mysten/sui/utils";

// Fixture values of `blast_presale_tests.move`.
const RAISE = 1_000n;
/** One `recipient_share` paid outright to `destination`. */
const share = (destination: string, bps: bigint): RecipientShare => ({
  recipient: { destination, vestingTerms: null },
  bps,
});
const recipients = [share("0xa110c", 2_500n), share("0xb110c", 1_500n)];
const feeSplit = {
  routes: [
    { destination: { kind: "Address", address: "0xc0ffee" }, bps: 5_000n },
    { destination: { kind: "Address", address: "0xfee" }, bps: 2_000n },
    { destination: { kind: "HolderRewards" }, bps: 3_000n },
  ],
} as const satisfies PresaleCreationConfig["feeSplit"];
const config: PresaleCreationConfig = {
  tokenSupply: 20_001n,
  tokenAllocationBps: 5_000n,
  participantVesting: null,
  liquidityTokenAllocationBps: 1_000n,
  recipientAllocations: recipients,
  raiseTarget: RAISE,
  raiseAllocations: [],
  durationMs: 100n,
  liquidityWindowMs: MIN_LIQUIDITY_WINDOW_DURATION_MS,
  eligibility: openEligibility(5_000n, 2n, RAISE / 2n),
  uncapped: null,
  hardCap: null,
  feeSplit,
  protocolFees: {
    raiseBps: 0n,
    tokenBps: 0n,
    lpFeeMemeBps: 0n,
    lpFeeQuoteBps: 0n,
  },
};

function aborts(run: () => unknown, code: string) {
  assert.throws(
    run,
    (error) => error instanceof PresaleAbortError && error.abort === code,
  );
}

test("apportions the fixture supply exactly like apportion_supply", () => {
  const preview = previewPresaleCreation(config);
  assert.equal(preview.tokenAllocation, 10_001n);
  assert.equal(preview.liquidityTokenAllocation, 2_000n);
  assert.deepEqual(
    preview.recipientPayouts.map((payout) => payout.amount),
    [5_000n, 3_000n],
  );
  assert.equal(preview.liquidityQuote, RAISE);
  assert.deepEqual(preview.raisePayouts, []);
});

test("apportions Blast's snapshotted token and raise shares like blast_presale::new", () => {
  // `migration_pays_blast_its_snapshotted_shares_at_the_current_destination`.
  const preview = previewPresaleCreation({
    ...config,
    recipientAllocations: [itemAt(recipients, 0), share("0xb110c", 1_000n)],
    raiseAllocations: [share("0x5a1e", 2_000n)],
    protocolFees: {
      raiseBps: 333n,
      tokenBps: 500n,
      lpFeeMemeBps: 0n,
      lpFeeQuoteBps: 0n,
    },
  });
  assert.deepEqual(
    [
      preview.tokenAllocation,
      preview.liquidityTokenAllocation,
      preview.protocolTokenAllocation,
    ],
    [10_001n, 2_000n, 1_000n],
  );
  assert.deepEqual(
    preview.recipientPayouts.map((payout) => payout.amount),
    [5_000n, 2_000n],
  );
  // 1,000 * [2,000, 333, 7,667] / 10,000: the LP takes the leftover atom.
  assert.deepEqual(
    [
      itemAt(preview.raisePayouts, 0).amount,
      preview.protocolQuote,
      preview.liquidityQuote,
    ],
    [200n, 33n, 767n],
  );
  // `allocations_must_leave_room_for_blasts_token_share`.
  aborts(
    () =>
      previewPresaleCreation({
        ...config,
        protocolFees: { ...config.protocolFees, tokenBps: 500n },
      }),
    "EInvalidTokenAllocation",
  );
  // `raise_allocations_must_leave_the_lp_a_share_after_blasts`.
  aborts(
    () => apportionRaise([share("0x5a1e", 9_667n)], 333n, RAISE),
    "EInvalidRaiseAllocation",
  );
});

test("apportions raise allocations with the LP keeping the last share", () => {
  // `raise_allocations_are_paid_at_migration_and_the_lp_takes_the_rest`.
  const raise = apportionRaise([share("0x5a1e", 2_000n)], 0n, RAISE);
  assert.deepEqual(raise.raisePayouts, [
    {
      recipient: {
        destination: normalizeSuiAddress("0x5a1e"),
        vestingTerms: null,
      },
      amount: 200n,
    },
  ]);
  assert.equal(raise.liquidityQuote, 800n);
  aborts(
    () => apportionRaise([share("0x5a1e", 9_999n)], 0n, 5n),
    "EInvalidRaiseAllocation",
  );
});

test("rejects every creation shape blast_presale::new aborts on", () => {
  const cases: Array<[Partial<PresaleCreationConfig>, string]> = [
    [{ raiseTarget: 0n }, "EInvalidRaiseTarget"],
    [
      {
        raiseAllocations: [share("0x5a1e", 6_000n), share("0xca201", 4_000n)],
      },
      "EInvalidRaiseAllocation",
    ],
    [
      {
        raiseAllocations: [share("0x5a1e", 1_000n), share("0x5a1e", 1_000n)],
      },
      "EInvalidRaiseAllocation",
    ],
    [
      { tokenAllocationBps: 10_000n, liquidityTokenAllocationBps: 1n },
      "EInvalidTokenAllocation",
    ],
    [{ tokenSupply: 1n }, "EInvalidTokenAllocation"],
    // `bps::new` rejects a rate above 10,000 before `new` runs.
    [{ liquidityTokenAllocationBps: U64_MAX }, "EInvalidBps"],
    [{ raiseAllocations: [share("0x5a1e", 10_001n)] }, "EInvalidBps"],
    [
      {
        feeSplit: {
          routes: [{ destination: { kind: "Owner" }, bps: 9_999n }],
        },
      },
      "EInvalidFeeSplit",
    ],
    [
      {
        feeSplit: {
          routes: [
            { destination: { kind: "Owner" }, bps: 5_000n },
            { destination: { kind: "Owner" }, bps: 5_000n },
          ],
        },
      },
      "EInvalidFeeSplit",
    ],
    [
      {
        feeSplit: {
          routes: [
            { destination: { kind: "Address", address: "0x0" }, bps: 10_000n },
          ],
        },
      },
      "EInvalidRoute",
    ],
    [
      {
        feeSplit: {
          routes: [
            { destination: { kind: "Owner" }, bps: 0n },
            { destination: { kind: "Burn" }, bps: 10_000n },
          ],
        },
      },
      "EInvalidRoute",
    ],
    [
      {
        feeSplit: {
          routes: [{ destination: { kind: "Owner" }, bps: U64_MAX }],
        },
      },
      "EInvalidBps",
    ],
    [
      {
        recipientAllocations: [share("0x0", 2_500n), share("0xb110c", 1_500n)],
      },
      "EInvalidRecipient",
    ],
    [
      {
        recipientAllocations: [
          share("0xa110c", 2_500n),
          {
            recipient: {
              destination: "0xb110c",
              vestingTerms: {
                cliffDelayMs: 0n,
                periodDurationMs: 0n,
                periods: 1n,
              },
            },
            bps: 1_500n,
          },
        ],
      },
      "EInvalidVestingTerms",
    ],
    [{ durationMs: 0n }, "EInvalidWindow"],
    // `a_liquidity_window_below_seven_days_is_rejected`.
    [
      { liquidityWindowMs: MIN_LIQUIDITY_WINDOW_DURATION_MS - 1n },
      "EInvalidWindow",
    ],
    [
      { eligibility: openEligibility(5_000n, 2n, RAISE / 2n - 1n) },
      "EUnreachableRaise",
    ],
    [{ uncapped: uncappedForEligible(100n) }, "EInvalidUncappedPhase"],
    [
      {
        eligibility: openEligibility(500n, 4n, RAISE / 4n),
        uncapped: uncappedForAnyone(50n, 3n, RAISE),
      },
      "EInvalidUncappedPhase",
    ],
    [
      {
        eligibility: openEligibility(500n, 4n, RAISE / 4n),
        uncapped: uncappedForAnyone(50n, 4n, RAISE / 4n - 1n),
      },
      "EUnreachableRaise",
    ],
    // `an_open_uncapped_phase_counts_only_the_slots_beyond_the_allowlist`.
    [
      {
        eligibility: allowlistedEligibility("00".repeat(32), 1n),
        uncapped: uncappedForAnyone(50n, 4n, RAISE / 4n),
      },
      "EUnreachableRaise",
    ],
    // `a_hard_cap_must_start_inside_the_window`.
    [
      { hardCap: { startsAfterMs: 100n, closesWhenFilled: true } },
      "EInvalidHardCap",
    ],
    // `a_sale_whose_seed_price_no_venue_can_pool_is_rejected`.
    [
      {
        tokenSupply: 10n,
        tokenAllocationBps: 9_000n,
        liquidityTokenAllocationBps: 1_000n,
        recipientAllocations: [],
        raiseTarget: U64_MAX,
        eligibility: openEligibility(U64_MAX, 1n, U64_MAX),
      },
      "EUnseedablePrice",
    ],
  ];
  for (const [override, code] of cases) {
    aborts(() => previewPresaleCreation({ ...config, ...override }), code);
  }
});

test("mirrors the eligibility and uncapped constructors", () => {
  aborts(() => openEligibility(100n, 20n, 101n), "EInvalidEligibilityPolicy");
  aborts(() => openEligibility(100n, 65_537n, 1n), "EInvalidEligibilityPolicy");
  aborts(() => uncappedForAnyone(0n, 1n, 0n), "EInvalidUncappedPhase");
});

test("fixes the windows share starts", () => {
  assert.deepEqual(presaleWindows(1_000n, 100n, 50n, { startsAfterMs: 50n }), {
    endMs: 1_100n,
    liquidityDeadlineMs: 1_150n,
    uncappedFromMs: 1_050n,
    hardCapFromMs: null,
  });
  assert.equal(
    presaleWindows(1_000n, 100n, 50n, null, { startsAfterMs: 0n })
      .hardCapFromMs,
    1_000n,
  );
  assert.equal(presaleWindows(1_000n, 100n, 50n, null).uncappedFromMs, 1_100n);
  aborts(() => presaleWindows(U64_MAX, 1n, 1n, null), "EInvalidWindow");
});

const openSale: CommitPreviewInput["presale"] = {
  lifecycle: "Open",
  startMs: 1_000n,
  endMs: 1_100n,
  raiseTarget: RAISE,
  eligibility: openEligibility(5_000n, 2n, RAISE / 2n),
  uncapped: null,
  uncappedFromMs: 1_100n,
  hardCapFromMs: null,
  totalCommitments: 0n,
  participants: 0n,
};

function commit(
  presale: CommitPreviewInput["presale"],
  offered: bigint,
  extra: Partial<CommitPreviewInput> = {},
) {
  const result = previewCommit({
    presale,
    route: "open",
    offered,
    nowMs: 1_000n,
    commitment: null,
    ...extra,
  });
  return [
    result.walletCommitment,
    result.totalCommitments,
    result.participants,
  ];
}

test("previews open commitments like the Committed event", () => {
  // `oversubscription_uses_one_fill_rate_and_refunds_the_rest`.
  assert.deepEqual(commit(openSale, 1_000n), [1_000n, 1_000n, 1n]);
  assert.deepEqual(
    commit({ ...openSale, totalCommitments: 1_000n, participants: 1n }, 3_000n),
    [3_000n, 4_000n, 2n],
  );
  // `a_wallet_above_the_minimum_may_top_up_by_any_amount`.
  assert.deepEqual(
    commit({ ...openSale, totalCommitments: 500n, participants: 1n }, 1n, {
      commitment: { quote: 500n, walletCap: 5_000n },
    }),
    [501n, 501n, 1n],
  );
});

test("previews every commitment abort in contract order", () => {
  aborts(() => commit(openSale, 499n), "EBelowMinimumCommitment");
  aborts(
    () => commit({ ...openSale, lifecycle: "Funded" }, 500n),
    "EInvalidLifecycle",
  );
  // `commitments_before_the_start_are_rejected_before_amount_checks`.
  aborts(() => commit(openSale, 0n, { nowMs: 999n }), "EPresaleNotStarted");
  aborts(() => commit(openSale, 500n, { nowMs: 1_100n }), "EPresaleEnded");
  aborts(() => commit(openSale, 0n, { nowMs: 1_100n }), "EPresaleEnded");
  aborts(() => commit(openSale, 0n), "EZeroCommitment");
  aborts(() => commit(openSale, 5_001n), "EWalletCapExceeded");
  aborts(
    () =>
      commit(openSale, 1n, {
        commitment: { quote: 5_000n, walletCap: 5_000n },
      }),
    "EWalletCapExceeded",
  );
  aborts(
    () => commit({ ...openSale, participants: 2n }, 500n),
    "EParticipantCapacityReached",
  );
  aborts(
    () => commit(openSale, 500n, { route: "uncapped" }),
    "EUncappedPhaseNotOpen",
  );
  aborts(
    () => commit(openSale, 500n, { route: "allowlisted" }),
    "EWrongEligibilityPolicy",
  );
  const allowlisted = {
    ...openSale,
    eligibility: {
      kind: "allowlisted" as const,
      root: "00".repeat(32),
      leafCount: 1n,
    },
  };
  aborts(() => commit(allowlisted, 500n), "EWrongEligibilityPolicy");
  aborts(
    () => commit(allowlisted, 500n, { route: "allowlisted", walletCap: 0n }),
    "EInvalidEligibilityProof",
  );
  aborts(
    () =>
      commit(allowlisted, 1n, {
        route: "allowlisted",
        walletCap: 600n,
        commitment: { quote: 1n, walletCap: 500n },
      }),
    "EInvalidEligibilityProof",
  );
  assert.deepEqual(
    commit(allowlisted, 1n, { route: "allowlisted", walletCap: 500n }),
    [1n, 1n, 1n],
  );
  aborts(
    () => commit({ ...openSale, totalCommitments: U64_MAX - 1n }, 500n),
    "ETotalCommitmentOverflow",
  );
});

/** An uncapped phase from 1,050, hard-capped from then when `hardCap`. */
const phased = (hardCap: boolean): CommitPreviewInput["presale"] => ({
  ...openSale,
  eligibility: openEligibility(500n, 4n, RAISE / 4n),
  uncapped: uncappedForEligible(50n),
  uncappedFromMs: 1_050n,
  hardCapFromMs: hardCap ? 1_050n : null,
});

test("previews uncapped phases, hard caps, and returned change", () => {
  // `wallet_caps_hold_until_the_uncapped_phase_starts`.
  aborts(
    () => commit(phased(false), 501n, { nowMs: 1_049n }),
    "EWalletCapExceeded",
  );
  // `an_uncapped_phase_without_a_hard_cap_lifts_caps_and_overflows`.
  assert.deepEqual(
    commit(
      { ...phased(false), totalCommitments: 500n, participants: 1n },
      3_000n,
      {
        nowMs: 1_050n,
      },
    ),
    [3_000n, 3_500n, 2n],
  );
  // `a_hard_capped_uncapped_phase_fills_the_raise_and_returns_the_excess`.
  const filled = previewCommit({
    presale: { ...phased(true), totalCommitments: 400n, participants: 1n },
    route: "open",
    offered: 2_000n,
    nowMs: 1_050n,
    commitment: null,
  });
  assert.deepEqual([filled.accepted, filled.change], [600n, 1_400n]);
  // `a_full_hard_capped_sale_accepts_no_more_quote`.
  aborts(
    () =>
      commit({ ...phased(true), totalCommitments: RAISE }, 250n, {
        nowMs: 1_050n,
      }),
    "EPresaleFilled",
  );
  // `the_commitment_that_fills_a_hard_cap_may_be_below_the_minimum`.
  const last = previewCommit({
    presale: { ...phased(true), totalCommitments: 900n, participants: 1n },
    route: "open",
    offered: 500n,
    nowMs: 1_050n,
    commitment: null,
  });
  assert.deepEqual([last.accepted, last.change], [100n, 400n]);
  // Without a hard cap every commitment returns a zero coin.
  assert.equal(
    previewCommit({
      presale: phased(false),
      route: "open",
      offered: 250n,
      nowMs: 1_000n,
      commitment: null,
    }).change,
    0n,
  );
});

test("previews a hard cap from the start that keeps wallet caps", () => {
  // `a_hard_cap_from_the_start_fills_first_come_within_wallet_caps`.
  const capped = {
    ...openSale,
    eligibility: openEligibility(500n, 4n, RAISE / 4n),
    hardCapFromMs: 1_000n,
  };
  const carol = previewCommit({
    presale: { ...capped, totalCommitments: 900n, participants: 2n },
    route: "open",
    offered: 500n,
    nowMs: 1_000n,
    commitment: null,
  });
  assert.deepEqual([carol.accepted, carol.change], [100n, 400n]);
  // `a_hard_cap_keeps_wallet_caps`.
  aborts(() => commit(capped, 501n), "EWalletCapExceeded");
});

test("previews the anyone route only once its phase starts", () => {
  // `an_uncapped_phase_open_to_anyone_admits_wallets_outside_the_allowlist`.
  const presale = {
    ...openSale,
    eligibility: {
      kind: "allowlisted" as const,
      root: "00".repeat(32),
      leafCount: 1n,
    },
    uncapped: uncappedForAnyone(50n, 4n, RAISE / 4n),
    uncappedFromMs: 1_050n,
    totalCommitments: 500n,
    participants: 1n,
  };
  assert.deepEqual(
    commit(presale, 2_000n, { route: "uncapped", nowMs: 1_050n }),
    [2_000n, 2_500n, 2n],
  );
  aborts(
    () => commit(presale, 500n, { route: "uncapped", nowMs: 1_049n }),
    "EUncappedPhaseNotOpen",
  );
  aborts(
    () => commit(phased(false), 500n, { route: "uncapped", nowMs: 1_050n }),
    "EUncappedPhaseNotOpen",
  );
});

test("previews settlement and every claim, the last taking the remainder", () => {
  const settling = {
    lifecycle: "Open" as const,
    startMs: 1_000n,
    endMs: 1_100n,
    liquidityWindowMs: MIN_LIQUIDITY_WINDOW_DURATION_MS,
    hardCap: null,
    hardCapFromMs: null,
    raiseTarget: RAISE,
  };
  assert.deepEqual(
    previewSettlement({ ...settling, totalCommitments: 4_000n }, 1_100n),
    {
      outcome: "Funded",
      acceptedQuote: RAISE,
      refundableQuote: 3_000n,
      endMs: 1_100n,
      liquidityDeadlineMs: 1_100n + MIN_LIQUIDITY_WINDOW_DURATION_MS,
    },
  );
  assert.deepEqual(
    previewSettlement({ ...settling, totalCommitments: 999n }, 1_100n),
    {
      outcome: "Cancelled",
      refundableQuote: 999n,
    },
  );
  // `an_overflowing_sale_cannot_close_early`.
  aborts(
    () => previewSettlement({ ...settling, totalCommitments: 3_000n }, 1_099n),
    "EPresaleNotEnded",
  );

  // `oversubscription_uses_one_fill_rate_and_refunds_the_rest`: Alice then Bob.
  const migrated = {
    lifecycle: "Migrated" as const,
    totalCommitments: 4_000n,
    participants: 2n,
    raiseTarget: RAISE,
    tokenAllocation: 10_001n,
    participantVesting: null,
    saleTokens: 10_001n,
    quote: 3_000n,
  };
  assert.deepEqual(previewClaim(migrated, 1_000n), {
    tokens: 2_500n,
    quoteRefund: 750n,
    vesting: null,
  });
  assert.deepEqual(
    previewClaim(
      {
        ...migrated,
        participants: 1n,
        saleTokens: 7_501n,
        quote: 2_250n,
      },
      3_000n,
    ),
    { tokens: 7_501n, quoteRefund: 2_250n, vesting: null },
  );
  const cancelled = {
    ...migrated,
    lifecycle: "Cancelled" as const,
    totalCommitments: 500n,
    participants: 1n,
    quote: 500n,
  };
  assert.deepEqual(previewClaim(cancelled, 500n), {
    tokens: 0n,
    quoteRefund: 500n,
    vesting: null,
  });
  assert.deepEqual(previewClaim({ ...cancelled, participants: 2n }, 200n), {
    tokens: 0n,
    quoteRefund: 200n,
    vesting: null,
  });
  aborts(
    () => previewClaim({ ...migrated, lifecycle: "Funded" }, 1n),
    "EInvalidLifecycle",
  );
});

test("apportionSupply rejects a zero presale or LP allocation", () => {
  aborts(
    () => apportionSupply(1n, 5_000n, 1_000n, 0n, recipients),
    "EInvalidTokenAllocation",
  );
});

test("participant vesting locks every positive claim in a schedule from the claim", () => {
  const vesting = { cliffDelayMs: 100n, periodDurationMs: 50n, periods: 4n };
  previewPresaleCreation({ ...config, participantVesting: vesting });
  aborts(
    () =>
      previewPresaleCreation({
        ...config,
        participantVesting: {
          cliffDelayMs: 0n,
          periodDurationMs: 0n,
          periods: 1n,
        },
      }),
    "EInvalidVestingTerms",
  );

  // `blast_presale_tests::claims_lock_participant_tokens_in_a_schedule_from_each_claim`.
  const migrated = {
    lifecycle: "Migrated" as const,
    totalCommitments: 4_000n,
    participants: 2n,
    raiseTarget: RAISE,
    tokenAllocation: 10_001n,
    participantVesting: vesting,
    saleTokens: 10_001n,
    quote: 3_000n,
  };
  assert.deepEqual(previewClaim(migrated, 1_000n), {
    tokens: 2_500n,
    quoteRefund: 750n,
    vesting,
  });
  // `a_participant_claim_without_tokens_creates_no_schedule`: no tokens, no schedule.
  assert.deepEqual(
    previewClaim({ ...migrated, totalCommitments: 20_001n }, 1n),
    { tokens: 0n, quoteRefund: 0n, vesting: null },
  );
  // `a_cancelled_vesting_sale_refunds_without_a_schedule`.
  assert.deepEqual(
    previewClaim(
      {
        ...migrated,
        lifecycle: "Cancelled",
        totalCommitments: 500n,
        participants: 1n,
        quote: 500n,
      },
      500n,
    ),
    { tokens: 0n, quoteRefund: 500n, vesting: null },
  );
});

test("previews an early close once the raise is full under a hard cap that closes when filled", () => {
  const closing = {
    lifecycle: "Open" as const,
    startMs: 1_000n,
    endMs: 1_100n,
    liquidityWindowMs: MIN_LIQUIDITY_WINDOW_DURATION_MS,
    hardCap: { startsAfterMs: 0n, closesWhenFilled: true },
    hardCapFromMs: 1_000n,
    totalCommitments: RAISE,
    raiseTarget: RAISE,
  };
  // `a_sale_that_closes_when_filled_settles_once_its_raise_is_full`.
  assert.equal(canClosePresaleEarly(closing, 1_010n), true);
  assert.deepEqual(previewSettlement(closing, 1_010n), {
    outcome: "Funded",
    acceptedQuote: RAISE,
    refundableQuote: 0n,
    endMs: 1_010n,
    liquidityDeadlineMs: 1_010n + MIN_LIQUIDITY_WINDOW_DURATION_MS,
  });
  // `a_full_sale_that_does_not_close_when_filled_waits_for_its_end`.
  aborts(
    () =>
      previewSettlement(
        { ...closing, hardCap: { startsAfterMs: 0n, closesWhenFilled: false } },
        1_099n,
      ),
    "EPresaleNotEnded",
  );
  // `a_hard_capped_sale_short_of_its_raise_cannot_close_early`.
  aborts(
    () =>
      previewSettlement({ ...closing, totalCommitments: RAISE - 1n }, 1_010n),
    "EPresaleNotEnded",
  );
  // `a_sale_overfilled_before_its_hard_cap_cannot_close_before_the_hard_cap_starts`.
  const overfilled = {
    ...closing,
    hardCap: { startsAfterMs: 50n, closesWhenFilled: true },
    hardCapFromMs: 1_050n,
    totalCommitments: 1_500n,
  };
  aborts(() => previewSettlement(overfilled, 1_049n), "EPresaleNotEnded");
  assert.equal(previewSettlement(overfilled, 1_050n).outcome, "Funded");
  aborts(
    () => previewSettlement({ ...closing, lifecycle: "Funded" }, 1_010n),
    "EInvalidLifecycle",
  );
});
