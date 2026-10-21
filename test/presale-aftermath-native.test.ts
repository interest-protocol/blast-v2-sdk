import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import {
  decodeNativeAftermathEvent,
  decodeNativeAftermathPoolCreationObject,
  findNativeAftermathPoolCreation,
  nativeAftermathEventBcs,
  nativeAftermathEventSpecs,
  nativeAftermathReservationOf,
} from "../src/presale/aftermath-native.ts";
import { PresaleClient } from "../src/presale/client.ts";
import type {
  NativeAftermathPresaleTerms,
  PresaleDeployment,
} from "../src/presale/transactions.ts";
import {
  PresaleCalls,
  PresaleTransactions,
} from "../src/presale/transactions.ts";
import {
  assertBuildersMatchAbi,
  moveCallArguments,
  orderedEventFields,
  readAbi,
} from "./abi.ts";
import { verifiedLpCoin } from "./aftermath-lp.ts";

const id = normalizeSuiAddress;
const shared = <const M extends boolean>(objectId: string, mutable: M) => ({
  objectId: id(objectId),
  initialSharedVersion: "3",
  mutable,
});
const deployment: PresaleDeployment = {
  packageId: id("0x5f"),
  originalPackageId: id("0x5e"),
  packageVersion: shared("0x64", false),
  venueConfig: shared("0x60", false),
  feePolicy: shared("0x61", false),
  creationPolicy: shared("0x62", false),
  admin: { packageId: id("0x65"), acl: shared("0x63", false) },
};
const lpCoin = await verifiedLpCoin("0xa::af_lp::AF_LP", "0xcc9");
const presale = shared("0xab", true);
const poolCreation = shared("0xac", true);
const types = {
  memeType: normalizeStructTag("0xa::meme::MEME"),
  quoteType: normalizeStructTag("0x2::sui::SUI"),
};
const terms: NativeAftermathPresaleTerms = {
  ...types,
  lpCoin,
  treasuryCap: "0x7c",
  memeCurrency: shared("0xcc", true),
  daoFeeBps: 200,
  tokenSupply: 20_000n,
  tokenAllocationBps: 5_000n,
  participantVesting: null,
  liquidityTokenAllocationBps: 5_000n,
  recipientAllocations: [],
  burnable: false,
  raiseTarget: 1_000n,
  raiseAllocations: [],
  durationMs: 100n,
  liquidityWindowMs: 50n,
  eligibility: {
    kind: "open",
    walletCap: 1_000n,
    maxParticipants: 1n,
    minCommitment: 1_000n,
  },
  uncapped: null,
  hardCap: { startsAfterMs: 0n, closesWhenFilled: true },
  feeRecipients: [{ recipient: "0xfee", bps: 6_000n }],
  holderRewardsBps: 4_000n,
};
const abi = readAbi("production-presale-v1.json", "presale");
const sdk = new PresaleTransactions(deployment);
const calls = new PresaleCalls(deployment);
const reservationType = `${deployment.originalPackageId}::aftermath::PoolCreationReserved<${lpCoin.lpType},${types.memeType},${types.quoteType}>`;
const payload = {
  presale_id: presale.objectId,
  pool_creation_id: poolCreation.objectId,
  create_pool_cap_id: lpCoin.createPoolCapId,
};
function reservation(): SuiClientTypes.EventEntry {
  return {
    packageId: deployment.packageId,
    module: "aftermath",
    sender: id("0xc0"),
    eventType: reservationType,
    bcs: nativeAftermathEventBcs.PoolCreationReserved.serialize(
      payload,
    ).toBytes(),
    json: null,
    checkpoint: "9",
    transactionDigest: "creation",
    eventIndex: 0,
  };
}
function object() {
  return {
    objectId: poolCreation.objectId,
    initialSharedVersion: "3",
    type: reservationType.replace("PoolCreationReserved", "PoolCreation"),
    // Real PoolCreation prefix: UID, presale ID, then CreatePoolCapV2's UID.
    content: bcs
      .tuple([bcs.Address, bcs.Address, bcs.Address])
      .serialize([
        poolCreation.objectId,
        presale.objectId,
        lpCoin.createPoolCapId,
      ])
      .toBytes(),
  };
}
function fakeClient(
  options: { deleted?: boolean; pages?: boolean; changedCap?: boolean } = {},
) {
  const requests: string[] = [];
  const client = {
    core: {
      getTransaction: async () => {
        requests.push("transaction");
        return {
          $kind: "Transaction",
          Transaction: { events: [reservation()] },
        };
      },
      listEvents: async ({ after }: { after: string | null }) => {
        requests.push(`events:${after}`);
        return {
          events: after ? [reservation()] : [],
          hasNextPage: !after,
          endCursor: after ? null : "next",
        };
      },
      getObject: async () => {
        requests.push("object");
        if (options.deleted)
          throw new ObjectError("deleted", "gone", { reason: "deleted" });
        const o = object();
        if (options.changedCap)
          o.content = bcs
            .tuple([bcs.Address, bcs.Address, bcs.Address])
            .serialize([poolCreation.objectId, presale.objectId, id("0xbad")])
            .toBytes();
        return {
          object: {
            ...o,
            owner: { $kind: "Shared", Shared: { initialSharedVersion: "3" } },
          },
        };
      },
    },
  } as unknown as ClientWithCoreApi;
  return { client, requests };
}

