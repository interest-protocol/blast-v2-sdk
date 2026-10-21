import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { deserialize, get_constants } from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

import type { AftermathLpCoinOptions } from "../src/presale/aftermath-lp.ts";
import {
  AFTERMATH_AMM_PACKAGE_ID,
  AFTERMATH_LP_DECIMALS,
  AFTERMATH_LP_PACKAGE_DEPENDENCIES,
  AftermathLpCoin,
  assertAftermathLpCoin,
  buildAftermathLpCoinBytecode,
  findAftermathLpCoinPublication,
  publishAftermathLpCoin,
  verifyAftermathLpCoin,
  verifyAftermathLpCoinPublication,
} from "../src/presale/aftermath-lp.ts";
import type { FakeLpCoinChain } from "./aftermath-lp.ts";
import {
  AMM,
  fakeLpCoinClient,
  METADATA_ID,
  OWNER,
  TREASURY_ID,
  verifiedLpCoin,
} from "./aftermath-lp.ts";

const LP_PACKAGE = normalizeSuiAddress("0xda78");
const LP = normalizeStructTag(`${LP_PACKAGE}::af_lp::AF_LP`);
const CAP = normalizeSuiObjectId("0xc3da");
const SUI = normalizeSuiAddress("0x2");

/** The mainnet publication's constants, which the template embeds. */
const mainnet: AftermathLpCoinOptions = {
  symbol: "VPTESTC",
  name: "Versioned presale test LP c",
  description: "LP coin for Versioned presale test LP c",
};

const options: AftermathLpCoinOptions = {
  symbol: "MEME-SUI LP",
  name: "Meme / SUI Aftermath LP",
  description: "LP coin of a Blast presale's Aftermath pool",
};

function constants(bytecode: Uint8Array) {
  return get_constants(bytecode).map(
    (constant: { type_: string; value_bcs: number[] }) => [
      constant.type_,
      constant.value_bcs,
    ],
  );
}

const string = (value: string) =>
  Array.from(bcs.string().serialize(value).toBytes());

// === Template ===

test("locks the embedded template to the mainnet LP coin publication", async () => {
  const bytecode = await buildAftermathLpCoinBytecode(mainnet);
  assert.equal(
    createHash("sha256").update(bytecode).digest("hex"),
    "083489f1a3d3f46d281fbac8214884200f0864c876d873775c0d78c73fe5abef",
  );
});

test("patches the symbol, name and description and nothing else", async () => {
  const original = constants(await buildAftermathLpCoinBytecode(mainnet));
  const bytecode = await buildAftermathLpCoinBytecode(options);
  const patched = constants(bytecode);

  assert.deepEqual(patched.slice(0, 3), [
    ["Vector(U8)", string("MEME-SUI LP")],
    ["Vector(U8)", string("Meme / SUI Aftermath LP")],
    ["Vector(U8)", string("LP coin of a Blast presale's Aftermath pool")],
  ]);
  assert.deepEqual(patched.slice(3), original.slice(3));

  const compiled = deserialize(bytecode) as {
    identifiers: string[];
    address_identifiers: string[];
  };
  // The module and witness are fixed: every LP coin is `<package>::af_lp::AF_LP`.
  assert.ok(compiled.identifiers.includes("af_lp"));
  assert.ok(compiled.identifiers.includes("AF_LP"));
  assert.deepEqual(
    [...compiled.address_identifiers].sort(),
    [
      "0x0",
      "0x1",
      "0x2",
      "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c",
    ]
      .map((address) => normalizeSuiAddress(address).slice(2))
      .sort(),
  );
});

test("merges colliding strings so the verifier accepts the module", async () => {
  const bytecode = await buildAftermathLpCoinBytecode({
    symbol: "LP",
    name: "LP",
    description: "LP",
  });
  const keys: string[] = constants(bytecode).map(
    ([type, value]: [string, number[]]) => `${type}:${value.join(",")}`,
  );
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(
    keys.filter((key) => key === `Vector(U8):${string("LP")}`).length,
    1,
  );
});

test("rejects a symbol that is not ASCII printable, and empty names", async () => {
  await assert.rejects(
    buildAftermathLpCoinBytecode({ ...options, symbol: "MÈME" }),
    /ASCII printable/,
  );
  await assert.rejects(
    buildAftermathLpCoinBytecode({ ...options, symbol: " " }),
    /symbol must not be empty/,
  );
  await assert.rejects(
    buildAftermathLpCoinBytecode({ ...options, name: "" }),
    /name must not be empty/,
  );
  await assert.rejects(
    buildAftermathLpCoinBytecode(null as unknown as AftermathLpCoinOptions),
    /options are required/,
  );
});

