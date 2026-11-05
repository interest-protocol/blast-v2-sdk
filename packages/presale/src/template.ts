import type { BytecodeTemplateInitOptions } from "@interest-protocol/blast-core/bytecode-template";
import {
  assertIdentifierSlots,
  deriveTemplateIdentifiers,
  deserializeTemplate,
  initializeBytecodeTemplate,
  patchConstantSlots,
  patchDependencyAddresses,
  requireDependencyPackageId,
  requireNonEmptyString,
  requireString,
} from "@interest-protocol/blast-core/bytecode-template";
import { normalizeNonzeroSuiObjectId } from "@interest-protocol/blast-core/sui";
import { serialize, update_identifiers } from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";

// Built from contracts/sui/presale_coin_template/sources/presale_coin.move at
// contracts commit 7efd9342 with Sui CLI 1.77.2-51d177ad7d65 (`sui move build
// --with-unpublished-dependencies`), `blast_presale` bound to 0x5a1e and
// `blast_core` to 0xc0de. Its initializer transfers the
// `SealedTreasuryCap<SaleToken>` to the publisher and delivers or deletes the
// `MetadataCap`. SHA-256:
// 7a3afd900b037f11863e55de2824acc6d60c001eee5293963c9d1d82d1b61a6f
const TEMPLATE_BYTECODE_BASE64 =
  "oRzrCwcAAAUKAQAOAg4eAywnBFMKBV1aB7cBgAIItwOgAQbXBHsK0gUFDNcFQwAMBA8DDgERAgYCEgITAAICAAEDDAEAAQMEBwAEAAABAAEEAQwBAAEGBQIAAAoAAQACCwYHAQIDFAMEAAQIDA0BAAQJDAEBAAUNCwEBDAYQCAkAAQUFCgMFBQ4EBQIIAAcIBQACCwMBCAALAQEIAAEKAgEIAgEIAAcJAAIIAggCCAIIAgcIBQILAwEJAAsBAQkAAQYIBQEFAQsBAQgAAgkABQILAwEJAAcIBQELBAEJAAELBAEIABNDdXJyZW5jeUluaXRpYWxpemVyC01ldGFkYXRhQ2FwDFBSRVNBTEVfQ09JThFTZWFsZWRUcmVhc3VyeUNhcAZTdHJpbmcJVHhDb250ZXh0DWNvaW5fcmVnaXN0cnkLZHVtbXlfZmllbGQIZmluYWxpemUgZmluYWxpemVfYW5kX2RlbGV0ZV9tZXRhZGF0YV9jYXAEaW5pdANuZXcMcHJlc2FsZV9jb2luD3B1YmxpY190cmFuc2ZlcgpzYWxlX3Rva2VuE3NlYWxlZF90cmVhc3VyeV9jYXAGc2VuZGVyBnN0cmluZwh0cmFuc2Zlcgp0eF9jb250ZXh0BHV0ZjgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABaHgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDeCgIFBFNBTEUKAhEQQmxhc3QgU2FsZSBUb2tlbgoCFhVBIHRva2VuIHNvbGQgb24gQmxhc3QKAhsaaHR0cHM6Ly9ibGFzdC5mdW4vc2FsZS5wbmcCAQkBAQEFIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD56AAIBBwEAAAAAAh8LAAcEBwARAgcBEQIHAhECBwMRAgoBOAAMAwwCCwMKAS4RBjgBBwUEGwsCCwE4AgcGOAMFHgsCCwE4BAIAAA==";

const LABEL = "presale coin template";

/** The template's placeholder module and one-time-witness names. */
const PLACEHOLDERS = ["PRESALE_COIN", "presale_coin"] as const;

const defaults = {
  symbol: bcs.string().serialize("SALE").toBytes(),
  name: bcs.string().serialize("Blast Sale Token").toBytes(),
  description: bcs.string().serialize("A token sold on Blast").toBytes(),
  iconUrl: bcs.string().serialize("https://blast.fun/sale.png").toBytes(),
  decimals: bcs.u8().serialize(9).toBytes(),
  metadataMutable: bcs.bool().serialize(true).toBytes(),
  metadataCapRecipient: bcs.Address.serialize("0x3e7a").toBytes(),
} as const;

export type PresaleCoinTemplateOptions = {
  /** ASCII printable; the Coin Registry rejects anything else. */
  symbol: string;
  name: string;
  description: string;
  iconUrl: string;
  decimals: number;
  /**
   * Receives the `MetadataCap`; null deletes it, freezing the metadata for
   * good.
   */
  metadataCapRecipient: string | null;
  /** Defaults to the lowercased symbol; the witness is the uppercased module name. */
  moduleName?: string;
};

