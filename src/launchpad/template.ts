import initBytecodeTemplate, {
  deserialize,
  serialize,
  update_identifiers,
} from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";
import {
  fromBase64,
  fromHex,
  isValidSuiObjectId,
  MOVE_STDLIB_ADDRESS,
  normalizeSuiObjectId,
  SUI_FRAMEWORK_ADDRESS,
} from "@mysten/sui/utils";

import { requireBasisPoints } from "../lib/integers.ts";
import { MAX_SELL_BURN_BPS } from "./curve.ts";

const ZERO_ADDRESS = normalizeSuiObjectId("0x0");
const SYSTEM_ADDRESSES = new Set([
  ZERO_ADDRESS,
  MOVE_STDLIB_ADDRESS,
  SUI_FRAMEWORK_ADDRESS,
]);

// Built from contracts/sui/meme_template/sources/meme.move with
// Sui CLI 1.77.2-51d177ad7d65. SHA-256:
// e35e26dcf39354bcf3a7be6d9c9d33e670846b7d50a046ad06c564467b777b74
const TEMPLATE_BYTECODE_BASE64 =
  "oRzrCwcAAAUKAQAOAg4WAyQqBE4EBVJAB5IB0AEI4gKAAQbiA4QBCuYEBQzrBEMACwMGAwoBEQIFAhICEwACAgABAAYAAgEMAQABAwMHAAYEAgAACQABAAENAwQAAQ4FBAACDAgJAQIDFAMGAAQIAwUABQ8MAQEMBhAKBQADBwYLAggABwgEAAIIAQgBAQoCAQgBAQUBCAMBCAAJCQAIAwgDCAMIAwgBAQMHCAQBCwIBCQABBggEAQsCAQgAAgkABRBDcmVhdG9yUmVjaXBpZW50DExhdW5jaFRpY2tldARNRU1FBlN0cmluZwlUeENvbnRleHQHYWRkcmVzcxFjcmVhdG9yX2F1dGhvcml0eQtkdW1teV9maWVsZApmcm9tX2J5dGVzBGluaXQNbGF1bmNoX3RpY2tldARtZW1lA25ldwtuZXdfYWNjb3VudAtuZXdfYWRkcmVzcw9wdWJsaWNfdHJhbnNmZXIGc2VuZGVyBnN0cmluZwh0cmFuc2Zlcgp0eF9jb250ZXh0BHV0ZjgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADadAoCBQRNRU1FCgILCkJsYXN0IE1lbWUKAhkYQSBNZW1lIGxhdW5jaGVkIG9uIEJsYXN0CgIbGmh0dHBzOi8vYmxhc3QuZnVuL21lbWUucG5nCgIhIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fAQEBAQEAAwgAAAAAAAAAAAACAQcBAAAAAAIfBwUEBgcEEQEMAgUKBwQRBRECDAILAgwDCwAHABEEBwERBAcCEQQHAxEECwMHBgcHCgE4AAsBLhEHOAECAAA=";

const DEFAULT_CREATOR_RECIPIENT_BYTES = fromHex(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
);

const defaults = {
  symbol: bcs.string().serialize("MEME").toBytes(),
  name: bcs.string().serialize("Blast Meme").toBytes(),
  description: bcs.string().serialize("A Meme launched on Blast").toBytes(),
  iconUrl: bcs.string().serialize("https://blast.fun/meme.png").toBytes(),
  creatorRecipientBytes: bcs
    .vector(bcs.u8())
    .serialize(Array.from(DEFAULT_CREATOR_RECIPIENT_BYTES))
    .toBytes(),
  creatorIsAccount: bcs.bool().serialize(true).toBytes(),
  burnable: bcs.bool().serialize(false).toBytes(),
  sellBurnBps: bcs.u64().serialize(0n).toBytes(),
} as const;

type CompiledConstant = {
  type_: unknown;
  data: number[];
};

type CompiledModule = Record<string, unknown> & {
  address_identifiers: string[];
  constant_pool: CompiledConstant[];
  function_handles: { module: number; name: number }[];
  identifiers: string[];
  module_handles: { address: number; name: number }[];
};

export type MemeTemplateOptions = {
  symbol: string;
  name: string;
  description: string;
  iconUrl: string;
  burnable: boolean;
  sellBurnBps: bigint;
  creatorRecipient: MemeCreatorRecipientInput;
  moduleName?: string;
};

export type MemeCreatorRecipientInput =
  | { kind: "address"; address: string }
  | { kind: "account"; accountCommitment: Uint8Array };

export type MemeTemplateIdentifiers = {
  moduleName: string;
  witnessName: string;
};

export type MemeTemplateInitOptions = {
  module_or_path?: unknown;
};

let initialization: Promise<void> | undefined;

/**
 * Initializes the bytecode-template WASM helper. A browser can supply its WASM
 * URL when the bundler cannot discover the package asset automatically.
 */
