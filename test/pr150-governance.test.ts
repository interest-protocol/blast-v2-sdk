import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LaunchpadCalls,
  LaunchpadTransactions,
} from "@interest-protocol/blast-launchpad-sdk/transactions";
import {
  MigratorCalls,
  MigratorTransactions,
} from "@interest-protocol/blast-migrators-sdk/transactions";
import {
  PresaleCalls,
  PresaleTransactions,
} from "@interest-protocol/blast-presale-sdk/transactions";
import type {
  TransactionArgument,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";
import { assertBuildersMatchAbi, readAbi } from "./abi.ts";

const shared = { objectId: "0x71", initialSharedVersion: "3" };
const admin = { packageId: "0xad", acl: { ...shared, objectId: "0xac" } };
const launchpad = {
  packageId: "0x15",
  originalPackageId: "0x15",
  admin,
  partnersPackageId: "0xae",
  timelockPackageId: "0xaf",
  packageVersion: shared,
  launchConfig: { ...shared, objectId: "0x72" },
  runtimeConfig: { ...shared, objectId: "0x73" },
};
const presale = {
  packageId: "0x16",
  originalPackageId: "0x16",
  admin,
  packageVersion: shared,
  venueConfig: shared,
  creationPolicy: { ...shared, objectId: "0x72" },
  feePolicy: { ...shared, objectId: "0x73" },
};
const migrators = {
  packageId: "0x17",
  originalPackageId: "0x17",
  launchpad,
  migratorsVersion: shared,
  lpFeePolicy: { ...shared, objectId: "0x72" },
  venueConfig: shared,
};
const products = {
  launchpad: {
    calls: new LaunchpadCalls(launchpad),
    tx: new LaunchpadTransactions(launchpad),
    deployment: launchpad,
    domain: "blast_fun_domain",
    rolePackage: "0x15",
  },
  presale: {
    calls: new PresaleCalls(presale),
    tx: new PresaleTransactions(presale),
    deployment: presale,
    domain: "blast_presale_domain",
    rolePackage: "0x16",
  },
  migrators: {
    calls: new MigratorCalls(migrators),
    tx: new MigratorTransactions(migrators),
    deployment: migrators,
    domain: "blast_fun_domain",
    rolePackage: "0x15",
  },
};
type Case = {
  method: string;
  module: string;
  function: string;
  role: string | null;
  sample: Record<string, unknown>;
  returns: boolean;
};
const cases = JSON.parse(
  readFileSync(
    new URL("./pr150-governance-cases.json", import.meta.url),
    "utf8",
  ),
) as Record<keyof typeof products, Case[]>;
function input(value: unknown): unknown {
  if (value === "BIGINT") return 123n;
  if (value === "BYTES32") return new Uint8Array(32).fill(17);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, input(v)]),
    );
  return value;
}
for (const product of Object.keys(products) as (keyof typeof products)[]) {
  const {
    calls,
    tx: transactions,
    deployment,
    rolePackage,
    domain,
  } = products[product];
  const abi = readAbi("pr150-consumers.json", product);
  for (const sample of cases[product]) {
    test(`PR150 ${product}.${sample.method}: exact compiler signature, roles and mutable objects`, () => {
      const options = input(sample.sample) as Record<string, unknown>;
      const build = Reflect.get(calls, sample.method) as (
        options: Record<string, unknown>,
      ) => (tx: Transaction) => void | TransactionResult;
      assert.equal(typeof build, "function");
      const tx = new Transaction();
      tx.add(build.call(calls, options));
      assert.ok(
        assertBuildersMatchAbi(tx, abi, deployment.packageId).includes(
          `${sample.module}::${sample.function}`,
        ),
      );
      const command = tx
        .getData()
        .commands.find(
          (command) =>
            command.$kind === "MoveCall" &&
            command.MoveCall.module === sample.module &&
            command.MoveCall.function === sample.function,
        );
      assert.ok(command?.$kind === "MoveCall");
      const signature = abi[sample.module]!.functions.find(
        (f) => f.name === sample.function,
      )!;
      for (const [index, type] of signature.parameters.entries()) {
        const reference =
          typeof type === "object" && type !== null && "Reference" in type
            ? (type as { Reference: [boolean, unknown] }).Reference
            : null;
        if (!reference) continue;
        const arg: TransactionArgument | undefined =
          command.MoveCall.arguments[index];
        if (arg?.$kind !== "Input") continue;
        const actual:
          | ReturnType<Transaction["getData"]>["inputs"][number]
          | undefined = tx.getData().inputs[arg.Input];
        if (
          actual?.$kind === "Object" &&
          actual.Object.$kind === "SharedObject"
        )
          assert.equal(
            actual.Object.SharedObject.mutable,
            reference[0],
            `${sample.method} argument ${index}`,
          );
      }
      // Hot potatoes and publication must be composed in one PTB; never expose an unusable standalone transaction.
      if (
        sample.returns ||
        ["commit_upgrade_and_advance", "wrap"].includes(sample.function)
      )
        return;
      const transaction = Reflect.get(transactions, sample.method) as (
        options: Record<string, unknown>,
      ) => Transaction;
      const built = transaction.call(transactions, {
        ...options,
        adminCapId: "0xca",
      });
      assertBuildersMatchAbi(built, abi, deployment.packageId);
      const signIns = built
        .getData()
        .commands.filter(
          (c) => c.$kind === "MoveCall" && c.MoveCall.module === "blast_acl",
        );
      if (sample.role) {
        assert.equal(signIns.length, 1);
        const signIn = signIns[0]!;
        assert.ok(signIn.$kind === "MoveCall");
        assert.deepEqual(signIn.MoveCall.typeArguments, [
          normalizeStructTag(`${rolePackage}::${domain}::${sample.role}`),
        ]);
      } else assert.equal(signIns.length, 0, "apply needs no admin witness");
    });
  }
}

