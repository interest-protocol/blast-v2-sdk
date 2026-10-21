import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import { definePresaleDeployment } from "../src/deployments/registry.ts";
import type { SharedObjectReference } from "../src/lib/sui.ts";
import type {
  AftermathPresaleEventKind,
  AftermathPresaleEventPayloads,
} from "../src/presale/aftermath.ts";
import {
  AFTERMATH_MAINNET_OBJECTS,
  aftermathPoolCoinTypes,
  aftermathPresaleEventBcs,
  aftermathPresaleEventSpecs,
  aftermathReservationOf,
  aftermathSaleTokenFirst,
  aftermathWitnessType,
  decodeAftermathPoolCreationObject,
  decodeAftermathPresaleEvent,
  defineAftermathPresaleDeployment,
  findAftermathPoolCreation,
} from "../src/presale/aftermath.ts";
import type { AftermathLpCoin } from "../src/presale/aftermath-lp.ts";
import { PresaleClient } from "../src/presale/client.ts";
import { openEligibility } from "../src/presale/math.ts";
import type {
  AftermathPresaleTerms,
  PresaleDeployment,
} from "../src/presale/transactions.ts";
import {
  PresaleCalls,
  PresaleTransactions,
} from "../src/presale/transactions.ts";
import {
  assertBuildersMatchAbi,
  moveCallArguments,
  moveCallTypeArguments,
  orderedEventFields,
  readAbi,
} from "./abi.ts";
import { verifiedLpCoin } from "./aftermath-lp.ts";

const id = (value: string) => normalizeSuiAddress(value);
const VENDOR = id("0xaf7e");
const PRESALE_PKG = "0x5e";
const LP = normalizeStructTag(`${VENDOR}::lp_coin::LP_COIN`);
const memeA = normalizeStructTag("0xa::meme::MEME");
const memeB = normalizeStructTag("0x1::meme::MEME");
const sui = normalizeStructTag("0x2::sui::SUI");
const PRESALE = id("0xab");
const POOL_CREATION = id("0xc4ea");
const CLOCK = "clock";

function shared<const Mutable extends boolean>(
  objectId: string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion: "3", mutable };
}

const aftermath = defineAftermathPresaleDeployment({
  packageId: VENDOR,
  poolRegistry: { objectId: "0xa1", initialSharedVersion: "7" },
  daoFeeVersion: { objectId: "0xa2", initialSharedVersion: "8" },
});
const deployment: PresaleDeployment = {
  packageId: "0x5f",
  originalPackageId: PRESALE_PKG,
  packageVersion: shared("0x64", false),
  venueConfig: shared("0x60", false),
  feePolicy: shared("0x61", false),
  creationPolicy: shared("0x62", false),
  admin: {
    packageId: "0x64",
    acl: { objectId: "0x63", initialSharedVersion: "3" },
  },
  aftermath,
};
const tx = new PresaleTransactions(deployment);
const vendorAbi = readAbi(
  "production-aftermath-dao-presale-v1.json",
  "aftermathDaoPresale",
);
const presaleAbi = readAbi("production-presale-v1.json", "presale");
const presale = shared(PRESALE, true);
const poolCreation = shared(POOL_CREATION, true);
const partner = shared("0x9a27", false);
// The fresh LP coin, verified against a fake chain holding its capability.
const lpCoin = await verifiedLpCoin(LP, "0xcc9");

// === Configuration and venue ===

