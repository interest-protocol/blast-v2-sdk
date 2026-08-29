import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeSuiObjectId,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";

import {
  LaunchpadCalls,
  LaunchpadTransactions,
} from "../src/launchpad/transactions.ts";
import type {
  LaunchpadDeployment,
  SharedObjectReference,
} from "../src/launchpad/transactions.ts";

function shared<const Mutable extends boolean>(
  objectId: string,
  initialSharedVersion: number | string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion, mutable };
}

const deployment: LaunchpadDeployment = {
  packageId: "0x123",
  packageVersion: shared("0x2", "10", false),
  launchConfig: shared("0x3", "11", false),
  runtimeConfig: shared("0x4", "12", false),
  protocolAuthority: shared("0x5", "13", false),
};
const types = {
  memeType: "0xa::meme::MEME",
  quoteType: "0x2::sui::SUI",
};
const migrationTypes = {
  ...types,
  migrationWitnessType: "0xb::adapter::WITNESS",
};

test("constructs an atomic create-and-share transaction", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.createLaunch({ ...migrationTypes, ticketId: "0xc" });

  assert.deepEqual(moveFunctions(tx), ["launch::new", "launch::share"]);
  const share = tx.getData().commands[1];
  assert.equal(share?.$kind, "MoveCall");
  if (share?.$kind === "MoveCall") {
    assert.deepEqual(share.MoveCall.arguments[0], {
      Result: 0,
      $kind: "Result",
    });
  }
  assert.deepEqual(sharedInputs(tx), [
    shared("0x2", "10", false),
    shared("0x3", "11", false),
  ].map(normalizedShared));
});

test("constructs the generated Meme publish and makes it immutable", async () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.publishMeme({
    symbol: "DOG",
    name: "Dog Coin",
    description: "Good dog",
    iconUrl: "https://example.com/dog.png",
    burnable: false,
    sellBurnBps: 0n,
    creatorIdentity: { kind: "address", address: "0xc" },
  });

  await tx.prepareForSerialization({});
  assert.equal(tx.getData().commands[0]?.$kind, "Publish");
  assert.equal(tx.getData().commands[1]?.$kind, "MoveCall");
  const publish = tx.getData().commands[0];
  if (publish?.$kind === "Publish") {
    assert.deepEqual(publish.Publish.dependencies, [
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000000000000000000000000000123",
    ]);
  }
  const makeImmutable = tx.getData().commands[1];
  if (makeImmutable?.$kind === "MoveCall") {
    assert.equal(makeImmutable.MoveCall.module, "package");
    assert.equal(makeImmutable.MoveCall.function, "make_immutable");
  }
  assert.equal((await tx.build({ onlyTransactionKind: true })).length > 0, true);
});

test("constructs a buy with exact-balance coin selection and output routing", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.buy({
    ...types,
    launch: shared("0xc", "20", true),
    quoteAmount: 1_000n,
    minMemeOut: 900n,
    recipient: "0xd",
  });

  assert.deepEqual(moveFunctions(tx), ["launch::buy"]);
  assert.equal(tx.getData().commands[0]?.$kind, "$Intent");
  assert.equal(tx.getData().commands.at(-1)?.$kind, "TransferObjects");
  assert.deepEqual(sharedInputs(tx), [
    shared("0xc", "20", true),
    shared("0x2", "10", false),
    shared("0x4", "12", false),
  ].map(normalizedShared));
});

test("composes admin sign-in with a protocol fee claim", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.claimProtocolFees({
    ...types,
    launch: shared("0xc", "20", true),
    adminCapId: "0xe",
    recipient: "0xf",
  });

  assert.deepEqual(moveFunctions(tx), [
    "acl::sign_in",
    "launch::claim_protocol_fees",
  ]);
  assert.ok(
    sharedInputs(tx).some(
      (input) => input.objectId.endsWith("05") && input.mutable === false,
    ),
  );
});

test("uses a fully qualified immutable Clock reference", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  tx.add(
    calls.claimCreatorCap({
      ...types,
      launch: shared("0xc", "20", true),
      xAttestation: null,
    }),
  );

  assert.ok(
    sharedInputs(tx).some(
      (input) =>
        input.objectId === SUI_CLOCK_OBJECT_ID &&
        BigInt(input.initialSharedVersion) === 1n &&
        input.mutable === false,
    ),
  );
});

test("exposes migration as a composable call for the adapter PTB", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  const payload = tx.add(
    calls.migrate({
      ...migrationTypes,
      launch: shared("0xc", "20", true),
      currency: shared("0xd", "22", true),
    }),
  );
  tx.add(
    calls.redeemMigration({
      ...migrationTypes,
      payload,
      migrationWitness: "0xe",
    }),
  );

  assert.deepEqual(moveFunctions(tx), [
    "launch::migrate",
    "launch::redeem_migration",
  ]);
  assert.ok(
    sharedInputs(tx).some(
      (input) => input.objectId.endsWith("0d") && input.mutable === true,
    ),
  );
});

test("rejects incomplete or incorrectly mutable shared references", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const invalidLaunch = shared(
    "0xc",
    "20",
    false,
  ) as unknown as SharedObjectReference<true>;
  assert.throws(
    () =>
      sdk.buy({
        ...types,
        launch: invalidLaunch,
        quoteAmount: 1n,
        minMemeOut: 0n,
        recipient: "0xd",
      }),
    /launch\.mutable must be true/,
  );
  assert.throws(
    () =>
      new LaunchpadTransactions({
        ...deployment,
        runtimeConfig: shared("0x4", "0", false),
      }),
    /runtimeConfig\.initialSharedVersion must be a positive u64/,
  );
});

function moveFunctions(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall"
        ? [`${command.MoveCall.module}::${command.MoveCall.function}`]
        : [],
    );
}

function sharedInputs(tx: Transaction): SharedObjectReference[] {
  return tx.getData().inputs.flatMap((input) =>
    input.$kind === "Object" && input.Object.$kind === "SharedObject"
      ? [input.Object.SharedObject]
      : [],
  );
}

function normalizedShared<const Mutable extends boolean>(
  reference: SharedObjectReference<Mutable>,
): SharedObjectReference<Mutable> {
  return {
    ...reference,
    objectId: normalizeSuiObjectId(reference.objectId),
  };
}
