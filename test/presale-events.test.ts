import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type {
  DecodedPresaleEvent,
  PresaleEventKind,
  PresaleEventPayloads,
} from "../src/presale/events.ts";
import {
  decodePresaleEvent,
  decodePresaleFeePolicyEvent,
  presaleEventBcs,
  presaleEventModules,
  presaleEventSpecs,
  presaleFeePolicyEventSpecs,
} from "../src/presale/events.ts";
import { openEligibility, previewClaim } from "../src/presale/math.ts";
import {
  createPresaleEventProjection,
  reducePresaleEvent,
} from "../src/presale/reducer.ts";

const pkg = normalizeSuiAddress("0x5e");
const meme = normalizeStructTag("0xa::meme::MEME");
const quote = normalizeStructTag("0x2::sui::SUI");
const id = (value: string) => normalizeSuiAddress(value);
const PRESALE = id("0xab");
const VAULT = id("0xba");
const ROUND = id("0xd0");
const ALICE = id("0xa11ce");
const BOB = id("0xb0b");
const NO_FEES = { raiseBps: 0n, tokenBps: 0n, lpMemeBps: 0n, lpQuoteBps: 0n };
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
  const venue = kind === "PresaleVaultCreated" ? `, ${pkg}::cetus::Venue` : "";
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
    { ...presaleEventSpecs, fee_policy: presaleFeePolicyEventSpecs },
    readFrozenPresaleEventSpecs(),
  );
  assert.equal(Object.keys(presaleEventModules).length, 16);
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
      liquidity_token_allocation_bps: 1_000n,
      recipients,
      recipient_bps: [2_500n, 1_500n],
      burnable: false,
      raise_target: 1_000n,
      raise_recipients: [],
      raise_recipient_bps: [],
      duration_ms: 100n,
      liquidity_window_ms: 50n,
      eligibility: openEligibility(5_000n, 2n, 500n),
      uncapped: null,
      migration_witness: `${pkg}::cetus::Witness`,
      tick_spacing: 200,
      fee_rate: 10_000n,
      fee_recipients: [id("0xc0ffee"), id("0xfee")],
      fee_recipient_bps: [5_000n, 2_000n],
      rewards_fee_bps: 3_000n,
      protocol_fees: NO_FEES,
      protocol_quote: 0n,
      protocol_tokens: 0n,
    }),
    decode("PresaleOpened", {
      presale_id: PRESALE,
      start_ms: 1_000n,
      end_ms: 1_100n,
      liquidity_deadline_ms: 1_150n,
      uncapped_from_ms: 1_100n,
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
      commitments: 4_000n,
      accepted_quote: 1_000n,
      refundable_quote: 3_000n,
      token_allocation: 10_001n,
    }),
  ];
  let state = createPresaleEventProjection();
  for (const event of events) state = reducePresaleEvent(state, event);
  let presale = state.presales[PRESALE]!;
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
    }),
    decode("RecipientAllocated", {
      presale_id: PRESALE,
      recipient: recipients[0]!,
      tokens: 5_000n,
    }),
    decode("RecipientAllocated", {
      presale_id: PRESALE,
      recipient: recipients[1]!,
      tokens: 3_000n,
    }),
    decode("PresaleMigrated", {
      presale_id: PRESALE,
      migration_witness: `${pkg}::cetus::Witness`,
      quote: 1_000n,
      liquidity_tokens: 2_000n,
      recipient_tokens: 8_000n,
    }),
  ];
  for (const event of migration) state = reducePresaleEvent(state, event);
  for (const [participant, commitment] of [
    [ALICE, 1_000n],
    [BOB, 3_000n],
  ] as const) {
    const expected = previewClaim(state.presales[PRESALE]!, commitment);
    state = reducePresaleEvent(
      state,
      decode("Claimed", {
        presale_id: PRESALE,
        participant,
        commitment,
        tokens: expected.tokens,
        quote_refund: expected.quoteRefund,
        remaining_commitments:
          state.presales[PRESALE]!.remainingCommitments - commitment,
      }),
    );
  }
  presale = state.presales[PRESALE]!;
  assert.equal(presale.lifecycle, "Migrated");
  assert.deepEqual(presale.commitments, {});
  // `blast_presale_tests`: custody is [4_000, 0, 2, 0, 0, 0, 0] after both claims.
  assert.deepEqual(
    [
      presale.totalCommitments,
      presale.remainingCommitments,
      presale.participants,
      presale.quote,
      presale.saleTokens,
      presale.liquidityTokens,
      presale.recipientTokens,
    ],
    [4_000n, 0n, 2n, 0n, 0n, 0n, 0n],
  );

  const vaultEvents: DecodedPresaleEvent[] = [
    decode("PresaleVaultCreated", {
      vault_id: VAULT,
      presale_id: PRESALE,
      pool_id: id("0x90"),
      position_id: id("0x91"),
      liquidity: 1_234n,
      fee_recipients: [id("0xc0ffee"), id("0xfee")],
      fee_recipient_bps: [5_000n, 2_000n],
      rewards_fee_bps: 3_000n,
      protocol_lp_meme_bps: 0n,
      protocol_lp_quote_bps: 0n,
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
      recipient_meme: [51n, 20n],
      recipient_quote: [5n, 2n],
      rewards_meme: 30n,
      rewards_quote: 3n,
    }),
    decode("MigrationResidualsClaimed", {
      vault_id: VAULT,
      meme: 1n,
      quote: 0n,
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
    }),
  ];
  for (const event of vaultEvents) {
    const next = reducePresaleEvent(state, event);
    assert.equal(reducePresaleEvent(next, event), next, "replay is a no-op");
    state = next;
  }
  assert.equal(state.presales[PRESALE]!.vaultId, VAULT);
  const vault = state.vaults[VAULT]!;
  assert.equal(vault.venueType, normalizeStructTag(`${pkg}::cetus::Venue`));
  assert.deepEqual(
    [
      vault.rewardsMeme,
      vault.rewardsQuote,
      vault.nextRound,
      vault.lastCheckpoint,
      vault.migrationMemeResidual,
    ],
    [10n, 1n, 1n, 10n, 0n],
  );
  assert.deepEqual(vault.recipientMemePaid, [51n, 20n]);
  assert.deepEqual(vault.recipientQuotePaid, [5n, 2n]);
  const round = state.rounds[ROUND]!;
  assert.deepEqual(round.paidIndexes, { "1": true });
  assert.equal(round.closed, true);
  assert.equal(round.memeRemaining, 0n);
  const twice = ["Committed", "Claimed", "RecipientAllocated"];
  const never = ["RaiseAllocated", "PresaleCancelled"];
  for (const kind of Object.keys(presaleEventModules) as PresaleEventKind[]) {
    const expected = twice.includes(kind) ? 2 : never.includes(kind) ? 0 : 1;
    assert.equal(state.eventCounts[kind], expected, kind);
  }

  // Cancellation refunds every commitment in full.
  const cancelled = reducePresaleEvent(
    reducePresaleEvent(
      reducePresaleEvent(createPresaleEventProjection(), events[0]!),
      events[2]!,
    ),
    decode("PresaleCancelled", {
      presale_id: PRESALE,
      commitments: 1_000n,
      refundable_quote: 1_000n,
    }),
  ).presales[PRESALE]!;
  assert.equal(cancelled.lifecycle, "Cancelled");
  assert.deepEqual(previewClaim(cancelled, 1_000n), {
    tokens: 0n,
    quoteRefund: 1_000n,
  });
});

