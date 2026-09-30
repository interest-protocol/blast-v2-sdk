import assert from "node:assert/strict";
import test from "node:test";

import type { SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";

import {
  readCurrencyRegistration,
  readLaunchCreation,
  readMemePublication,
} from "../src/launchpad/effects.ts";
import { LaunchpadTransactions } from "../src/launchpad/transactions.ts";

const launchpad = normalizeSuiObjectId("0x122");
const memePackage = normalizeSuiObjectId("0xabc");
const memeType = `${memePackage}::dog::DOG`;
const quoteType = normalizeStructTag("0x2::sui::SUI");
const publisher = normalizeSuiObjectId("0xb1a57");
const registry = normalizeSuiObjectId("0xc");

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
    [normalizeSuiObjectId("0xd1")]:
      `${launchpad}::launch_ticket::LaunchTicket<${memeType}>`,
    [normalizeSuiObjectId("0xd2")]: `0x2::coin_registry::Currency<${memeType}>`,
    [normalizeSuiObjectId("0xd3")]: "0x2::package::UpgradeCap",
  },
};

test("discovers the published Meme type, its ticket, and its pending currency", () => {
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

test("finalizes the currency registration and reads the shared Currency", () => {
  const sdk = new LaunchpadTransactions({
    packageId: "0x123",
    originalPackageId: "0x122",
    adminPackageId: "0xad",
    partnersPackageId: "0xbe",
    timelockPackageId: "0x7e",
    packageVersion: {
      objectId: "0x2",
      initialSharedVersion: "1",
      mutable: false,
    },
    launchConfig: {
      objectId: "0x3",
      initialSharedVersion: "1",
      mutable: false,
    },
    runtimeConfig: {
      objectId: "0x4",
      initialSharedVersion: "1",
      mutable: false,
    },
    acl: { objectId: "0x5", initialSharedVersion: "1", mutable: false },
  });
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

test("reads the shared launch a creation transaction produced", () => {
  const creation = {
    effects: effects([
      changed("0xf1", shared("12")),
      changed("0xf2", owner(publisher)),
    ]),
    objectTypes: {
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
