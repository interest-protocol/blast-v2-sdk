import { serialize } from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import {
  fromBase64,
  MOVE_STDLIB_ADDRESS,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
  SUI_FRAMEWORK_ADDRESS,
} from "@mysten/sui/utils";

import { suiUidBcs, u64Bcs } from "../lib/bcs.ts";
import type { BytecodeTemplateInitOptions } from "../lib/bytecode-template.ts";
import {
  deserializeTemplate,
  initializeBytecodeTemplate,
  patchConstantSlots,
  requireNonEmptyString,
  requireString,
} from "../lib/bytecode-template.ts";
import { normalizeNonzeroSuiObjectId } from "../lib/sui.ts";

// An Aftermath sale migrates by consuming the `CreatePoolCapV2` its creation
// bound to it. Aftermath mints that capability only through
// `pool::create_pool_cap_and_set_decimals`, which stores the LP coin's
// `TreasuryCap<Lp>` and `CoinMetadata<Lp>` inside it as dynamic object fields
// under keys only the `pool` module can construct, so no Move code outside
// Aftermath, the vendor's `finalize` included, can tell whether the
// capability it is handed fits the pool `migrate` creates. A capability for
// another LP coin, or for one with other than nine decimals, binds the sale to
// a pool that can never be created: every `migrate` aborts, participants
// wait for the liquidity deadline to be refunded, and the sale token's whole
// supply stays locked forever. This module closes that gap off chain: it
// publishes the LP coin from a pinned template and reads the capability's
// contents back from the chain before a sale is created with it. The
// Aftermath builders take only the `AftermathLpCoin` that verification
// returns, never a capability ID.

// === Constants ===

/**
 * Aftermath's AMM package on mainnet: the defining package of
 * `pool::CreatePoolCapV2` and of the `TreasuryKey` and `MetadataKey` under
 * which a capability holds its LP coin's `TreasuryCap` and `CoinMetadata`.
 */
export const AFTERMATH_AMM_PACKAGE_ID =
  "0xf948935b111990c2b604900c9b2eeb8f24dcf9868a45d1ea1653a5f282c10e29";

/** The AMM's original package, which the LP coin module links for `pool`. */
const AFTERMATH_AMM_ORIGINAL_PACKAGE_ID =
  "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c";

/** The LP coin module: every LP coin's type is `<package>::af_lp::AF_LP`. */
export const AFTERMATH_LP_COIN_MODULE = "af_lp";
export const AFTERMATH_LP_COIN_WITNESS = "AF_LP";

/**
 * The LP decimals Aftermath's `new_pool` requires of a pool created without
 * coin decimals (its `DEFAULT_DECIMALS`), which is how the vendor creates
 * the sale's pool. The template fixes them; verification reads them back.
 */
export const AFTERMATH_LP_DECIMALS = 9;

/**
 * The packages an LP coin publication links, as the mainnet publication
 * `5FE2eVoacFwnLfixqRAGftH9UwWotxDt3BJUqkWHxWwQ` listed them: Aftermath's
 * AMM and its dependencies, the Move standard library and the Sui framework.
 */
export const AFTERMATH_LP_PACKAGE_DEPENDENCIES = [
  AFTERMATH_AMM_PACKAGE_ID,
  "0xbc7b2c577ad9362fbb0dba397d17f3bcc81bf7aa916559f99a77eaee05d0947c",
  "0xa6baab1e668c7868991c1c3c11e144100f5734c407d020f72a01b9d1a8bcb97f",
  MOVE_STDLIB_ADDRESS,
  "0x2d9316f1f1a95f6d7c85a4e690ef7c359e6649773ef2c37ad7d9857adb6bef06",
  "0xc66fabf1a9253e43c70f1cc02d40a1d18db183140ecaae2a3f58fa6b66c55acf",
  SUI_FRAMEWORK_ADDRESS,
  "0x64213b0e4a52bac468d4ac3f140242f70714381653a1919a6d57cd49c628207a",
  "0x73baa782c55003b3a359dec04b189312565d18e7309d4a51f5f112f891e3b2ab",
] as const;

