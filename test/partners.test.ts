import assert from "node:assert/strict";
import test from "node:test";
import {
  delayedEventBcs,
  delayedEventModule,
} from "@interest-protocol/blast-admin-sdk/events";
import type {
  PartnerEventKind,
  PartnerEventPayloads,
} from "@interest-protocol/blast-partners-sdk/events";
import {
  decodePartnerDelayedEvent,
  decodePartnerEvent,
  partnerDelayedKeys,
  partnerEventBcs,
} from "@interest-protocol/blast-partners-sdk/events";
import {
  createPartnersEventProjection,
  reducePartnerEvent,
} from "@interest-protocol/blast-partners-sdk/reducer";
import {
  decodePartnerObject,
  PARTNER_DELAY_MS,
  partnerBcs,
  partnerListBcs,
  partnerPayment,
} from "@interest-protocol/blast-partners-sdk/state";
import {
  PartnersCalls,
  PartnersTransactions,
} from "@interest-protocol/blast-partners-sdk/transactions";
import type { SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import {
  assertBuildersMatchAbi,
  moveCallArguments,
  moveCallTypeArguments,
  readAbi,
} from "./abi.ts";

const id = (value: string) => normalizeSuiAddress(value);
const PARTNERS = id("0xa7");
const ADMIN = id("0xad");
const deployment = {
  packageId: PARTNERS,
  admin: {
    packageId: ADMIN,
    acl: { objectId: "0xac", initialSharedVersion: "3" },
  },
};
const partner = {
  objectId: "0xb1",
  initialSharedVersion: "5",
  mutable: true as const,
};
const abi = readAbi("production-partners-v1.json", "partners");
/** `blast_partners` readers and the payout products compose; the rest are builders. */
const NOT_BUILT = new Set([
  "pay",
  "delay_ms",
  "max_share_bps",
  "recipient",
  "share_bps",
  "pending_share_bps",
  "is_share_ready",
  "cap_id",
  "pending_cap_id",
  "is_cap_ready",
]);
const SUI = normalizeStructTag("0x2::sui::SUI");
const terms = (share: bigint, cap: string, owner = id("0xb1")) => ({
  recipient: id("0xfee"),
  share_bps: {
    owner,
    key: null,
    value: share,
    delay_ms: PARTNER_DELAY_MS,
    pending: null,
  },
  cap_id: {
    owner,
    key: null,
    value: id(cap),
    delay_ms: PARTNER_DELAY_MS,
    pending: null,
  },
});

test("builds every blast_partners call against the frozen ABI", () => {
  const calls = new PartnersCalls(deployment);
  const tx = new Transaction();
  const adminWitness = tx.add(calls.signIn({ adminCap: "0xc1" }));
  tx.add(calls.newCap());
  tx.add(
    calls.register({
      adminWitness,
      capId: "0xca",
      recipient: "0xfee",
      shareBps: 2_500n,
    }),
  );
  tx.add(calls.scheduleShare({ partner, adminWitness, shareBps: 1_000n }));
  tx.add(calls.scheduleCap({ partner, adminWitness, capId: "0xcb" }));
  tx.add(
    calls.setRecipient({ partner, partnerCap: "0xca", recipient: "0xb0b" }),
  );
  tx.add(calls.destroyCap({ partnerCap: "0xcc" }));
  tx.add(calls.applyShare({ partner }));
  tx.add(calls.applyCap({ partner }));
  tx.add(calls.cancelShare({ partner, adminWitness }));
  tx.add(calls.cancelCap({ partner, adminWitness }));

  // `pay` composes into product payouts and `delay_ms` is a read.
  assert.deepEqual(
    assertBuildersMatchAbi(tx, abi, PARTNERS).sort(),
    abi.blast_partners?.functions
      .filter((candidate) => !NOT_BUILT.has(candidate.name))
      .map((candidate) => `blast_partners::${candidate.name}`)
      .sort(),
  );
  assert.deepEqual(moveCallTypeArguments(tx)[0], [
    `${PARTNERS}::blast_partners::PartnerAdmin`,
  ]);
  assert.deepEqual(moveCallArguments(tx, 2), [
    "result:0",
    "pure",
    "pure",
    "pure",
  ]);
  assert.deepEqual(moveCallArguments(tx, 3), [
    "shared-mut:0xb1",
    "result:0",
    "pure",
    "clock",
  ]);
  assert.deepEqual(moveCallArguments(tx, 5), [
    "shared-mut:0xb1",
    "object:0xca",
    "pure",
  ]);
  assert.deepEqual(moveCallArguments(tx, 7), ["shared-mut:0xb1", "clock"]);
  assert.deepEqual(moveCallArguments(tx, 9), ["shared-mut:0xb1", "result:0"]);
  assert.throws(
    () =>
      calls.register({
        adminWitness,
        capId: "0xca",
        recipient: "0xfee",
        shareBps: 10_001n,
      }),
    /basis points/,
  );
});

test("transactions sign in as PartnerAdmin in the same PTB", () => {
  const txs = new PartnersTransactions(deployment);
  const register = txs.register({
    adminCapId: "0xc1",
    capId: "0xca",
    recipient: "0xfee",
    shareBps: 2_500n,
  });
  assert.deepEqual(assertBuildersMatchAbi(register, abi, PARTNERS), [
    "blast_partners::register",
  ]);
  assert.deepEqual(moveCallArguments(register, 0), [
    "shared:0xac",
    "object:0xc1",
  ]);
  const minted = txs.newCap({ recipient: "0xb0b" }).getData().commands;
  assert.deepEqual(
    minted.map((command) => command.$kind),
    ["MoveCall", "TransferObjects"],
  );
});

test("decodes a partner and previews its payment like blast_partners::pay", () => {
  const state = decodePartnerObject(
    {
      objectId: "0xb1",
      initialSharedVersion: "5",
      type: `${PARTNERS}::blast_partners::Partner`,
      content: partnerBcs
        .serialize({
          id: { id: { bytes: id("0xb1") } },
          ...terms(5_000n, "0xca"),
        })
        .toBytes(),
    },
    PARTNERS,
  );
  assert.equal(state.recipient, id("0xfee"));
  assert.equal(state.capId.value, id("0xca"));

  // A proposal pays nothing until it is applied: `pay` reads the applied share.
  const scheduled = {
    shareBps: {
      ...state.shareBps,
      pending: {
        value: 8_000n,
        delay_ms: PARTNER_DELAY_MS,
        ready_at_ms: PARTNER_DELAY_MS,
      },
    },
  };
  assert.equal(partnerPayment(state, 1_000n), 500n);
  assert.equal(partnerPayment(scheduled, 500n), 250n);
  // `payment_matches_the_rounded_down_reference`.
  const fixed = (share: bigint) => ({
    shareBps: { ...state.shareBps, value: share },
  });
  for (const share of [0n, 1n, 3_333n, 5_000n, 7_999n, 8_000n]) {
    for (let amount = 0n; amount <= 200n; amount++) {
      assert.equal(
        partnerPayment(fixed(share), amount),
        (amount * share) / 10_000n,
      );
    }
  }
  const max = (1n << 64n) - 1n;
  assert.equal(partnerPayment(fixed(8_000n), max), (max * 8_000n) / 10_000n);
  assert.throws(
    () =>
      decodePartnerObject(
        {
          ...state,
          type: `${PARTNERS}::blast_partners::Partner`,
          content: partnerBcs
            .serialize({
              id: { id: { bytes: id("0xb1") } },
              ...terms(5_000n, "0xca", id("0xb2")),
            })
            .toBytes(),
        },
        PARTNERS,
      ),
    /mismatched UID/,
  );
  assert.throws(
    () =>
      decodePartnerObject(
        {
          ...state,
          type: "0x1::blast_partners::Partner",
          content: new Uint8Array(),
        },
        PARTNERS,
      ),
    /not a Blast partner/,
  );
});

test("Partner, PartnerList and their events follow the frozen Move field order", () => {
  const frozen = abi.blast_partners;
  const list = abi.partner_list;
  assert.ok(frozen && list);
  // An event is a struct or an event of its module, as the artifact classifies it.
  const all = [frozen, list].flatMap((module) => [
    ...module.structs,
    ...(module.events ?? []),
  ]);
  const fields = (
    name: string,
    candidates: { name: string; fields: { name: string }[] }[] = all,
  ) =>
    candidates
      .find((candidate) => candidate.name === name)
      ?.fields.map((field) => field.name);
  assert.deepEqual(
    Object.keys(
      partnerListBcs.parse(
        partnerListBcs
          .serialize({
            owner: id("0x3"),
            acceptance_ends_at_ms: { id: id("0x4"), size: 0n },
          })
          .toBytes(),
      ),
    ),
    fields("PartnerList"),
  );
  assert.deepEqual(
    Object.keys(
      partnerBcs.parse(
        partnerBcs
          .serialize({
            id: { id: { bytes: id("0xb1") } },
            ...terms(1n, "0xca"),
          })
          .toBytes(),
      ),
    ),
    fields("Partner"),
  );
  for (const kind of Object.keys(partnerEventBcs) as PartnerEventKind[]) {
    assert.deepEqual(Object.keys(SAMPLES[kind]), fields(kind), kind);
  }
});

test("replays partner terms and payouts from events", () => {
  const ready = 1_000n + PARTNER_DELAY_MS;
  const events = [
    delayed("Share", "DelayedCreated", {
      value: 2_500n,
      delay_ms: PARTNER_DELAY_MS,
    }),
    delayed("Cap", "DelayedCreated", {
      value: id("0xca"),
      delay_ms: PARTNER_DELAY_MS,
    }),
    event("PartnerUpdated", { partner_id: id("0xb1"), recipient: id("0xfee") }),
    event("PartnerPaid", { partner_id: id("0xb1"), amount: 7n }, SUI),
    event("PartnerPaid", { partner_id: id("0xb1"), amount: 3n }, SUI),
    delayed("Share", "DelayedScheduled", {
      value: 1_000n,
      delay_ms: PARTNER_DELAY_MS,
      ready_at_ms: ready,
    }),
    delayed("Cap", "DelayedScheduled", {
      value: id("0xcb"),
      delay_ms: PARTNER_DELAY_MS,
      ready_at_ms: ready,
    }),
    event("PartnerPaid", { partner_id: id("0xb9"), amount: 1n }, SUI),
  ];
  const pending = [...events, ...events].reduce(
    reducePartnerEvent,
    createPartnersEventProjection(),
  );
  // Readiness alone changes nothing.
  assert.equal(pending.partners[id("0xb1")]?.shareBps, 2_500n);
  assert.deepEqual(pending.partners[id("0xb1")]?.pendingShare, {
    value: 1_000n,
    readyAtMs: ready,
  });
  const state = [
    delayed("Share", "DelayedApplied", {
      previous_value: 2_500n,
      value: 1_000n,
      delay_ms: PARTNER_DELAY_MS,
    }),
    delayed("Cap", "DelayedCancelled", {
      value: id("0xcb"),
      delay_ms: PARTNER_DELAY_MS,
      ready_at_ms: ready,
    }),
  ].reduce(reducePartnerEvent, pending);
  assert.deepEqual(Object.keys(state.partners), [id("0xb1")]);
  const replayed = state.partners[id("0xb1")];
  assert.ok(replayed);
  assert.equal(replayed.recipient, id("0xfee"));
  assert.equal(replayed.shareBps, 1_000n);
  assert.equal(replayed.pendingShare, null);
  assert.equal(replayed.capId, id("0xca"));
  assert.equal(replayed.pendingCap, null);
  assert.deepEqual(replayed.paid, { [SUI]: 10n });
  assert.equal(state.eventCounts.PartnerPaid, 3);
  assert.throws(
    () =>
      decodePartnerEvent(
        { ...entry("PartnerPaid", SAMPLES.PartnerPaid, null) },
        PARTNERS,
      ),
    /unexpected partner event type/,
  );
});

const SAMPLES: { [Kind in PartnerEventKind]: PartnerEventPayloads[Kind] } = {
  PartnerUpdated: { partner_id: id("0xb1"), recipient: id("0xfee") },
  PartnerPaid: { partner_id: id("0xb1"), amount: 1n },
  PartnerAdded: { owner: id("0x3"), partner_id: id("0xb1") },
  PartnerRemoved: {
    owner: id("0x3"),
    partner_id: id("0xb1"),
    acceptance_ends_at_ms: 1n,
  },
  PartnerListDestroyed: { owner: id("0x3") },
};

test("replays each product's partner list from the partner-list events", () => {
  const config = id("0x3");
  const policy = id("0x4");
  const removedAt = 1_000n + PARTNER_DELAY_MS;
  const state = [
    event("PartnerAdded", { owner: config, partner_id: id("0xb1") }),
    event("PartnerAdded", { owner: config, partner_id: id("0xb2") }),
    event("PartnerAdded", { owner: policy, partner_id: id("0xb1") }),
    event("PartnerRemoved", {
      owner: config,
      partner_id: id("0xb2"),
      acceptance_ends_at_ms: removedAt,
    }),
  ].reduce(reducePartnerEvent, createPartnersEventProjection());
  const forever = (1n << 64n) - 1n;
  assert.deepEqual(state.lists, {
    [config]: { [id("0xb1")]: forever, [id("0xb2")]: removedAt },
    [policy]: { [id("0xb1")]: forever },
  });
  // Re-adding a removed partner accepts it again.
  const readded = reducePartnerEvent(
    state,
    event("PartnerAdded", { owner: config, partner_id: id("0xb2") }),
  );
  assert.equal(readded.lists[config]?.[id("0xb2")], forever);
  const destroyed = reducePartnerEvent(
    readded,
    event("PartnerListDestroyed", { owner: policy }),
  );
  assert.deepEqual(Object.keys(destroyed.lists), [config]);
  assert.equal(destroyed.eventCounts.PartnerAdded, 4);
  assert.equal(destroyed.eventCounts.PartnerListDestroyed, 1);
  // Partner-list events live in `partner_list`, not `blast_partners`.
  assert.throws(
    () =>
      decodePartnerEvent(
        {
          ...entry("PartnerAdded", SAMPLES.PartnerAdded, null),
          eventType: `${PARTNERS}::blast_partners::PartnerAdded`,
        },
        PARTNERS,
      ),
    /unexpected partner event type/,
  );
});

let eventIndex = 0;
function entry<Kind extends PartnerEventKind>(
  kind: Kind,
  payload: PartnerEventPayloads[Kind],
  coinType: string | null,
): SuiClientTypes.EventEntry {
  eventIndex += 1;
  return {
    packageId: PARTNERS,
    module: "blast_partners",
    sender: id("0x5e"),
    eventType: `${PARTNERS}::${kind.startsWith("PartnerList") || kind === "PartnerAdded" || kind === "PartnerRemoved" ? "partner_list" : "blast_partners"}::${kind}${coinType ? `<${coinType}>` : ""}`,
    bcs: (partnerEventBcs[kind] as (typeof partnerEventBcs)["PartnerPaid"])
      .serialize(payload as never)
      .toBytes(),
    json: null,
    checkpoint: "9",
    transactionDigest: `tx-${eventIndex}`,
    eventIndex,
  };
}

function event<Kind extends PartnerEventKind>(
  kind: Kind,
  payload: PartnerEventPayloads[Kind],
  coinType: string | null = null,
) {
  const decoded = decodePartnerEvent(entry(kind, payload, coinType), PARTNERS);
  assert.equal(decoded.kind, kind);
  assert.equal(decoded.coinType, coinType);
  assert.deepEqual(decoded.payload, payload);
  return decoded;
}

function delayed(
  name: keyof typeof partnerDelayedKeys,
  kind:
    | "DelayedCreated"
    | "DelayedScheduled"
    | "DelayedCancelled"
    | "DelayedApplied",
  payload: Record<string, unknown>,
) {
  eventIndex += 1;
  const spec = partnerDelayedKeys[name];
  return decodePartnerDelayedEvent(
    {
      packageId: ADMIN,
      module: "delayed",
      sender: id("0x5e"),
      eventType: `${ADMIN}::${delayedEventModule(kind)}::${kind}<${PARTNERS}::${spec.key}, ${spec.valueType}>`,
      bcs: delayedEventBcs(kind, spec)
        .serialize({ owner: id("0xb1"), key: null, ...payload } as never)
        .toBytes(),
      json: null,
      checkpoint: "9",
      transactionDigest: `tx-${eventIndex}`,
      eventIndex,
    },
    { adminPackageId: ADMIN, partnersPackageId: PARTNERS },
  );
}