test("defaults the Aftermath objects to the recorded mainnet ones", () => {
  const defaults = defineAftermathPresaleDeployment({ packageId: VENDOR });
  assert.deepEqual(defaults, {
    packageId: VENDOR,
    ...AFTERMATH_MAINNET_OBJECTS,
  });
  assert.equal(
    AFTERMATH_MAINNET_OBJECTS.poolRegistry.objectId,
    "0xfcc774493db2c45c79f688f88d28023a3e7d98e4ee9f48bbf5c7990f651577ae",
  );
  assert.equal(
    AFTERMATH_MAINNET_OBJECTS.daoFeeVersion.objectId,
    "0xb4bfb0f917f12ad2a772bea9b4f22431f6f5f9653162c3ae6fae5b99b21392b7",
  );
  assert.throws(
    () => defineAftermathPresaleDeployment({ packageId: "0x0" }),
    /zero address/,
  );
  // A registered presale deployment keeps its vendor configuration.
  const registered = definePresaleDeployment(deployment);
  assert.deepEqual(registered.aftermath, aftermath);
});

test("names the Aftermath venue by the vendor's witness", () => {
  const calls = new PresaleCalls(deployment);
  const witness = aftermathWitnessType(VENDOR);
  assert.equal(
    witness,
    normalizeStructTag(`${VENDOR}::blast_aftermath_dao_presale::Witness`),
  );
  assert.equal(calls.migrationWitnessType("aftermath"), witness);
  assert.equal(calls.venueOf(witness), "aftermath");
  assert.equal(calls.venueOf(`${PRESALE_PKG}::bluefin::Witness`), "bluefin");
  assert.equal(calls.venueOf(`${PRESALE_PKG}::cetus::Witness`), "cetus");
  assert.equal(calls.venueOf("0xdead::other::Witness"), null);

  const allow = tx.setMigrationWitnessAllowed({
    adminCapId: "0xadc",
    venue: "aftermath",
    allowed: true,
  });
  assert.deepEqual(moveCallTypeArguments(allow), [
    [normalizeStructTag(`${PRESALE_PKG}::blast_presale_domain::AdapterAdmin`)],
    [witness],
  ]);

  // Without the vendor's configuration, nothing reaches Aftermath.
  const { aftermath: _, ...bare } = deployment;
  const without = new PresaleCalls(bare);
  assert.equal(without.venueOf(witness), null);
  assert.throws(
    () => without.migrationWitnessType("aftermath"),
    /deployment.aftermath/,
  );
  assert.throws(
    () =>
      without.migrateAftermath({
        memeType: memeA,
        quoteType: sui,
        presale,
        poolCreation,
        lpType: LP,
      }),
    /deployment.aftermath/,
  );
});

// === Coin order ===

test("mirrors sorts_before: the byte order of defining-ID type names", () => {
  // The contract's own cases: its test package sits at 0x0, before 0x2.
  const QUOTE = "0x0::blast_aftermath_dao_presale_tests::QUOTE";
  const A = "0x0::blast_aftermath_dao_presale_tests::A";
  const AB = "0x0::blast_aftermath_dao_presale_tests::AB";
  assert.equal(aftermathSaleTokenFirst(QUOTE, sui), true);
  assert.equal(aftermathSaleTokenFirst(sui, QUOTE), false);
  assert.equal(aftermathSaleTokenFirst(A, AB), true);
  assert.equal(aftermathSaleTokenFirst(AB, A), false);
  assert.equal(aftermathSaleTokenFirst(AB, QUOTE), true);
  assert.equal(aftermathSaleTokenFirst(A, A), false);
  // Addresses compare as 64 hex digits, so 0x1 < 0x2 < 0xa.
  assert.equal(aftermathSaleTokenFirst(memeB, sui), true);
  assert.equal(aftermathSaleTokenFirst(memeA, sui), false);
  // A type argument extends its base name, which therefore comes first.
  assert.equal(
    aftermathSaleTokenFirst(
      "0xa::meme::MEME",
      "0xa::meme::MEME<0x2::sui::SUI>",
    ),
    true,
  );
});