// The LP coin module published on mainnet as package
// 0xda789adbb3dcbf4a41c05a462c33b34c954ea1381fe08ea700018108ab5b3526 by
// transaction 5FE2eVoacFwnLfixqRAGftH9UwWotxDt3BJUqkWHxWwQ. Its initializer
// calls `pool::create_pool_cap_and_set_decimals<AF_LP>` with 50/50 weights,
// coin decimals [9, 9] respected (so the LP coin has nine decimals), no icon,
// and transfers the `CreatePoolCapV2` to the sender. SHA-256:
// 083489f1a3d3f46d281fbac8214884200f0864c876d873775c0d78c73fe5abef
const TEMPLATE_BYTECODE_BASE64 =
  "oRzrCwcAAAUKAQAMAgwWAyInBEkKBVNrB74BvgEI/AKAAQb8A80BCskFBQzOBbMCAAUDDAELAhACEQISAAACAAEBDAACAgcBAAAEAwIABQQHAAAIAAEAAQYKCwECAgoBBwEAAg8GBwEAAw0OAQEMBA4MDQAFCQUIAAMFAggDCAEJBAsCCAAHCAMAFAMDCgMLAgEIBAsCAQoCCgIDAwMDAwMDAwsCAQgECgMDCgMKAwoDAQMBAgEKAgEJAAELAgEJAAEIBAEIAAoJAAoCCgIKAgsCAQgECwIBCgIBCgMDBwgDAQgBAQYIAwEFAgkABQVBRl9MUA9DcmVhdGVQb29sQ2FwVjIGT3B0aW9uCVR4Q29udGV4dANVcmwFYWZfbHAgY3JlYXRlX3Bvb2xfY2FwX2FuZF9zZXRfZGVjaW1hbHMLZHVtbXlfZmllbGQEaW5pdBVuZXdfdW5zYWZlX2Zyb21fYnl0ZXMEbm9uZQZvcHRpb24EcG9vbA9wdWJsaWNfdHJhbnNmZXIGc2VuZGVyBHNvbWUIdHJhbnNmZXIKdHhfY29udGV4dAN1cmwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALv4XDsC+TXYhlr7ezXoGWBZXYZimUnyZKColUaqn2jjAoCCAdWUFRFU1RDCgIcG1ZlcnNpb25lZCBwcmVzYWxlIHRlc3QgTFAgYwoCKCdMUCBjb2luIGZvciBWZXJzaW9uZWQgcHJlc2FsZSB0ZXN0IExQIGMKAgYFZW1wdHkDCAkJAAAAAAAAAQEBAwgAALLTWVvwBgMIEgCy01lb8AYDCCQAAAAAAAAAAwg2AAAAAAAAAAMISAAAAAAAAAADCFoAAAAAAAAAAwhsAAAAAAAAAAMIfgAAAAAAAAADCJAAAAAAAAAACgMBAAoCAQAAAgEHAQAAAAACfgcPDBQHBgcHBwgHCQcKBwsHDAcNQAMIAAAAAAAAAAwRDhFBAwwDBgAAAAAAAAAADAsLAwwPCgsKDyMENAoLDAwKDAwNDhELDEIDFAsNBhIAAAAAAAAAGBcMEgoSBgAAAAAAAAAAJAQpBSwLFAwEBTYNFAsSRAMLCwYBAAAAAAAAABYMCwUTCxQMBAsEDBMKEwwVBwQMCAcQDAcOFUEDDAIGAAAAAAAAAAAMCgsCDA4KCgoOIwRaCgoBDQcKCAb/AAAAAAAAABwzRAQLCDEIMAwICwoGAQAAAAAAAAAWDAoFRQsHOAAMBgcOBpAAAAAAAAAAFwwJBwMHAyEEaDgBDAUFbAcDEQY4AgwFCwUMEAsABwAHAQcCCxALBgcFCxMLCQoBOAMLAS4RBTgEAgAA";

const LABEL = "Aftermath LP coin template";

