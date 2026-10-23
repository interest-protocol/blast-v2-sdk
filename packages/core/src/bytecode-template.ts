import initBytecodeTemplate, {
  deserialize,
} from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";

// Shared by every generated-package template: one WASM initialization, module
// table checks, and constant patching by type and default value.

export type CompiledConstant = {
  type_: unknown;
  data: number[];
};

export type CompiledModule = Record<string, unknown> & {
  address_identifiers: string[];
  constant_pool: CompiledConstant[];
  function_handles: { module: number; name: number }[];
  identifiers: string[];
  module_handles: { address: number; name: number }[];
  function_defs: { code: { code: unknown[] } | null }[];
};

/** One constant the template patches: its pool type, compiled default, and new value. */
export type ConstantPatch = {
  name: string;
  type: string;
  expected: Uint8Array;
  replacement: Uint8Array;
};

export type BytecodeTemplateInitOptions = {
  module_or_path?: unknown;
};

let initialization: Promise<void> | undefined;

/**
 * Initializes the bytecode-template WASM helper once for every template. A
 * browser can supply its WASM URL when the bundler cannot discover the package
 * asset automatically.
 */
export function initializeBytecodeTemplate(
  options?: BytecodeTemplateInitOptions,
): Promise<void> {
  if (initialization) return initialization;

  const pending = Promise.resolve(initBytecodeTemplate(options)).then(
    () => undefined,
  );
  initialization = pending.catch((error: unknown) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

/** Deserializes a template module and checks the tables patching reads. */
export function deserializeTemplate(
  label: string,
  bytecode: Uint8Array,
): CompiledModule {
  const value: unknown = deserialize(bytecode);
  if (!isRecord(value)) throw new TypeError(`${label} is not a module`);
  if (
    !isStringArray(value.address_identifiers) ||
    !Array.isArray(value.constant_pool) ||
    !Array.isArray(value.function_handles) ||
    !isStringArray(value.identifiers) ||
    !Array.isArray(value.module_handles) ||
    !Array.isArray(value.function_defs)
  ) {
    throw new TypeError(`${label} has invalid module tables`);
  }
  return value as CompiledModule;
}

/**
 * Replaces each patch's one constant, found by pool type and compiled default,
 * then merges any constants the replacements made equal. Every slot is resolved
 * before any is written, so replacements may swap values between slots of the
 * same type.
 */
export function patchConstantSlots(
  label: string,
  compiled: CompiledModule,
  patches: readonly ConstantPatch[],
): void {
  const targets = patches.map((patch) => {
    const matches = compiled.constant_pool.flatMap((constant, index) =>
      constantTypeName(constant.type_) === patch.type &&
      bytesEqual(constant.data, patch.expected)
        ? [index]
        : [],
    );
    if (matches.length !== 1) {
      throw new TypeError(`${label} must have one ${patch.name} constant slot`);
    }
    return matches[0];
  });

  if (new Set(targets).size !== targets.length) {
    throw new TypeError(`${label} constant slots must be distinct`);
  }
  patches.forEach((patch, patchIndex) => {
    const target = targets[patchIndex];
    if (target === undefined) throw new TypeError("Missing constant slot");
    const constant = compiled.constant_pool[target];
    if (!constant) throw new TypeError("Missing constant");
    constant.data = Array.from(patch.replacement);
  });
  mergeDuplicateConstants(compiled);
}

/**
 * The bytecode verifier rejects a module whose constant pool holds the same
 * type and value twice (`DUPLICATE_ELEMENT`), which patching produces whenever
 * two slots of one type receive equal values: one recipient for every
 * capability, a name equal to the symbol, or two false flags. Each duplicate's
 * loads move to the last copy, which keeps a module's error constants, declared
 * after its settings, at their indices for clever-error decoding. The freed
 * slot becomes a unique `vector<u8>` that nothing loads, so no other index
 * shifts.
 */
function mergeDuplicateConstants(compiled: CompiledModule): void {
  const pool = compiled.constant_pool;
  const lastIndex = new Map(
    pool.map((constant, index) => [constantKey(constant), index]),
  );
  const redirects = new Map<number, number>();
  pool.forEach((constant, index) => {
    const kept = lastIndex.get(constantKey(constant));
    if (kept !== undefined && kept !== index) redirects.set(index, kept);
  });
  if (redirects.size === 0) return;

  for (const definition of compiled.function_defs) {
    for (const instruction of definition.code?.code ?? []) {
      if (isRecord(instruction) && typeof instruction.LdConst === "number") {
        instruction.LdConst =
          redirects.get(instruction.LdConst) ?? instruction.LdConst;
      }
    }
  }
  for (const index of redirects.keys()) {
    let attempt = 0;
    let unused: CompiledConstant;
    do {
      unused = {
        type_: { Vector: "U8" },
        data: Array.from(
          bcs
            .string()
            .serialize(`\u0000unused-constant-${index}-${attempt++}`)
            .toBytes(),
        ),
      };
    } while (lastIndex.has(constantKey(unused)));
    pool[index] = unused;
    lastIndex.set(constantKey(unused), index);
  }
}

function constantKey(constant: CompiledConstant): string {
  return `${constantTypeName(constant.type_)}:${constant.data.join(",")}`;
}

/**
 * Rejects a module or witness name that another identifier of the template
 * already uses, other than the placeholders it replaces.
 */
export function assertIdentifierSlots(
  label: string,
  compiled: CompiledModule,
  placeholders: readonly string[],
  identifiers: { moduleName: string; witnessName: string },
): void {
  const occupied = new Set(
    compiled.identifiers.filter(
      (identifier) => !placeholders.includes(identifier),
    ),
  );
  if (occupied.has(identifiers.moduleName)) {
    throw new RangeError(
      `moduleName ${identifiers.moduleName} collides with the ${label}`,
    );
  }
  if (occupied.has(identifiers.witnessName)) {
    throw new RangeError(
      `witnessName ${identifiers.witnessName} collides with the ${label}`,
    );
  }
}

/**
 * Derives the module and one-time-witness names from a symbol, the same
 * transformation as Blast V1: the witness is the uppercased symbol and the
 * module its lowercase form, spaces becoming underscores.
 */
export function deriveTemplateIdentifiers(
  symbol: string,
  requestedModuleName?: string,
): { moduleName: string; witnessName: string } {
  const normalizedSymbol = requireNonEmptyString("symbol", symbol);
  const witnessName = normalizedSymbol.toUpperCase().replaceAll(" ", "_");
  const moduleName =
    requestedModuleName ?? normalizedSymbol.toLowerCase().replaceAll(" ", "_");

  if (!/^[A-Z][A-Z0-9_]*$/.test(witnessName)) {
    throw new RangeError(
      "symbol must produce an uppercase Move witness identifier",
    );
  }
  if (!/^[a-z][a-z0-9_]*$/.test(moduleName)) {
    throw new RangeError(
      "moduleName must start with a lowercase letter and contain only lowercase letters, digits, or underscores",
    );
  }
  return { moduleName, witnessName };
}

export function requireString(name: string, value: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

export function requireNonEmptyString(name: string, value: string): string {
  const normalized = requireString(name, value).trim();
  if (!normalized) throw new RangeError(`${name} must not be empty`);
  return normalized;
}

function constantTypeName(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  const entries = Object.entries(value);
  if (entries.length !== 1 || !entries[0]) return "";
  return `${entries[0][0]}(${constantTypeName(entries[0][1])})`;
}

function bytesEqual(left: number[], right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
