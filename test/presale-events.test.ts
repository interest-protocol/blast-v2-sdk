import assert from "node:assert/strict";
import test from "node:test";
import type { DelayedEventKind } from "@interest-protocol/blast-admin-sdk/events";
import {
  delayedEventBcs,
  delayedEventModule,
} from "@interest-protocol/blast-admin-sdk/events";
import { decodeProtocolFeesPaid } from "@interest-protocol/blast-core/protocol-fees";
import { decodeAftermathDaoPresaleEvent } from "@interest-protocol/blast-presale-sdk/aftermath-dao";
import type {
  DecodedPresaleDelayedEvent,
  DecodedPresaleEvent,
  PresaleEventKind,
} from "@interest-protocol/blast-presale-sdk/events";
import {
  decodePresaleDelayedEvent,
  decodePresaleEvent,
  decodePresalePolicyEvent,
  presaleDelayedKeys,
  presaleEventBcs,
  presaleEventModules,
  quoteAllowedBcs,
} from "@interest-protocol/blast-presale-sdk/events";
import {
  createPresaleEventProjection,
  reducePresaleEvent,
} from "@interest-protocol/blast-presale-sdk/reducer";
import { decodePresaleObject } from "@interest-protocol/blast-presale-sdk/state";
import type { BcsType } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
} from "@mysten/sui/utils";
import { PRESALE_FIXTURE as fixture } from "./fixtures/presale-4fe8d73.ts";

// The Move fixture publishes the presale (and core, in its own build) at 0x0.
const pkg = normalizeSuiAddress("0x0");
const type = (name: string) =>
  normalizeStructTag(`0x0::blast_presale_tests::${name}`);
const saleToken = type("BLAST_PRESALE_TESTS");
const quote = type("QUOTE");
const PRESALE = `0x${fixture.presaleId}`;
const PARTNER = `0x${fixture.partnerId}`;
const VENUE = normalizeStructTag(
  new TextDecoder().decode(fromHex(fixture.venue)),
);
const ALICE = normalizeSuiAddress("0xa11ce");
const BOB = normalizeSuiAddress("0xb0b");
const ADMIN = normalizeSuiAddress("0xad");

let eventIndex = 0;
function entry(
  eventType: string,
  bcs: Uint8Array,
  sender = ALICE,
): SuiClientTypes.EventEntry {
  eventIndex += 1;
  return {
    packageId: pkg,
    module: "events",
    sender,
    eventType,
    bcs,
    json: null,
    checkpoint: "9",
    transactionDigest: `tx-${eventIndex}`,
    eventIndex,
  };
}

function decode(
  kind: PresaleEventKind,
  hex: string,
  sender?: string,
): DecodedPresaleEvent {
  return decodePresaleEvent(
    entry(
      `${pkg}::${presaleEventModules[kind]}::${kind}<${saleToken}, ${quote}>`,
      fromHex(hex),
      sender,
    ),
    { originalPackageId: pkg },
  );
}

/** Serializes a payload the fixture did not print (Bob's commitment). */
function encode<Kind extends PresaleEventKind>(
  kind: Kind,
  payload: Parameters<(typeof presaleEventBcs)[Kind]["serialize"]>[0],
): string {
  return Buffer.from(
    (presaleEventBcs[kind] as BcsType<unknown, unknown>)
      .serialize(payload)
      .toBytes(),
  ).toString("hex");
}

test("maps PresaleCreated to blast_presale and the rest to events", () => {
  assert.equal(presaleEventModules.PresaleCreated, "blast_presale");
  assert.deepEqual(
    Object.entries(presaleEventModules)
      .filter(([, module]) => module === "events")
      .map(([kind]) => kind),
    [
      "PresaleOpened",
      "ProtocolFeesChanged",
      "Committed",
      "PresaleFunded",
      "PresaleCancelled",
      "PresaleMigrated",
      "RaiseAllocated",
      "RecipientAllocated",
      "Claimed",
    ],
  );
});