const defaults = {
  symbol: bcs.string().serialize("VPTESTC").toBytes(),
  name: bcs.string().serialize("Versioned presale test LP c").toBytes(),
  description: bcs
    .string()
    .serialize("LP coin for Versioned presale test LP c")
    .toBytes(),
} as const;

const SUI_FRAMEWORK = normalizeSuiAddress(SUI_FRAMEWORK_ADDRESS);

// === Verified LP coin ===

export type AftermathLpCoinFields = Readonly<{
  lpType: string;
  createPoolCapId: string;
  owner: string;
  ammPackageId: string;
  decimals: number;
}>;

let makeAftermathLpCoin: (fields: AftermathLpCoinFields) => AftermathLpCoin;
/** Set only while `makeAftermathLpCoin` runs: `new` from anywhere else throws. */
let constructing = false;

/**
 * An LP coin whose `CreatePoolCapV2` `verifyAftermathLpCoin` read back from
 * the chain: the capability holds that coin's `TreasuryCap` with nothing
 * minted and its `CoinMetadata` with `AFTERMATH_LP_DECIMALS`, so the pool
 * the sale's `migrate` creates can be created. Only verification constructs
 * one; a copy, a spread, or a JSON round trip loses the brand and the
 * builders refuse it, so verify again after persisting.
 */
export class AftermathLpCoin {
  /** The fresh LP coin `Lp`, the vendor's `finalize` and `migrate` type argument. */
  readonly lpType: string;
  /** The `CreatePoolCapV2` holding `Lp`'s `TreasuryCap` and `CoinMetadata`, consumed by `finalize`. */
  readonly createPoolCapId: string;
  /** The address that owns the capability; it must send the sale's creation. */
  readonly owner: string;
  /** Aftermath's AMM package, the capability's defining package. */
  readonly ammPackageId: string;
  /** `Lp`'s metadata decimals, `AFTERMATH_LP_DECIMALS`. */
  readonly decimals: number;
  readonly #verified = true;

  static {
    makeAftermathLpCoin = (fields) => {
      constructing = true;
      try {
        return new AftermathLpCoin(fields);
      } finally {
        constructing = false;
      }
    };
  }

  private constructor(fields: AftermathLpCoinFields) {
    if (!constructing) {
      throw new TypeError(
        "AftermathLpCoin is only created by verifyAftermathLpCoin",
      );
    }
    this.lpType = fields.lpType;
    this.createPoolCapId = fields.createPoolCapId;
    this.owner = fields.owner;
    this.ammPackageId = fields.ammPackageId;
    this.decimals = fields.decimals;
    Object.freeze(this);
  }

  /** Whether `value` is an instance verification returned, whatever its shape says. */
  static isVerified(value: unknown): value is AftermathLpCoin {
    return (
      typeof value === "object" &&
      value !== null &&
      #verified in value &&
      value.#verified
    );
  }
}

/**
 * The `AftermathLpCoin` verification returned, or a `TypeError`: a
 * capability ID, a look-alike object, or a persisted copy is refused.
 */
export function assertAftermathLpCoin(
  value: unknown,
  name = "lpCoin",
): AftermathLpCoin {
  if (!AftermathLpCoin.isVerified(value)) {
    throw new TypeError(
      `${name} must be the AftermathLpCoin that verifyAftermathLpCoin returned; an arbitrary CreatePoolCapV2 is refused`,
    );
  }
  return value;
}

// === Publication ===

export type AftermathLpCoinOptions = {
  /** ASCII printable; the LP coin's `CoinMetadata` symbol. */
  symbol: string;
  name: string;
  description: string;
};

export type PublishAftermathLpCoinOptions = AftermathLpCoinOptions & {
  /**
   * Receives the package's `UpgradeCap`; null makes the package immutable in
   * the same transaction, so nobody can ever change the LP coin's module.
   */
  upgradeCapRecipient: string | null;
};

/**
 * Initializes the bytecode-template WASM helper, shared with the coin and
 * Meme templates. A browser can supply its WASM URL when the bundler cannot
 * discover the package asset automatically.
 */