test("orders the pool's coins both ways; the migration's type arguments do not change", () => {
  const cases = [
    { memeType: memeB, coins: [memeB, sui] },
    { memeType: memeA, coins: [sui, memeA] },
  ];
  for (const { memeType, coins } of cases) {
    assert.deepEqual(aftermathPoolCoinTypes(memeType, sui), coins);
    // `migrate` takes <Lp, SaleToken, Quote> and orders the coins on chain.
    const ptb = tx.migrateAftermath({
      memeType,
      quoteType: sui,
      presale,
      poolCreation,
      lpType: LP,
    });
    assert.deepEqual(moveCallTypeArguments(ptb), [[LP, memeType, sui]]);
  }
});

// === Builders ===

const terms: AftermathPresaleTerms = {
  memeType: memeA,
  quoteType: sui,
  adminCap: "0xad",
  lpCoin,
  treasuryCap: "0x7c",
  memeCurrency: shared("0xcc", true),
  tokenSupply: 20_001n,
  tokenAllocationBps: 5_000n,
  participantVesting: null,
  liquidityTokenAllocationBps: 1_000n,
  recipientAllocations: [{ recipient: "0xa110c", bps: 4_000n }],
  burnable: false,
  raiseTarget: 1_000n,
  raiseAllocations: [{ recipient: "0x5a1e", bps: 2_000n }],
  durationMs: 100n,
  liquidityWindowMs: 50n,
  eligibility: openEligibility(500n, 4n, 250n),
  uncapped: null,
  hardCap: null,
};

test("creates an Aftermath sale through the initializer: vendor new, setters, vendor finalize, share", () => {
  const ptb = tx.createAftermathPresale({
    ...terms,
    hardCap: { startsAfterMs: 40n, closesWhenFilled: true },
    startMs: 1_000n,
    partner,
  });
  const vendorCalls = assertBuildersMatchAbi(ptb, vendorAbi, VENDOR);
  assert.deepEqual(vendorCalls, [
    "blast_aftermath_dao_presale::new",
    "blast_aftermath_dao_presale::finalize",
  ]);
  const presaleCalls = assertBuildersMatchAbi(ptb, presaleAbi, "0x5f");
  // Every setter but the LP-fee split, which the vendor's finalize sets.
  assert.deepEqual(
    presaleCalls.filter((name) => /^blast_presale::(set_|share)/.test(name)),
    [
      "blast_presale::set_supply",
      "blast_presale::set_token_allocations",
      "blast_presale::set_raise",
      "blast_presale::set_windows",
      "blast_presale::set_eligibility",
      "blast_presale::set_hard_cap",
      "blast_presale::set_partner",
      "blast_presale::share",
    ],
  );
  const calls = ptb
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall] : [],
    );
  const names = calls.map((call) => `${call.module}::${call.function}`);
  assert.equal(names[0], "blast_aftermath_dao_presale::new");
  assert.equal(names.at(-2), "blast_aftermath_dao_presale::finalize");
  assert.equal(names.at(-1), "blast_presale::share");

  // `new<SaleToken, Quote>(&AdminCap, TreasuryCap, &CreationPolicy, &FeePolicy)`.
  assert.deepEqual(calls[0]?.typeArguments, [memeA, sui]);
  assert.deepEqual(moveCallArguments(ptb, 0), [
    "object:0xad",
    "shared:0x64",
    "object:0x7c",
    "shared:0x62",
    "shared:0x61",
  ]);
  const hardCap = calls[names.indexOf("blast_presale::set_hard_cap")];
  assert.deepEqual(
    hardCap?.arguments.slice(2).map((argument) => {
      assert.ok(argument.$kind === "Input");
      return ptb.getData().inputs[argument.Input]?.Pure?.bytes;
    }),
    [
      bcs.u64().serialize(40n).toBase64(),
      bcs.bool().serialize(true).toBase64(),
    ],
  );
  // `finalize<Lp, SaleToken, Quote>(&AdminCap, initializer, &mut Currency, CreatePoolCapV2)`.
  const finalizeIndex = names.length - 2;
  assert.deepEqual(calls[finalizeIndex]?.typeArguments, [LP, memeA, sui]);
  const finalizeArgs = moveCallArguments(ptb, finalizeIndex);
  assert.equal(finalizeArgs[0], "object:0xad");
  assert.equal(finalizeArgs[1], "shared:0x64");
  assert.equal(finalizeArgs[2], "result:0");
  assert.deepEqual(finalizeArgs.slice(3), ["shared-mut:0xcc", "object:0xcc9"]);
  assert.equal(
    moveCallArguments(ptb, names.length - 1)[0],
    `result:${ptb
      .getData()
      .commands.findIndex(
        (command) => command.MoveCall?.function === "finalize",
      )}`,
  );
  // The vendor sends the PresaleCap to its treasury: nothing to transfer.
  assert.ok(
    ptb
      .getData()
      .commands.every((command) => command.$kind !== "TransferObjects"),
  );

  // Without a hard cap or partner, those setters are left out.
  const plain = tx
    .createAftermathPresale({ ...terms, startMs: 0n })
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall.function] : [],
    );
  assert.ok(!plain.includes("set_hard_cap"));
  assert.ok(!plain.includes("set_partner"));
  assert.ok(!plain.includes("set_fee_split"));
});