test("a raise allocation leaves custody the migration's overflow", () => {
  let state = createPresaleEventProjection();
  const created = decode("PresaleCreated", {
    presale_id: PRESALE,
    presale_cap_id: id("0xca"),
    treasury_cap_id: id("0x7c"),
    token_supply: 20_001n,
    token_allocation_bps: 5_000n,
    liquidity_token_allocation_bps: 5_000n,
    recipients: [],
    recipient_bps: [],
    burnable: true,
    raise_target: 1_000n,
    raise_recipients: [id("0x5a1e")],
    raise_recipient_bps: [2_000n],
    duration_ms: 100n,
    liquidity_window_ms: 50n,
    eligibility: openEligibility(5_000n, 1n, 1_000n),
    uncapped: null,
    migration_witness: `${pkg}::bluefin::Witness`,
    tick_spacing: 60,
    fee_rate: 3_000n,
    fee_recipients: [],
    fee_recipient_bps: [],
    rewards_fee_bps: 10_000n,
    protocol_fees: NO_FEES,
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
      commitments: 1_200n,
      accepted_quote: 1_000n,
      refundable_quote: 200n,
      token_allocation: 10_001n,
    }),
    decode("RaiseAllocated", {
      presale_id: PRESALE,
      recipient: id("0x5a1e"),
      quote: 200n,
    }),
    decode("PresaleMigrated", {
      presale_id: PRESALE,
      migration_witness: `${pkg}::bluefin::Witness`,
      quote: 800n,
      liquidity_tokens: 10_000n,
      recipient_tokens: 0n,
    }),
  ]) {
    state = reducePresaleEvent(state, event);
  }
  const presale = state.presales[PRESALE]!;
  assert.deepEqual(presale.raisePayouts, [
    { recipient: id("0x5a1e"), amount: 200n },
  ]);
  assert.deepEqual([presale.quote, presale.liquidityTokens], [200n, 0n]);
});