export function initializeAftermathLpCoinTemplate(
  options?: BytecodeTemplateInitOptions,
): Promise<void> {
  return initializeBytecodeTemplate(options);
}

/**
 * Builds the one-module LP coin package from the pinned mainnet template with
 * `options`' symbol, name and description: its initializer mints the
 * `CreatePoolCapV2` for `<package>::af_lp::AF_LP`, a nine-decimal LP coin,
 * and transfers it to the publisher. Nothing else in the module can change.
 */
export async function buildAftermathLpCoinBytecode(
  options: AftermathLpCoinOptions,
): Promise<Uint8Array> {
  const settings = validateLpCoinOptions(options);
  await initializeAftermathLpCoinTemplate();

  const compiled = deserializeTemplate(
    LABEL,
    fromBase64(TEMPLATE_BYTECODE_BASE64),
  );
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
  ]);
  const bytecode = serialize(compiled);
  assertLpCoinTemplateWiring(bytecode);
  return bytecode;
}

/**
 * Publishes a fresh LP coin for one Aftermath sale: the sender receives its
 * `CreatePoolCapV2`. Read the capability back with
 * `verifyAftermathLpCoinPublication` (or `findAftermathLpCoinPublication`
 * and `verifyAftermathLpCoin`) to obtain the `AftermathLpCoin` the sale's
 * creation takes.
 */
export function publishAftermathLpCoin(
  options: PublishAftermathLpCoinOptions,
): Transaction {
  const tx = new Transaction();
  const upgradeCap = tx.add(async (innerTx) => {
    const module = await buildAftermathLpCoinBytecode(options);
    return innerTx.publish({
      modules: [Array.from(module)],
      dependencies: [...AFTERMATH_LP_PACKAGE_DEPENDENCIES],
    });
  });
  if (options.upgradeCapRecipient === null) {
    tx.moveCall({
      target: `${SUI_FRAMEWORK_ADDRESS}::package::make_immutable`,
      arguments: [upgradeCap],
    });
  } else {
    tx.transferObjects(
      [upgradeCap],
      normalizeSuiAddress(options.upgradeCapRecipient),
    );
  }
  return tx;
}

/** What an LP coin publication created, before verification. */
export type AftermathLpCoinPublication = {
  /** The publishing transaction. */
  digest: string;
  /** The LP coin package it published. */
  packageId: string;
  lpType: string;
  createPoolCapId: string;
};

/**
 * The LP coin and `CreatePoolCapV2` a publication created, from its effects
 * and object types (`getTransaction` with `effects` and `objectTypes`). The
 * transaction must have succeeded and created exactly one capability and one
 * `CoinMetadata`, for a coin of a package it published. Verify the result
 * with `verifyAftermathLpCoin` before creating the sale.
 */
export function findAftermathLpCoinPublication(
  transaction: Pick<
    SuiClientTypes.Transaction<{ effects: true; objectTypes: true }>,
    "digest" | "effects" | "objectTypes"
  >,
  options: { ammPackageId?: string } = {},
): AftermathLpCoinPublication {
  const amm = ammAddress(options.ammPackageId);
  const { digest, effects, objectTypes } = transaction;
  if (!effects.status.success) {
    throw new TypeError(`transaction ${digest} failed`);
  }
  const types = new Map(
    Object.entries(objectTypes).map(([objectId, type]) => [
      normalizeSuiObjectId(objectId),
      type,
    ]),
  );
  const created = effects.changedObjects.filter(
    (change) => change.idOperation === "Created",
  );
  const packages = new Set(
    created
      .filter((change) => change.outputState === "PackageWrite")
      .map((change) => normalizeSuiObjectId(change.objectId)),
  );
  const caps = created.filter(
    (change) =>
      structTagOrNull(types.get(normalizeSuiObjectId(change.objectId))) ===
      poolType(amm, "CreatePoolCapV2"),
  );
  const lpTypes = created.flatMap((change) => {
    const coinType = coinTypeParameter(
      types.get(normalizeSuiObjectId(change.objectId)),
      "CoinMetadata",
    );
    return coinType === null ? [] : [coinType];
  });
  const [cap] = caps;
  const [lpType] = lpTypes;
  if (caps.length !== 1 || cap === undefined) {
    throw new TypeError(
      `transaction ${digest} must create one Aftermath CreatePoolCapV2`,
    );
  }
  if (lpTypes.length !== 1 || lpType === undefined) {
    throw new TypeError(`transaction ${digest} must create one CoinMetadata`);
  }
  const packageId = parseStructTag(lpType).address;
  if (!packages.has(packageId)) {
    throw new TypeError(
      `transaction ${digest} did not publish the package of ${lpType}`,
    );
  }
  return {
    digest,
    packageId,
    lpType,
    createPoolCapId: normalizeSuiObjectId(cap.objectId),
  };
}

