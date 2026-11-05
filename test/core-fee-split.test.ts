import assert from "node:assert/strict";
import test from "node:test";
import { CoreCalls, coreType } from "@interest-protocol/blast-core/deployment";
import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import {
  apportionFeeSplit,
  feeSplitBcs,
  normalizeFeeSplit,
} from "@interest-protocol/blast-core/fee-split";
import { CORE_ROLES, coreRoleType } from "@interest-protocol/blast-core/roles";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toHex } from "@mysten/sui/utils";

const core = {
  packageId: "0xc02e",
  originalPackageId: "0xc0",
  treasury: { objectId: "0x7e", initialSharedVersion: "5" },
};

// Literal BCS and amounts from test/fixtures/core-vectors.move at contracts a1a8f6c9.
const SPLIT: FeeSplit = {
  routes: [
    { destination: { kind: "Address", address: "0xf00d" }, bps: 1000n },
    { destination: { kind: "Owner" }, bps: 4000n },
    { destination: { kind: "AutoLp" }, bps: 2000n },
    { destination: { kind: "HolderRewards" }, bps: 2000n },
    { destination: { kind: "Burn" }, bps: 1000n },
  ],
};
const SPLIT_BCS =
  "0500000000000000000000000000000000000000000000000000000000000000f00de80300000000000001a00f00000000000002d00700000000000003d00700000000000004e803000000000000";

test("FeeSplit encodes in Move variant and field order", () => {
  const normalized = normalizeFeeSplit(SPLIT);
  assert.equal(toHex(feeSplitBcs.serialize(normalized).toBytes()), SPLIT_BCS);
  assert.deepEqual(
    feeSplitBcs.parse(feeSplitBcs.serialize(normalized).toBytes()),
    normalized,
  );
  assert.deepEqual(normalized.routes[0]?.destination, {
    kind: "Address",
    address: normalizeSuiAddress("0xf00d"),
  });
});

test("apportionFeeSplit mirrors fee_split::apportion", () => {
  assert.deepEqual(apportionFeeSplit(SPLIT, 12_345n), [
    1235n,
    4938n,
    2469n,
    2469n,
    1234n,
  ]);
});

test("normalizeFeeSplit rejects what fee_split::new aborts on", () => {
  const route = (bps: bigint, address: string) => ({
    destination: { kind: "Address" as const, address },
    bps,
  });
  assert.throws(() => normalizeFeeSplit({ routes: [route(9_999n, "0x1")] }));
  assert.throws(() =>
    normalizeFeeSplit({ routes: [route(10_000n, "0x1"), route(0n, "0x2")] }),
  );
  assert.throws(() =>
    normalizeFeeSplit({
      routes: [route(5_000n, "0x1"), route(5_000n, "0x01")],
    }),
  );
  assert.throws(() =>
    normalizeFeeSplit({
      routes: [
        { destination: { kind: "Owner" }, bps: 5_000n },
        { destination: { kind: "Owner" }, bps: 5_000n },
      ],
    }),
  );
  assert.throws(() => normalizeFeeSplit({ routes: [route(10_000n, "0x0")] }));
  assert.throws(() =>
    normalizeFeeSplit({
      routes: Array.from({ length: 21 }, (_, i) =>
        route(i === 0 ? 8_000n : 100n, `0x${i + 1}`),
      ),
    }),
  );
  assert.deepEqual(normalizeFeeSplit({ routes: [route(10_000n, "0x1")] }), {
    routes: [route(10_000n, normalizeSuiAddress("0x1"))],
  });
});

test("CoreCalls.feeSplit builds every route, then fee_split::new", () => {
  const tx = new Transaction();
  tx.add(new CoreCalls(core).feeSplit(SPLIT));
  const calls = tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall"
        ? [`${command.MoveCall.module}::${command.MoveCall.function}`]
        : command.$kind === "MakeMoveVec"
          ? [`MakeMoveVec<${command.MakeMoveVec.type}>`]
          : [],
    );
  assert.deepEqual(calls, [
    "fee_split::address_destination",
    "bps::new",
    "fee_split::route",
    "fee_split::owner_destination",
    "bps::new",
    "fee_split::route",
    "fee_split::auto_lp_destination",
    "bps::new",
    "fee_split::route",
    "fee_split::holder_rewards_destination",
    "bps::new",
    "fee_split::route",
    "fee_split::burn_destination",
    "bps::new",
    "fee_split::route",
    `MakeMoveVec<${coreType(core, "fee_split", "Route")}>`,
    "fee_split::new",
  ]);
  const packages = new Set(
    tx
      .getData()
      .commands.flatMap((command) =>
        command.$kind === "MoveCall" ? [command.MoveCall.package] : [],
      ),
  );
  assert.deepEqual([...packages], [normalizeSuiAddress("0xc02e")]);
});

test("core roles name blast_domain types in the original package", () => {
  assert.equal(CORE_ROLES.length, 9);
  assert.ok(CORE_ROLES.includes("VenueAdmin"));
  assert.equal(
    coreRoleType(core, "RewardsAdmin"),
    `${normalizeSuiAddress("0xc0")}::blast_domain::RewardsAdmin`,
  );
  assert.throws(() => coreRoleType(core, "AdapterAdmin" as never), TypeError);
});

test("treasury builders take the shared treasury mutably", () => {
  const calls = new CoreCalls(core);
  const tx = new Transaction();
  tx.add(
    calls.scheduleDestination({
      adminWitness: "0xa1",
      destination: "0xbee",
      delayMs: 172_800_000n,
    }),
  );
  tx.add(calls.applyDestination());
  tx.add(calls.cancelDestination({ adminWitness: "0xa2" }));
  const data = tx.getData();
  const moveCalls = data.commands.flatMap((command) =>
    command.$kind === "MoveCall" ? [command.MoveCall] : [],
  );
  assert.deepEqual(
    moveCalls.map((call) => [call.function, call.arguments.length]),
    [
      ["schedule_destination", 5],
      ["apply_destination", 2],
      ["cancel_destination", 2],
    ],
  );
  const treasury = data.inputs.find(
    (input) =>
      input.$kind === "Object" && input.Object.$kind === "SharedObject",
  );
  assert.ok(
    treasury?.$kind === "Object" && treasury.Object.$kind === "SharedObject",
  );
  assert.equal(treasury.Object.SharedObject.mutable, true);
  assert.equal(
    treasury.Object.SharedObject.objectId,
    normalizeSuiAddress("0x7e"),
  );
});
