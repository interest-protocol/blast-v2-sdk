import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readPresaleCoinPublication } from "@interest-protocol/blast-presale-sdk/effects";
import type { PresaleCoinTemplateOptions } from "@interest-protocol/blast-presale-sdk/template";
import {
  buildPresaleCoinPackageBytecode,
  derivePresaleCoinTemplateIdentifiers,
} from "@interest-protocol/blast-presale-sdk/template";
import { PresaleTransactions } from "@interest-protocol/blast-presale-sdk/transactions";
import { deserialize, get_constants } from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  MOVE_STDLIB_ADDRESS,
  normalizeStructTag,
  normalizeSuiObjectId,
  SUI_FRAMEWORK_ADDRESS,
} from "@mysten/sui/utils";
import { PRESALE_DEPLOYMENT } from "./fixtures/presale-deployment.ts";

/** The template's compiled defaults (contracts `sui/presale_coin_template/sources/presale_coin.move`). */
const templateDefaults: PresaleCoinTemplateOptions = {
  symbol: "SALE",
  name: "Blast Sale Token",
  description: "A token sold on Blast",
  iconUrl: "https://blast.fun/sale.png",
  decimals: 9,
  metadataCapRecipient: "0x3e7a",
  moduleName: "presale_coin",
};
/** The placeholder addresses the embedded artifact was built against. */
const templateDependencies = {
  originalPackageId: "0x5a1e",
  core: { originalPackageId: "0xc0de" },
};

const options: PresaleCoinTemplateOptions = {
  symbol: "DOG",
  name: "Dog Sale",
  description: "A good dog, sold",
  iconUrl: "https://example.com/dog.png",
  decimals: 6,
  metadataCapRecipient: "0xca7",
};
const deployment = PRESALE_DEPLOYMENT;
const presale = normalizeSuiObjectId(deployment.originalPackageId);
const core = normalizeSuiObjectId(deployment.core.originalPackageId);

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

test("locks the embedded artifact to the contracts build of presale_coin_template", async () => {
  const bytecode = await buildPresaleCoinPackageBytecode(
    templateDefaults,
    templateDependencies,
  );
  assert.equal(
    createHash("sha256").update(bytecode).digest("hex"),
    "7a3afd900b037f11863e55de2824acc6d60c001eee5293963c9d1d82d1b61a6f",
  );
});

test("patches every constant slot, both dependencies, and renames the module and witness", async () => {
  const bytecode = await buildPresaleCoinPackageBytecode(options, deployment);
  assert.deepEqual(constants(bytecode), [
    ["Vector(U8)", string("DOG")],
    ["Vector(U8)", string("Dog Sale")],
    ["Vector(U8)", string("A good dog, sold")],
    ["Vector(U8)", string("https://example.com/dog.png")],
    ["U8", [6]],
    ["Bool", [1]],
    ["Address", address("0xca7")],
  ]);
  const compiled = deserialize(bytecode) as {
    address_identifiers: string[];
    identifiers: string[];
    module_handles: { address: number; name: number }[];
  };
  assert.deepEqual(derivePresaleCoinTemplateIdentifiers("DOG"), {
    moduleName: "dog",
    witnessName: "DOG",
  });
  assert.ok(compiled.identifiers.includes("dog"));
  assert.ok(compiled.identifiers.includes("DOG"));
  assert.ok(!compiled.identifiers.includes("presale_coin"));
  const moduleAt = (packageId: string, name: string) =>
    compiled.module_handles.some(
      (handle) =>
        compiled.address_identifiers[handle.address] === packageId.slice(2) &&
        compiled.identifiers[handle.name] === name,
    );
  assert.ok(moduleAt(presale, "sale_token"));
  assert.ok(moduleAt(core, "sealed_treasury_cap"));
  assert.ok(!compiled.address_identifiers.includes("0".repeat(60) + "5a1e"));
  assert.ok(!compiled.address_identifiers.includes("0".repeat(60) + "c0de"));
});

