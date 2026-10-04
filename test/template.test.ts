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
  memeAtomicSupply,
} from "../src/launchpad/template.ts";
import { LaunchpadTransactions } from "../src/launchpad/transactions.ts";

const blastPackageId = normalizeSuiObjectId("0xb1a57");
const latestBlastPackageId = normalizeSuiObjectId("0xb1a58");
const adminPackageId = normalizeSuiObjectId("0xad");
const partnersPackageId = normalizeSuiObjectId("0xbe");
const timelockPackageId = normalizeSuiObjectId("0x7e");
const options = {
  decimals: 6,
  symbol: "DOG COIN",
  name: "Dog Coin",
  description: "A good dog",
  iconUrl: "https://blast.fun/dog.png",
  burnable: true,
  sellBurnBps: 2_500n,
  creatorRecipient: { kind: "address", address: "0xc" } as const,
};

test("locks the embedded artifact to the nine source constants", async () => {
  const creatorRecipientBytes = Uint8Array.from(
    { length: 32 },
    (_, index) => index,
  );
  const defaults = {
    decimals: 9,
    symbol: "MEME",
    name: "Blast Meme",
    description: "A Meme launched on Blast",
    iconUrl: "https://blast.fun/meme.png",
    burnable: false,
    sellBurnBps: 0n,
    creatorRecipient: {
      kind: "account" as const,
      accountCommitment: creatorRecipientBytes,
    },
  };
  const bytecode = await buildMemePackageBytecode(defaults, "0xda74");

  assert.equal(
    createHash("sha256").update(bytecode).digest("hex"),
    "7a0303c62ce622ed2f0eb17de1ac4a8d0d8852ee859d4cdca3fdc2711b265da8",
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
          .serialize(Array.from(creatorRecipientBytes))
          .toBytes(),
      ),
    },
    {
      type_: "Bool",
      value_bcs: Array.from(bcs.bool().serialize(true).toBytes()),
    },
    {
      type_: "U8",
      value_bcs: Array.from(bcs.u8().serialize(defaults.decimals).toBytes()),
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
    normalizeSuiObjectId(options.creatorRecipient.address),
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
      type_: "U8",
      value_bcs: Array.from(bcs.u8().serialize(options.decimals).toBytes()),
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

test("patches a 32-byte account commitment in the same compiled template", async () => {
  const accountCommitment = Uint8Array.from(
    { length: 32 },
    (_, index) => 255 - index,
  );
  const bytecode = await buildMemePackageBytecode(
    {
      ...options,
      creatorRecipient: { kind: "account", accountCommitment },
      burnable: false,
    },
    blastPackageId,
  );
  const constants = get_constants(bytecode);

  assert.deepEqual(constants[4], {
    type_: "Vector(U8)",
    value_bcs: Array.from(
      bcs.vector(bcs.u8()).serialize(Array.from(accountCommitment)).toBytes(),
    ),
  });
  assert.deepEqual(constants[5], {
    type_: "Bool",
    value_bcs: Array.from(bcs.bool().serialize(true).toBytes()),
  });
  assert.deepEqual(constants[7], {
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

test("publishes against the whole dependency closure, then makes the package immutable", async () => {
  const tx = new LaunchpadTransactions({
    packageId: latestBlastPackageId,
    originalPackageId: blastPackageId,
    adminPackageId,
    partnersPackageId,
    timelockPackageId,
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
    acl: {
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
      timelockPackageId,
      adminPackageId,
      partnersPackageId,
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
test("mirrors the one-billion-token atomic supply at each precision", () => {
  assert.equal(memeAtomicSupply(6), 1_000_000_000_000_000n);
  assert.equal(memeAtomicSupply(9), 1_000_000_000_000_000_000n);
  assert.equal(memeAtomicSupply(10), 10_000_000_000_000_000_000n);
  assert.throws(() => memeAtomicSupply(11), /u64/);
});

test("rejects invalid policy, dependency, and identifier inputs", async () => {
  await assert.rejects(
    buildMemePackageBytecode(
      {
        ...options,
        creatorRecipient: {
          kind: "account",
          accountCommitment: new Uint8Array(31),
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
        creatorRecipient: { kind: "address", address: "0x0" },
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
    buildMemePackageBytecode({ ...options, decimals: 11 }, blastPackageId),
    /Meme atomic supply must be a u64/,
  );
  await assert.rejects(
    buildMemePackageBytecode({ ...options, decimals: 1.5 }, blastPackageId),
    /decimals must be a u8/,
  );
  await assert.rejects(
    buildMemePackageBytecode(
      { ...options, symbol: "A".repeat(33) },
      blastPackageId,
    ),
    /must not exceed 32 bytes/,
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