// === Verification ===

export type VerifyAftermathLpCoinOptions = {
  createPoolCapId: string;
  /** The LP coin the capability must hold, when known. */
  lpType?: string;
  /** The address that must own the capability: the sale's creator. */
  owner?: string;
  /** Aftermath's AMM package; defaults to `AFTERMATH_AMM_PACKAGE_ID`. */
  ammPackageId?: string;
};

/**
 * Reads `createPoolCapId` from the chain and returns its `AftermathLpCoin`
 * when it is an address-owned Aftermath `CreatePoolCapV2` holding exactly
 * two dynamic object fields, `TreasuryKey` to a `TreasuryCap<Lp>` with
 * nothing minted and `MetadataKey` to a `CoinMetadata<Lp>` with
 * `AFTERMATH_LP_DECIMALS`, for the same `Lp` (and `options.lpType`, when
 * given), owned by `options.owner` when given. Any other capability throws
 * a `TypeError` naming what is wrong, so a sale is never created with a
 * capability its migration cannot consume. Verify again right before
 * creation if time has passed: the result describes the chain as read.
 */
export async function verifyAftermathLpCoin(
  client: ClientWithCoreApi,
  options: VerifyAftermathLpCoinOptions,
): Promise<AftermathLpCoin> {
  const createPoolCapId = normalizeNonzeroSuiObjectId(
    "createPoolCapId",
    options.createPoolCapId,
  );
  const ammPackageId = ammAddress(options.ammPackageId);
  const owner = await readCreatePoolCapOwner(
    client,
    createPoolCapId,
    ammPackageId,
  );
  if (
    options.owner !== undefined &&
    normalizeSuiAddress(options.owner) !== owner
  ) {
    throw new TypeError(
      `CreatePoolCapV2 ${createPoolCapId} is owned by ${owner}, not ${normalizeSuiAddress(options.owner)}`,
    );
  }

  const fields = await listCapabilityFields(client, createPoolCapId);
  if (fields.length !== 2) {
    throw new TypeError(
      `CreatePoolCapV2 ${createPoolCapId} must hold exactly its LP coin's TreasuryCap and CoinMetadata`,
    );
  }
  const lpType = await readLpTreasuryCap(
    client,
    fieldChild(fields, poolType(ammPackageId, "TreasuryKey"), createPoolCapId),
    createPoolCapId,
  );
  const metadata = await readLpCoinMetadata(
    client,
    fieldChild(fields, poolType(ammPackageId, "MetadataKey"), createPoolCapId),
    createPoolCapId,
  );
  if (metadata.lpType !== lpType) {
    throw new TypeError(
      `CreatePoolCapV2 ${createPoolCapId} holds a TreasuryCap<${lpType}> but a CoinMetadata<${metadata.lpType}>`,
    );
  }
  if (
    options.lpType !== undefined &&
    normalizeStructTag(options.lpType) !== lpType
  ) {
    throw new TypeError(
      `CreatePoolCapV2 ${createPoolCapId} holds ${lpType}, not ${normalizeStructTag(options.lpType)}`,
    );
  }
  return makeAftermathLpCoin({
    lpType,
    createPoolCapId,
    owner,
    ammPackageId,
    decimals: metadata.decimals,
  });
}