/**
 * The packages a generated sale-token package links by original ID: the
 * presale (`sale_token`) and `blast_core` (`sealed_treasury_cap`). A
 * `PresaleDeployment` is one.
 */
export type PresaleCoinPackageDependencies = {
  originalPackageId: string;
  core: { originalPackageId: string };
};

/**
 * Initializes the bytecode-template WASM helper, shared with every template.
 * A browser can supply its WASM URL when the bundler cannot discover the
 * package asset automatically.
 */
export function initializePresaleCoinTemplate(
  options?: BytecodeTemplateInitOptions,
): Promise<void> {
  return initializeBytecodeTemplate(options);
}

/**
 * Builds the one-module sale-token package of contracts ADR 0138. Its
 * initializer creates the currency through `blast_presale::sale_token::new`,
 * which seals the `TreasuryCap` under the presale from birth, transfers the
 * `SealedTreasuryCap<SaleToken>` to the publisher, who can never mint through
 * the seal, and delivers or deletes the `MetadataCap`. Only this package's
 * coins can start a presale: `blast_presale::new` opens the seal.
 */
export async function buildPresaleCoinPackageBytecode(
  options: PresaleCoinTemplateOptions,
  deployment: PresaleCoinPackageDependencies,
): Promise<Uint8Array> {
  const settings = validateOptions(options);
  const dependencies = {
    presale: requireDependencyPackageId(
      "originalPackageId",
      deployment.originalPackageId,
    ),
    core: requireDependencyPackageId(
      "core.originalPackageId",
      deployment.core.originalPackageId,
    ),
  };
  const identifiers = deriveTemplateIdentifiers(
    settings.symbol,
    options.moduleName,
  );
  await initializePresaleCoinTemplate();

  const compiled = deserializeTemplate(
    LABEL,
    fromBase64(TEMPLATE_BYTECODE_BASE64),
  );
  assertIdentifierSlots(LABEL, compiled, PLACEHOLDERS, identifiers);
  patchDependencyAddresses(LABEL, compiled, {
    sale_token: dependencies.presale,
    sealed_treasury_cap: dependencies.core,
  });
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
    [PLACEHOLDERS[0]]: identifiers.witnessName,
    [PLACEHOLDERS[1]]: identifiers.moduleName,
  });
  assertTemplateWiring(bytecode, dependencies, identifiers);
  return bytecode;
}

/** Derives the sale-token module name and its uppercase one-time-witness name. */
export function derivePresaleCoinTemplateIdentifiers(
  symbol: string,
  requestedModuleName?: string,
): { moduleName: string; witnessName: string } {
  return deriveTemplateIdentifiers(symbol, requestedModuleName);
}

function validateOptions(options: PresaleCoinTemplateOptions) {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("presale coin template options are required");
  }
  const symbol = requireNonEmptyString("symbol", options.symbol);
  if (!/^[\x20-\x7e]+$/.test(symbol)) {
    throw new RangeError("symbol must be ASCII printable");
  }
  const { decimals } = options;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("decimals must be a u8");
  }
  const metadataMutable = options.metadataCapRecipient !== null;
  return {
    symbol,
    name: requireNonEmptyString("name", options.name),
    description: requireString("description", options.description),
    iconUrl: requireString("iconUrl", options.iconUrl),
    decimals,
    metadataMutable,
    metadataCapRecipient: metadataMutable
      ? normalizeNonzeroSuiObjectId(
          "metadataCapRecipient",
          options.metadataCapRecipient ?? "",
        )
      : normalizeSuiAddress("0x3e7a"),
  };
}

function assertTemplateWiring(
  bytecode: Uint8Array,
  dependencies: { presale: string; core: string },
  identifiers: { moduleName: string; witnessName: string },
): void {
  const compiled = deserializeTemplate(LABEL, bytecode);
  if (
    !compiled.identifiers.includes(identifiers.moduleName) ||
    !compiled.identifiers.includes(identifiers.witnessName)
  ) {
    throw new TypeError(`${LABEL} identifiers were not patched`);
  }
  const moduleAt = (packageId: string, name: string) =>
    compiled.module_handles.findIndex(
      (handle) =>
        compiled.address_identifiers[handle.address] === packageId.slice(2) &&
        compiled.identifiers[handle.name] === name,
    );
  if (moduleAt(dependencies.core, "sealed_treasury_cap") < 0) {
    throw new TypeError(`${LABEL} is not wired to the core seal`);
  }
  const saleTokenModule = moduleAt(dependencies.presale, "sale_token");
  if (
    saleTokenModule < 0 ||
    !compiled.function_handles.some(
      (handle) =>
        handle.module === saleTokenModule &&
        compiled.identifiers[handle.name] === "new",
    )
  ) {
    throw new TypeError(`${LABEL} is not wired to sale_token::new`);
  }
}
