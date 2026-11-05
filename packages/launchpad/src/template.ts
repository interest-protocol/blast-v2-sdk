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
import {
  requireBasisPoints,
  requireU64,
} from "@interest-protocol/blast-core/integers";
import { serialize, update_identifiers } from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";
import {
  fromBase64,
  fromHex,
  isValidSuiObjectId,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";
import { MAX_SELL_BURN_BPS } from "./curve.ts";

/** Exact whole-token supply of every generated Meme. */
export const MEME_TOTAL_SUPPLY_WHOLE_TOKENS = 1_000_000_000n;

const ZERO_ADDRESS = normalizeSuiObjectId("0x0");

// Built from contracts/sui/launch_ticket_template/sources/meme.move at contracts
// commit 7efd9342 with Sui CLI 1.77.2-51d177ad7d65 (`sui move build
// --with-unpublished-dependencies`), `blast_fun` bound to 0xda74 and
// `blast_core` to 0xc0de. Its initializer transfers the `LaunchTicket<Meme>`
// and the `SealedTreasuryCap<Meme>` to the publisher. SHA-256:
// 7a51d20899341936f9d93ec012872062dab2168e82b08fa97e2765123b78a426
const TEMPLATE_BYTECODE_BASE64 =
  "oRzrCwcAAAUKAQAQAhAcAywqBFYGBVxRB60B9gEIowOgAQbDBIcBCsoFBQzPBVAADAMRBAcECwETAgYCFAIVAAICAAEDDAEAAQIABwADAQwBAAEEBAcABwUCAAAKAAEAAg4DBAACDwUEAAMNCAkBAgQWAwYABQkDBQAGEAwBAQwHEgoFAAMHBgsGDQIIAAcIBQADCAIIAgsBAQgAAQoCAQgCAQUBCAQBCAAKCQACCAQIBAgECAQIAgEDBwgFAgsDAQkACwEBCQABBggFAQsDAQgAAgkABQELAQEIABBDcmVhdG9yUmVjaXBpZW50DExhdW5jaFRpY2tldARNRU1FEVNlYWxlZFRyZWFzdXJ5Q2FwBlN0cmluZwlUeENvbnRleHQHYWRkcmVzcxFjcmVhdG9yX2F1dGhvcml0eQtkdW1teV9maWVsZApmcm9tX2J5dGVzBGluaXQNbGF1bmNoX3RpY2tldARtZW1lA25ldwtuZXdfYWNjb3VudAtuZXdfYWRkcmVzcw9wdWJsaWNfdHJhbnNmZXITc2VhbGVkX3RyZWFzdXJ5X2NhcAZzZW5kZXIGc3RyaW5nCHRyYW5zZmVyCnR4X2NvbnRleHQEdXRmOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2nQKAgUETUVNRQoCCwpCbGFzdCBNZW1lCgIZGEEgTWVtZSBsYXVuY2hlZCBvbiBCbGFzdAoCGxpodHRwczovL2JsYXN0LmZ1bi9tZW1lLnBuZwoCISAAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHwEBAQIBCQEBAAMIAAAAAAAAAAAAAgEIAQAAAAACJgcFBAYHBBEBDAIFCgcEEQURAgwCCwIMAwsABwYHABEEBwERBAcCEQQHAxEECwMHBwcICgE4AAwECgEuEQc4AQsECwEuEQc4AgIAAA==";

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
  decimals: bcs.u8().serialize(9).toBytes(),
  burnable: bcs.bool().serialize(false).toBytes(),
  sellBurnBps: bcs.u64().serialize(0n).toBytes(),
} as const;

const LABEL = "Meme template";

export type MemeTemplateOptions = {
  /** Decimal precision; launch intake admits only `LaunchConfig`-allowed values. */
  decimals: number;
  symbol: string;
  name: string;
  description: string;
  iconUrl: string;
  burnable: boolean;
  sellBurnBps: bigint;
  creatorRecipient: MemeCreatorRecipientInput;
  /** Defaults to the lowercased symbol; the witness is the uppercased module name. */
  moduleName?: string;
};

export type MemeCreatorRecipientInput =
  | { kind: "address"; address: string }
  | { kind: "account"; accountCommitment: Uint8Array };

export type MemeTemplateIdentifiers = {
  moduleName: string;
  witnessName: string;
};

export type MemeTemplateInitOptions = BytecodeTemplateInitOptions;