/**
 * Reads the LP coin publication `digest` and verifies the capability it
 * created: `findAftermathLpCoinPublication` then `verifyAftermathLpCoin`,
 * with the publication's coin as the capability's expected `lpType`.
 */
export async function verifyAftermathLpCoinPublication(
  client: ClientWithCoreApi,
  digest: string,
  options: Omit<
    VerifyAftermathLpCoinOptions,
    "createPoolCapId" | "lpType"
  > = {},
): Promise<AftermathLpCoin> {
  const result = await client.core.getTransaction({
    digest,
    include: { effects: true, objectTypes: true },
  });
  const transaction = result.Transaction ?? result.FailedTransaction;
  const publication = findAftermathLpCoinPublication(transaction, options);
  return verifyAftermathLpCoin(client, {
    ...options,
    createPoolCapId: publication.createPoolCapId,
    lpType: publication.lpType,
  });
}

// === Private ===

const treasuryCapBcs = bcs.struct("TreasuryCap", {
  id: suiUidBcs,
  total_supply: bcs.struct("Supply", { value: u64Bcs }),
});

/** Leading fields of `CoinMetadata`; its strings and icon follow, unread. */
const coinMetadataPrefixBcs = bcs.struct("CoinMetadata", {
  id: suiUidBcs,
  decimals: bcs.u8(),
});

function validateLpCoinOptions(options: AftermathLpCoinOptions) {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Aftermath LP coin options are required");
  }
  const symbol = requireNonEmptyString("symbol", options.symbol);
  if (!/^[\x20-\x7e]+$/.test(symbol)) {
    throw new RangeError("symbol must be ASCII printable");
  }
  return {
    symbol,
    name: requireNonEmptyString("name", options.name),
    description: requireString("description", options.description),
  };
}

function assertLpCoinTemplateWiring(bytecode: Uint8Array): void {
  const compiled = deserializeTemplate(LABEL, bytecode);
  if (
    !compiled.identifiers.includes(AFTERMATH_LP_COIN_MODULE) ||
    !compiled.identifiers.includes(AFTERMATH_LP_COIN_WITNESS)
  ) {
    throw new TypeError(`${LABEL} lost its module or witness`);
  }
  const linked = new Set(
    [
      normalizeSuiAddress("0x0"),
      MOVE_STDLIB_ADDRESS,
      SUI_FRAMEWORK_ADDRESS,
      AFTERMATH_AMM_ORIGINAL_PACKAGE_ID,
    ].map((address) => normalizeSuiAddress(address).slice(2)),
  );
  if (!compiled.address_identifiers.every((address) => linked.has(address))) {
    throw new TypeError(
      `${LABEL} must link only the Move standard library, the Sui framework and Aftermath's AMM`,
    );
  }
}

function ammAddress(packageId: string | undefined): string {
  return normalizeSuiAddress(packageId ?? AFTERMATH_AMM_PACKAGE_ID);
}

function poolType(amm: string, name: string): string {
  return `${amm}::pool::${name}`;
}

function structTagOrNull(type: string | undefined): string | null {
  if (type === undefined) return null;
  try {
    return normalizeStructTag(type);
  } catch {
    return null;
  }
}

/** `C` of `0x2::coin::<name><C>`, or null for any other type. */
function coinTypeParameter(
  type: string | undefined,
  name: "TreasuryCap" | "CoinMetadata",
): string | null {
  if (type === undefined) return null;
  let tag: ReturnType<typeof parseStructTag>;
  try {
    tag = parseStructTag(type);
  } catch {
    return null;
  }
  const [coinType, ...extra] = tag.typeParams;
  if (
    tag.address !== SUI_FRAMEWORK ||
    tag.module !== "coin" ||
    tag.name !== name ||
    coinType === undefined ||
    extra.length > 0
  ) {
    return null;
  }
  return normalizeStructTag(coinType);
}

