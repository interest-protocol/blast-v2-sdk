import assert from "node:assert/strict";
import test from "node:test";

import type { SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type {
  PartnerEventKind,
  PartnerEventPayloads,
} from "../src/partners/events.ts";
import { decodePartnerEvent, partnerEventBcs } from "../src/partners/events.ts";
import {
  createPartnersEventProjection,
  reducePartnerEvent,
} from "../src/partners/reducer.ts";
import {
  decodePartnerObject,
  PARTNER_DELAY_MS,
  partnerBcs,
  partnerPayment,
} from "../src/partners/state.ts";
import {
  PartnersCalls,
  PartnersTransactions,
} from "../src/partners/transactions.ts";
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
const SUI = normalizeStructTag("0x2::sui::SUI");
const terms = (share: bigint, cap: string) => ({
  recipient: id("0xfee"),
  share_bps: {
    before: share,
    after: share,
    atMs: 0n,
    delayMs: PARTNER_DELAY_MS,
  },
  cap_id: {
    before: id(cap),
    after: id(cap),
    atMs: 0n,
    delayMs: PARTNER_DELAY_MS,
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

  assert.deepEqual(
    assertBuildersMatchAbi(tx, abi, PARTNERS).sort(),
    abi.blast_partners?.functions
      .filter((candidate) => candidate.sdk === "builder")
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
    "clock",
  ]);
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
  assert.equal(state.capId.after, id("0xca"));

  // `a_partner_is_paid_its_share_from_registration_and_a_new_one_only_once_in_force`.
  const start = 1_000n;
  const scheduled = {
    shareBps: {
      before: 5_000n,
      after: 8_000n,
      atMs: start + PARTNER_DELAY_MS,
      delayMs: PARTNER_DELAY_MS,
    },
  };
  assert.equal(partnerPayment(state, 1_000n, start), 500n);
  assert.equal(
    partnerPayment(scheduled, 500n, start + PARTNER_DELAY_MS - 1n),
    250n,
  );
  assert.equal(partnerPayment(scheduled, 250n, start + PARTNER_DELAY_MS), 200n);
  // `payment_matches_the_rounded_down_reference`.
  for (const share of [0n, 1n, 3_333n, 5_000n, 7_999n, 8_000n]) {
    for (let amount = 0n; amount <= 200n; amount++) {
      const fixed = {
        shareBps: { before: share, after: share, atMs: 0n, delayMs: 1n },
      };
      assert.equal(
        partnerPayment(fixed, amount, 0n),
        (amount * share) / 10_000n,
      );
    }
  }
  const max = (1n << 64n) - 1n;
  const top = {
    shareBps: { before: 8_000n, after: 8_000n, atMs: 0n, delayMs: 1n },
  };
  assert.equal(partnerPayment(top, max, 0n), (max * 8_000n) / 10_000n);
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

test("Partner and its events follow the frozen Move field order", () => {
  const frozen = abi.blast_partners;
  assert.ok(frozen);
  const fields = (
    name: string,
    list: { name: string; fields: { name: string }[] }[],
  ) =>
    list
      .find((candidate) => candidate.name === name)
      ?.fields.map((field) => field.name);
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
    fields("Partner", frozen.structs),
  );
  for (const kind of Object.keys(partnerEventBcs) as PartnerEventKind[]) {
    assert.deepEqual(
      Object.keys(SAMPLES[kind]),
      fields(kind, frozen.events),
      kind,
    );
  }
});

test("replays partner terms and payouts from events", () => {
  const events = [
    event("PartnerUpdated", {
      partner_id: id("0xb1"),
      ...terms(2_500n, "0xca"),
    }),
    event("PartnerPaid", { partner_id: id("0xb1"), amount: 7n }, SUI),
    event("PartnerPaid", { partner_id: id("0xb1"), amount: 3n }, SUI),
    event("PartnerUpdated", {
      partner_id: id("0xb1"),
      ...terms(1_000n, "0xcb"),
    }),
    event("PartnerPaid", { partner_id: id("0xb9"), amount: 1n }, SUI),
  ];
  const state = [...events, ...events].reduce(
    reducePartnerEvent,
    createPartnersEventProjection(),
  );
  assert.deepEqual(Object.keys(state.partners), [id("0xb1")]);
  const replayed = state.partners[id("0xb1")];
  assert.ok(replayed);
  assert.equal(replayed.shareBps.after, 1_000n);
  assert.equal(replayed.capId.after, id("0xcb"));
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
  PartnerUpdated: { partner_id: id("0xb1"), ...terms(1n, "0xca") },
  PartnerPaid: { partner_id: id("0xb1"), amount: 1n },
};

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
    eventType: `${PARTNERS}::blast_partners::${kind}${coinType ? `<${coinType}>` : ""}`,
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