test("deletes the MetadataCap when no recipient is named", async () => {
  const bytecode = await buildPresaleCoinPackageBytecode(
    { ...options, metadataCapRecipient: null },
    deployment,
  );
  assert.deepEqual(constants(bytecode).slice(5), [
    ["Bool", [0]],
    ["Address", address("0x3e7a")],
  ]);
});

test("rejects invalid metadata, dependency and identifier inputs", async () => {
  const cases: [Partial<PresaleCoinTemplateOptions>, RegExp][] = [
    [{ symbol: "" }, /symbol must not be empty/],
    [{ symbol: "DÖG" }, /ASCII printable/],
    [{ decimals: 256 }, /decimals must be a u8/],
    [
      { metadataCapRecipient: "0x0" },
      /metadataCapRecipient must not be the zero address/,
    ],
    [{ name: " " }, /name must not be empty/],
    // `string` names the standard module the template already imports.
    [{ symbol: "STRING" }, /collides with the presale coin template/],
    [{ moduleName: "Dog" }, /moduleName must start with a lowercase letter/],
  ];
  for (const [override, message] of cases) {
    await assert.rejects(
      buildPresaleCoinPackageBytecode({ ...options, ...override }, deployment),
      message,
    );
  }
  await assert.rejects(
    buildPresaleCoinPackageBytecode(options, {
      ...deployment,
      originalPackageId: "0x2",
    }),
    /originalPackageId must identify a deployed Blast package/,
  );
  await assert.rejects(
    buildPresaleCoinPackageBytecode(options, {
      ...deployment,
      core: { originalPackageId: "0x0" },
    }),
    /core.originalPackageId must identify a deployed Blast package/,
  );
});

test("publishes against every transitive dependency, then makes the package immutable", async () => {
  const tx = new PresaleTransactions(deployment).publishPresaleCoin(options);
  await tx.prepareForSerialization({});
  const [publish, makeImmutable] = tx.getData().commands;
  assert.equal(publish?.$kind, "Publish");
  if (publish?.$kind === "Publish") {
    assert.equal(publish.Publish.modules.length, 1);
    assert.deepEqual(publish.Publish.dependencies, [
      MOVE_STDLIB_ADDRESS,
      SUI_FRAMEWORK_ADDRESS,
      normalizeSuiObjectId(deployment.admin.packageId),
      normalizeSuiObjectId(deployment.partners.packageId),
      normalizeSuiObjectId(deployment.vestingPackageId),
      normalizeSuiObjectId(deployment.core.packageId),
      normalizeSuiObjectId(deployment.packageId),
    ]);
  }
  assert.equal(makeImmutable?.$kind, "MoveCall");
  if (makeImmutable?.$kind === "MoveCall") {
    assert.equal(makeImmutable.MoveCall.module, "package");
    assert.equal(makeImmutable.MoveCall.function, "make_immutable");
    assert.deepEqual(makeImmutable.MoveCall.arguments, [
      { Result: 0, $kind: "Result" },
    ]);
  }
});

// Publication effects.

const saleTokenPackage = normalizeSuiObjectId("0xabc");
const saleTokenType = normalizeStructTag(`${saleTokenPackage}::dog::DOG`);
const publisher = normalizeSuiObjectId("0xb1a57");
const owner = (address: string): SuiClientTypes.ObjectOwner => ({
  $kind: "AddressOwner",
  AddressOwner: normalizeSuiObjectId(address),
});

function changed(
  objectId: string,
  outputOwner: SuiClientTypes.ObjectOwner | null,
  overrides: Partial<SuiClientTypes.ChangedObject> = {},
): SuiClientTypes.ChangedObject {
  return {
    objectId: normalizeSuiObjectId(objectId),
    inputState: "DoesNotExist",
    inputVersion: null,
    inputDigest: null,
    inputOwner: null,
    outputState: "ObjectWrite",
    outputVersion: "7",
    outputDigest: `digest-${objectId}`,
    outputOwner,
    idOperation: "Created",
    ...overrides,
  };
}