test("refuses to create a sale with anything but the verified LP coin", () => {
  const lookalikes = [
    { ...lpCoin },
    JSON.parse(JSON.stringify(lpCoin)),
    { lpType: LP, createPoolCapId: "0xcc9" },
    "0xcc9",
  ] as unknown as AftermathLpCoin[];
  for (const value of lookalikes) {
    assert.throws(
      () => tx.createAftermathPresale({ ...terms, startMs: 0n, lpCoin: value }),
      /lpCoin must be the AftermathLpCoin that verifyAftermathLpCoin returned/,
    );
    assert.throws(() =>
      tx.call.finalizeAftermathPresale({
        memeType: memeA,
        quoteType: sui,
        adminCap: "0xad",
        initializer: { $kind: "Result", Result: 0 },
        memeCurrency: shared("0xcc", true),
        lpCoin: value,
      }),
    );
  }
});

test("migrates an Aftermath sale with its PoolCreation and Aftermath's objects", () => {
  const ptb = tx.migrateAftermath({
    memeType: memeA,
    quoteType: sui,
    presale,
    poolCreation,
    lpType: LP,
  });
  assert.deepEqual(assertBuildersMatchAbi(ptb, vendorAbi, VENDOR), [
    "blast_aftermath_dao_presale::migrate",
  ]);
  assert.deepEqual(moveCallArguments(ptb, 0), [
    "shared-mut:0xab",
    "shared:0x64",
    `shared-mut:${POOL_CREATION.replace(/^0x0+/, "0x")}`,
    "shared:0x61",
    "shared-mut:0xa1",
    "shared:0xa2",
    CLOCK,
  ]);
});

test("settles and migrates in one PTB, then pays the partner", () => {
  const options = {
    memeType: memeA,
    quoteType: sui,
    presale,
    poolCreation,
    lpType: LP,
  };
  const ptb = tx.settleAndMigrateAftermath({ ...options, partner });
  const names = ptb
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall"
        ? [`${command.MoveCall.module}::${command.MoveCall.function}`]
        : [],
    );
  assert.deepEqual(names, [
    "blast_presale::settle",
    "blast_aftermath_dao_presale::migrate",
    "blast_presale::pay_protocol_fees_with_partner",
  ]);
  assertBuildersMatchAbi(ptb, presaleAbi, "0x5f");
  assertBuildersMatchAbi(ptb, vendorAbi, VENDOR);
  assert.deepEqual(moveCallArguments(ptb, 0), [
    "shared-mut:0xab",
    "shared:0x64",
    CLOCK,
  ]);
  // Without a partner, only settle and migrate.
  const alone = tx.settleAndMigrateAftermath(options);
  assert.equal(
    alone.getData().commands.filter((command) => command.$kind === "MoveCall")
      .length,
    2,
  );
});

