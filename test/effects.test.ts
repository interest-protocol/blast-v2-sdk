import assert from "node:assert/strict";
import test from "node:test";
import {
  readCurrencyRegistration,
  readLaunchCreation,
  readMemePublication,
} from "@interest-protocol/blast-launchpad-sdk/effects";
import { LaunchpadTransactions } from "@interest-protocol/blast-launchpad-sdk/transactions";
import type { SuiClientTypes } from "@mysten/sui/client";
import { Inputs, Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";

const launchpad = normalizeSuiObjectId("0x122");
const memePackage = normalizeSuiObjectId("0xabc");
const memeType = `${memePackage}::dog::DOG`;
const quoteType = normalizeStructTag("0x2::sui::SUI");
const publisher = normalizeSuiObjectId("0xb1a57");
const registry = normalizeSuiObjectId("0xc");
// A valid base58 object digest; `build` rejects the placeholder digests above.
const CURRENCY_DIGEST = "11111111111111111111111111111111";

function changed(
  objectId: string,
  outputOwner: SuiClientTypes.ObjectOwner | null,
  options: Partial<SuiClientTypes.ChangedObject> = {},
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
    ...options,
  };
}

function effects(
  changedObjects: SuiClientTypes.ChangedObject[],
  success = true,
): SuiClientTypes.TransactionEffects {
  return {
    bcs: null,
    version: 2,
    status: success
      ? { success: true, error: null }
      : ({ success: false, error: { message: "aborted" } } as never),
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

const owner = (address: string): SuiClientTypes.ObjectOwner => ({
  $kind: "AddressOwner",
  AddressOwner: normalizeSuiObjectId(address),
});
const shared = (version: string): SuiClientTypes.ObjectOwner => ({
  $kind: "Shared",
  Shared: { initialSharedVersion: version },
});

const publication = {
  effects: effects([
    changed("0xabc", { $kind: "Immutable", Immutable: true } as never, {
      outputState: "PackageWrite",
    }),
    changed("0xd1", owner(publisher)),
    changed("0xd2", owner(registry)),
    changed("0xd3", owner(publisher)),
  ]),
  objectTypes: {
    [memePackage]: "package",
    [normalizeSuiObjectId("0xd1")]:
      `${launchpad}::launch_ticket::LaunchTicket<${memeType}>`,
    [normalizeSuiObjectId("0xd2")]: `0x2::coin_registry::Currency<${memeType}>`,
    [normalizeSuiObjectId("0xd3")]: "0x2::package::UpgradeCap",
  },
};

test("reads the published Meme, ticket, and currency with the Core API package marker", () => {
  assert.deepEqual(readMemePublication(publication, "0x122"), {
    packageId: memePackage,
    memeType: normalizeStructTag(memeType),
    ticket: {
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

test("requires exactly one published package even with Core API package markers", () => {
  const [publishedPackage, ...objects] = publication.effects.changedObjects;
  assert.ok(publishedPackage);
  const extraPackage = changed("0xdef", null, {
    outputState: "PackageWrite",
  });
  for (const changedObjects of [
    objects,
    [publishedPackage, extraPackage, ...objects],
  ]) {
    assert.throws(
      () =>
        readMemePublication(
          {
            effects: effects(changedObjects),
            objectTypes: {
              ...publication.objectTypes,
              [extraPackage.objectId]: "package",
            },
          },
          "0x122",
        ),
      /publication must create exactly one package/,
    );
  }
});

test("rejects malformed object struct tags in publication effects", () => {
  assert.throws(
    () =>
      readMemePublication(
        {
          ...publication,
          objectTypes: {
            ...publication.objectTypes,
            [normalizeSuiObjectId("0xd1")]: "invalid-struct-tag",
          },
        },
        "0x122",
      ),
    /Invalid struct tag: invalid-struct-tag/,
  );
});

test("rejects publication effects without exactly one ticket from the launchpad", () => {
  assert.throws(
    () =>
      readMemePublication(
        { ...publication, effects: effects([], false) },
        "0x122",
      ),
    /did not succeed/,
  );
  assert.throws(
    () => readMemePublication(publication, "0x999"),
    /exactly one LaunchTicket/,
  );
  const foreignTicket = {
    ...publication,
    objectTypes: {
      ...publication.objectTypes,
      [normalizeSuiObjectId("0xd1")]:
        `${launchpad}::launch_ticket::LaunchTicket<0x777::dog::DOG>`,
    },
  };
  assert.throws(
    () => readMemePublication(foreignTicket, "0x122"),
    /not from the published package/,
  );
});

const deployment = {
  packageId: "0x123",
  originalPackageId: "0x122",
  admin: {
    packageId: "0xad",
    acl: { objectId: "0x5", initialSharedVersion: "1" },
  },
  partnersPackageId: "0xbe",
  timelockPackageId: "0x7e",
  packageVersion: { objectId: "0x2", initialSharedVersion: "1" },
  launchConfig: { objectId: "0x3", initialSharedVersion: "1" },
  runtimeConfig: { objectId: "0x4", initialSharedVersion: "1" },
};

test("finalizes the currency registration and reads the shared Currency", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx: Transaction = sdk.finalizeCurrencyRegistration({
    memeType,
    currency: readMemePublication(publication, "0x122").pendingCurrency,
  });
  const command = tx.getData().commands[0];
  assert.ok(command?.$kind === "MoveCall");
  assert.equal(command.MoveCall.module, "coin_registry");
  assert.equal(command.MoveCall.function, "finalize_registration");
  assert.deepEqual(command.MoveCall.typeArguments, [
    normalizeStructTag(memeType),
  ]);
  const [registryArgument, currencyArgument] = command.MoveCall.arguments;
  const inputs = tx.getData().inputs;
  assert.ok(registryArgument?.$kind === "Input");
  assert.equal(
    inputs[registryArgument.Input]?.UnresolvedObject?.objectId,
    registry,
  );
  assert.ok(currencyArgument?.$kind === "Input");
  assert.deepEqual(inputs[currencyArgument.Input]?.Object?.Receiving, {
    objectId: normalizeSuiObjectId("0xd2"),
    version: "7",
    digest: "digest-0xd2",
  });

  const registration = {
    effects: effects([
      changed("0xe1", shared("9")),
      changed("0xd2", null, {
        idOperation: "Deleted",
        outputState: "DoesNotExist",
      }),
    ]),
    objectTypes: {
      [normalizeSuiObjectId("0xe1")]:
        `0x2::coin_registry::Currency<${memeType}>`,
    },
  };
  assert.deepEqual(readCurrencyRegistration(registration, memeType), {
    objectId: normalizeSuiObjectId("0xe1"),
    initialSharedVersion: "9",
    mutable: true,
  });
});

/** Builds `tx` offline: the Coin Registry input is pinned instead of fetched. */
async function kindBytes(tx: Transaction): Promise<Uint8Array> {
  tx.addBuildPlugin(async (data, _options, next) => {
    for (const [index, input] of data.inputs.entries()) {
      if (input.UnresolvedObject?.objectId === registry) {
        data.inputs[index] = Inputs.SharedObjectRef({
          objectId: registry,
          initialSharedVersion: "1",
          mutable: true,
        });
      }
    }
    await next();
  });
  return tx.build({ onlyTransactionKind: true });
}

test("the composable registration builds the same bytes as the transaction", async () => {
  const sdk = new LaunchpadTransactions(deployment);
  const options = {
    memeType,
    currency: { objectId: "0xd2", version: "7", digest: CURRENCY_DIGEST },
  };
  const composed = new Transaction();
  composed.add(sdk.call.finalizeCurrencyRegistration(options));

  assert.deepEqual(
    await kindBytes(composed),
    await kindBytes(sdk.finalizeCurrencyRegistration(options)),
  );
});

test("registrations in one PTB share the Coin Registry input", () => {
  const { call } = new LaunchpadTransactions(deployment);
  const tx = new Transaction();
  tx.add(
    call.finalizeCurrencyRegistration({
      memeType,
      currency: { objectId: "0xd2", version: "7", digest: CURRENCY_DIGEST },
    }),
  );
  tx.add(
    call.finalizeCurrencyRegistration({
      memeType: `${normalizeSuiObjectId("0xabd")}::cat::CAT`,
      currency: { objectId: "0xd3", version: "8", digest: CURRENCY_DIGEST },
    }),
  );

  const { inputs, commands } = tx.getData();
  assert.equal(commands.length, 2);
  assert.deepEqual(
    inputs.map((input) =>
      input.UnresolvedObject
        ? input.UnresolvedObject.objectId
        : input.Object?.Receiving?.objectId,
    ),
    [registry, normalizeSuiObjectId("0xd2"), normalizeSuiObjectId("0xd3")],
  );
});

test("reads the shared launch a creation transaction produced", () => {
  const creation = {
    effects: effects([
      changed("0xf1", shared("12")),
      changed("0xf2", owner(publisher)),
      changed("0xabc", null, { outputState: "PackageWrite" }),
    ]),
    objectTypes: {
      [memePackage]: "package",
      [normalizeSuiObjectId("0xf1")]:
        `${launchpad}::launch::Launch<${memeType}, 0x2::sui::SUI>`,
      [normalizeSuiObjectId("0xf2")]: `0x2::coin::Coin<${memeType}>`,
    },
  };

  assert.deepEqual(readLaunchCreation(creation, "0x122"), {
    launch: {
      objectId: normalizeSuiObjectId("0xf1"),
      initialSharedVersion: "12",
      mutable: true,
    },
    memeType: normalizeStructTag(memeType),
    quoteType,
  });
  assert.throws(
    () =>
      readLaunchCreation(
        {
          ...creation,
          effects: effects([changed("0xf1", owner(publisher))]),
        },
        "0x122",
      ),
    /exactly one shared Launch/,
  );
});