test("tracks Blast's snapshotted shares from creation through migration and LP fees", () => {
  let state = createPresaleEventProjection();
  const recipients = [id("0xa110c"), id("0xb110c")];
  for (const event of [
    // `blast_presale_tests::migration_pays_blast_its_snapshotted_shares_at_the_current_destination`.
    decode("PresaleCreated", {
      presale_id: PRESALE,
      presale_cap_id: id("0xca"),
      treasury_cap_id: id("0x7c"),
      token_supply: 20_001n,
      token_allocation_bps: 5_000n,
      liquidity_token_allocation_bps: 1_000n,
      recipients,
      recipient_bps: [2_500n, 1_000n],
      burnable: false,
      raise_target: 1_000n,
      raise_recipients: [id("0x5a1e")],
      raise_recipient_bps: [2_000n],
      duration_ms: 100n,
      liquidity_window_ms: 50n,
      eligibility: openEligibility(5_000n, 2n, 500n),
      uncapped: null,
      migration_witness: `${pkg}::cetus::Witness`,
      tick_spacing: 200,
      fee_rate: 10_000n,
      fee_recipients: [id("0xc0ffee")],
      fee_recipient_bps: [7_000n],
      rewards_fee_bps: 3_000n,
      protocol_fees: {
        raiseBps: 333n,
        tokenBps: 500n,
        lpMemeBps: 1_000n,
        lpQuoteBps: 2_500n,
      },
      protocol_quote: 33n,
      protocol_tokens: 1_000n,
    }),
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
  let presale = state.presales[PRESALE]!;
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
    { recipient: id("0x5a1e"), amount: 200n },
  ]);

  for (const event of [
    decode("ProtocolFeesPaid", {
      presale_id: PRESALE,
      destination: TREASURY,
      quote: 33n,
      tokens: 1_000n,
    }),
    decode("RaiseAllocated", {
      presale_id: PRESALE,
      recipient: id("0x5a1e"),
      quote: 200n,
    }),
    decode("PresaleMigrated", {
      presale_id: PRESALE,
      migration_witness: `${pkg}::cetus::Witness`,
      quote: 767n,
      liquidity_tokens: 2_000n,
      recipient_tokens: 7_000n,
    }),
    decode("PresaleVaultCreated", {
      vault_id: VAULT,
      presale_id: PRESALE,
      pool_id: id("0x90"),
      position_id: id("0x91"),
      liquidity: 1n,
      fee_recipients: [id("0xc0ffee")],
      fee_recipient_bps: [7_000n],
      rewards_fee_bps: 3_000n,
      protocol_lp_meme_bps: 1_000n,
      protocol_lp_quote_bps: 2_500n,
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
      recipient_meme: [63n],
      recipient_quote: [5n],
      rewards_meme: 27n,
      rewards_quote: 2n,
    }),
  ]) {
    state = reducePresaleEvent(state, event);
  }
  presale = state.presales[PRESALE]!;
  // Only the overflow remains: 4,000 - 33 - 200 - 767.
  assert.deepEqual(
    [presale.quote, presale.protocolTokens, presale.protocolDestination],
    [3_000n, 0n, TREASURY],
  );
  const vault = state.vaults[VAULT]!;
  assert.deepEqual(
    [
      vault.protocolLpMemeBps,
      vault.protocolLpQuoteBps,
      vault.protocolMemePaid,
      vault.protocolQuotePaid,
    ],
    [1_000n, 2_500n, 11n, 3n],
  );
});

test("decodes fee-policy events, which have no type arguments", () => {
  const packages = { originalPackageId: pkg };
  const entry = (
    eventType: string,
    bytes: number[],
  ): SuiClientTypes.EventEntry => ({
    packageId: pkg,
    module: "fee_policy",
    sender: ALICE,
    eventType,
    bcs: Uint8Array.from(bytes),
    json: null,
    checkpoint: "9",
    transactionDigest: "fees",
    eventIndex: 0,
  });
  const changed = decodePresaleFeePolicyEvent(
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
    lp_meme_bps: 1_000n,
    lp_quote_bps: 2_500n,
  });
  const destination = decodePresaleFeePolicyEvent(
    entry(`${pkg}::fee_policy::DestinationChanged`, [
      ...Buffer.from(TREASURY.slice(2), "hex"),
    ]),
    packages,
  );
  assert.deepEqual(destination.payload, { destination: TREASURY });
  for (const eventType of [
    `${id("0x99")}::fee_policy::FeesChanged`,
    `${pkg}::blast_presale::FeesChanged`,
    `${pkg}::fee_policy::FeesChanged<${meme}>`,
  ]) {
    assert.throws(() =>
      decodePresaleFeePolicyEvent(entry(eventType, []), packages),
    );
  }
});

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
  const datatype = record.Datatype as {
    name: string;
    type_arguments: unknown[];
  };
  const name = datatype.name;
  if (name === "ID") return "id";
  if (name === "TypeName") return "typeName";
  if (name === "EligibilityPolicy") return "eligibility";
  if (name === "ProtocolFees") return "protocolFees";
  if (name === "Option") {
    const inner = (
      datatype.type_arguments[0] as { argument: { Datatype: { name: string } } }
    ).argument.Datatype.name;
    if (inner === "UncappedPhase") return "optionUncapped";
  }
  throw new TypeError(`unsupported ABI event field ${JSON.stringify(type)}`);
}
