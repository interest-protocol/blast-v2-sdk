import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import {
  createPresaleCreatorClient,
  decodePresaleCreatorEvents,
  presaleBcs,
  presaleEventBcs,
  presaleVaultBcs,
} from "../src/presale/index.ts";

const id = (byte: string) => `0x${byte.repeat(32)}`;
const SALE = id("11"),
  VAULT = id("22"),
  CAP = id("33"),
  POOL = id("44"),
  OWNER = id("55"),
  OTHER = id("66"),
  PARTNER = id("77");
const MEME = `${id("88")}::meme::MEME`,
  QUOTE = "0x2::sui::SUI";
const shared = (objectId: string) => ({ objectId, initialSharedVersion: "7" });
const identity = {
  presale: {
    packageId: id("a1"),
    originalPackageId: id("a1"),
    packageVersion: { ...shared(id("a5")), mutable: false as const },
    venueConfig: { ...shared(id("a2")), mutable: false as const },
    feePolicy: { ...shared(id("a3")), mutable: false as const },
    creationPolicy: { ...shared(id("a4")), mutable: false as const },
    admin: { packageId: id("a5"), acl: shared(id("a6")) },
  },
  venues: {
    cetus: { globalConfig: shared(id("a7")), burnManager: shared(id("a8")) },
    bluefin: { globalConfig: shared(id("a9")) },
  },
};
const original = identity.presale.originalPackageId;
const fees = {
  raiseBps: 0n,
  tokenBps: 0n,
  lpFeeMemeBps: 100n,
  lpFeeQuoteBps: 100n,
};
const capBcs = bcs.struct("PresaleCap", {
  id: bcs.Address,
  presaleId: bcs.Address,
});

function fixture(
  options: {
    venue?: "cetus" | "bluefin";
    lifecycle?: "Migrated" | "Funded";
    capOwner?: string;
    recipient?: string;
    partner?: boolean;
  } = {},
) {
  const venue = options.venue ?? "cetus";
  const shared = { $kind: "Shared", Shared: { initialSharedVersion: "7" } };
  const objects = new Map<
    string,
    { type: string; content: Uint8Array; owner: unknown }
  >();
  const put = (
    objectId: string,
    type: string,
    content = new Uint8Array(),
    owner: unknown = shared,
  ) => objects.set(objectId, { type, content, owner });
  put(
    SALE,
    `${original}::blast_presale::Presale<${MEME}, ${QUOTE}>`,
    presaleBcs
      .serialize({
        id: { id: { bytes: SALE } },
        presale_cap_id: { bytes: CAP },
        lifecycle: options.lifecycle ?? "Migrated",
        duration_ms: 86_400_000n,
        liquidity_window_ms: 3_600_000n,
        start_ms: 1n,
        raise_target: 1_000_000n,
        eligibility: {
          kind: "open",
          walletCap: 0n,
          maxParticipants: 0n,
          minCommitment: 1n,
        },
        uncapped: null,
        hard_cap: null,
        migration_witness: `${original.slice(2)}::${venue}::Witness`,
        fee_split: { fee_recipients: [], holder_rewards_bps: 0n },
        total_commitments: 0n,
        participants: 0n,
        quote: { value: 0n },
        token_allocation: 1_000_000n,
        participant_vesting: null,
        sale_tokens: { value: 0n },
        liquidity_tokens: { value: 0n },
        recipient_payouts: [],
        recipient_tokens: { value: 0n },
        raise_payouts: [],
        protocol_fees: fees,
        protocol_quote: 0n,
        protocol_tokens: { value: 0n },
        partner_id: null,
        unpaid_protocol_quote: null,
      })
      .toBytes(),
  );
  put(
    VAULT,
    `${original}::presale_vault::Vault<${MEME}, ${QUOTE}>`,
    presaleVaultBcs
      .serialize({
        id: { id: { bytes: VAULT } },
        presale_id: { bytes: SALE },
        presale_cap_id: { bytes: CAP },
        pool_id: { bytes: POOL },
        fee_split: {
          fee_recipients: [
            { recipient: options.recipient ?? OWNER, bps: 5000n },
          ],
          holder_rewards_bps: 5000n,
        },
        protocol_fees: fees,
        partner_id: options.partner ? PARTNER : null,
        unpaid_protocol_meme: { value: 0n },
        unpaid_protocol_quote: { value: 0n },
        migration_meme_residual: { value: 20n },
        migration_quote_residual: { value: 10n },
        holder_rewards_meme: { value: 0n },
        holder_rewards_quote: { value: 0n },
        next_round: 0n,
        last_checkpoint: null,
      })
      .toBytes(),
  );
  put(POOL, "0x2::pool::Pool");
  put(PARTNER, `${original}::partners::Partner`);
  put(
    CAP,
    `${original}::blast_presale::PresaleCap`,
    capBcs.serialize({ id: CAP, presaleId: SALE }).toBytes(),
    { $kind: "AddressOwner", AddressOwner: options.capOwner ?? OWNER },
  );
  const core = {
    async getObjects({ objectIds }: { objectIds: string[] }) {
      return {
        objects: objectIds.map((objectId) => {
          const object = objects.get(objectId);
          return object
            ? {
                ...object,
                objectId,
                version: "9",
                digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
              }
            : new Error("missing");
        }),
      };
    },
    async getObject({ objectId }: { objectId: string }) {
      return {
        object: (await this.getObjects({ objectIds: [objectId] })).objects[0],
      };
    },
    async listOwnedObjects() {
      return {
        objects: [
          {
            objectId: CAP,
            content: capBcs.serialize({ id: CAP, presaleId: SALE }).toBytes(),
          },
        ],
        hasNextPage: false,
        cursor: null,
      };
    },
  };
  return {
    chain: createPresaleCreatorClient(
      { core } as unknown as ClientWithCoreApi,
      identity,
    ),
    objects,
  };
}