test("decodes the Move-printed PresaleCreated", () => {
  const created = decode("PresaleCreated", fixture.presaleCreated);
  assert.equal(created.kind, "PresaleCreated");
  assert.equal(created.saleTokenType, saleToken);
  assert.equal(created.quoteType, quote);
  if (created.kind !== "PresaleCreated") return;
  const { payload } = created;
  assert.equal(payload.presale_id, PRESALE);
  assert.deepEqual(
    [
      payload.token_supply,
      payload.token_allocation_bps,
      payload.liquidity_token_allocation_bps,
      payload.raise_target,
      payload.duration_ms,
      payload.liquidity_window_ms,
    ],
    [20_001n, 5_000n, 1_000n, 1_000n, 100n, 604_800_000n],
  );
  assert.equal(payload.participant_vesting, null);
  assert.deepEqual(payload.recipients, [
    { destination: normalizeSuiAddress("0xa110c"), vestingTerms: null },
    { destination: normalizeSuiAddress("0xb110c"), vestingTerms: null },
  ]);
  assert.deepEqual(payload.recipient_bps, [2_500n, 1_000n]);
  assert.equal(payload.burnable, false);
  assert.deepEqual(payload.raise_recipients, [
    { destination: normalizeSuiAddress("0x5a1e"), vestingTerms: null },
  ]);
  assert.deepEqual(payload.raise_recipient_bps, [2_000n]);
  assert.deepEqual(payload.eligibility, {
    kind: "open",
    walletCap: 5_000n,
    maxParticipants: 2n,
    minCommitment: 500n,
  });
  assert.equal(payload.uncapped, null);
  assert.equal(payload.hard_cap, null);
  assert.equal(payload.venue, VENUE);
  assert.equal(payload.fee_split.routes.length, 3);
  assert.deepEqual(
    [
      payload.protocol_raise_bps,
      payload.protocol_token_bps,
      payload.protocol_lp_fee_meme_bps,
      payload.protocol_lp_fee_quote_bps,
      payload.protocol_quote,
      payload.protocol_tokens,
    ],
    [333n, 500n, 0n, 0n, 33n, 1_000n],
  );
});

test("decodes every Move-printed events-module struct", () => {
  const payload = (kind: PresaleEventKind, hex: string) =>
    decode(kind, hex).payload as Record<string, unknown>;
  assert.deepEqual(payload("PresaleOpened", fixture.presaleOpened), {
    presale_id: PRESALE,
    start_ms: 1_000n,
    end_ms: 1_100n,
    liquidity_deadline_ms: 604_801_100n,
    uncapped_from_ms: 1_100n,
    hard_cap_from_ms: null,
    partner_id: PARTNER,
  });
  assert.deepEqual(payload("Committed", fixture.committed), {
    presale_id: PRESALE,
    quote: 1_000n,
    wallet_commitment: 1_000n,
    total_commitments: 1_000n,
    participants: 1n,
  });
  assert.deepEqual(payload("PresaleFunded", fixture.presaleFunded), {
    presale_id: PRESALE,
    total_commitments: 4_000n,
    accepted_quote: 1_000n,
    refundable_quote: 3_000n,
    token_allocation: 10_001n,
    end_ms: 1_100n,
    liquidity_deadline_ms: 604_801_100n,
  });
  assert.deepEqual(payload("RaiseAllocated", fixture.raiseAllocated), {
    presale_id: PRESALE,
    recipient: normalizeSuiAddress("0x5a1e"),
    quote: 200n,
    vesting_id: null,
  });
  assert.deepEqual(
    fixture.recipientAllocated.map((hex) => payload("RecipientAllocated", hex)),
    [
      {
        presale_id: PRESALE,
        recipient: normalizeSuiAddress("0xa110c"),
        tokens: 5_000n,
        vesting_id: null,
      },
      {
        presale_id: PRESALE,
        recipient: normalizeSuiAddress("0xb110c"),
        tokens: 2_000n,
        vesting_id: null,
      },
    ],
  );
  assert.deepEqual(payload("PresaleMigrated", fixture.presaleMigrated), {
    presale_id: PRESALE,
    venue: VENUE,
    liquidity_quote: 767n,
    liquidity_tokens: 2_000n,
    recipient_tokens: 7_000n,
  });
  assert.deepEqual(payload("Claimed", fixture.claimed), {
    presale_id: PRESALE,
    participant: ALICE,
    wallet_commitment: 1_000n,
    tokens: 2_500n,
    quote_refund: 750n,
    remaining_participants: 1n,
    vesting_id: null,
  });
  assert.deepEqual(
    payload("ProtocolFeesChanged", fixture.protocolFeesChanged),
    {
      presale_id: PRESALE,
      protocol_raise_bps: 500n,
      protocol_token_bps: 250n,
      protocol_lp_fee_meme_bps: 100n,
      protocol_lp_fee_quote_bps: 200n,
      protocol_quote: 50n,
      protocol_tokens: 500n,
      token_allocation: 10_501n,
    },
  );
  assert.deepEqual(payload("PresaleCancelled", fixture.presaleCancelled), {
    presale_id: PRESALE,
    total_commitments: 500n,
    refundable_quote: 500n,
  });
});

