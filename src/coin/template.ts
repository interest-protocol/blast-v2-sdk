import { serialize, update_identifiers } from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";
import {
  fromBase64,
  isValidSuiAddress,
  MOVE_STDLIB_ADDRESS,
  normalizeSuiAddress,
  SUI_FRAMEWORK_ADDRESS,
} from "@mysten/sui/utils";

import type { BytecodeTemplateInitOptions } from "../lib/bytecode-template.ts";
import {
  assertIdentifierSlots,
  deriveTemplateIdentifiers,
  deserializeTemplate,
  initializeBytecodeTemplate,
  patchConstantSlots,
  requireNonEmptyString,
  requireString,
} from "../lib/bytecode-template.ts";
import { requireU64 } from "../lib/integers.ts";

// Built from contracts/sui/coin_template/sources/my_coin.move at contracts
// commit 86d29e1 (ADR 0108) with Sui CLI 1.77.2-51d177ad7d65. SHA-256:
// f175d5053793e7add203f76273745be16048638a3dd8835c2a936a8bb350679f
const TEMPLATE_BYTECODE_BASE64 =
  "oRzrCwcAAAUKAQAMAgwkAzA5BGkSBXuPAQeKArkCCMMEYAajBaECCsQHBQzJB78BABEBFAIHAggCFQIWAAICAAEEBwACAAwBAAECBQwBAAEDAQABAAEDAwwBAAEFBgIAAA0AAQAACQIBAAEXAwQAAhAJCgEAAwsPEAEAAwwPAQEAAw4OAQEAAw8OAQEAAxIHCAECBBMMAQEMCAYDBgkLCQ0HBgYGBAYJEQUGAggABwgGAA0IAAIIAQgBCAEIAQMFAgUBBQcIBgEKAgEIAQQGAgILBAEIAAsDAQgAAQgABwkAAggBCAEIAQgBBwgGAgsEAQkACwMBCQADBwsDAQkAAwcIBgELAgEJAAELAgEIAAIJAAUBCwMBCAACBwsEAQkACwMBCQACCwQBCQAHCAYBCwUBCQABCwUBCAAEQ29pbhNDdXJyZW5jeUluaXRpYWxpemVyB01ZX0NPSU4LTWV0YWRhdGFDYXAGU3RyaW5nC1RyZWFzdXJ5Q2FwCVR4Q29udGV4dARjb2luDWNvaW5fcmVnaXN0cnkbY3JlYXRlX2FuZF9kZWxpdmVyX2N1cnJlbmN5C2R1bW15X2ZpZWxkCGZpbmFsaXplIGZpbmFsaXplX2FuZF9kZWxldGVfbWV0YWRhdGFfY2FwBGluaXQabWFrZV9zdXBwbHlfYnVybl9vbmx5X2luaXQWbWFrZV9zdXBwbHlfZml4ZWRfaW5pdARtaW50B215X2NvaW4VbmV3X2N1cnJlbmN5X3dpdGhfb3R3D3B1YmxpY190cmFuc2ZlcgZzdHJpbmcIdHJhbnNmZXIKdHhfY29udGV4dAR1dGY4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACCgIFBENPSU4KAggHTXkgQ29pbgoCGBdBIGNvaW4gY3JlYXRlZCBvbiBCbGFzdAoCGxpodHRwczovL2JsYXN0LmZ1bi9jb2luLnBuZwIBCQMIAABkp7O24A0FIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF7hAgEBBSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8qQEBAQUgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPnoKAhMSRUludmFsaWRTdXBwbHlNb2RlCgJDQlRoZSBzdXBwbHkgbW9kZSBtdXN0IGJlIDAgKG1pbnRhYmxlKSwgMSAoZml4ZWQpLCBvciAyIChidXJuLW9ubHkpLgACAQoBAAAAAAETCwAHBAcAEQIHARECBwIRAgcDEQIHBQcGBwcHCAcJBwoLAREBAgABAAAABUQKCDECJQQFBQkLDAEGDAALAFcAAMAnCwALAQsCCwMLBAsFCgw4AAwQDA8KBgYAAAAAAAAAACQEHQ0QCwYKDDgBCwc4AgsIDA4ODgwNCg0UMQAhBCwLDQELEAsJOAMFOAsNFDEBIQQ1DQ8LEDgEBTgNDwsQOAULCgRACw8LDDgGCws4BwVDCw8LDDgIAgAA";

const LABEL = "coin template";

/** The template's placeholder module and one-time-witness names. */
const PLACEHOLDERS = ["MY_COIN", "my_coin"] as const;

