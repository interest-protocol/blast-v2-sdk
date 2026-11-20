import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { BoostsGovernanceAction } from "@interest-protocol/blast-boosts-sdk";
import { addBoostsGovernanceCall } from "@interest-protocol/blast-boosts-sdk";
import {
  BOOSTS_ADAPTER_ABORTS,
  BOOSTS_CORE_ABORTS,
  boostsAdapterAbortName,
  boostsCoreAbortName,
} from "@interest-protocol/blast-boosts-sdk/aborts";
import { Transaction } from "@mysten/sui/transactions";
import { assertBuildersMatchAbi, readAbi } from "./abi.ts";
import { BOOSTS_FIXTURE_MANIFEST as manifest } from "./boosts-fixtures.ts";

test("governance calls match the contract ABI and pass authorization only when required", () => {
  const tx = new Transaction();
  const signIn = (role: string) =>
    tx.moveCall({
      target: `${manifest.adminPackageId}::blast_acl::sign_in`,
      typeArguments: [role],
      arguments: [tx.object("0x10"), tx.object("0x20")],
    });
  const fee = signIn("0xc0::blast_domain::FeeAdmin");
  const cancel = signIn("0xc0::blast_domain::CancelAdmin");
  const risk = signIn("0xbc::blast_boosts_core::RiskAdmin");
  const treasury = signIn("0xc0::blast_domain::TreasuryAdmin");
  const otw = `${manifest.adapterPackage.originalPackageId}::blast_boosts_aftermath::BLAST_BOOSTS_AFTERMATH`;
  const upgrade = signIn(
    `${manifest.adminPackageId}::package_admin::UpgradeAdmin<${otw}>`,
  );
  const unpause = signIn(
    `${manifest.adminPackageId}::package_admin::UnpauseAdmin<${otw}>`,
  );
  const actions: BoostsGovernanceAction[] = [
    {
      kind: "schedule_fees",
      adminWitness: fee,
      mintFeeBps: 1n,
      redeemFeeBps: 2n,
      adminShareBps: 3n,
    },
    { kind: "schedule_nav_cap", adminWitness: risk, navCapAtoms: 5n },
    {
      kind: "schedule_max_order_notional",
      adminWitness: risk,
      maxOrderNotional: 6n,
    },
    { kind: "cancel_fees", adminWitness: cancel },
    { kind: "cancel_nav_cap", adminWitness: cancel },
    { kind: "cancel_max_order_notional", adminWitness: cancel },
    { kind: "apply_fees" },
    { kind: "apply_nav_cap" },
    { kind: "apply_max_order_notional" },
    { kind: "add_partner", adminWitness: fee, partner: "0x77" },
    { kind: "remove_partner", adminWitness: fee, partner: "0x77" },
    {
      kind: "withdraw_admin_fees",
      adminWitness: treasury,
      treasury: "0x55",
      amountAtoms: 7n,
    },
    {
      kind: "unpause",
      adminWitness: unpause,
      packageAdmin: "0x49",
      treasury: "0x55",
    },
    { kind: "activate_upgrade", adminWitness: upgrade },
    { kind: "make_immutable", adminWitness: upgrade, packageAdmin: "0x49" },
  ];
  for (const action of actions) {
    addBoostsGovernanceCall(tx, manifest, "sui-2x-bull", action);
    const cmd = tx.getData().commands.at(-1);
    assert.ok(cmd?.$kind === "MoveCall");
    assert.equal(cmd.MoveCall.function, action.kind);
    assert.equal(
      cmd.MoveCall.arguments.some((arg) => arg.$kind === "Result"),
      "adminWitness" in action,
    );
  }
  assert.equal(
    assertBuildersMatchAbi(
      tx,
      readAbi("production-boosts-v1.json", "boostsAftermath"),
      manifest.adapterPackage.packageId,
    ).length,
    actions.length,
  );
});

test("adapter aborts distinguish module-local codes from the shared registry", () => {
  assert.equal(
    boostsAdapterAbortName("package_admin", 0),
    "EUnguardedTreasuryDelay",
  );
  assert.equal(
    boostsAdapterAbortName("blast_boosts_aftermath", 0),
    "EGenerationMismatch",
  );
  assert.equal(
    boostsAdapterAbortName("operations", 0),
    "EInvalidProductWitnessType",
  );
  assert.equal(
    boostsAdapterAbortName("orders", 37),
    "EProfitRealizationNoProgress",
  );
  assert.equal(boostsAdapterAbortName("orders", 38), null);
  assert.equal(boostsAdapterAbortName("partner_list", 4), null);
  assert.equal(boostsCoreAbortName("state", -1), null);
});

const contracts = process.env.BLAST_CONTRACTS_DIR ?? "../blast-v2-contracts";
test("Boosts abort tables match the reviewed contract sources", {
  skip: !process.env.BLAST_CONTRACTS_DIR && !existsSync(contracts),
}, () => {
  const { baseline } = JSON.parse(
    readFileSync(
      new URL("../abi/production-boosts-v1.json", import.meta.url),
      "utf8",
    ),
  );
  for (const [pkg, table] of [
    ["core", BOOSTS_CORE_ABORTS],
    ["aftermath_adapter", BOOSTS_ADAPTER_ABORTS],
  ] as const) {
    const source = execFileSync(
      "git",
      [
        "-C",
        contracts,
        "show",
        `${baseline.contractsCommit}:sui/defi/boosts/${pkg}/sources/lib/errors.move`,
      ],
      { encoding: "utf8" },
    );
    const expected = [...source.matchAll(/^const (E\w+): u64 = (\d+);/gm)].map(
      ([, name, code], i) => {
        assert.equal(Number(code), i);
        return name;
      },
    );
    assert.deepEqual(table, expected);
  }
});
