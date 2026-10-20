import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import type { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";

import type { SharedObjectReference } from "../src/lib/sui.ts";
import {
  AftermathDaoPresaleTransactions,
  decodeAftermathDaoPresaleEvent,
} from "../src/presale/aftermath-dao.ts";
import { openEligibility } from "../src/presale/math.ts";
import type { PresaleDeployment } from "../src/presale/transactions.ts";

function shared<const Mutable extends boolean>(
  objectId: string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion: "3", mutable };
}

const presaleDeployment: PresaleDeployment = {
  packageId: "0x5f",
  originalPackageId: "0x5e",
  packageVersion: shared("0x64", false),
  venueConfig: shared("0x60", false),
  feePolicy: shared("0x61", false),
  creationPolicy: shared("0x62", false),
  admin: {
    packageId: "0xad",
    acl: { objectId: "0x63", initialSharedVersion: "3" },
  },
};
const vendor = { packageId: "0x7a", originalPackageId: "0x7a" };
const tx = new AftermathDaoPresaleTransactions(vendor, presaleDeployment);
const meme = normalizeStructTag("0xa::meme::MEME");
const quote = normalizeStructTag("0x2::sui::SUI");
const lp = normalizeStructTag("0xb::lp::LP");
const types = { memeType: meme, quoteType: quote, lpType: lp };
const CLOCK = `shared:${normalizeSuiAddress(SUI_CLOCK_OBJECT_ID)}`;

const abi = JSON.parse(
  readFileSync(
    new URL("../abi/production-aftermath-dao-presale-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  packages: {
    aftermathDaoPresale: {
      modules: Record<
        string,
        { functions: { name: string; parameters: unknown[] }[] }
      >;
    };
  };
};

/** Move parameters a transaction supplies: everything but the trailing `TxContext`. */
function abiArity(name: string): number {
  const fn =
    abi.packages.aftermathDaoPresale.modules.blast_aftermath_dao_presale?.functions.find(
      (candidate) => candidate.name === name,
    );
  assert.ok(fn);
  return fn.parameters.filter(
    (parameter) => !JSON.stringify(parameter).includes("TxContext"),
  ).length;
}

function moveCalls(ptb: Transaction) {
  return ptb
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall] : [],
    );
}

function call(ptb: Transaction, module: string, fn: string) {
  const found = moveCalls(ptb).find(
    (candidate) => candidate.module === module && candidate.function === fn,
  );
  assert.ok(found, `${module}::${fn}`);
  return found;
}

function argumentKinds(ptb: Transaction, moveCall: { arguments: unknown[] }) {
  return moveCall.arguments.map((argument) => argumentKind(ptb, argument));
}

function argumentKind(ptb: Transaction, argument: unknown): string {
  const value = argument as {
    $kind: string;
    Input?: number;
    Result?: number;
    NestedResult?: [number, number];
  };
  if (value.$kind === "Result") return `Result:${value.Result}`;
  if (value.$kind !== "Input") {
    return `NestedResult:${value.NestedResult?.join(":")}`;
  }
  return inputKind(ptb.getData().inputs[value.Input ?? -1]);
}

function inputKind(
  input: ReturnType<Transaction["getData"]>["inputs"][number] | undefined,
): string {
  if (input?.$kind === "UnresolvedObject") {
    return `object:${normalizeSuiAddress(input.UnresolvedObject.objectId)}`;
  }
  if (input?.$kind !== "Object" || input.Object.$kind !== "SharedObject") {
    return "pure";
  }
  const object = input.Object.SharedObject;
  return `${object.mutable ? "shared-mut" : "shared"}:${normalizeSuiAddress(object.objectId)}`;
}

