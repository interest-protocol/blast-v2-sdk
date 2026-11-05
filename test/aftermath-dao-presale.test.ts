import assert from "node:assert/strict";
import test from "node:test";
import {
  AFTERMATH_DAO_BURN_ADDRESS,
  AFTERMATH_DAO_FEE_BPS,
  AFTERMATH_DAO_TREASURY,
  AftermathDaoPresaleCalls,
  aftermathDaoPresaleEventBcs,
  decodeAftermathDaoPresaleEvent,
} from "@interest-protocol/blast-presale-sdk/aftermath-dao";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

const shared = (objectId: string) => ({ objectId, initialSharedVersion: "3" });
const vendor = new AftermathDaoPresaleCalls(
  {
    packageId: "0x7a",
    originalPackageId: "0x7a",
    adminCapId: "0xadc",
    aftermath: {
      poolRegistry: shared("0xaf1"),
      daoFeeVersion: shared("0xaf2"),
    },
  },
  { originalPackageId: "0x5e" },
);
const lp = normalizeStructTag("0xb::lp::LP");
const sale = normalizeStructTag("0xa::sale::SALE");
const quote = normalizeStructTag("0x2::sui::SUI");

function onlyCall(tx: Transaction) {
  const [command, ...rest] = tx.getData().commands;
  assert.equal(rest.length, 0);
  assert.ok(command?.$kind === "MoveCall");
  return command.MoveCall;
}

test("prepare pins the presale's package witness and takes the two owned objects", () => {
  const tx = new Transaction();
  tx.add(
    vendor.prepare({
      lpType: lp,
      saleTokenType: sale,
      quoteType: quote,
      adminCap: "0xadc",
      createPoolCap: "0xcf",
    }),
  );
  const call = onlyCall(tx);
  assert.equal(call.module, "blast_aftermath_dao_presale");
  assert.equal(call.function, "prepare");
  assert.deepEqual(call.typeArguments, [
    lp,
    sale,
    quote,
    normalizeStructTag("0x5e::blast_presale_package::PackageWitness"),
  ]);
  assert.equal(call.arguments.length, 2);
  assert.equal(
    vendor.venueType,
    normalizeStructTag("0x7a::blast_aftermath_dao_presale::Venue"),
  );
});

test("migrate consumes the hand-off and the shared PoolCreation", () => {
  const tx = new Transaction();
  const migration = tx.moveCall({ target: "0x5f::blast_presale::migrate" });
  tx.add(
    vendor.migrate({
      migration,
      lpType: lp,
      saleTokenType: sale,
      quoteType: quote,
      poolCreation: shared("0xb00"),
    }),
  );
  const data = tx.getData();
  const command = data.commands[1];
  assert.ok(command?.$kind === "MoveCall");
  const call = command.MoveCall;
  assert.deepEqual(call.typeArguments, [lp, sale, quote]);
  assert.deepEqual(call.arguments[0], { $kind: "Result", Result: 0 });
  const mutability = call.arguments.slice(1).map((argument) => {
    assert.ok(argument.$kind === "Input");
    const input = data.inputs[argument.Input];
    assert.ok(
      input?.$kind === "Object" && input.Object.$kind === "SharedObject",
    );
    return [
      `0x${BigInt(input.Object.SharedObject.objectId).toString(16)}`,
      input.Object.SharedObject.mutable,
    ];
  });
  assert.deepEqual(mutability, [
    ["0xb00", true],
    ["0xaf1", true],
    ["0xaf2", false],
  ]);
});

test("decodes Migrated typed <Lp, SaleToken, Quote>", () => {
  const payload = {
    presale_id: normalizeSuiAddress("0xab"),
    pool_id: normalizeSuiAddress("0xa00"),
    dao_fee_pool_id: normalizeSuiAddress("0xdf"),
    owner_cap_id: normalizeSuiAddress("0x0c"),
    lp_coin_id: normalizeSuiAddress("0x1c"),
    lp: 1_414n,
  };
  const decoded = decodeAftermathDaoPresaleEvent(
    {
      packageId: "0x7a",
      module: "blast_aftermath_dao_presale",
      sender: "0x1",
      eventType: `0x7a::blast_aftermath_dao_presale::Migrated<${lp}, ${sale}, ${quote}>`,
      bcs: aftermathDaoPresaleEventBcs.Migrated.serialize(payload).toBytes(),
      json: null,
      checkpoint: "1",
      transactionDigest: "tx",
      eventIndex: 0,
    },
    { originalPackageId: "0x7a" },
  );
  assert.equal(decoded.kind, "Migrated");
  assert.deepEqual(decoded.payload, payload);
  assert.equal(decoded.lpType, lp);
  assert.throws(
    () =>
      decodeAftermathDaoPresaleEvent(
        {
          packageId: "0x7b",
          module: "blast_aftermath_dao_presale",
          sender: "0x1",
          eventType: `0x7b::blast_aftermath_dao_presale::Migrated<${lp}, ${sale}, ${quote}>`,
          bcs: new Uint8Array(),
          json: null,
          checkpoint: "1",
          transactionDigest: "tx",
          eventIndex: 0,
        },
        { originalPackageId: "0x7a" },
      ),
    /unexpected Aftermath DAO event/,
  );
});

test("mirrors the vendor's display constants", () => {
  assert.equal(AFTERMATH_DAO_FEE_BPS, 200);
  assert.equal(
    AFTERMATH_DAO_TREASURY,
    "0x37cf46b499f740e653644bd2f7a8ed97f248e8b3c69d5d12c97d7845a54c0cd8",
  );
  assert.equal(AFTERMATH_DAO_BURN_ADDRESS, normalizeSuiAddress("0x0"));
});
