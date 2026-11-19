import type { Transaction } from "@mysten/sui/transactions";

import type { SharedObjectReference } from "../src/lib/sui.ts";

export function shared<const Mutable extends boolean>(
  objectId: string,
  initialSharedVersion: number | string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion, mutable };
}

export function moveCalls(tx: Transaction) {
  return tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall] : [],
    );
}

export function moveFunctions(tx: Transaction): string[] {
  return moveCalls(tx).map((call) => `${call.module}::${call.function}`);
}

export function commandKinds(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.map((command) =>
      command.$kind === "MoveCall"
        ? `${command.MoveCall.module}::${command.MoveCall.function}`
        : command.$kind,
    );
}

export function sharedInputs(tx: Transaction): SharedObjectReference[] {
  return tx
    .getData()
    .inputs.flatMap((input) =>
      input.$kind === "Object" && input.Object.$kind === "SharedObject"
        ? [input.Object.SharedObject]
        : [],
    );
}

/** Reads the frozen ABI artifact for one package. */
export async function frozenAbi(path: string): Promise<FrozenAbi> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(
    await readFile(new URL(`../abi/${path}`, import.meta.url), "utf8"),
  ) as FrozenAbi;
}

export type FrozenAbi = {
  mainnet: { packageId: string };
  package: {
    modules: Record<
      string,
      {
        functions: readonly {
          name: string;
          parameters: readonly unknown[];
        }[];
        events: readonly {
          name: string;
          fields: readonly { name: string; type: unknown }[];
        }[];
      }
    >;
  };
};

/** Parameters a PTB passes: every parameter but the implicit `&mut TxContext`. */
export function ptbParameterCount(parameters: readonly unknown[]): number {
  return parameters.filter((parameter) => !isTxContext(parameter)).length;
}

function isTxContext(type: unknown): boolean {
  const reference = (type as { Reference?: [boolean, unknown] }).Reference;
  const datatype = (reference?.[1] as { Datatype?: { name?: string } })
    ?.Datatype;
  return datatype?.name === "TxContext";
}