test("native lifecycle builders match the final frozen ABI in both coin orders", async () => {
  for (const memeType of [
    types.memeType,
    normalizeStructTag("0x1::meme::MEME"),
  ]) {
    const launch = { ...types, memeType };
    const create = sdk.createNativeAftermathPresale({
      ...terms,
      ...launch,
      startMs: 0n,
      capRecipient: "0xc0",
    });
    const names = assertBuildersMatchAbi(create, abi, deployment.packageId);
    assert.equal(names[0], "aftermath::new");
    assert.deepEqual(names.slice(-3), [
      "aftermath::finalize",
      "blast_presale::share",
      "aftermath::share",
    ]);
    const commands = create.getData().commands;
    const start = commands.findIndex(
      (c) =>
        c.MoveCall?.module === "aftermath" && c.MoveCall.function === "new",
    );
    const finalizeIndex = commands.findIndex(
      (c) =>
        c.MoveCall?.module === "aftermath" &&
        c.MoveCall.function === "finalize",
    );
    const finalize = commands[finalizeIndex]?.MoveCall;
    assert.deepEqual(finalize?.arguments[0], {
      $kind: "NestedResult",
      NestedResult: [start, 0],
    });
    assert.deepEqual(finalize?.arguments[2], {
      $kind: "NestedResult",
      NestedResult: [start, 1],
    });
    assert.deepEqual(finalize?.typeArguments, [
      lpCoin.lpType,
      memeType,
      types.quoteType,
    ]);
    assert.equal(commands.filter((c) => c.TransferObjects).length, 1);
    assert.ok(names.includes("blast_presale::set_fee_split"));
    const commit = sdk.commit({
      ...launch,
      presale,
      amount: 1_000n,
      recipient: "0xc0",
      route: "open",
    });
    assert.deepEqual(
      assertBuildersMatchAbi(commit, abi, deployment.packageId),
      ["blast_presale::commit_open"],
    );
    const migration = sdk.settleAndMigrateNativeAftermath({
      ...launch,
      presale,
      poolCreation,
      lpType: lpCoin.lpType,
    });
    assert.deepEqual(
      assertBuildersMatchAbi(migration, abi, deployment.packageId),
      ["blast_presale::settle", "aftermath::migrate"],
    );
    assert.deepEqual(moveCallArguments(migration, 1).slice(0, 5), [
      "shared-mut:0xab",
      "shared:0x64",
      "shared-mut:0xac",
      "shared:0x61",
      "shared:0x60",
    ]);
    const claim = sdk.claim({ ...launch, presale, participants: ["0xc0"] });
    assertBuildersMatchAbi(claim, abi, deployment.packageId);
  }
});

test("native witness uses original type address and does not require vendor configuration", () => {
  const witness = `${deployment.originalPackageId}::aftermath::Witness`;
  assert.equal(calls.migrationWitnessType("aftermath-native"), witness);
  assert.equal(calls.venueOf(witness), "aftermath-native");
  assert.equal(
    calls.venueOf(`${deployment.packageId}::aftermath::Witness`),
    null,
  );
  assert.throws(
    () => calls.migrationWitnessType("aftermath"),
    /deployment.aftermath/,
  );
  for (const daoFeeBps of [0, -1, 10_001, 2.5, NaN, Infinity]) {
    assert.throws(
      () =>
        sdk.createNativeAftermathPresale({
          ...terms,
          daoFeeBps,
          startMs: 0n,
          capRecipient: "0xc0",
        }),
      /daoFeeBps/,
    );
  }
  assert.throws(
    () =>
      sdk.createNativeAftermathPresale({
        ...terms,
        // @ts-expect-error A persisted copy deliberately loses the verification brand.
        lpCoin: { ...lpCoin },
        startMs: 0n,
        capRecipient: "0xc0",
      }),
    /verified|verifyAftermathLpCoin/,
  );
});

