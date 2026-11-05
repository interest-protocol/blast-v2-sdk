import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiObjectId, SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";

type AbiFunction = {
  name: string;
  sdk: string;
  typeParameters: unknown[];
  parameters: unknown[];
  returns: unknown[];
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
      frozen.sdk === "builder" ||
        frozen.sdk === "compositional" ||
        frozen.sdk === "read",
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
    const valueParameters = frozen.parameters.filter(
      (parameter) => !JSON.stringify(parameter).includes('"TxContext"'),
    );
    call.arguments.forEach((argument, index) => {
      if (argument.$kind !== "Input") return;
      const input = tx.getData().inputs[argument.Input];
      const parameter = valueParameters[index];
      const position = `${name} argument ${index}`;
      if (input?.$kind === "Pure") {
        assert.ok(isPureType(parameter), `${position} is a pure value`);
        return;
      }
      assert.ok(!isPureType(parameter), `${position} is an object`);
      if (input?.$kind !== "Object" || input.Object.$kind !== "SharedObject") {
        return;
      }
      const reference = (parameter as { Reference?: [boolean, unknown] })
        .Reference;
      // By value or `&mut` needs a mutable input; `&` an immutable one unless
      // another command in the PTB borrows the same object mutably.
      const mutable = reference === undefined || reference[0];
      if (mutable || !input.Object.SharedObject.mutable) {
        assert.equal(
          input.Object.SharedObject.mutable,
          mutable,
          `${position} has its Move mutability`,
        );
        return;
      }
      assert.ok(
        inputUses(tx, argument.Input) > 1,
        `${position} is borrowed immutably`,
      );
    });
    return [name];
  });
}

const PURE_DATATYPES = new Set([
  "string::String",
  "ascii::String",
  "object::ID",
  "option::Option",
]);

/** Whether a Move parameter type can be passed as a pure input. */
function isPureType(type: unknown): boolean {
  if (typeof type === "string") return true;
  if (type === null || typeof type !== "object") return false;
  if ("vector" in type) return isPureType((type as { vector: unknown }).vector);
  const datatype = (
    type as {
      Datatype?: {
        module: { name: string };
        name: string;
        type_arguments: { argument: unknown }[];
      };
    }
  ).Datatype;
  return (
    datatype !== undefined &&
    PURE_DATATYPES.has(`${datatype.module.name}::${datatype.name}`) &&
    datatype.type_arguments.every(({ argument }) => isPureType(argument))
  );
}

/** How many Move-call arguments read input `index`. */
function inputUses(tx: Transaction, index: number): number {
  return tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? command.MoveCall.arguments : [],
    )
    .filter(
      (argument) => argument.$kind === "Input" && argument.Input === index,
    ).length;
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

/**
 * Checks every transaction a test file builds against one package's frozen
 * ABI and records the builders it reaches; `assertEveryBuilder` then requires
 * each classified `builder` of the package to have been exercised.
 */
export function abiCoverage(
  modules: Record<string, AbiModule>,
  packageId: string,
) {
  const covered = new Set<string>();
  return {
    check<T extends Transaction>(tx: T): T {
      for (const name of assertBuildersMatchAbi(tx, modules, packageId)) {
        covered.add(name);
      }
      return tx;
    },
    assertEveryBuilder(count: number) {
      const builders = Object.entries(modules).flatMap(([module, frozen]) =>
        frozen.functions
          .filter((candidate) => candidate.sdk === "builder")
          .map((candidate) => `${module}::${candidate.name}`),
      );
      assert.equal(builders.length, count, "classified builders");
      assert.deepEqual(
        builders.filter((name) => !covered.has(name)),
        [],
        "every builder is exercised",
      );
    },
  };
}
