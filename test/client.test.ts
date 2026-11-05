import assert from "node:assert/strict";
import test from "node:test";
import {
  blastLaunchpad,
  LaunchpadClient,
} from "@interest-protocol/blast-launchpad-sdk/client";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { LAUNCHPAD_DEPLOYMENT } from "./fixtures/launchpad-deployment.ts";

test("registers the typed launchpad client extension", () => {
  const client = new SuiGrpcClient({
    network: "mainnet",
    baseUrl: "https://fullnode.mainnet.sui.io:443",
  }).$extend(blastLaunchpad(LAUNCHPAD_DEPLOYMENT));

  assert.equal(client.blastLaunchpad instanceof LaunchpadClient, true);
});