test("fee collection uses each venue's SDK call and includes the partner payout", async () => {
  for (const venue of ["cetus", "bluefin"] as const) {
    const { chain } = fixture({ venue, partner: true });
    const action = await chain.transaction(VAULT, OWNER, "collect_fees");
    assert.ok(action);
    const kind = bcs.TransactionKind.parse(action.kindBytes);
    assert.equal(
      kind.ProgrammableTransaction?.commands[0]?.MoveCall?.function,
      "collect_fees",
    );
    assert.equal(
      kind.ProgrammableTransaction?.commands[0]?.MoveCall?.module,
      venue,
    );
    assert.equal(
      kind.ProgrammableTransaction?.commands.length,
      2,
      "SDK partner payout follows collection",
    );
  }
});

test("creator authority comes from the live fee split and cap ownership", async () => {
  assert.equal(
    await fixture({ recipient: OTHER }).chain.transaction(
      VAULT,
      OWNER,
      "collect_fees",
    ),
    null,
  );
  assert.equal(
    await fixture({ capOwner: OTHER }).chain.transaction(
      VAULT,
      OWNER,
      "claim_residuals",
    ),
    null,
  );
  assert.equal(
    await fixture({ lifecycle: "Funded" }).chain.transaction(
      VAULT,
      OWNER,
      "collect_fees",
    ),
    null,
  );
  const { chain } = fixture();
  assert.deepEqual(await chain.ownedPresales(OWNER), [SALE]);
  const action = await chain.transaction(VAULT, OWNER, "claim_residuals");
  assert.ok(action);
  const kind = bcs.TransactionKind.parse(action.kindBytes);
  assert.equal(
    kind.ProgrammableTransaction?.commands[0]?.MoveCall?.function,
    "claim_migration_residuals",
  );
  const ptb = kind.ProgrammableTransaction;
  assert.ok(ptb);
  const transfer = ptb.commands.at(-1)?.TransferObjects;
  assert.ok(transfer);
  assert.equal(transfer.objects.length, 2);
  const input = transfer.address.Input;
  assert.notEqual(input, undefined);
  const addressInput = ptb.inputs[input ?? -1]?.Pure;
  assert.ok(addressInput);
  assert.equal(
    bcs.Address.parse(Buffer.from(addressInput.bytes, "base64")),
    OWNER,
  );
});

test("only a successful simulation with no emitted events proves an empty preview", async () => {
  const kind = await new Transaction().build({ onlyTransactionKind: true });
  const feeEvent = {
    eventType: `${original}::presale_vault::FeesCollected<${MEME}, ${QUOTE}>`,
    bcs: presaleEventBcs.FeesCollected.serialize({
      vault_id: VAULT,
      gross_meme: 100n,
      gross_quote: 200n,
      protocol_destination: OWNER,
      protocol_meme: 1n,
      protocol_quote: 2n,
      fee_recipient_meme: [49n],
      fee_recipient_quote: [99n],
      holder_rewards_meme: 50n,
      holder_rewards_quote: 99n,
    }).toBytes(),
  };
  const cases = [
    { success: true, eventsDigest: null, events: [], expected: [] },
    { success: false, eventsDigest: null, events: [], expected: null },
    { success: true, eventsDigest: "event-digest", events: [], expected: null },
    { success: true, eventsDigest: null, events: undefined, expected: null },
    {
      success: true,
      eventsDigest: "event-digest",
      events: [
        {
          eventType: `${original}::presale_vault::FeesCollected`,
          bcs: new Uint8Array([0]),
        },
      ],
      expected: null,
    },
    {
      success: true,
      eventsDigest: "event-digest",
      events: [
        { ...feeEvent, eventType: feeEvent.eventType.replace(original, OTHER) },
      ],
      expected: null,
    },
    {
      success: true,
      eventsDigest: "event-digest",
      events: [feeEvent],
      expected: [
        {
          kind: "collect_fees",
          vaultId: VAULT,
          meme: "100",
          quote: "200",
          recipientsMeme: ["49"],
          recipientsQuote: ["99"],
        },
      ],
    },
  ];
  for (const scenario of cases) {
    const client = {
      core: {
        async simulateTransaction() {
          const execution = {
            effects: {
              status: { success: scenario.success },
              eventsDigest: scenario.eventsDigest,
            },
            events: scenario.events,
          };
          return scenario.success
            ? { $kind: "Transaction", Transaction: execution }
            : { $kind: "FailedTransaction", FailedTransaction: execution };
        },
      },
    } as unknown as ClientWithCoreApi;
    assert.deepEqual(
      await createPresaleCreatorClient(client, identity).preview(kind, OWNER),
      scenario.expected,
    );
  }
});