test("publishes against Aftermath's AMM and makes the package immutable, or hands over its UpgradeCap", async () => {
  const immutable = publishAftermathLpCoin({
    ...options,
    upgradeCapRecipient: null,
  });
  await immutable.prepareForSerialization({});
  const [publish, makeImmutable] = immutable.getData().commands;
  assert.equal(publish?.$kind, "Publish");
  if (publish?.$kind === "Publish") {
    assert.deepEqual(
      publish.Publish.dependencies,
      AFTERMATH_LP_PACKAGE_DEPENDENCIES.map((id) => normalizeSuiAddress(id)),
    );
    assert.ok(
      publish.Publish.dependencies.includes(
        normalizeSuiAddress(AFTERMATH_AMM_PACKAGE_ID),
      ),
    );
    assert.equal(publish.Publish.modules.length, 1);
  }
  assert.equal(makeImmutable?.$kind, "MoveCall");
  if (makeImmutable?.$kind === "MoveCall") {
    assert.equal(makeImmutable.MoveCall.module, "package");
    assert.equal(makeImmutable.MoveCall.function, "make_immutable");
  }

  const kept = publishAftermathLpCoin({
    ...options,
    upgradeCapRecipient: "0xc0ffee",
  });
  await kept.prepareForSerialization({});
  assert.equal(kept.getData().commands[1]?.$kind, "TransferObjects");
  assert.ok((await kept.build({ onlyTransactionKind: true })).length > 0);
});

// === Publication ===

type Publication = Parameters<typeof findAftermathLpCoinPublication>[0];

function publication(
  overrides: {
    success?: boolean;
    created?: { objectId: string; type?: string; package?: boolean }[];
  } = {},
): Publication {
  const created = overrides.created ?? [
    { objectId: LP_PACKAGE, package: true },
    { objectId: "0xa3e8", type: `${SUI}::package::UpgradeCap` },
    { objectId: METADATA_ID, type: `${SUI}::coin::CoinMetadata<${LP}>` },
    { objectId: TREASURY_ID, type: `${SUI}::coin::TreasuryCap<${LP}>` },
    { objectId: CAP, type: `${AMM}::pool::CreatePoolCapV2` },
    {
      objectId: "0xb3d7",
      type: `${SUI}::dynamic_field::Field<${SUI}::dynamic_object_field::Wrapper<${AMM}::pool::MetadataKey>,${SUI}::object::ID>`,
    },
  ];
  const changedObjects = [
    // A mutated gas coin, which is not created.
    {
      objectId: normalizeSuiObjectId("0x9a5"),
      idOperation: "None",
      outputState: "ObjectWrite",
    },
    ...created.map((object) => ({
      objectId: normalizeSuiObjectId(object.objectId),
      idOperation: "Created",
      outputState: object.package ? "PackageWrite" : "ObjectWrite",
    })),
  ];
  const objectTypes = Object.fromEntries(
    created.flatMap((object) =>
      object.type ? [[normalizeSuiObjectId(object.objectId), object.type]] : [],
    ),
  );
  return {
    digest: "publication",
    effects: {
      status:
        overrides.success === false
          ? { success: false, error: { $kind: "Unknown" } }
          : { success: true, error: null },
      changedObjects,
    },
    objectTypes,
  } as unknown as Publication;
}

test("finds the LP coin and capability a publication created", () => {
  assert.deepEqual(findAftermathLpCoinPublication(publication()), {
    digest: "publication",
    packageId: LP_PACKAGE,
    lpType: LP,
    createPoolCapId: CAP,
  });
});

test("refuses a publication that is not one fresh LP coin with one capability", () => {
  assert.throws(
    () => findAftermathLpCoinPublication(publication({ success: false })),
    /transaction publication failed/,
  );
  assert.throws(
    () =>
      findAftermathLpCoinPublication(
        publication({
          created: [
            { objectId: LP_PACKAGE, package: true },
            {
              objectId: METADATA_ID,
              type: `${SUI}::coin::CoinMetadata<${LP}>`,
            },
            { objectId: CAP, type: `${AMM}::pool::CreatePoolCapV2` },
            { objectId: "0xc3db", type: `${AMM}::pool::CreatePoolCapV2` },
          ],
        }),
      ),
    /one Aftermath CreatePoolCapV2/,
  );
  assert.throws(
    () =>
      findAftermathLpCoinPublication(
        publication({
          created: [
            { objectId: LP_PACKAGE, package: true },
            { objectId: CAP, type: `${AMM}::pool::CreatePoolCapV2` },
          ],
        }),
      ),
    /one CoinMetadata/,
  );
  // A capability of some other AMM, or an LP coin from a package published earlier.
  assert.throws(
    () =>
      findAftermathLpCoinPublication(publication(), {
        ammPackageId: "0xa1",
      }),
    /one Aftermath CreatePoolCapV2/,
  );
  assert.throws(
    () =>
      findAftermathLpCoinPublication(
        publication({
          created: [
            {
              objectId: METADATA_ID,
              type: `${SUI}::coin::CoinMetadata<${LP}>`,
            },
            { objectId: CAP, type: `${AMM}::pool::CreatePoolCapV2` },
          ],
        }),
      ),
    /did not publish the package/,
  );
});