async function readCreatePoolCapOwner(
  client: ClientWithCoreApi,
  objectId: string,
  amm: string,
): Promise<string> {
  const { object } = await client.core.getObject({ objectId });
  if (structTagOrNull(object.type) !== poolType(amm, "CreatePoolCapV2")) {
    throw new TypeError(
      `object ${objectId} is not an Aftermath CreatePoolCapV2`,
    );
  }
  if (object.owner.$kind !== "AddressOwner") {
    throw new TypeError(
      `CreatePoolCapV2 ${objectId} is not owned by an address`,
    );
  }
  return normalizeSuiAddress(object.owner.AddressOwner);
}

async function listCapabilityFields(
  client: ClientWithCoreApi,
  parentId: string,
): Promise<SuiClientTypes.DynamicFieldEntry[]> {
  const fields: SuiClientTypes.DynamicFieldEntry[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.core.listDynamicFields({ parentId, cursor });
    fields.push(...page.dynamicFields);
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor !== null);
  return fields;
}

/**
 * The child object of the one dynamic object field named `keyType`. A
 * transport may report a dynamic object field's name as the key itself or
 * as `dynamic_object_field::Wrapper<key>`; both are the same field.
 */
function fieldChild(
  fields: readonly SuiClientTypes.DynamicFieldEntry[],
  keyType: string,
  capId: string,
): string {
  const matches = fields.filter(
    (field) => dynamicFieldKeyType(field) === keyType,
  );
  const [field] = matches;
  if (matches.length !== 1 || field === undefined) {
    throw new TypeError(
      `CreatePoolCapV2 ${capId} must hold one ${keyType} field`,
    );
  }
  if (field.$kind !== "DynamicObject") {
    throw new TypeError(
      `CreatePoolCapV2 ${capId}'s ${keyType} field is not an object`,
    );
  }
  return normalizeSuiObjectId(field.childId);
}

function dynamicFieldKeyType(field: SuiClientTypes.DynamicFieldEntry): string {
  let tag: ReturnType<typeof parseStructTag>;
  try {
    tag = parseStructTag(field.name.type);
  } catch {
    return field.name.type;
  }
  const [wrapped] = tag.typeParams;
  if (
    tag.address === SUI_FRAMEWORK &&
    tag.module === "dynamic_object_field" &&
    tag.name === "Wrapper" &&
    wrapped !== undefined
  ) {
    return normalizeStructTag(wrapped);
  }
  return normalizeStructTag(tag);
}

async function readLpTreasuryCap(
  client: ClientWithCoreApi,
  objectId: string,
  capId: string,
): Promise<string> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  const lpType = coinTypeParameter(object.type, "TreasuryCap");
  if (lpType === null) {
    throw new TypeError(`CreatePoolCapV2 ${capId} does not hold a TreasuryCap`);
  }
  const parsed = treasuryCapBcs.parse(object.content);
  assertUid(parsed.id.id.bytes, objectId);
  if (parsed.total_supply.value !== 0n) {
    throw new TypeError(
      `CreatePoolCapV2 ${capId}'s TreasuryCap<${lpType}> has minted ${parsed.total_supply.value}`,
    );
  }
  return lpType;
}

async function readLpCoinMetadata(
  client: ClientWithCoreApi,
  objectId: string,
  capId: string,
): Promise<{ lpType: string; decimals: number }> {
  const { object } = await client.core.getObject({
    objectId,
    include: { content: true },
  });
  const lpType = coinTypeParameter(object.type, "CoinMetadata");
  if (lpType === null) {
    throw new TypeError(
      `CreatePoolCapV2 ${capId} does not hold a CoinMetadata`,
    );
  }
  const parsed = coinMetadataPrefixBcs.parse(object.content);
  assertUid(parsed.id.id.bytes, objectId);
  if (parsed.decimals !== AFTERMATH_LP_DECIMALS) {
    throw new TypeError(
      `CreatePoolCapV2 ${capId}'s LP coin ${lpType} has ${parsed.decimals} decimals, not ${AFTERMATH_LP_DECIMALS}`,
    );
  }
  return { lpType, decimals: parsed.decimals };
}

function assertUid(uid: string, objectId: string): void {
  if (normalizeSuiObjectId(uid) !== normalizeSuiObjectId(objectId)) {
    throw new TypeError(`object ${objectId} has a mismatched UID`);
  }
}