test("rejects a look-alike module, package or arity", () => {
  const bytes = fromHex(fixture.committed);
  const reject = (eventType: string) =>
    assert.throws(
      () =>
        decodePresaleEvent(entry(eventType, bytes), { originalPackageId: pkg }),
      /unexpected presale event type/,
    );
  reject(`${pkg}::blast_presale::Committed<${saleToken}, ${quote}>`);
  reject(`0x5e::events::Committed<${saleToken}, ${quote}>`);
  reject(`${pkg}::events::Committed<${saleToken}>`);
  reject(`${pkg}::events::QuoteAllowed<${saleToken}, ${quote}>`);
});

test("decodes QuoteAllowed with its Quote from the event type", () => {
  const decoded = decodePresalePolicyEvent(
    entry(
      `${pkg}::events::QuoteAllowed<${quote}>`,
      quoteAllowedBcs.serialize({ allowed: true }).toBytes(),
    ),
    { originalPackageId: pkg },
  );
  assert.equal(decoded.quoteType, quote);
  assert.deepEqual(decoded.payload, { allowed: true });
  assert.throws(
    () =>
      decodePresalePolicyEvent(
        entry(
          `${pkg}::creation_policy::QuoteAllowed<${quote}>`,
          new Uint8Array([1]),
        ),
        { originalPackageId: pkg },
      ),
    /unexpected presale policy event/,
  );
});

function decodeDelayed(
  kind: DelayedEventKind,
  name: keyof typeof presaleDelayedKeys,
  payload: Record<string, unknown>,
): DecodedPresaleDelayedEvent {
  const spec = presaleDelayedKeys[name];
  const valueType = spec.valueType.replaceAll("{package}", pkg);
  return decodePresaleDelayedEvent(
    entry(
      `${ADMIN}::${delayedEventModule(kind)}::${kind}<${pkg}::${spec.key}, ${valueType}>`,
      (delayedEventBcs(kind, spec) as unknown as BcsType<unknown, unknown>)
        .serialize(payload)
        .toBytes(),
    ),
    { originalPackageId: pkg, adminPackageId: ADMIN },
  );
}

test("projects the fee policy and venue allowlist from delayed events", () => {
  const owner = normalizeSuiAddress("0xf0");
  const fees = {
    raiseBps: 200n,
    tokenBps: 100n,
    lpFeeMemeBps: 1_500n,
    lpFeeQuoteBps: 1_500n,
  };
  const venue = normalizeStructTag("0x9::cetus::Venue");
  let state = createPresaleEventProjection();
  for (const event of [
    decodeDelayed("DelayedCreated", "Fees", {
      owner,
      key: null,
      value: fees,
      delay_ms: 0n,
    }),
    decodeDelayed("SetCreated", "Venues", { owner, key: null, delay_ms: 0n }),
    decodeDelayed("SetScheduled", "Venues", {
      owner,
      key: null,
      change: { kind: "Admission", member: venue },
      delay_ms: 0n,
      ready_at_ms: 5n,
    }),
  ]) {
    state = reducePresaleEvent(state, event);
  }
  assert.deepEqual(state.policy.fees, fees);
  assert.deepEqual(Object.keys(state.policy.pendingPolicies), [
    `Venues:${venue}`,
  ]);
  state = reducePresaleEvent(
    state,
    decodeDelayed("SetApplied", "Venues", {
      owner,
      key: null,
      change: { kind: "Admission", member: venue },
      delay_ms: 0n,
    }),
  );
  assert.deepEqual(state.policy.venues, { [venue]: true });
  assert.deepEqual(state.policy.pendingPolicies, {});
  state = reducePresaleEvent(
    state,
    decodeDelayed("MemberRemoved", "Venues", {
      owner,
      key: null,
      member: venue,
    }),
  );
  assert.deepEqual(state.policy.venues, {});
});