test("native migration and collection append partner payouts and use receiving inputs", () => {
  const partner = shared("0x9a27", false);
  const migration = sdk.migrateNativeAftermath({
    ...types,
    presale,
    poolCreation,
    lpType: lpCoin.lpType,
    partner,
    aftermathObjects: {
      poolRegistry: shared("0xd1", false),
      daoFeeVersion: shared("0xd2", false),
    },
  });
  assert.deepEqual(
    assertBuildersMatchAbi(migration, abi, deployment.packageId),
    ["aftermath::migrate", "blast_presale::pay_protocol_fees_with_partner"],
  );
  assert.deepEqual(moveCallArguments(migration, 0).slice(-3), [
    "shared-mut:0xd1",
    "shared:0xd2",
    "clock",
  ]);
  const fee = {
    objectId: id("0xf1"),
    version: "10",
    digest: "11111111111111111111111111111111",
  };
  const collection = sdk.collectNativeAftermathFees({
    ...types,
    vault: shared("0xb0", true),
    memeFees: [fee],
    quoteFees: [],
    partner,
  });
  assert.deepEqual(
    assertBuildersMatchAbi(collection, abi, deployment.packageId),
    [
      "aftermath::collect_fees",
      "presale_vault::pay_protocol_lp_fees_with_partner",
    ],
  );
  const data = collection.getData();
  assert.deepEqual(
    data.inputs.find((i) => i.Object?.$kind === "Receiving")?.Object?.Receiving,
    fee,
  );
  const vectors = data.commands.flatMap((c) =>
    c.MakeMoveVec ? [c.MakeMoveVec] : [],
  );
  assert.deepEqual(
    vectors.map((v) => v.elements.length),
    [1, 0],
  );
  assert.equal(
    vectors[1]?.type,
    `0x2::transfer::Receiving<0x2::coin::Coin<${types.quoteType}>>`,
  );
});

test("native events preserve final ABI field order and the original defining address", () => {
  assert.deepEqual(orderedEventFields(nativeAftermathEventSpecs.aftermath), {
    PoolCreationReserved: abi.aftermath?.events
      .find((e) => e.name === "PoolCreationReserved")
      ?.fields.map((f) => [f.name, "id"]),
    DaoFeePoolCreated: abi.aftermath?.events
      .find((e) => e.name === "DaoFeePoolCreated")
      ?.fields.map((f) => [f.name, "id"]),
  });
  const decoded = decodeNativeAftermathEvent(reservation(), deployment);
  assert.equal(decoded.kind, "PoolCreationReserved");
  assert.deepEqual(decoded.payload, payload);
  assert.equal(decoded.lpType, lpCoin.lpType);
  assert.equal(
    nativeAftermathReservationOf(
      [reservation()],
      presale.objectId,
      deployment.packageId,
    ),
    null,
  );
  assert.throws(
    () =>
      decodeNativeAftermathEvent(
        {
          ...reservation(),
          eventType: reservationType.replace(
            "aftermath",
            "blast_aftermath_dao_presale",
          ),
        },
        deployment,
      ),
    /unexpected/,
  );
  const o = object();
  assert.equal(
    decodeNativeAftermathPoolCreationObject(o, deployment.originalPackageId)
      .createPoolCapId,
    lpCoin.createPoolCapId,
  );
  assert.throws(
    () =>
      decodeNativeAftermathPoolCreationObject(
        { ...o, objectId: id("0xbad") },
        deployment.originalPackageId,
      ),
    /UID/,
  );
  assert.throws(
    () =>
      decodeNativeAftermathPoolCreationObject(
        {
          ...o,
          type: `${deployment.originalPackageId}::aftermath::PoolCreation<${lpCoin.lpType}>`,
        },
        deployment.originalPackageId,
      ),
    /not an Aftermath/,
  );
});

test("native receipt discovery provides migration inputs, scans pages and retains consumed reservations", async () => {
  const { client, requests } = fakeClient();
  const reader = new PresaleClient(client, deployment);
  const binding = await reader.getNativeAftermathPoolCreation(
    presale.objectId,
    { creationDigest: "creation" },
  );
  assert.ok(binding?.poolCreation);
  assert.deepEqual(binding.poolCreation, poolCreation);
  assert.deepEqual(requests, ["transaction", "object"]);
  assertBuildersMatchAbi(
    sdk.migrateNativeAftermath({
      ...binding,
      poolCreation: binding.poolCreation,
      presale,
    }),
    abi,
    deployment.packageId,
  );
  const scan = fakeClient();
  await findNativeAftermathPoolCreation(scan.client, {
    presaleId: presale.objectId,
    originalPackageId: deployment.originalPackageId,
  });
  assert.deepEqual(scan.requests, ["events:null", "events:next", "object"]);
  const deleted = await new PresaleClient(
    fakeClient({ deleted: true }).client,
    deployment,
  ).getNativeAftermathPoolCreation(presale.objectId, {
    creationDigest: "creation",
  });
  assert.equal(deleted?.poolCreation, null);
  assert.equal(deleted?.lpType, lpCoin.lpType);
  await assert.rejects(
    () =>
      new PresaleClient(
        fakeClient({ changedCap: true }).client,
        deployment,
      ).getNativeAftermathPoolCreation(presale.objectId, {
        creationDigest: "creation",
      }),
    /does not match/,
  );
});