test("verifies a publication by its digest, with its coin as the expected LP type", async () => {
  const { client, requests } = fakeLpCoinClient({
    createPoolCapId: CAP,
    lpType: LP,
    transaction: publication(),
  });
  const lpCoin = await verifyAftermathLpCoinPublication(client, "publication", {
    owner: OWNER,
  });
  assert.ok(AftermathLpCoin.isVerified(lpCoin));
  assert.equal(lpCoin.lpType, LP);
  assert.equal(lpCoin.createPoolCapId, CAP);
  assert.deepEqual(
    requests.map(({ method }) => method),
    [
      "getTransaction",
      "getObject",
      "listDynamicFields",
      "getObject",
      "getObject",
    ],
  );
  assert.deepEqual(requests[0]?.request, {
    digest: "publication",
    include: { effects: true, objectTypes: true },
  });

  // The capability on chain holds another coin than the publication created.
  const other = fakeLpCoinClient({
    createPoolCapId: CAP,
    lpType: `${normalizeSuiAddress("0xda79")}::af_lp::AF_LP`,
    transaction: publication(),
  });
  await assert.rejects(
    verifyAftermathLpCoinPublication(other.client, "publication"),
    /holds .*, not/,
  );
});

// === Verification ===

test("verifies an address-owned capability holding a fresh nine-decimal LP coin", async () => {
  const { client, requests } = fakeLpCoinClient({
    createPoolCapId: "0xc3da",
    lpType: LP,
  });
  const lpCoin = await verifyAftermathLpCoin(client, {
    createPoolCapId: "0xc3da",
  });
  assert.ok(lpCoin instanceof AftermathLpCoin);
  assert.ok(AftermathLpCoin.isVerified(lpCoin));
  assert.equal(assertAftermathLpCoin(lpCoin), lpCoin);
  assert.deepEqual(
    { ...lpCoin },
    {
      lpType: LP,
      createPoolCapId: CAP,
      owner: OWNER,
      ammPackageId: AMM,
      decimals: AFTERMATH_LP_DECIMALS,
    },
  );
  assert.ok(Object.isFrozen(lpCoin));
  assert.throws(() => {
    (lpCoin as { lpType: string }).lpType = "0x1::sui::SUI";
  });
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["getObject", "listDynamicFields", "getObject", "getObject"],
  );
  assert.deepEqual(
    requests.slice(2).map(({ request }) => request),
    [
      { objectId: TREASURY_ID, include: { content: true } },
      { objectId: METADATA_ID, include: { content: true } },
    ],
  );
});

test("accepts wrapped field names and paged listings; the expected coin and owner may be given", async () => {
  for (const wrapKeys of [false, true]) {
    const { client } = fakeLpCoinClient({
      createPoolCapId: CAP,
      lpType: LP,
      wrapKeys,
      paged: true,
    });
    const lpCoin = await verifyAftermathLpCoin(client, {
      createPoolCapId: CAP,
      lpType: `${LP_PACKAGE}::af_lp::AF_LP`,
      owner: "0xca7",
      ammPackageId: AFTERMATH_AMM_PACKAGE_ID,
    });
    assert.equal(lpCoin.lpType, LP);
    assert.equal(lpCoin.owner, OWNER);
  }
});

