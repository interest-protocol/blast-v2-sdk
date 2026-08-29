import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { deserialize, get_constants } from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiObjectId } from "@mysten/sui/utils";

import {
  buildMemePackageBytecode,
  deriveMemeTemplateIdentifiers,
} from "../src/launchpad/template.ts";

const blastPackageId = normalizeSuiObjectId("0xb1a57");
const options = {
  symbol: "DOG COIN",
  name: "Dog Coin",
  description: "A good dog",
  iconUrl: "https://blast.fun/dog.png",
  burnable: true,
  sellBurnBps: 2_500n,
  creatorIdentity: { kind: "address", address: "0xc" } as const,
};

test("locks the embedded artifact to the eight source constants", async () => {
  const creatorIdentityBytes = Uint8Array.from(
    { length: 32 },
    (_, index) => index,
  );
  const defaults = {
    symbol: "MEME",
    name: "Blast Meme",
    description: "A Meme launched on Blast",
    iconUrl: "https://blast.fun/meme.png",
    burnable: false,
    sellBurnBps: 0n,
    creatorIdentity: {
      kind: "x" as const,
      xIdentityHash: creatorIdentityBytes,
    },
  };
  const bytecode = await buildMemePackageBytecode(defaults, "0x9d72");

  assert.equal(
    createHash("sha256").update(bytecode).digest("hex"),
    "3168a68c91959aabf6d44571f9a3ff68956cbdc4c26293126c6d22f4ebd48c31",
  );
  assert.deepEqual(get_constants(bytecode), [
    {
      type_: "Vector(U8)",
      value_bcs: Array.from(bcs.string().serialize(defaults.symbol).toBytes()),
    },
    {
      type_: "Vector(U8)",
      value_bcs: Array.from(bcs.string().serialize(defaults.name).toBytes()),
    },
    {
      type_: "Vector(U8)",
      value_bcs: Array.from(
        bcs.string().serialize(defaults.description).toBytes(),
      ),
    },
    {
      type_: "Vector(U8)",
      value_bcs: Array.from(bcs.string().serialize(defaults.iconUrl).toBytes()),
    },
    {
      type_: "Vector(U8)",
      value_bcs: Array.from(
        bcs
          .vector(bcs.u8())
          .serialize(Array.from(creatorIdentityBytes))
          .toBytes(),
      ),
    },
    {
      type_: "Bool",
      value_bcs: Array.from(bcs.bool().serialize(true).toBytes()),
    },
    {
      type_: "Bool",
      value_bcs: Array.from(bcs.bool().serialize(defaults.burnable).toBytes()),
    },
    {
      type_: "U64",
      value_bcs: Array.from(bcs.u64().serialize(defaults.sellBurnBps).toBytes()),
    },
  ]);
});

test("patches identifiers, constants, and the Blast dependency", async () => {
  const bytecode = await buildMemePackageBytecode(options, blastPackageId);
  const compiled = deserialize(bytecode) as {
    address_identifiers: string[];
    function_handles: { module: number; name: number }[];
    identifiers: string[];
    module_handles: { address: number; name: number }[];
  };

  assert.deepEqual(deriveMemeTemplateIdentifiers(options.symbol), {
    moduleName: "dog_coin",
    witnessName: "DOG_COIN",
  });
  assert.ok(compiled.identifiers.includes("dog_coin"));
  assert.ok(compiled.identifiers.includes("DOG_COIN"));
  assert.ok(compiled.address_identifiers.includes(blastPackageId.slice(2)));

  const launchTicketModule = compiled.module_handles.findIndex(
    (handle) =>
      compiled.address_identifiers[handle.address] === blastPackageId.slice(2) &&
      compiled.identifiers[handle.name] === "launch_ticket",
  );
  assert.notEqual(launchTicketModule, -1);
  assert.ok(
    compiled.function_handles.some(
      (handle) =>
        handle.module === launchTicketModule &&
        compiled.identifiers[handle.name] === "new",
    ),
  );

  const creatorAddress = bcs.Address.serialize(
    normalizeSuiObjectId(options.creatorIdentity.address),
  ).toBytes();
  assert.deepEqual(get_constants(bytecode), [
    {
      type_: "Vector(U8)",
      value_bcs: Array.from(bcs.string().serialize(options.symbol).toBytes()),
    },
    {
      type_: "Vector(U8)",
      value_bcs: Array.from(bcs.string().serialize(options.name).toBytes()),
    },
    {
      type_: "Vector(U8)",
      value_bcs: Array.from(
        bcs.string().serialize(options.description).toBytes(),
      ),
    },
    {
      type_: "Vector(U8)",
      value_bcs: Array.from(
        bcs.string().serialize(options.iconUrl).toBytes(),
      ),
    },
    {
      type_: "Vector(U8)",
      value_bcs: Array.from(
        bcs.vector(bcs.u8()).serialize(Array.from(creatorAddress)).toBytes(),
      ),
    },
    {
      type_: "Bool",
      value_bcs: Array.from(bcs.bool().serialize(false).toBytes()),
    },
    {
      type_: "Bool",
      value_bcs: Array.from(bcs.bool().serialize(options.burnable).toBytes()),
    },
    {
      type_: "U64",
      value_bcs: Array.from(bcs.u64().serialize(options.sellBurnBps).toBytes()),
    },
  ]);
});