const defaults = {
  symbol: bcs.string().serialize("COIN").toBytes(),
  name: bcs.string().serialize("My Coin").toBytes(),
  description: bcs.string().serialize("A coin created on Blast").toBytes(),
  iconUrl: bcs.string().serialize("https://blast.fun/coin.png").toBytes(),
  decimals: bcs.u8().serialize(9).toBytes(),
  initialSupply: bcs.u64().serialize(1_000_000_000_000_000_000n).toBytes(),
  supplyRecipient: bcs.Address.serialize("0x5ee1").toBytes(),
  supplyMode: bcs.u8().serialize(1).toBytes(),
  treasuryCapRecipient: bcs.Address.serialize("0x7ca9").toBytes(),
  metadataMutable: bcs.bool().serialize(true).toBytes(),
  metadataCapRecipient: bcs.Address.serialize("0x3e7a").toBytes(),
} as const;

/** `SUPPLY_MODE` values the template's initializer accepts. */
const SUPPLY_MODES = { mintable: 0, fixed: 1, burnOnly: 2 } as const;

/**
 * How the coin's supply may change after publication.
 * - `mintable`: the `TreasuryCap` goes to `treasuryCapRecipient`, who may mint and burn.
 * - `fixed`: the `TreasuryCap` is consumed; the supply never changes.
 * - `burnOnly`: the `TreasuryCap` is consumed; any holder may burn through the `Currency`.
 */
export type CoinSupplyMode =
  | { kind: "mintable"; treasuryCapRecipient: string }
  | { kind: "fixed" }
  | { kind: "burnOnly" };

export type CoinTemplateOptions = {
  /** ASCII printable; the Coin Registry rejects anything else. */
  symbol: string;
  name: string;
  description: string;
  iconUrl: string;
  decimals: number;
  /** Atomic units minted at publication; `0n` mints nothing (mintable only). */
  initialSupply: bigint;
  /** Receives the initial supply as one `Coin`. */
  supplyRecipient: string;
  supply: CoinSupplyMode;
  /**
   * Receives the `MetadataCap`; null deletes it, freezing the metadata for
   * good.
   */
  metadataCapRecipient: string | null;
  /** Defaults to the lowercased symbol; the witness is the uppercased symbol. */
  moduleName?: string;
};

export type CoinTemplateIdentifiers = {
  moduleName: string;
  witnessName: string;
};

/**
 * Initializes the bytecode-template WASM helper, shared with the Meme template.
 * A browser can supply its WASM URL when the bundler cannot discover the
 * package asset automatically.
 */
export function initializeCoinTemplate(
  options?: BytecodeTemplateInitOptions,
): Promise<void> {
  return initializeBytecodeTemplate(options);
}

/**
 * Builds the one-module standalone coin package of contracts ADR 0108. Its
 * initializer creates the currency through the Coin Registry, mints
 * `initialSupply` to `supplyRecipient`, settles the `TreasuryCap` by the
 * supply mode, and delivers or deletes the `MetadataCap`. It depends only on
 * the Move standard library and the Sui framework: Blast holds no authority
 * over the coin, and it can never launch on Blast.
 */
export async function buildCoinPackageBytecode(
  options: CoinTemplateOptions,
): Promise<Uint8Array> {
  const settings = validateCoinOptions(options);
  const identifiers = deriveCoinTemplateIdentifiers(
    settings.symbol,
    options.moduleName,
  );
  await initializeCoinTemplate();

  const compiled = deserializeTemplate(
    LABEL,
    fromBase64(TEMPLATE_BYTECODE_BASE64),
  );
  assertIdentifierSlots(LABEL, compiled, PLACEHOLDERS, identifiers);
  patchConstantSlots(LABEL, compiled, [
    {
      name: "symbol",
      type: "Vector(U8)",
      expected: defaults.symbol,
      replacement: bcs.string().serialize(settings.symbol).toBytes(),
    },
    {
      name: "name",
      type: "Vector(U8)",
      expected: defaults.name,
      replacement: bcs.string().serialize(settings.name).toBytes(),
    },
    {
      name: "description",
      type: "Vector(U8)",
      expected: defaults.description,
      replacement: bcs.string().serialize(settings.description).toBytes(),
    },
    {
      name: "iconUrl",
      type: "Vector(U8)",
      expected: defaults.iconUrl,
      replacement: bcs.string().serialize(settings.iconUrl).toBytes(),
    },
    {
      name: "decimals",
      type: "U8",
      expected: defaults.decimals,
      replacement: bcs.u8().serialize(settings.decimals).toBytes(),
    },
    {
      name: "initialSupply",
      type: "U64",
      expected: defaults.initialSupply,
      replacement: bcs.u64().serialize(settings.initialSupply).toBytes(),
    },
    {
      name: "supplyRecipient",
      type: "Address",
      expected: defaults.supplyRecipient,
      replacement: bcs.Address.serialize(settings.supplyRecipient).toBytes(),
    },
    {
      name: "supplyMode",
      type: "U8",
      expected: defaults.supplyMode,
      replacement: bcs.u8().serialize(settings.supplyMode).toBytes(),
    },
    {
      name: "treasuryCapRecipient",
      type: "Address",
      expected: defaults.treasuryCapRecipient,
      replacement: bcs.Address.serialize(
        settings.treasuryCapRecipient,
      ).toBytes(),
    },
    {
      name: "metadataMutable",
      type: "Bool",
      expected: defaults.metadataMutable,
      replacement: bcs.bool().serialize(settings.metadataMutable).toBytes(),
    },
    {
      name: "metadataCapRecipient",
      type: "Address",
      expected: defaults.metadataCapRecipient,
      replacement: bcs.Address.serialize(
        settings.metadataCapRecipient,
      ).toBytes(),
    },
  ]);

  const bytecode = update_identifiers(serialize(compiled), {
    MY_COIN: identifiers.witnessName,
    my_coin: identifiers.moduleName,
  });
  assertCoinTemplateWiring(bytecode, identifiers);
  return bytecode;
}

