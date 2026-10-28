import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_MAINNET_PACKAGES,
  CANONICAL_MAINNET_SHARED_OBJECTS,
  getPresaleDeployment,
  MAINNET_ADMIN_DEPLOYMENT,
  MAINNET_LAUNCHPAD_DEPLOYMENT,
  MAINNET_MIGRATORS_DEPLOYMENT,
  MAINNET_PARTNERS_DEPLOYMENT,
  MAINNET_PRESALE_DEPLOYMENT,
} from "@interest-protocol/blast-deployments-sdk";
import { LaunchpadCalls } from "@interest-protocol/blast-launchpad-sdk/transactions";
import { MigratorCalls } from "@interest-protocol/blast-migrators-sdk/transactions";
import { PresaleCalls } from "@interest-protocol/blast-presale-sdk/transactions";
import { MAINNET_LAUNCHPAD_DEPLOYMENT as compatible } from "@interest-protocol/blast-sdk/deployments";

test("canonical call bindings share the published dependency lineage and activated versions", () => {
  assert.equal(
    MAINNET_LAUNCHPAD_DEPLOYMENT.packageId,
    "0x827e04933699da94c23d9ea529f184656738cacdb7962f03be791fd715b76743",
  );
  assert.equal(
    MAINNET_PRESALE_DEPLOYMENT.packageId,
    "0xedb6ddae546132a66f5ae5a1c3561ef07bf892620bd78d90659aba962f7be0af",
  );
  assert.equal(compatible, MAINNET_LAUNCHPAD_DEPLOYMENT);
  assert.equal(MAINNET_LAUNCHPAD_DEPLOYMENT.admin, MAINNET_ADMIN_DEPLOYMENT);
  assert.equal(MAINNET_PRESALE_DEPLOYMENT.admin, MAINNET_ADMIN_DEPLOYMENT);
  assert.equal(MAINNET_PARTNERS_DEPLOYMENT.admin, MAINNET_ADMIN_DEPLOYMENT);
  assert.equal(
    MAINNET_LAUNCHPAD_DEPLOYMENT.partnersPackageId,
    CANONICAL_MAINNET_PACKAGES.partners.packageId,
  );
  assert.equal(
    MAINNET_MIGRATORS_DEPLOYMENT.launchpad,
    MAINNET_LAUNCHPAD_DEPLOYMENT,
  );
  assert.deepEqual(getPresaleDeployment("mainnet"), MAINNET_PRESALE_DEPLOYMENT);
  assert.equal(
    new LaunchpadCalls(MAINNET_LAUNCHPAD_DEPLOYMENT).deployment.packageVersion
      .initialSharedVersion,
    "2",
  );
  assert.equal(
    new PresaleCalls(MAINNET_PRESALE_DEPLOYMENT).deployment.packageVersion
      .initialSharedVersion,
    "2",
  );
  assert.equal(
    new MigratorCalls(MAINNET_MIGRATORS_DEPLOYMENT).deployment.migratorsVersion
      .initialSharedVersion,
    "1",
  );
  assert.ok(
    Object.isFrozen(CANONICAL_MAINNET_SHARED_OBJECTS.presale.packageVersion),
  );
  assert.ok(Object.isFrozen(CANONICAL_MAINNET_PACKAGES.launchpad));
});
