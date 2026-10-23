import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CoinTemplateOptions } from "@interest-protocol/blast-coin-sdk/template";
import { buildCoinPackageBytecode } from "@interest-protocol/blast-coin-sdk/template";
import { publishCoin } from "@interest-protocol/blast-coin-sdk/transactions";
import {
  deserialize,
  get_constants,
  update_identifiers,
} from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress } from "@mysten/sui/utils";

/** The template's compiled defaults (contracts `sui/coin_template/sources/my_coin.move`). */
const templateDefaults: CoinTemplateOptions = {
  symbol: "COIN",
  name: "My Coin",
  description: "A coin created on Blast",
  iconUrl: "https://blast.fun/coin.png",
  decimals: 9,
  initialSupply: 1_000_000_000_000_000_000n,
  supplyRecipient: "0x5ee1",
  supply: { kind: "fixed" },
  metadataCapRecipient: "0x3e7a",
  // `coin` is the framework module's name, so the default symbol needs its own module.
  moduleName: "my_coin",
};

const options: CoinTemplateOptions = {
  symbol: "DOG",
  name: "Dog Coin",
  description: "A good dog",
  iconUrl: "https://example.com/dog.png",
  decimals: 6,
  initialSupply: 21_000_000_000_000n,
  supplyRecipient: "0xa11ce",
  supply: { kind: "mintable", treasuryCapRecipient: "0xb0b" },
  metadataCapRecipient: "0xca7",
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
const address = (value: string) =>
  Array.from(bcs.Address.serialize(value).toBytes());

test("locks the embedded artifact to the contracts build of coin_template", async () => {
  const bytecode = await buildCoinPackageBytecode(templateDefaults);
  // Built with the defaults, only the witness rename differs from the contracts build.
  const original = update_identifiers(bytecode, { COIN: "MY_COIN" });

  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    "f175d5053793e7add203f76273745be16048638a3dd8835c2a936a8bb350679f",
  );
});

test("patches every constant slot and renames the module and witness", async () => {
  const bytecode = await buildCoinPackageBytecode(options);
  const patched = constants(bytecode);

  assert.deepEqual(patched.slice(0, 11), [
    ["Vector(U8)", string("DOG")],
    ["Vector(U8)", string("Dog Coin")],
    ["Vector(U8)", string("A good dog")],
    ["Vector(U8)", string("https://example.com/dog.png")],
    ["U8", [6]],
    ["U64", Array.from(bcs.u64().serialize(21_000_000_000_000n).toBytes())],
    ["Address", address("0xa11ce")],
    ["U8", [0]], // mintable
    ["Address", address("0xb0b")],
    ["Bool", [1]],
    ["Address", address("0xca7")],
  ]);
  const compiled = deserialize(bytecode) as { identifiers: string[] };
  assert.ok(compiled.identifiers.includes("dog"));
  assert.ok(compiled.identifiers.includes("DOG"));
  assert.ok(!compiled.identifiers.includes("my_coin"));
  assert.ok(!compiled.identifiers.includes("MY_COIN"));
});

test("maps each supply mode and the metadata choice, keeping unused recipients at their defaults", async () => {
  const burnOnly = constants(
    await buildCoinPackageBytecode({
      ...options,
      supply: { kind: "burnOnly" },
      metadataCapRecipient: null,
    }),
  );
  assert.deepEqual(burnOnly[7], ["U8", [2]]);
  assert.deepEqual(burnOnly[8], ["Address", address("0x7ca9")]);
  assert.deepEqual(burnOnly[9], ["Bool", [0]]);
  assert.deepEqual(burnOnly[10], ["Address", address("0x3e7a")]);

  const fixed = constants(
    await buildCoinPackageBytecode({ ...options, supply: { kind: "fixed" } }),
  );
  assert.deepEqual(fixed[7], ["U8", [1]]);

  const unminted = constants(
    await buildCoinPackageBytecode({ ...options, initialSupply: 0n }),
  );
  assert.deepEqual(unminted[5], ["U64", Array(8).fill(0)]);
  assert.deepEqual(unminted[6], ["Address", address("0x5ee1")]);
});

test("rejects options the initializer or the Coin Registry would abort on", async () => {
  const cases: [Partial<CoinTemplateOptions>, RegExp][] = [
    [
      { supply: { kind: "fixed" }, initialSupply: 0n },
      /nonzero initial supply/,
    ],
    [
      { supply: { kind: "burnOnly" }, initialSupply: 0n },
      /nonzero initial supply/,
    ],
    [{ symbol: "DÖG" }, /ASCII printable/],
    [{ decimals: 256 }, /decimals must be a u8/],
    [{ initialSupply: 1n << 64n }, /initialSupply/],
    [{ supplyRecipient: "0x0" }, /supplyRecipient must be a nonzero/],
    [
      { supply: { kind: "mintable", treasuryCapRecipient: "0x0" } },
      /treasuryCapRecipient must be a nonzero/,
    ],
    [{ metadataCapRecipient: "0x0" }, /metadataCapRecipient must be a nonzero/],
    [{ name: " " }, /name must not be empty/],
    // `coin` names the framework module the template already imports.
    [{ symbol: "COIN" }, /collides with the coin template/],
    [{ moduleName: "Dog" }, /moduleName must start with a lowercase letter/],
  ];
  for (const [override, message] of cases) {
    await assert.rejects(
      buildCoinPackageBytecode({ ...options, ...override }),
      message,
    );
  }
});

test("publishes against 0x1 and 0x2 and makes the package immutable, or hands over its UpgradeCap", async () => {
  const immutable = publishCoin({ ...options, upgradeCapRecipient: null });
  await immutable.prepareForSerialization({});
  const [publish, makeImmutable] = immutable.getData().commands;
  assert.equal(publish?.$kind, "Publish");
  if (publish?.$kind === "Publish") {
    assert.deepEqual(publish.Publish.dependencies, [
      normalizeSuiAddress("0x1"),
      normalizeSuiAddress("0x2"),
    ]);
  }
  assert.equal(makeImmutable?.$kind, "MoveCall");
  if (makeImmutable?.$kind === "MoveCall") {
    assert.equal(makeImmutable.MoveCall.module, "package");
    assert.equal(makeImmutable.MoveCall.function, "make_immutable");
  }

  const kept = publishCoin({ ...options, upgradeCapRecipient: "0xc0ffee" });
  await kept.prepareForSerialization({});
  assert.equal(kept.getData().commands[1]?.$kind, "TransferObjects");
  assert.ok((await kept.build({ onlyTransactionKind: true })).length > 0);
});

test("publishes one recipient for everything and colliding values without duplicate constants", async () => {
  const bytecode = await buildCoinPackageBytecode({
    ...options,
    name: "DOG",
    description: "",
    iconUrl: "",
    decimals: 0, // equal to the mintable mode's 0
    supplyRecipient: "0xa11ce",
    supply: { kind: "mintable", treasuryCapRecipient: "0xa11ce" },
    metadataCapRecipient: "0xa11ce",
  });
  const keys = constants(bytecode).map(
    ([type, value]: [string, number[]]) => `${type}:${value.join(",")}`,
  );
  assert.equal(new Set(keys).size, keys.length);
});