// === Events ===

let eventIndex = 0;
function suiEvent<Kind extends AftermathPresaleEventKind>(
  kind: Kind,
  payload: AftermathPresaleEventPayloads[Kind],
  options: { pkg?: string; module?: string; types?: string } = {},
): SuiClientTypes.EventEntry {
  const pkg = options.pkg ?? VENDOR;
  const module = options.module ?? "blast_aftermath_dao_presale";
  eventIndex += 1;
  return {
    packageId: pkg,
    module,
    sender: id("0x4ee9"),
    eventType: `${pkg}::${module}::${kind}<${options.types ?? `${LP}, ${memeA}, ${sui}`}>`,
    bcs: aftermathPresaleEventBcs[kind].serialize(payload).toBytes(),
    json: null,
    checkpoint: "9",
    transactionDigest: `tx-${eventIndex}`,
    eventIndex,
  };
}

test("event specs match both events frozen in the vendor ABI", () => {
  const frozen = Object.fromEntries(
    Object.entries(vendorAbi).map(([module, { events }]) => [
      module,
      Object.fromEntries(
        events.map((event) => [
          event.name,
          Object.fromEntries(
            event.fields.map((field) => {
              const type = JSON.stringify(
                (field as { type?: unknown }).type ?? null,
              );
              return [field.name, type === '"u64"' ? "u64" : "id"];
            }),
          ),
        ]),
      ),
    ]),
  );
  for (const [module, events] of Object.entries(aftermathPresaleEventSpecs)) {
    assert.deepEqual(
      orderedEventFields(events),
      orderedEventFields(frozen[module] ?? {}),
    );
  }
});

test("decodes PoolCreationReserved and Migrated from bytes in Move field order", () => {
  const idBytes = (value: string) =>
    Array.from(Buffer.from(id(value).slice(2), "hex"));
  const reserved = decodeAftermathPresaleEvent(
    {
      ...suiEvent("PoolCreationReserved", {
        presale_id: PRESALE,
        pool_creation_id: POOL_CREATION,
      }),
      bcs: Uint8Array.from([...idBytes(PRESALE), ...idBytes(POOL_CREATION)]),
    },
    { packageId: VENDOR },
  );
  assert.equal(reserved.kind, "PoolCreationReserved");
  assert.equal(reserved.lpType, LP);
  assert.equal(reserved.memeType, memeA);
  assert.equal(reserved.quoteType, sui);
  assert.deepEqual(reserved.payload, {
    presale_id: PRESALE,
    pool_creation_id: POOL_CREATION,
  });

  const lp = 1_234_567n;
  const migrated = decodeAftermathPresaleEvent(
    {
      ...suiEvent("Migrated", {
        presale_id: PRESALE,
        pool_id: id("0x9001"),
        dao_fee_pool_id: id("0xdf"),
        owner_cap_id: id("0x0c"),
        lp_coin_id: id("0x1c"),
        lp,
      }),
      bcs: Uint8Array.from([
        ...idBytes(PRESALE),
        ...idBytes("0x9001"),
        ...idBytes("0xdf"),
        ...idBytes("0x0c"),
        ...idBytes("0x1c"),
        ...Array.from({ length: 8 }, (_, i) =>
          Number((lp >> BigInt(8 * i)) & 0xffn),
        ),
      ]),
    },
    { packageId: VENDOR },
  );
  assert.equal(migrated.kind, "Migrated");
  assert.deepEqual(migrated.payload, {
    presale_id: PRESALE,
    pool_id: id("0x9001"),
    dao_fee_pool_id: id("0xdf"),
    owner_cap_id: id("0x0c"),
    lp_coin_id: id("0x1c"),
    lp,
  });
});

