import assert from "node:assert/strict";
import test from "node:test";

import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { SharedObjectReference } from "../src/lib/sui.ts";
import { blastMigrators, MigratorsClient } from "../src/migrators/client.ts";

function shared<const Mutable extends boolean>(
  objectId: string,
  initialSharedVersion: string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion, mutable };
}

test("registers the typed migrators client extension", () => {
  const client = new SuiGrpcClient({
    network: "mainnet",
    baseUrl: "https://fullnode.mainnet.sui.io:443",
  }).$extend(
    blastMigrators({
      packageId: "0x321",
      originalPackageId: "0x320",
      launchpad: {
        packageId: "0x123",
        originalPackageId: "0x122",
        partnersPackageId: "0x112",
        timelockPackageId: "0x113",
        packageVersion: shared("0x2", "10", false),
        launchConfig: shared("0x3", "11", false),
        runtimeConfig: shared("0x4", "12", false),
        admin: { packageId: "0x111", acl: shared("0x5", "13", false) },
      },
      migratorsVersion: shared("0x7", "15", false),
      lpFeePolicy: shared("0x40", "18", false),
      venueConfig: shared("0x6", "14", false),
    }),
  );

  assert.equal(client.blastMigrators instanceof MigratorsClient, true);
});
