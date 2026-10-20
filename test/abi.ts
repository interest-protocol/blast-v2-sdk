import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiObjectId, SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";

type AbiFunction = {
  name: string;
  sdk: string;
  typeParameters: unknown[];
  parameters: unknown[];
};
type AbiModule = {
  functions: AbiFunction[];
  structs: { name: string; fields: { name: string }[] }[];
  events: { name: string; sdk: string; fields: { name: string }[] }[];
};
type Artifact = {
  packages: Record<string, { modules: Record<string, AbiModule> }>;
};

export function readAbi(file: string, packageKey: string) {
  const artifact = JSON.parse(
    readFileSync(new URL(`../abi/${file}`, import.meta.url), "utf8"),
  ) as Artifact;
  const modules = artifact.packages[packageKey]?.modules;
  assert.ok(modules, `${packageKey} is in abi/${file}`);
  return modules;
}

/**
 * Asserts every Move call `tx` makes into `packageId` is a frozen builder
 * (or compositional constructor) called with its exact type and value arity (`&mut TxContext` is
 * implicit), and returns each call's `module::function`.
 */
export function assertBuildersMatchAbi(
  tx: Transaction,
  modules: Record<string, AbiModule>,
  packageId: string,
): string[] {
  const target = normalizeSuiObjectId(packageId);
  return tx.getData().commands.flatMap((command) => {
    if (command.$kind !== "MoveCall") return [];
    const call = command.MoveCall;
    if (normalizeSuiObjectId(call.package) !== target) return [];
    const name = `${call.module}::${call.function}`;
    const frozen = modules[call.module]?.functions.find(
      (candidate) => candidate.name === call.function,
    );
    assert.ok(frozen, `${name} is in the frozen ABI`);
    assert.ok(
      frozen.sdk === "builder" || frozen.sdk === "compositional",
      `${name} is a builder`,
    );
    assert.equal(call.typeArguments.length, frozen.typeParameters.length, name);
    assert.equal(
      call.arguments.length,
      frozen.parameters.filter(
        (parameter) => !JSON.stringify(parameter).includes('"TxContext"'),
      ).length,
      name,
    );
    if (
      JSON.stringify(frozen.parameters[1])?.includes('"blast_presale_package"')
    ) {
      const argument = call.arguments[1];
      assert.ok(argument?.$kind === "Input", `${name} borrows PackageVersion`);
      const input = tx.getData().inputs[argument.Input];
      assert.ok(
        input?.$kind === "Object" && input.Object.$kind === "SharedObject",
      );
      assert.equal(
        input.Object.SharedObject.mutable,
        false,
        `${name} reads PackageVersion`,
      );
    }
    return [name];
  });
}

/** One descriptor per argument of the `index`th Move call. */
export function moveCallArguments(tx: Transaction, index: number): string[] {
  const calls = tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall] : [],
    );
  const call = calls[index];
  assert.ok(call, `Move call ${index}`);
  return call.arguments.map((argument) => {
    if (argument.$kind === "Result") return `result:${argument.Result}`;
    if (argument.$kind === "NestedResult") {
      return `result:${argument.NestedResult.join(":")}`;
    }
    assert.ok(argument.$kind === "Input");
    const input = tx.getData().inputs[argument.Input];
    if (input?.$kind === "Pure") return "pure";
    if (input?.$kind === "UnresolvedObject") {
      return `object:${short(input.UnresolvedObject.objectId)}`;
    }
    assert.ok(input?.$kind === "Object");
    assert.ok(input.Object.$kind === "SharedObject");
    const shared = input.Object.SharedObject;
    if (shared.objectId === SUI_CLOCK_OBJECT_ID) return "clock";
    return `${shared.mutable ? "shared-mut" : "shared"}:${short(shared.objectId)}`;
  });
}

/** Every Move call's type arguments, in command order. */
export function moveCallTypeArguments(tx: Transaction): string[][] {
  return tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall.typeArguments] : [],
    );
}

function short(objectId: string): string {
  return `0x${BigInt(objectId).toString(16)}`;
}

/**
 * Each event's `[field, descriptor]` pairs in declaration order. BCS decodes
 * fields positionally, but `deepEqual` ignores object key order, so compare
 * these to catch a field the SDK declares out of the Move order.
 */
export function orderedEventFields(
  specs: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Record<string, [string, string][]> {
  return Object.fromEntries(
    Object.entries(specs).map(([kind, fields]) => [
      kind,
      Object.entries(fields),
    ]),
  );
}