function effects(
  changedObjects: SuiClientTypes.ChangedObject[],
): SuiClientTypes.TransactionEffects {
  return {
    bcs: null,
    version: 2,
    status: { success: true, error: null },
    gasUsed: {
      computationCost: "0",
      storageCost: "0",
      storageRebate: "0",
      nonRefundableStorageFee: "0",
    },
    transactionDigest: "publish",
    gasObject: null,
    eventsDigest: null,
    dependencies: [],
    lamportVersion: "7",
    changedObjects,
    unchangedConsensusObjects: [],
    auxiliaryDataDigest: null,
  };
}

const publication = {
  effects: effects([
    changed("0xabc", { $kind: "Immutable", Immutable: true } as never, {
      outputState: "PackageWrite",
    }),
    changed("0xd1", owner(publisher)),
    changed("0xd2", owner("0xc")),
    changed("0xd3", owner(publisher)),
    changed("0xd4", owner("0xca7")),
  ]),
  objectTypes: {
    [saleTokenPackage]: "package",
    [normalizeSuiObjectId("0xd1")]:
      `${core}::sealed_treasury_cap::SealedTreasuryCap<${saleTokenType}>`,
    [normalizeSuiObjectId("0xd2")]:
      `0x2::coin_registry::Currency<${saleTokenType}>`,
    [normalizeSuiObjectId("0xd3")]: "0x2::package::UpgradeCap",
    [normalizeSuiObjectId("0xd4")]:
      `0x2::coin_registry::MetadataCap<${saleTokenType}>`,
  },
};

test("reads the published sale token, its sealed treasury cap and pending currency", () => {
  assert.deepEqual(readPresaleCoinPublication(publication, deployment), {
    packageId: saleTokenPackage,
    saleTokenType,
    sealedTreasuryCap: {
      objectId: normalizeSuiObjectId("0xd1"),
      version: "7",
      digest: "digest-0xd1",
      owner: publisher,
    },
    pendingCurrency: {
      objectId: normalizeSuiObjectId("0xd2"),
      version: "7",
      digest: "digest-0xd2",
    },
  });
});

test("refuses a publication whose seal is another core's, another coin's, or missing", () => {
  assert.throws(
    () =>
      readPresaleCoinPublication(publication, {
        core: { originalPackageId: "0x999" },
      }),
    /exactly one SealedTreasuryCap of the published package/,
  );
  const foreignCoin = {
    ...publication,
    objectTypes: {
      ...publication.objectTypes,
      [normalizeSuiObjectId("0xd1")]:
        `${core}::sealed_treasury_cap::SealedTreasuryCap<0x999::dog::DOG>`,
    },
  };
  assert.throws(
    () => readPresaleCoinPublication(foreignCoin, deployment),
    /exactly one SealedTreasuryCap of the published package/,
  );
  const unregistered = {
    ...publication,
    effects: effects(
      publication.effects.changedObjects.filter(
        (object) => object.objectId !== normalizeSuiObjectId("0xd2"),
      ),
    ),
  };
  assert.throws(
    () => readPresaleCoinPublication(unregistered, deployment),
    /exactly one Currency<Coin> to the Coin Registry/,
  );
});

test("finalizes the currency registration from the publication's pending Currency", () => {
  const tx = new PresaleTransactions(deployment).finalizeCurrencyRegistration({
    saleTokenType,
    currency: readPresaleCoinPublication(publication, deployment)
      .pendingCurrency,
    coinRegistry: { objectId: "0xc", initialSharedVersion: "1" },
  });
  const [call] = tx.getData().commands;
  assert.equal(call?.$kind, "MoveCall");
  if (call?.$kind === "MoveCall") {
    assert.equal(call.MoveCall.module, "coin_registry");
    assert.equal(call.MoveCall.function, "finalize_registration");
    assert.deepEqual(call.MoveCall.typeArguments, [saleTokenType]);
  }
  const receiving = tx
    .getData()
    .inputs.find(
      (input) => input.$kind === "Object" && input.Object.$kind === "Receiving",
    );
  assert.ok(receiving);
});
