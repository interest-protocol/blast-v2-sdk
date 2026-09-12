import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { deserialize, get_constants } from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";
import {
  MOVE_STDLIB_ADDRESS,
  normalizeSuiObjectId,
  SUI_FRAMEWORK_ADDRESS,
} from "@mysten/sui/utils";

import {
  buildMemePackageBytecode,
  deriveMemeTemplateIdentifiers,
} from "../src/launchpad/template.ts";
import { LaunchpadTransactions } from "../src/launchpad/transactions.ts";

const blastPackageId = normalizeSuiObjectId("0xb1a57");
const latestBlastPackageId = normalizeSuiObjectId("0xb1a58");
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
  const bytecode = await buildMemePackageBytecode(defaults, "0xda74");

  assert.equal(
    createHash("sha256").update(bytecode).digest("hex"),
    "6747a1c0711a6ff8b94f7fc3f015f462e7ce11ec4b2d58ff2b2bd416357309c1",
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
      value_bcs: Array.from(
        bcs.u64().serialize(defaults.sellBurnBps).toBytes(),
      ),
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
      compiled.address_identifiers[handle.address] ===
        blastPackageId.slice(2) &&
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
      value_bcs: Array.from(bcs.string().serialize(options.iconUrl).toBytes()),
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

test("publishes against 0x1, 0x2, and Blast, then makes the package immutable", async () => {
  const tx = new LaunchpadTransactions({
    packageId: latestBlastPackageId,
    originalPackageId: blastPackageId,
    packageVersion: {
      objectId: "0x3",
      initialSharedVersion: "10",
      mutable: false,
    },
    launchConfig: {
      objectId: "0x4",
      initialSharedVersion: "11",
      mutable: false,
    },
    runtimeConfig: {
      objectId: "0x5",
      initialSharedVersion: "12",
      mutable: false,
    },
    protocolAuthority: {
      objectId: "0x6",
      initialSharedVersion: "13",
      mutable: false,
    },
  }).publishMeme(options);

  await tx.prepareForSerialization({});
  const commands = tx.getData().commands;
  assert.equal(commands[0]?.$kind, "Publish");
  if (commands[0]?.$kind === "Publish") {
    assert.equal(commands[0].Publish.modules.length, 1);
    assert.deepEqual(commands[0].Publish.dependencies, [
      MOVE_STDLIB_ADDRESS,
      SUI_FRAMEWORK_ADDRESS,
      latestBlastPackageId,
    ]);
    const publishedModule = Buffer.from(
      commands[0].Publish.modules[0] ?? "",
      "base64",
    );
    const compiled = deserialize(publishedModule) as {
      address_identifiers: string[];
    };
    assert.ok(compiled.address_identifiers.includes(blastPackageId.slice(2)));
    assert.ok(
      !compiled.address_identifiers.includes(latestBlastPackageId.slice(2)),
    );
  }
  assert.equal(commands[1]?.$kind, "MoveCall");
  if (commands[1]?.$kind === "MoveCall") {
    assert.equal(commands[1].MoveCall.package, SUI_FRAMEWORK_ADDRESS);
    assert.equal(commands[1].MoveCall.module, "package");
    assert.equal(commands[1].MoveCall.function, "make_immutable");
    assert.deepEqual(commands[1].MoveCall.arguments, [
      { Result: 0, $kind: "Result" },
    ]);
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
      { ...options, sellBurnBps: 5_001n },
      blastPackageId,
    ),
    /exceeds 5,000/,
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
