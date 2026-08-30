import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "@mysten/sui/transactions";

import {
  MigratorCalls,
  MigratorTransactions,
} from "../src/migrators/transactions.ts";
import type { MigratorsDeployment } from "../src/migrators/transactions.ts";
import type { SharedObjectReference } from "../src/lib/sui.ts";

function shared<const Mutable extends boolean>(
  objectId: string,
  initialSharedVersion: number | string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion, mutable };
}

const deployment: MigratorsDeployment = {
  packageId: "0x321",
  originalPackageId: "0x320",
  launchpad: {
    packageId: "0x123",
    originalPackageId: "0x122",
    packageVersion: shared("0x2", "10", false),
    launchConfig: shared("0x3", "11", false),
    runtimeConfig: shared("0x4", "12", false),
    protocolAuthority: shared("0x5", "13", false),
  },
  venueConfig: shared("0x6", "14", false),
};
const types = {
  memeType: "0xa::meme::MEME",
  quoteType: "0x2::sui::SUI",
};

test("exposes composable creator and protocol LP-fee calls", () => {
  const calls = new MigratorCalls(deployment);
  const creatorTx = new Transaction();
  creatorTx.add(
    calls.claimCreatorFees({
      ...types,
      vault: shared("0xc", "20", true),
      creatorCap: "0xd",
    }),
  );
  assert.deepEqual(moveFunctions(creatorTx), ["vault::claim_creator_fees"]);

  const protocolTx = new Transaction();
  const witness = protocolTx.add(calls.signIn({ adminCap: "0xe" }));
  protocolTx.add(
    calls.claimProtocolFees({
      ...types,
      vault: shared("0xc", "20", true),
      adminWitness: witness,
    }),
  );
  assert.deepEqual(moveFunctions(protocolTx), [
    "acl::sign_in",
    "vault::claim_protocol_fees",
  ]);
});

test("routes both creator LP-fee coins to the requested recipient", () => {
  const sdk = new MigratorTransactions(deployment);
  const tx = sdk.claimCreatorFees({
    ...types,
    vault: shared("0xc", "20", true),
    creatorCapId: "0xd",
    recipient: "0xf",
  });

  assert.deepEqual(moveFunctions(tx), ["vault::claim_creator_fees"]);
  assert.equal(tx.getData().commands.at(-1)?.$kind, "TransferObjects");
  assert.equal(transferObjectCount(tx), 2);
});

test("signs in and routes both protocol LP-fee coins", () => {
  const sdk = new MigratorTransactions(deployment);
  const tx = sdk.claimProtocolFees({
    ...types,
    vault: shared("0xc", "20", true),
    adminCapId: "0xe",
    recipient: "0xf",
  });

  assert.deepEqual(moveFunctions(tx), [
    "acl::sign_in",
    "vault::claim_protocol_fees",
  ]);
  assert.equal(transferObjectCount(tx), 2);
});

function moveFunctions(tx: Transaction): string[] {
  return tx.getData().commands.flatMap((command) =>
    command.$kind === "MoveCall"
      ? [`${command.MoveCall.module}::${command.MoveCall.function}`]
      : [],
  );
}

function transferObjectCount(tx: Transaction): number {
  const transfer = tx.getData().commands.at(-1);
  return transfer?.$kind === "TransferObjects"
    ? transfer.TransferObjects.objects.length
    : 0;
}