export function initializeMemeTemplate(
  options?: MemeTemplateInitOptions,
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

/**
 * Builds the one-module Meme package used by the launch intake.
 *
 * Its initializer creates the selected address or Blast account recipient, calls
 * `blast_fun::launch_ticket::new`, and transfers the ticket to the publisher.
 */
export async function buildMemePackageBytecode(
  options: MemeTemplateOptions,
  blastOriginalPackageId: string,
): Promise<Uint8Array> {
  const metadata = validateOptions(options);
  const creatorRecipient = validateCreatorRecipient(options.creatorRecipient);
  const dependency = normalizeBlastPackageId(blastOriginalPackageId);
  const identifiers = deriveMemeTemplateIdentifiers(
    metadata.symbol,
    options.moduleName,
  );
  await initializeMemeTemplate();

  const compiled = deserializeTemplate(fromBase64(TEMPLATE_BYTECODE_BASE64));
  assertIdentifierSlots(compiled, identifiers);
  patchBlastDependency(compiled, dependency);
  patchConstantSlots(compiled, [
    {
      name: "symbol",
      type: "Vector(U8)",
      expected: defaults.symbol,
      replacement: bcs.string().serialize(metadata.symbol).toBytes(),
    },
    {
      name: "name",
      type: "Vector(U8)",
      expected: defaults.name,
      replacement: bcs.string().serialize(metadata.name).toBytes(),
    },
    {
      name: "description",
      type: "Vector(U8)",
      expected: defaults.description,
      replacement: bcs.string().serialize(metadata.description).toBytes(),
    },
    {
      name: "iconUrl",
      type: "Vector(U8)",
      expected: defaults.iconUrl,
      replacement: bcs.string().serialize(metadata.iconUrl).toBytes(),
    },
    {
      name: "creatorRecipientBytes",
      type: "Vector(U8)",
      expected: defaults.creatorRecipientBytes,
      replacement: bcs
        .vector(bcs.u8())
        .serialize(Array.from(creatorRecipient.bytes))
        .toBytes(),
    },
    {
      name: "creatorIsAccount",
      type: "Bool",
      expected: defaults.creatorIsAccount,
      replacement: bcs.bool().serialize(creatorRecipient.isAccount).toBytes(),
    },
    {
      name: "burnable",
      type: "Bool",
      expected: defaults.burnable,
      replacement: bcs.bool().serialize(options.burnable).toBytes(),
    },
    {
      name: "sellBurnBps",
      type: "U64",
      expected: defaults.sellBurnBps,
      replacement: bcs.u64().serialize(options.sellBurnBps).toBytes(),
    },
  ]);

  const bytecode = update_identifiers(serialize(compiled), {
    MEME: identifiers.witnessName,
    meme: identifiers.moduleName,
  });
  assertTemplateWiring(bytecode, dependency, identifiers);
  return bytecode;
}

/** Derives the type identifiers using the same transformation as Blast V1. */
export function deriveMemeTemplateIdentifiers(
  symbol: string,
  requestedModuleName?: string,
): MemeTemplateIdentifiers {
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

function validateOptions(options: MemeTemplateOptions) {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Meme template options are required");
  }
  if (typeof options.burnable !== "boolean") {
    throw new TypeError("burnable must be a boolean");
  }
  if (typeof options.sellBurnBps !== "bigint") {
    throw new TypeError("sellBurnBps must be a bigint");
  }
  requireBasisPoints("sellBurnBps", options.sellBurnBps);
  if (options.sellBurnBps > MAX_SELL_BURN_BPS) {
    throw new RangeError("sellBurnBps exceeds 5,000");
  }

  return {
    symbol: requireNonEmptyString("symbol", options.symbol),
    name: requireNonEmptyString("name", options.name),
    description: requireString("description", options.description),
    iconUrl: requireString("iconUrl", options.iconUrl),
  };
}

function validateCreatorRecipient(recipient: MemeCreatorRecipientInput): {
  bytes: Uint8Array;
  isAccount: boolean;
} {
  if (typeof recipient !== "object" || recipient === null) {
    throw new TypeError("creatorRecipient is required");
  }
  if (recipient.kind === "address") {
    if (typeof recipient.address !== "string") {
      throw new TypeError("creatorRecipient.address must be a string");
    }
    const address = normalizeSuiObjectId(recipient.address);
    if (!isValidSuiObjectId(address) || address === ZERO_ADDRESS) {
      throw new RangeError(
        "creatorRecipient.address must be a nonzero Sui address",
      );
    }
    return {
      bytes: bcs.Address.serialize(address).toBytes(),
      isAccount: false,
    };
  }
  if (recipient.kind === "account") {
    if (
      !(recipient.accountCommitment instanceof Uint8Array) ||
      recipient.accountCommitment.length !== 32
    ) {
      throw new RangeError(
        "creatorRecipient.accountCommitment must contain 32 bytes",
      );
    }
    return {
      bytes: Uint8Array.from(recipient.accountCommitment),
      isAccount: true,
    };
  }
  throw new TypeError("creatorRecipient.kind must be address or account");
}

function requireString(name: string, value: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

function requireNonEmptyString(name: string, value: string): string {
  const normalized = requireString(name, value).trim();
  if (!normalized) throw new RangeError(`${name} must not be empty`);
  return normalized;
}

function normalizeBlastPackageId(packageId: string): string {
  if (typeof packageId !== "string") {
    throw new TypeError("blastPackageId must be a string");
  }
  const normalized = normalizeSuiObjectId(packageId);
  if (!isValidSuiObjectId(normalized)) {
    throw new TypeError("blastPackageId must be a valid Sui package ID");
  }
  if (SYSTEM_ADDRESSES.has(normalized)) {
    throw new RangeError(
      "blastPackageId must identify the deployed Blast package",
    );
  }
  return normalized;
}

function deserializeTemplate(bytecode: Uint8Array): CompiledModule {
  const value: unknown = deserialize(bytecode);
  if (!isRecord(value)) throw new TypeError("Meme template is not a module");
  if (
    !isStringArray(value.address_identifiers) ||
    !Array.isArray(value.constant_pool) ||
    !Array.isArray(value.function_handles) ||
    !isStringArray(value.identifiers) ||
    !Array.isArray(value.module_handles)
  ) {
    throw new TypeError("Meme template has invalid module tables");
  }
  return value as CompiledModule;
}

function patchBlastDependency(
  compiled: CompiledModule,
  blastPackageId: string,
): void {
  const candidates = compiled.address_identifiers.flatMap((address, index) =>
    SYSTEM_ADDRESSES.has(normalizeSuiObjectId(address)) ? [] : [index],
  );

  // ponytail: this supports one non-system dependency. Add named slots before
  // the template imports another external package.
  if (candidates.length !== 1) {
    throw new TypeError("Meme template must have one Blast dependency slot");
  }
  const index = candidates[0];
  if (index === undefined) {
    throw new TypeError("Meme template has no Blast dependency slot");
  }
  compiled.address_identifiers[index] = blastPackageId.slice(2);
}

function assertIdentifierSlots(
  compiled: CompiledModule,
  identifiers: MemeTemplateIdentifiers,
): void {
  const occupied = new Set(
    compiled.identifiers.filter(
      (identifier) => identifier !== "MEME" && identifier !== "meme",
    ),
  );
  if (occupied.has(identifiers.moduleName)) {
    throw new RangeError(
      `moduleName ${identifiers.moduleName} collides with the Meme template`,
    );
  }
  if (occupied.has(identifiers.witnessName)) {
    throw new RangeError(
      `witnessName ${identifiers.witnessName} collides with the Meme template`,
    );
  }
}

function patchConstantSlots(
  compiled: CompiledModule,
  patches: readonly {
    name: string;
    type: string;
    expected: Uint8Array;
    replacement: Uint8Array;
  }[],
): void {
  // Resolve every source slot before mutating. This is required when the
  // creator-kind and burnable boolean replacements swap true and false.
  const targets = patches.map((patch) => {
    const matches = compiled.constant_pool.flatMap((constant, index) =>
      constantTypeName(constant.type_) === patch.type &&
      bytesEqual(constant.data, patch.expected)
        ? [index]
        : [],
    );
    if (matches.length !== 1) {
      throw new TypeError(
        `Meme template must have one ${patch.name} constant slot`,
      );
    }
    return matches[0];
  });

  if (new Set(targets).size !== targets.length) {
    throw new TypeError("Meme template constant slots must be distinct");
  }
  patches.forEach((patch, patchIndex) => {
    const target = targets[patchIndex];
    if (target === undefined) throw new TypeError("Missing constant slot");
    const constant = compiled.constant_pool[target];
    if (!constant) throw new TypeError("Missing constant");
    constant.data = Array.from(patch.replacement);
  });
}

function assertTemplateWiring(
  bytecode: Uint8Array,
  blastPackageId: string,
  identifiers: MemeTemplateIdentifiers,
): void {
  const compiled = deserializeTemplate(bytecode);
  if (
    !compiled.identifiers.includes(identifiers.moduleName) ||
    !compiled.identifiers.includes(identifiers.witnessName)
  ) {
    throw new TypeError("Meme template identifiers were not patched");
  }

  const blastAddress = blastPackageId.slice(2);
  const launchTicketModule = compiled.module_handles.findIndex(
    (handle) =>
      compiled.address_identifiers[handle.address] === blastAddress &&
      compiled.identifiers[handle.name] === "launch_ticket",
  );
  if (
    launchTicketModule < 0 ||
    !compiled.function_handles.some(
      (handle) =>
        handle.module === launchTicketModule &&
        compiled.identifiers[handle.name] === "new",
    )
  ) {
    throw new TypeError("Meme template is not wired to launch_ticket::new");
  }

  const creatorAuthorityModule = compiled.module_handles.findIndex(
    (handle) =>
      compiled.address_identifiers[handle.address] === blastAddress &&
      compiled.identifiers[handle.name] === "creator_authority",
  );
  const recipientFunctions = compiled.function_handles.flatMap((handle) =>
    handle.module === creatorAuthorityModule
      ? [compiled.identifiers[handle.name]]
      : [],
  );
  if (
    !recipientFunctions.includes("new_address") ||
    !recipientFunctions.includes("new_account")
  ) {
    throw new TypeError(
      "Meme template must support address and account recipients",
    );
  }
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