test("patches a 32-byte X identity in the same compiled template", async () => {
  const xIdentityHash = Uint8Array.from(
    { length: 32 },
    (_, index) => 255 - index,
  );
  const bytecode = await buildMemePackageBytecode(
    {
      ...options,
      creatorIdentity: { kind: "x", xIdentityHash },
      burnable: false,
    },
    blastPackageId,
  );
  const constants = get_constants(bytecode);

  assert.deepEqual(constants[4], {
    type_: "Vector(U8)",
    value_bcs: Array.from(
      bcs.vector(bcs.u8()).serialize(Array.from(xIdentityHash)).toBytes(),
    ),
  });
  assert.deepEqual(constants[5], {
    type_: "Bool",
    value_bcs: Array.from(bcs.bool().serialize(true).toBytes()),
  });
  assert.deepEqual(constants[6], {
    type_: "Bool",
    value_bcs: Array.from(bcs.bool().serialize(false).toBytes()),
  });
});

test("keeps constant fields independent when values match placeholders", async () => {
  const bytecode = await buildMemePackageBytecode(
    {
      ...options,
      symbol: "Blast Meme",
      name: "A Meme launched on Blast",
      description: "https://blast.fun/meme.png",
    },
    blastPackageId,
  );
  const constants = get_constants(bytecode) as { value_bcs: number[] }[];

  for (const value of [
    "Blast Meme",
    "A Meme launched on Blast",
    "https://blast.fun/meme.png",
  ]) {
    const expected = bcs.string().serialize(value).toBytes();
    assert.equal(
      constants.filter(
        ({ value_bcs }) =>
          value_bcs.length === expected.length &&
          value_bcs.every((byte, index) => byte === expected[index]),
      ).length,
      1,
    );
  }
});

test("rejects invalid policy, dependency, and identifier inputs", async () => {
  await assert.rejects(
    buildMemePackageBytecode(
      {
        ...options,
        creatorIdentity: {
          kind: "x",
          xIdentityHash: new Uint8Array(31),
        },
      },
      blastPackageId,
    ),
    /32 bytes/,
  );
  await assert.rejects(
    buildMemePackageBytecode(
      {
        ...options,
        creatorIdentity: { kind: "address", address: "0x0" },
      },
      blastPackageId,
    ),
    /nonzero Sui address/,
  );
  await assert.rejects(
    buildMemePackageBytecode(
      { ...options, sellBurnBps: 10_001n },
      blastPackageId,
    ),
    /between 0 and 10,000/,
  );
  await assert.rejects(
    buildMemePackageBytecode(options, "0x2"),
    /deployed Blast package/,
  );
  await assert.rejects(
    buildMemePackageBytecode({ ...options, symbol: "BAD!" }, blastPackageId),
    /Move witness identifier/,
  );
  await assert.rejects(
    buildMemePackageBytecode({ ...options, symbol: "STRING" }, blastPackageId),
    /collides with the Meme template/,
  );
});