test("rejects vendor events from another package, module, or arity", () => {
  const payload = { presale_id: PRESALE, pool_creation_id: POOL_CREATION };
  for (const options of [
    { pkg: id("0xbad") },
    { module: "blast_presale" },
    { types: `${memeA}, ${sui}` },
    { types: `${LP}, ${memeA}, ${sui}, ${sui}` },
  ]) {
    assert.throws(
      () =>
        decodeAftermathPresaleEvent(
          suiEvent("PoolCreationReserved", payload, options),
          { packageId: VENDOR },
        ),
      /unexpected Aftermath presale event/,
    );
  }
});

// === The sale's binding ===

const reservation = (presaleId: string, poolCreationId: string) =>
  suiEvent("PoolCreationReserved", {
    presale_id: presaleId,
    pool_creation_id: poolCreationId,
  });

/** `PoolCreation<LP>`: its UID and presale ID, then the cap's UID. */
function poolCreationObject(presaleId = PRESALE) {
  const bytes = (value: string) =>
    Array.from(Buffer.from(id(value).slice(2), "hex"));
  return {
    objectId: POOL_CREATION,
    version: "12",
    digest: "d",
    owner: { $kind: "Shared", Shared: { initialSharedVersion: "11" } },
    type: `${VENDOR}::blast_aftermath_dao_presale::PoolCreation<${LP}>`,
    content: Uint8Array.from([
      ...bytes(POOL_CREATION),
      ...bytes(presaleId),
      ...bytes("0xcc9"),
    ]),
  };
}

test("decodes a PoolCreation and checks its type and UID", () => {
  const object = poolCreationObject();
  const decoded = decodeAftermathPoolCreationObject(
    { ...object, initialSharedVersion: "11" },
    VENDOR,
  );
  assert.deepEqual(decoded, {
    presaleId: PRESALE,
    poolCreationId: POOL_CREATION,
    lpType: LP,
    poolCreation: {
      objectId: POOL_CREATION,
      initialSharedVersion: "11",
      mutable: true,
    },
  });
  assert.throws(
    () =>
      decodeAftermathPoolCreationObject(
        { ...object, initialSharedVersion: "11" },
        id("0xbad"),
      ),
    /not an Aftermath PoolCreation/,
  );
  assert.throws(
    () =>
      decodeAftermathPoolCreationObject(
        { ...object, objectId: id("0xc4eb"), initialSharedVersion: "11" },
        VENDOR,
      ),
    /mismatched UID/,
  );
});

test("finds a sale's reservation among unrelated events", () => {
  const events = [
    suiEvent("PoolCreationReserved", {
      presale_id: id("0x07"),
      pool_creation_id: id("0x1"),
    }),
    { ...reservation(PRESALE, POOL_CREATION), eventType: "not a type" },
    suiEvent(
      "PoolCreationReserved",
      { presale_id: PRESALE, pool_creation_id: id("0x2") },
      { pkg: id("0xbad") },
    ),
    reservation(PRESALE, POOL_CREATION),
  ];
  assert.deepEqual(aftermathReservationOf(events, "0xab", VENDOR), {
    presaleId: PRESALE,
    poolCreationId: POOL_CREATION,
    lpType: LP,
    memeType: memeA,
    quoteType: sui,
  });
  assert.equal(aftermathReservationOf(events, "0xac", VENDOR), null);
});

function fakeClient(options: {
  pages?: SuiClientTypes.EventEntry[][];
  transaction?: SuiClientTypes.Event[];
  object?: "live" | "deleted";
}) {
  const requests: { method: string; request: unknown }[] = [];
  const pages = options.pages ?? [];
  const client = {
    core: {
      getTransaction: async (request: unknown) => {
        requests.push({ method: "getTransaction", request });
        return {
          $kind: "Transaction",
          Transaction: { events: options.transaction ?? [] },
        };
      },
      listEvents: async (request: { after?: string | null }) => {
        requests.push({ method: "listEvents", request });
        const index = request.after ? Number(request.after) : 0;
        return {
          events: pages[index] ?? [],
          hasNextPage: index + 1 < pages.length,
          startCursor: String(index),
          endCursor: String(index + 1),
        };
      },
      getObject: async (request: unknown) => {
        requests.push({ method: "getObject", request });
        if (options.object === "deleted") {
          throw new ObjectError("deleted", "gone", { reason: "deleted" });
        }
        return { object: poolCreationObject() };
      },
    },
  } as unknown as ClientWithCoreApi;
  return { client, requests };
}

