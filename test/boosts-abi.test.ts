import assert from "node:assert/strict";
import test from "node:test";

import { boostsActivityEventBcs } from "@interest-protocol/blast-boosts-sdk/events";
import {
  boostsCapturedSnapshotBcs,
  boostsVaultBcs,
} from "@interest-protocol/blast-boosts-sdk/state";
import { readAbi } from "./abi.ts";
import { fixtureEvent, fixtureRead } from "./boosts-fixtures.ts";

const core = readAbi("production-boosts-v1.json", "boostsCore");
const adapter = readAbi("production-boosts-v1.json", "boostsAftermath");

test("Boosts vault and nested layouts follow the current Move field order", () => {
  const vault = boostsVaultBcs.parse(fixtureRead("sui-2x-bull").vault.content);
  for (const [modules, moduleName, name, value] of [
    [adapter, "vault", "Vault", vault],
    [core, "state", "State", vault.state],
    [core, "policy", "VaultPolicy", vault.state.vault_policy],
    [
      core,
      "policy",
      "RebalancePolicy",
      vault.state.vault_policy.rebalance_policy,
    ],
    [core, "policy", "PricePolicy", vault.state.vault_policy.price_policy],
    [adapter, "venue_account", "VenueAccount", vault.venue_account],
    [adapter, "venue_account", "Binding", vault.venue_account.binding],
    [adapter, "checkpoint", "Checkpoint", vault.venue_account.checkpoint],
  ] as const) {
    const frozen = modules[moduleName]?.structs.find(
      (struct) => struct.name === name,
    );
    assert.ok(frozen, `${moduleName}::${name}`);
    assert.deepEqual(
      Object.keys(value),
      frozen.fields.map((field) => field.name),
    );
  }
});

test("Boosts activity event layouts follow the current Move field order", () => {
  for (const kind of ["Minted", "Redeemed", "Rebalanced"] as const) {
    const frozen = adapter.events?.events.find((event) => event.name === kind);
    assert.ok(frozen, kind);
    assert.equal(frozen.sdk, "decoder");
    const parsed = boostsActivityEventBcs[kind].parse(
      fixtureEvent("sui-2x-bull", kind).bcs,
    );
    assert.deepEqual(
      Object.keys(parsed),
      frozen.fields.map((field) => field.name),
    );
  }
});

test("Boosts observation and active operations retain their return shapes", () => {
  const functions = adapter.operations?.functions;
  assert.ok(functions);
  for (const [name, returnCount] of [
    ["observe", 4],
    ["mint", 2],
    ["redeem", 2],
    ["rebalance", 1],
  ] as const) {
    const operation: (typeof functions)[number] | undefined = functions.find(
      (candidate) => candidate.name === name,
    );
    assert.ok(operation, name);
    assert.equal(operation.returns.length, returnCount, name);
    if (name !== "observe") {
      assert.match(
        JSON.stringify(operation.returns.at(-1)),
        /"name":"ClearingHouse"/,
      );
    }
  }
  const captured = adapter.snapshot?.structs.find(
    (struct) => struct.name === "CapturedSnapshot",
  );
  assert.ok(captured);
  const vault = boostsVaultBcs.parse(fixtureRead("sui-2x-bull").vault.content);
  const snapshot = boostsCapturedSnapshotBcs.parse(
    boostsCapturedSnapshotBcs
      .serialize({
        venue_equity: 10_000_000n,
        position_base: 1_000n,
        lot_size: 1n,
        side: { Long: true },
        pending_order_count: 0n,
        margin_safe: true,
        venue_operational: true,
        economics_valid: true,
        base_price: 2_000_000_000n,
        base_timestamp: 1_000n,
        collateral_price: 1_000_000_000n,
        collateral_timestamp: 1_000n,
        mark_price: 2_000_000_000n,
        checkpoint: vault.venue_account.checkpoint,
        collateral_fixed: 1n,
      })
      .toBytes(),
  );
  assert.deepEqual(
    Object.keys(snapshot),
    captured.fields.map((field) => field.name),
  );
});
