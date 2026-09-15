import assert from "node:assert/strict";
import test from "node:test";

import { SuiGrpcClient } from "@mysten/sui/grpc";

import { blastLaunchpad, LaunchpadClient } from "../src/launchpad/client.ts";

test("registers the typed launchpad client extension", () => {
  const client = new SuiGrpcClient({
    network: "testnet",
    baseUrl: "https://fullnode.testnet.sui.io:443",
  }).$extend(
    blastLaunchpad({
      packageId: "0x123",
      packageVersion: {
        objectId: "0x2",
        initialSharedVersion: "10",
        mutable: false,
      },
      launchConfig: {
        objectId: "0x3",
        initialSharedVersion: "11",
        mutable: false,
      },
      runtimeConfig: {
        objectId: "0x4",
        initialSharedVersion: "12",
        mutable: false,
      },
      protocolAuthority: {
        objectId: "0x5",
        initialSharedVersion: "13",
        mutable: false,
      },
    }),
  );

  assert.equal(client.blastLaunchpad instanceof LaunchpadClient, true);
});