test("PR150 upgrade scheduling rejects wrong digest lengths and invalid delays", () => {
  for (const { calls } of Object.values(products)) {
    for (const length of [0, 31, 33])
      assert.throws(
        () =>
          calls.scheduleUpgrade({
            packageAdmin: { ...shared, mutable: true },
            adminWitness: "0xca",
            digest: new Uint8Array(length),
          }),
        /32 bytes/,
      );
    const tx = new Transaction();
    assert.throws(
      () =>
        tx.add(
          calls.scheduleUpgradeDelay({
            packageAdmin: { ...shared, mutable: true },
            adminWitness: "0xca",
            delayMs: -1n,
          }),
        ),
      /delayMs/,
    );
  }
  const calls = products.launchpad.calls;
  assert.throws(
    () =>
      calls.scheduleCreatorClaimSigner({
        adminWitness: "0xca",
        signerPublicKey: new Uint8Array(),
      }),
    /32 bytes/,
  );
  assert.throws(
    () =>
      calls.revokeCreatorClaimSigner({
        adminWitness: "0xca",
        signerPublicKey: "0x09",
      }),
    /32 bytes/,
  );
  assert.equal(
    normalizeSuiObjectId("0x15"),
    products.launchpad.calls.deployment.packageId,
  );
});

test("pause builders reject empty masks and bits outside their product", () => {
  for (const [product, invalid] of [
    ["launchpad", [0, 8, 255, 256, -1, 1.5]],
    ["presale", [0, 4, 255, 256, -1, 1.5]],
  ] as const) {
    const calls = products[product].calls;
    for (const bits of invalid) {
      assert.throws(() => calls.pause({ adminWitness: "0xca", bits }));
      assert.throws(() =>
        calls.unpause({
          packageAdmin: { ...shared, mutable: false },
          adminWitness: "0xca",
          bits,
        }),
      );
    }
  }
});
