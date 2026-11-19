import assert from "node:assert/strict";
import test from "node:test";

import { SuiGrpcClient } from "@mysten/sui/grpc";

import { blastVesting, VestingClient } from "../src/vesting/client.ts";

test("registers the typed vesting client extension", () => {
  const client = new SuiGrpcClient({
    network: "testnet",
    baseUrl: "https://fullnode.testnet.sui.io:443",
  }).$extend(
    blastVesting({
      packageId: "0x123",
      originalPackageId: "0x122",
    }),
  );

  assert.equal(client.blastVesting instanceof VestingClient, true);
});