/** The module and one-time-witness names the coin type takes from its symbol. */
export function deriveCoinTemplateIdentifiers(
  symbol: string,
  requestedModuleName?: string,
): CoinTemplateIdentifiers {
  return deriveTemplateIdentifiers(symbol, requestedModuleName);
}

/** The packages a coin package links: the Move standard library and the Sui framework. */
export const COIN_PACKAGE_DEPENDENCIES = [
  MOVE_STDLIB_ADDRESS,
  SUI_FRAMEWORK_ADDRESS,
] as const;

/**
 * Checks every option before patching, so the initializer cannot abort at
 * publication: a printable symbol, a `u8` precision, a `u64` supply that is
 * nonzero unless mintable, and nonzero recipients. A recipient the mode
 * leaves unused keeps the template default.
 */
function validateCoinOptions(options: CoinTemplateOptions) {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("coin template options are required");
  }
  const symbol = requireNonEmptyString("symbol", options.symbol);
  if (!/^[\x20-\x7e]+$/.test(symbol)) {
    throw new RangeError("symbol must be ASCII printable");
  }
  const { decimals } = options;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("decimals must be a u8");
  }
  if (typeof options.initialSupply !== "bigint") {
    throw new TypeError("initialSupply must be a bigint");
  }
  const initialSupply = requireU64("initialSupply", options.initialSupply);
  const { supply } = options;
  const supplyMode = SUPPLY_MODES[supply?.kind];
  if (supplyMode === undefined) {
    throw new TypeError("supply.kind must be mintable, fixed, or burnOnly");
  }
  if (supply.kind !== "mintable" && initialSupply === 0n) {
    throw new RangeError(
      "a fixed or burn-only supply must mint a nonzero initial supply",
    );
  }
  const metadataMutable = options.metadataCapRecipient !== null;

  return {
    symbol,
    name: requireNonEmptyString("name", options.name),
    description: requireString("description", options.description),
    iconUrl: requireString("iconUrl", options.iconUrl),
    decimals,
    initialSupply,
    supplyRecipient: initialSupply
      ? recipient("supplyRecipient", options.supplyRecipient)
      : normalizeSuiAddress("0x5ee1"),
    supplyMode,
    treasuryCapRecipient:
      supply.kind === "mintable"
        ? recipient("supply.treasuryCapRecipient", supply.treasuryCapRecipient)
        : normalizeSuiAddress("0x7ca9"),
    metadataMutable,
    metadataCapRecipient: metadataMutable
      ? recipient("metadataCapRecipient", options.metadataCapRecipient ?? "")
      : normalizeSuiAddress("0x3e7a"),
  };
}

function recipient(name: string, address: string): string {
  if (typeof address !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  const normalized = normalizeSuiAddress(address);
  if (!isValidSuiAddress(normalized) || BigInt(normalized) === 0n) {
    throw new RangeError(`${name} must be a nonzero Sui address`);
  }
  return normalized;
}

function assertCoinTemplateWiring(
  bytecode: Uint8Array,
  identifiers: CoinTemplateIdentifiers,
): void {
  const compiled = deserializeTemplate(LABEL, bytecode);
  if (
    !compiled.identifiers.includes(identifiers.moduleName) ||
    !compiled.identifiers.includes(identifiers.witnessName)
  ) {
    throw new TypeError("coin template identifiers were not patched");
  }
  const systemAddresses = new Set(
    [normalizeSuiAddress("0x0"), ...COIN_PACKAGE_DEPENDENCIES].map((address) =>
      normalizeSuiAddress(address).slice(2),
    ),
  );
  if (
    !compiled.address_identifiers.every((address) =>
      systemAddresses.has(address),
    )
  ) {
    throw new TypeError("coin template must link only 0x1 and 0x2");
  }
}