test("replays the Move-printed partnered sale to its decoded object", () => {
  const bobCommitted = encode("Committed", {
    presale_id: PRESALE,
    quote: 3_000n,
    wallet_commitment: 3_000n,
    total_commitments: 4_000n,
    participants: 2n,
  });
  const object = (hex: string) =>
    decodePresaleObject(
      {
        objectId: PRESALE,
        initialSharedVersion: 1,
        type: `${pkg}::blast_presale::Presale<${saleToken}, ${quote}>`,
        content: fromHex(hex),
      },
      pkg,
    );
  const custody = (state: ReturnType<typeof createPresaleEventProjection>) => {
    const presale = state.presales[PRESALE];
    assert.ok(presale);
    return {
      lifecycle: presale.lifecycle,
      quote: presale.quote,
      saleTokens: presale.saleTokens,
      liquidityTokens: presale.liquidityTokens,
      recipientTokens: presale.recipientTokens,
      protocolTokens: presale.protocolTokens,
      totalCommitments: presale.totalCommitments,
      participants: presale.participants,
      feeLedger: [presale.feeLedgerMeme, presale.feeLedgerQuote],
    };
  };
  const expected = (hex: string) => {
    const presale = object(hex);
    return {
      lifecycle: presale.lifecycle,
      quote: presale.quote,
      saleTokens: presale.saleTokens,
      liquidityTokens: presale.liquidityTokens,
      recipientTokens: presale.recipientTokens,
      protocolTokens: presale.protocolTokens,
      totalCommitments: presale.totalCommitments,
      participants: presale.participants,
      feeLedger: [presale.feeLedger.meme, presale.feeLedger.quote],
    };
  };

  let state = createPresaleEventProjection();
  for (const [kind, hex] of [
    ["PresaleCreated", fixture.presaleCreated],
    ["PresaleOpened", fixture.presaleOpened],
  ] as const) {
    state = reducePresaleEvent(state, decode(kind, hex));
  }
  assert.deepEqual(custody(state), expected(fixture.presaleOpenObject));
  const created = state.presales[PRESALE];
  const open = object(fixture.presaleOpenObject);
  assert.deepEqual(created?.recipientPayouts, open.recipientPayouts);
  assert.deepEqual(created?.raisePayouts, open.raisePayouts);
  assert.deepEqual(created?.feeSplit, open.feeSplit);
  assert.equal(created?.venue, open.venue);
  assert.equal(created?.partnerId, PARTNER);

  state = reducePresaleEvent(
    state,
    decode("Committed", fixture.committed, ALICE),
  );
  state = reducePresaleEvent(state, decode("Committed", bobCommitted, BOB));
  state = reducePresaleEvent(
    state,
    decode("PresaleFunded", fixture.presaleFunded),
  );
  assert.deepEqual(custody(state), expected(fixture.presaleFundedObject));

  state = reducePresaleEvent(
    state,
    decode("RaiseAllocated", fixture.raiseAllocated),
  );
  for (const hex of fixture.recipientAllocated) {
    state = reducePresaleEvent(state, decode("RecipientAllocated", hex));
  }
  state = reducePresaleEvent(
    state,
    decode("PresaleMigrated", fixture.presaleMigrated),
  );
  assert.deepEqual(custody(state), expected(fixture.presaleMigratedObject));

  // The partner payout is core's `ProtocolFeesPaid`, keyed by the presale as its origin.
  const paid = decodeProtocolFeesPaid(
    entry(
      `${pkg}::blast_core_events::ProtocolFeesPaid<${saleToken}, ${quote}>`,
      fromHex(fixture.protocolFeesPaid),
    ),
    { originalPackageId: pkg },
  );
  assert.equal(paid.payload.origin, PRESALE);
  assert.deepEqual(
    [
      paid.payload.meme_amount,
      paid.payload.quote_amount,
      paid.payload.partner_meme_amount,
      paid.payload.partner_quote_amount,
    ],
    [600n, 20n, 400n, 13n],
  );
  state = reducePresaleEvent(state, paid);
  assert.deepEqual(
    [
      state.presales[PRESALE]?.feeLedgerMeme,
      state.presales[PRESALE]?.feeLedgerQuote,
    ],
    [0n, 0n],
  );
  assert.equal(state.presales[PRESALE]?.protocolFeesPaid?.partner_id, PARTNER);

  state = reducePresaleEvent(state, decode("Claimed", fixture.claimed));
  const claimed = state.presales[PRESALE];
  assert.deepEqual(
    [claimed?.participants, claimed?.saleTokens, claimed?.quote],
    [1n, 7_501n, 2_250n],
  );
  assert.deepEqual(claimed?.commitments, { [BOB]: 3_000n });

  // Replaying an applied event changes nothing.
  const again = reducePresaleEvent(state, paid);
  assert.equal(again, state);
});

test("decodes the vendor's Move-printed PoolCreationReserved", () => {
  const vendorType = (name: string) =>
    normalizeStructTag(`0x0::blast_aftermath_dao_presale_tests::${name}`);
  const decoded = decodeAftermathDaoPresaleEvent(
    entry(
      `0x0::blast_aftermath_dao_presale::PoolCreationReserved<${vendorType("LP")}, ${vendorType("SALE")}, ${vendorType("QUOTE")}>`,
      fromHex(fixture.poolCreationReserved),
    ),
    { originalPackageId: "0x0" },
  );
  assert.equal(decoded.kind, "PoolCreationReserved");
  assert.equal(decoded.lpType, vendorType("LP"));
  assert.equal(decoded.saleTokenType, vendorType("SALE"));
  assert.equal(decoded.quoteType, vendorType("QUOTE"));
  assert.deepEqual(decoded.payload, {
    pool_creation_id: `0x${fixture.poolCreationId}`,
    package_witness: normalizeStructTag("0x77eb::migration::TestIssuer"),
  });
});