/**
 * The packages a generated Meme package links by original ID: the launchpad
 * (`launch_ticket`, `creator_authority`) and `blast_core`
 * (`sealed_treasury_cap`). A `LaunchpadDeployment` is one.
 */
export type MemePackageDependencies = {
  originalPackageId: string;
  core: { originalPackageId: string };
};

/**
 * Initializes the bytecode-template WASM helper, shared with the coin
 * template. A browser can supply its WASM URL when the bundler cannot
 * discover the package asset automatically.
 */
export function initializeMemeTemplate(
  options?: MemeTemplateInitOptions,
): Promise<void> {
  return initializeBytecodeTemplate(options);
}

/**
 * Builds the one-module Meme package used by the launch intake.
 *
 * Its initializer creates the selected address or Blast account recipient, calls
 * `blast_fun::launch_ticket::new` at the selected decimals, and transfers the
 * ticket and the `SealedTreasuryCap<Meme>` (sealed under the launchpad by
 * `blast_core::sealed_treasury_cap`, so no one mints before `launch::new`) to
 * the publisher, who prepares the venue and starts the launch with both
 * (`LaunchpadTransactions.createLaunch`).
 */
export async function buildMemePackageBytecode(
  options: MemeTemplateOptions,
  deployment: MemePackageDependencies,
): Promise<Uint8Array> {
  const metadata = validateOptions(options);
  const creatorRecipient = validateCreatorRecipient(options.creatorRecipient);
  const dependencies = {
    launchpad: requireDependencyPackageId(
      "originalPackageId",
      deployment.originalPackageId,
    ),
    core: requireDependencyPackageId(
      "core.originalPackageId",
      deployment.core.originalPackageId,
    ),
  };
  const identifiers = deriveMemeTemplateIdentifiers(
    metadata.symbol,
    options.moduleName,
  );
  await initializeMemeTemplate();

  const compiled = deserializeTemplate(
    LABEL,
    fromBase64(TEMPLATE_BYTECODE_BASE64),
  );
  assertIdentifierSlots(LABEL, compiled, ["MEME", "meme"], identifiers);
  patchDependencyAddresses(LABEL, compiled, {
    launch_ticket: dependencies.launchpad,
    creator_authority: dependencies.launchpad,
    sealed_treasury_cap: dependencies.core,
  });
  patchConstantSlots(LABEL, compiled, [
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
      name: "decimals",
      type: "U8",
      expected: defaults.decimals,
      replacement: bcs.u8().serialize(metadata.decimals).toBytes(),
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
  assertTemplateWiring(bytecode, dependencies, identifiers);
  return bytecode;
}

/**
 * Mirrors `launch_ticket::atomic_supply`: one billion whole tokens at
 * `decimals`. A precision whose supply exceeds `u64` aborts in Move and throws
 * here.
 */
export function memeAtomicSupply(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("decimals must be a u8");
  }
  return requireU64(
    "Meme atomic supply",
    MEME_TOTAL_SUPPLY_WHOLE_TOKENS * 10n ** BigInt(decimals),
  );
}

/** Derives the launch module name and its uppercase one-time-witness name. */
export function deriveMemeTemplateIdentifiers(
  symbol: string,
  requestedModuleName?: string,
): MemeTemplateIdentifiers {
  return deriveTemplateIdentifiers(symbol, requestedModuleName);
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

  const symbol = requireNonEmptyString("symbol", options.symbol);
  memeAtomicSupply(options.decimals);

  return {
    decimals: options.decimals,
    symbol,
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

function assertTemplateWiring(
  bytecode: Uint8Array,
  dependencies: { launchpad: string; core: string },
  identifiers: MemeTemplateIdentifiers,
): void {
  const compiled = deserializeTemplate(LABEL, bytecode);
  if (
    !compiled.identifiers.includes(identifiers.moduleName) ||
    !compiled.identifiers.includes(identifiers.witnessName)
  ) {
    throw new TypeError("Meme template identifiers were not patched");
  }

  const moduleAt = (packageId: string, name: string) =>
    compiled.module_handles.findIndex(
      (handle) =>
        compiled.address_identifiers[handle.address] === packageId.slice(2) &&
        compiled.identifiers[handle.name] === name,
    );
  if (moduleAt(dependencies.core, "sealed_treasury_cap") < 0) {
    throw new TypeError("Meme template is not wired to the core seal");
  }
  const blastAddress = dependencies.launchpad.slice(2);
  const launchTicketModule = moduleAt(dependencies.launchpad, "launch_ticket");
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
