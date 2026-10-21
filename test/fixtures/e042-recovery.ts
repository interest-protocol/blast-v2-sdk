import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import * as admin from "../../src/admin/index.ts";

// This isolated process replaces the chain boundary; it never loads keys or RPCs.
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const shared = (n: number) => ({ objectId: id(n), initialSharedVersion: "1" });
const deployment = {
  packageId: id(100),
  originalPackageId: id(100),
  admin: { packageId: id(101), acl: shared(102) },
};
const operator = { toSuiAddress: () => id(103) };
const roles = ["ListingAdmin", "AdapterAdmin"].map(
  (role) => `${id(100)}::roles::${role}`,
);
const template = {
  baseline: { allowedQuotes: [], allowedMigrationWitnesses: [] },
  adminCap: id(104),
  lp: { lpType: `${id(105)}::lp::LP` },
  sale: {
    memeType: `${id(106)}::sale_tokens::SALE_F`,
    quoteType: "0x2::sui::SUI",
    presale: shared(107),
    poolCreation: shared(108),
  },
  simulatedSuccesses: [] as string[],
  transactions: [] as { action: string; digest: string }[],
  checks: [],
};
let state = structuredClone(template);
let savedGrant = true;
let grantPending = true;
let savedMigration = false;
const executions: string[] = [];
const resumeMigration = new Error("resume saved migration receipt");
const unexpected = () => {
  throw new Error("unexpected operation during recovery");
};

mock.module("../../src/admin/index.ts", {
  namedExports: {
    ...admin,
    getAcl: async () => ({ admins: { [state.adminCap]: roles } }),
  },
});
mock.module("../../e2e/presale-mainnet/env.ts", {
  namedExports: {
    ADMIN_DEPLOYMENT: deployment.admin,
    AFTERMATH: { poolRegistry: id(109), daoFeeVersion: id(110) },
    acl: new admin.AdminTransactions(deployment.admin),
    administrator: () => operator,
    assertTarget: async () => {},
    CONFIG: { saleTokenLetter: "F", operators: { deployer: id(103) } },
    client: {
      core: {
        getObject: async () => ({
          object: {
            owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
          },
        }),
        simulateTransaction: async () => ({
          $kind: "Transaction",
          Transaction: { status: { success: true }, events: [] },
        }),
      },
    },
    DEPLOYMENT: deployment,
    deployer: () => operator,
    presale: {
      call: { roleType: (role: string) => `${id(100)}::roles::${role}` },
      getCreationPolicy: async () => ({}),
      // The chain is already Migrated. Funding must not require Funded again.
      getPresale: async () => ({ lifecycle: "Migrated" }),
      tx: {
        commit: () => new Transaction(),
        settle: () => new Transaction(),
        migrateNativeAftermath: () => new Transaction(),
      },
    },
    SUI: "0x2::sui::SUI",
    SUPER_ADMIN_CAP: id(111),
    TESTKIT: id(106),
  },
});
mock.module("../../e2e/presale-mainnet/chain.ts", {
  namedExports: {
    balanceChange: unexpected,
    check: (_label: string, pass: boolean) => assert.ok(pass),
    created: unexpected,
    createdAll: unexpected,
    equal: (_label: string, actual: unknown, expected: unknown) =>
      assert.equal(actual, expected),
    event: (_receipt: unknown, name: string) => {
      assert.ok(name === "Committed" || name === "PresaleFunded");
      return {
        quote: "10000000",
        total_commitments: "10000000",
        accepted_quote: "10000000",
        refundable_quote: "0",
      };
    },
    events: unexpected,
    exec: async (label: string) => {
      executions.push(label);
      if (label === "E2E-042 grant-roles" && savedGrant) {
        grantPending = false;
        return { digest: "recovered-grant" };
      }
      if (label === "E2E-042 migrate" && savedMigration) throw resumeMigration;
      if (label === "E2E-042 commit" || label === "E2E-042 settle")
        return { digest: label };
      return unexpected();
    },
    expectAbort: unexpected,
    expectSuccess: unexpected,
    hasReceipt: (label: string) =>
      label === "E2E-042 commit" ||
      (label === "E2E-042 grant-roles" && savedGrant) ||
      (label === "E2E-042 migrate" && savedMigration),
    record: () => {},
    sharedVersion: unexpected,
  },
});
mock.module("../../e2e/presale-mainnet/sale.ts", {
  namedExports: {
    mut: (value: object) => ({ ...value, mutable: true }),
    newSaleToken: unexpected,
    saveStateValue: (_key: string, value: typeof state) => {
      state = value;
    },
    stateValue: () => state,
    u64: (value: string) => BigInt(value),
  },
});
const { e042 } = await import("../../e2e/presale-mainnet/scenarios/e042.ts");

test("setup reconciles a pending grant even when the roles are already on chain", async () => {
  await e042("setup");
  assert.deepEqual(executions, ["E2E-042 grant-roles"]);
  assert.equal(grantPending, false);
  assert.equal(state.transactions[0]?.digest, "recovered-grant");
  executions.length = 0;
  await e042("setup");
  assert.deepEqual(executions, ["E2E-042 grant-roles"]);
  assert.equal(state.transactions.length, 1);
});

test("a migration receipt resumes without repeating funding or requiring Funded", async () => {
  state = structuredClone(template);
  savedGrant = false;
  savedMigration = true;
  executions.length = 0;
  await assert.rejects(e042("run"), (error) => error === resumeMigration);
  assert.deepEqual(executions, ["E2E-042 migrate"]);
});