test("reads the binding from the sale's creation transaction", async () => {
  const { client, requests } = fakeClient({
    transaction: [reservation(PRESALE, POOL_CREATION)],
    object: "live",
  });
  const binding = await findAftermathPoolCreation(client, {
    presaleId: PRESALE,
    packageId: VENDOR,
    creationDigest: "creation",
  });
  assert.deepEqual(binding, {
    presaleId: PRESALE,
    poolCreationId: POOL_CREATION,
    lpType: LP,
    memeType: memeA,
    quoteType: sui,
    poolCreation: {
      objectId: POOL_CREATION,
      initialSharedVersion: "11",
      mutable: true,
    },
  });
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["getTransaction", "getObject"],
  );
  assert.ok(binding?.poolCreation);
  // The binding is call-ready.
  const ptb: Transaction = tx.migrateAftermath({
    memeType: binding.memeType,
    quoteType: binding.quoteType,
    presale,
    poolCreation: binding.poolCreation,
    lpType: binding.lpType,
  });
  assertBuildersMatchAbi(ptb, vendorAbi, VENDOR);
});

test("scans the vendor's reservations page by page; a migrated sale's PoolCreation is gone", async () => {
  const { client, requests } = fakeClient({
    pages: [
      [reservation(id("0x1"), id("0x11"))],
      [reservation(id("0x2"), id("0x22")), reservation(PRESALE, POOL_CREATION)],
    ],
    object: "deleted",
  });
  const binding = await findAftermathPoolCreation(client, {
    presaleId: PRESALE,
    packageId: VENDOR,
  });
  assert.equal(binding?.poolCreationId, POOL_CREATION);
  assert.equal(binding?.poolCreation, null);
  const lists = requests.filter(({ method }) => method === "listEvents");
  assert.equal(lists.length, 2);
  const [first] = lists;
  assert.ok(first);
  assert.deepEqual((first.request as { filter: unknown }).filter, {
    eventType: `${VENDOR}::blast_aftermath_dao_presale::PoolCreationReserved`,
  });

  const none = fakeClient({ pages: [[reservation(id("0x1"), id("0x11"))]] });
  assert.equal(
    await findAftermathPoolCreation(none.client, {
      presaleId: PRESALE,
      packageId: VENDOR,
    }),
    null,
  );
});

test("rejects a PoolCreation bound to another sale than its reservation", async () => {
  const { client } = fakeClient({
    transaction: [reservation(id("0xac"), POOL_CREATION)],
    object: "live",
  });
  await assert.rejects(
    findAftermathPoolCreation(client, {
      presaleId: "0xac",
      packageId: VENDOR,
      creationDigest: "creation",
    }),
    /does not match its reservation/,
  );
});

test("PresaleClient reads the binding through the deployment's vendor", async () => {
  const { client } = fakeClient({
    transaction: [reservation(PRESALE, POOL_CREATION)],
    object: "live",
  });
  const presales = new PresaleClient(client, deployment);
  const binding = await presales.getAftermathPoolCreation(PRESALE, {
    creationDigest: "creation",
  });
  assert.equal(binding?.lpType, LP);
  const { aftermath: _, ...bare } = deployment;
  await assert.rejects(
    new PresaleClient(client, bare).getAftermathPoolCreation(PRESALE),
    /deployment.aftermath/,
  );
});
