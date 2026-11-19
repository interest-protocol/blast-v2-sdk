import assert from "node:assert/strict";
import test from "node:test";

import { SuiGrpcClient } from "@mysten/sui/grpc";

import { mainnet } from "../src/deployments.ts";
import { blastOtc, OtcClient } from "../src/otc/client.ts";
import { blastVesting, VestingClient } from "../src/vesting/client.ts";

test("registers typed OTC and vesting extensions against mainnet", () => {
  const client = new SuiGrpcClient({
    network: "mainnet",
    baseUrl: "https://fullnode.mainnet.sui.io:443",
  })
    .$extend(blastOtc(mainnet.otc))
    .$extend(blastVesting(mainnet.vesting));

  assert.equal(client.blastOtc instanceof OtcClient, true);
  assert.equal(client.blastVesting instanceof VestingClient, true);
  assert.equal(
    client.blastOtc.call.deployment.originalPackageId,
    mainnet.otc.packageId,
  );
});