test("creator event decoding ignores look-alike packages, modules and malformed BCS", () => {
  const event = {
    eventType: `${original}::presale_vault::MigrationResidualsClaimed`,
    bcs: presaleEventBcs.MigrationResidualsClaimed.serialize({
      vault_id: VAULT,
      meme: 20n,
      quote: 10n,
    }).toBytes(),
  };
  const decoded = decodePresaleCreatorEvents(
    [
      event,
      { ...event, eventType: event.eventType.replace(original, OTHER) },
      {
        ...event,
        eventType: event.eventType.replace("presale_vault", "blast_presale"),
      },
      { ...event, bcs: new Uint8Array([0]) },
    ],
    original,
  );
  assert.deepEqual(decoded, [
    {
      kind: "claim_residuals",
      vaultId: VAULT,
      meme: "20",
      quote: "10",
      recipientsMeme: [],
      recipientsQuote: [],
    },
  ]);
});

test("missing shared objects and mismatched sale identities do not prepare collection", async () => {
  for (const missing of [POOL, PARTNER]) {
    const { chain, objects } = fixture({ partner: true });
    objects.delete(missing);
    assert.equal(await chain.transaction(VAULT, OWNER, "collect_fees"), null);
  }
  const { chain, objects } = fixture();
  const sale = objects.get(SALE);
  assert.ok(sale);
  sale.content = presaleBcs
    .serialize({
      ...presaleBcs.parse(sale.content),
      presale_cap_id: { bytes: OTHER },
    })
    .toBytes();
  assert.equal(await chain.transaction(VAULT, OWNER, "collect_fees"), null);
});

test("an empty residual balance cannot prepare a claim", async () => {
  const { chain, objects } = fixture();
  const vault = objects.get(VAULT);
  assert.ok(vault);
  vault.content = presaleVaultBcs
    .serialize({
      ...presaleVaultBcs.parse(vault.content),
      migration_meme_residual: { value: 0n },
      migration_quote_residual: { value: 0n },
    })
    .toBytes();
  assert.equal(await chain.transaction(VAULT, OWNER, "claim_residuals"), null);
});

test("owned caps are paginated with the pinned type, bounded to 200, and forward cancellation", async () => {
  const controller = new AbortController();
  let pages = 0;
  const client = {
    core: {
      async listOwnedObjects(options: {
        owner: string;
        type: string;
        cursor: string | null;
        signal: AbortSignal;
        limit: number;
      }) {
        assert.equal(options.owner, OWNER);
        assert.equal(options.type, `${original}::blast_presale::PresaleCap`);
        assert.equal(options.cursor, pages === 0 ? null : String(pages));
        assert.equal(options.limit, 50);
        assert.equal(options.signal, controller.signal);
        pages += 1;
        return {
          objects: Array.from({ length: 50 }, () => ({
            content: capBcs.serialize({ id: CAP, presaleId: SALE }).toBytes(),
          })),
          hasNextPage: true,
          cursor: String(pages),
        };
      },
    },
  } as unknown as ClientWithCoreApi;
  const ids = await createPresaleCreatorClient(client, identity).ownedPresales(
    OWNER,
    controller.signal,
  );
  assert.equal(ids.length, 200);
  assert.equal(pages, 4);
});

test("RPC simulation failures reject instead of inventing an empty balance", async () => {
  const client = {
    core: {
      async simulateTransaction() {
        throw new Error("RPC unavailable");
      },
    },
  } as unknown as ClientWithCoreApi;
  const kind = await new Transaction().build({ onlyTransactionKind: true });
  await assert.rejects(
    createPresaleCreatorClient(client, identity).preview(kind, OWNER),
    /RPC unavailable/,
  );
});