test("creates a vendor sale in one PTB: new, every term but the fee split, finalize, share", () => {
  const ptb = tx.createSale({
    ...types,
    adminCap: "0xadc",
    treasuryCap: "0x7c",
    memeCurrency: shared("0xcc", true),
    createPoolCap: "0xcf",
    tokenSupply: 1_000_000_000n,
    tokenAllocationBps: 5_000n,
    participantVesting: null,
    liquidityTokenAllocationBps: 5_000n,
    recipientAllocations: [],
    burnable: false,
    raiseTarget: 1_000_000n,
    raiseAllocations: [],
    durationMs: 100n,
    liquidityWindowMs: 7n * 24n * 60n * 60n * 1_000n,
    eligibility: openEligibility(1_000_000n, 1n, 1_000_000n),
    uncapped: null,
    hardCap: { startsAfterMs: 0n, closesWhenFilled: true },
    partner: shared("0x9a27", false),
    startMs: 1_000n,
  });
  const functions = moveCalls(ptb).map(
    (moveCall) => `${moveCall.module}::${moveCall.function}`,
  );
  assert.equal(functions[0], "blast_aftermath_dao_presale::new");
  assert.deepEqual(functions.slice(-3), [
    "blast_presale::set_partner",
    "blast_aftermath_dao_presale::finalize",
    "blast_presale::share",
  ]);
  assert.ok(functions.includes("blast_presale::set_hard_cap"));
  assert.ok(!functions.includes("blast_presale::set_fee_split"));

  const started = call(ptb, "blast_aftermath_dao_presale", "new");
  assert.equal(started.package, normalizeSuiAddress("0x7a"));
  assert.deepEqual(started.typeArguments, [meme, quote]);
  assert.deepEqual(
    argumentKinds(ptb, started),
    [
      "object:0xadc",
      "shared:0x64",
      "object:0x7c",
      "shared:0x62",
      "shared:0x61",
    ].map((kind) =>
      kind.replace(/0x[0-9a-f]+/, (id) => normalizeSuiAddress(id)),
    ),
  );
  assert.equal(started.arguments.length, abiArity("new"));

  const finalized = call(ptb, "blast_aftermath_dao_presale", "finalize");
  assert.deepEqual(finalized.typeArguments, [lp, meme, quote]);
  assert.deepEqual(argumentKinds(ptb, finalized), [
    `object:${normalizeSuiAddress("0xadc")}`,
    `shared:${normalizeSuiAddress("0x64")}`,
    "Result:0",
    `shared-mut:${normalizeSuiAddress("0xcc")}`,
    `object:${normalizeSuiAddress("0xcf")}`,
  ]);
  assert.equal(finalized.arguments.length, abiArity("finalize"));

  const finalizeIndex = ptb
    .getData()
    .commands.findIndex(
      (command) =>
        command.$kind === "MoveCall" &&
        command.MoveCall.function === "finalize",
    );
  assert.equal(
    argumentKinds(ptb, call(ptb, "blast_presale", "share"))[0],
    `Result:${finalizeIndex}`,
  );
  // Every setter configures the vendor's initializer.
  for (const setter of moveCalls(ptb).filter((moveCall) =>
    moveCall.function.startsWith("set_"),
  )) {
    assert.equal(argumentKinds(ptb, setter)[0], "Result:0");
  }
});

test("migrates through the sale's pool creation and pays a partnered sale's fees", () => {
  const ptb = tx.migrate({
    ...types,
    presale: shared("0xab", true),
    poolCreation: shared("0xdc", true),
    poolRegistry: shared("0xfc", true),
    daoFeeVersion: shared("0xb4", false),
    partner: shared("0x9a27", false),
  });
  const migrated = call(ptb, "blast_aftermath_dao_presale", "migrate");
  assert.deepEqual(migrated.typeArguments, [lp, meme, quote]);
  assert.deepEqual(argumentKinds(ptb, migrated), [
    `shared-mut:${normalizeSuiAddress("0xab")}`,
    `shared:${normalizeSuiAddress("0x64")}`,
    `shared-mut:${normalizeSuiAddress("0xdc")}`,
    `shared:${normalizeSuiAddress("0x61")}`,
    `shared-mut:${normalizeSuiAddress("0xfc")}`,
    `shared:${normalizeSuiAddress("0xb4")}`,
    CLOCK,
  ]);
  assert.equal(migrated.arguments.length, abiArity("migrate"));
  assert.ok(
    moveCalls(ptb).some(
      (moveCall) => moveCall.function === "pay_protocol_fees_with_partner",
    ),
  );
  const unpartnered = tx.migrate({
    ...types,
    presale: shared("0xab", true),
    poolCreation: shared("0xdc", true),
    poolRegistry: shared("0xfc", true),
    daoFeeVersion: shared("0xb4", false),
  });
  assert.equal(moveCalls(unpartnered).length, 1);
});

test("decodes the vendor's pool-creation and migration events", () => {
  const event = (name: string, bytes: Uint8Array) => ({
    packageId: "0x7a",
    module: "blast_aftermath_dao_presale",
    sender: "0xa11ce",
    eventType: `0x7a::blast_aftermath_dao_presale::${name}<${lp}, ${meme}, ${quote}>`,
    bcs: bytes,
    json: null,
    checkpoint: "9",
    transactionDigest: "digest",
    eventIndex: 0,
  });
  const id = (value: string) => bcs.Address.serialize(value).toBytes();
  const reserved = decodeAftermathDaoPresaleEvent(
    event(
      "PoolCreationReserved",
      Uint8Array.from([...id("0xab"), ...id("0xdc")]),
    ),
    vendor,
  );
  assert.equal(reserved.kind, "PoolCreationReserved");
  assert.equal(reserved.lpType, lp);
  assert.deepEqual(reserved.payload, {
    presale_id: normalizeSuiAddress("0xab"),
    pool_creation_id: normalizeSuiAddress("0xdc"),
  });
  const migrated = decodeAftermathDaoPresaleEvent(
    event(
      "Migrated",
      Uint8Array.from([
        ...id("0xab"),
        ...id("0x1"),
        ...id("0x2"),
        ...id("0x3"),
        ...id("0x4"),
        ...bcs.u64().serialize(42n).toBytes(),
      ]),
    ),
    vendor,
  );
  assert.equal(migrated.kind, "Migrated");
  assert.equal(migrated.kind === "Migrated" && migrated.payload.lp, 42n);
  assert.throws(() =>
    decodeAftermathDaoPresaleEvent(
      {
        ...event("Migrated", new Uint8Array()),
        eventType: `0x99::blast_aftermath_dao_presale::Migrated<${lp}, ${meme}, ${quote}>`,
      },
      vendor,
    ),
  );
});