test("refuses every capability its migration could not consume", async () => {
  const cases: [string, Partial<FakeLpCoinChain>, RegExp][] = [
    [
      "a legacy CreatePoolCap",
      { capType: `${AMM}::pool::CreatePoolCap` },
      /not an Aftermath CreatePoolCapV2/,
    ],
    [
      "another package's capability",
      { capType: `${normalizeSuiAddress("0xa1")}::pool::CreatePoolCapV2` },
      /not an Aftermath CreatePoolCapV2/,
    ],
    [
      "a shared capability",
      {
        capOwner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
      },
      /not owned by an address/,
    ],
    [
      "a missing field",
      { fields: (defaults) => defaults.slice(0, 1) },
      /exactly its LP coin's TreasuryCap and CoinMetadata/,
    ],
    [
      "an extra field",
      { fields: (defaults) => [...defaults, ...defaults.slice(0, 1)] },
      /exactly its LP coin's TreasuryCap and CoinMetadata/,
    ],
    [
      "two treasuries and no metadata",
      { fields: (defaults) => [defaults[1], defaults[1]] as typeof defaults },
      /must hold one .*TreasuryKey field/,
    ],
    [
      "a plain dynamic field",
      {
        fields: (defaults) =>
          defaults.map((field) =>
            field.name.type.endsWith("TreasuryKey")
              ? { ...field, $kind: "DynamicField", childId: undefined }
              : field,
          ) as typeof defaults,
      },
      /TreasuryKey field is not an object/,
    ],
    [
      "a treasury that minted",
      { treasurySupply: 5n },
      /TreasuryCap<.*> has minted 5/,
    ],
    [
      "a coin instead of a treasury",
      { treasuryType: `${SUI}::coin::Coin<${LP}>` },
      /does not hold a TreasuryCap/,
    ],
    ["six LP decimals", { metadataDecimals: 6 }, /has 6 decimals, not 9/],
    [
      "metadata of another coin",
      { metadataLpType: `${normalizeSuiAddress("0xda79")}::af_lp::AF_LP` },
      /holds a TreasuryCap<.*> but a CoinMetadata</,
    ],
  ];
  for (const [name, chain, expected] of cases) {
    const { client } = fakeLpCoinClient({
      createPoolCapId: CAP,
      lpType: LP,
      ...chain,
    });
    await assert.rejects(
      verifyAftermathLpCoin(client, { createPoolCapId: CAP }),
      expected,
      name,
    );
  }

  const { client } = fakeLpCoinClient({ createPoolCapId: CAP, lpType: LP });
  await assert.rejects(
    verifyAftermathLpCoin(client, {
      createPoolCapId: CAP,
      lpType: `${normalizeSuiAddress("0xda79")}::af_lp::AF_LP`,
    }),
    /holds .*, not/,
  );
  await assert.rejects(
    verifyAftermathLpCoin(client, { createPoolCapId: CAP, owner: "0xb0b" }),
    /is owned by .*, not/,
  );
  await assert.rejects(
    verifyAftermathLpCoin(client, { createPoolCapId: "0x0" }),
    /must not be the zero address/,
  );
  await assert.rejects(
    verifyAftermathLpCoin(client, { createPoolCapId: "0xdead" }),
    /missing/,
  );
});

// === The brand ===

test("only verification yields an AftermathLpCoin; copies and persisted forms are refused", async () => {
  const lpCoin = await verifiedLpCoin(LP, CAP);
  assert.ok(AftermathLpCoin.isVerified(lpCoin));

  const lookalikes: unknown[] = [
    { ...lpCoin },
    JSON.parse(JSON.stringify(lpCoin)),
    Object.assign(Object.create(AftermathLpCoin.prototype), { ...lpCoin }),
    { lpType: LP, createPoolCapId: CAP },
    CAP,
    null,
    undefined,
  ];
  for (const value of lookalikes) {
    assert.equal(AftermathLpCoin.isVerified(value), false);
    assert.throws(
      () => assertAftermathLpCoin(value),
      /lpCoin must be the AftermathLpCoin that verifyAftermathLpCoin returned/,
    );
  }
  assert.throws(
    () => assertAftermathLpCoin(CAP, "terms.lpCoin"),
    /terms.lpCoin must be/,
  );
  // The class cannot be constructed from outside the module, even by `new`.
  const Constructor = AftermathLpCoin as unknown as new (
    fields: unknown,
  ) => object;
  assert.throws(
    () => new Constructor({ ...lpCoin }),
    /only created by verifyAftermathLpCoin/,
  );
  class Forged extends Constructor {}
  assert.throws(
    () => new Forged({ ...lpCoin }),
    /only created by verifyAftermathLpCoin/,
  );
  assert.throws(
    () => Reflect.construct(Constructor, [{ ...lpCoin }], Forged),
    /only created by verifyAftermathLpCoin/,
  );
  // A failed construction leaves verification working.
  assert.ok(AftermathLpCoin.isVerified(await verifiedLpCoin(LP, CAP)));
});
