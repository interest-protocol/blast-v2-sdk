import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_MAINNET_MVR_NAMES,
  CANONICAL_MAINNET_PACKAGES,
  CANONICAL_MAINNET_SHARED_OBJECTS,
  getPresaleDeployment,
  MAINNET_ADMIN_DEPLOYMENT,
  MAINNET_LAUNCHPAD_DEPLOYMENT,
  MAINNET_MIGRATORS_DEPLOYMENT,
  MAINNET_PARTNERS_DEPLOYMENT,
  MAINNET_PRESALE_DEPLOYMENT,
  resolveMainnetDeployments,
} from "@interest-protocol/blast-deployments-sdk";
import { LaunchpadCalls } from "@interest-protocol/blast-launchpad-sdk/transactions";
import { MigratorCalls } from "@interest-protocol/blast-migrators-sdk/transactions";
import { PresaleCalls } from "@interest-protocol/blast-presale-sdk/transactions";
import { MAINNET_LAUNCHPAD_DEPLOYMENT as compatible } from "@interest-protocol/blast-sdk/deployments";
import { SuiGrpcClient } from "@mysten/sui/grpc";

test("canonical call bindings share the published dependency lineage and activated versions", () => {
  assert.equal(
    MAINNET_LAUNCHPAD_DEPLOYMENT.packageId,
    "0x079a1b44c551613cbc63cc0406f8ff8d717407378dd6f17d43d9e1b3fd63a573",
  );
  assert.equal(
    MAINNET_PRESALE_DEPLOYMENT.packageId,
    "0xb0279fbe54bfd1d920e985a4dba0916b2b73a5218514edeecb7b9dd30cf2863b",
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
  assert.equal(
    MAINNET_ADMIN_DEPLOYMENT.acl.objectId,
    "0xbda4af615d93435145012eaaeb540bad2fe09ec0cbe6cb99fb0dae7637643a1d",
  );
});

test("MVR resolves only pinned release names and preserves dependency and shared-object identities", async () => {
  const client = mvrClient();
  const resolved = await resolveMainnetDeployments(client);
  assert.deepEqual(resolved, {
    admin: MAINNET_ADMIN_DEPLOYMENT,
    partners: MAINNET_PARTNERS_DEPLOYMENT,
    launchpad: MAINNET_LAUNCHPAD_DEPLOYMENT,
    migrators: MAINNET_MIGRATORS_DEPLOYMENT,
    presale: MAINNET_PRESALE_DEPLOYMENT,
  });
  assert.equal(resolved.launchpad.admin, resolved.admin);
  assert.equal(resolved.presale.admin, resolved.admin);
  assert.equal(resolved.migrators.launchpad, resolved.launchpad);
  assert.ok(Object.isFrozen(resolved));
  assert.ok(Object.isFrozen(resolved.presale));
  assert.ok(
    Object.values(CANONICAL_MAINNET_MVR_NAMES).every((name) =>
      name.endsWith("/1"),
    ),
  );
});

test("MVR refuses a foreign package and the wrong network", async () => {
  await assert.rejects(
    resolveMainnetDeployments(mvrClient({ "@blastpackages/admin/1": "0x5" })),
    /does not match the reviewed Blast release/,
  );
  const client = new SuiGrpcClient({
    network: "testnet",
    baseUrl: "https://unused.invalid",
  });
  await assert.rejects(
    resolveMainnetDeployments(client),
    /require Sui mainnet/,
  );
});

test("MVR missing names and resolver failures never fall back to static addresses", async () => {
  const client = mvrClient();
  client.core.mvr.resolve = async () => ({ packages: {}, types: {} });
  await assert.rejects(
    resolveMainnetDeployments(client),
    /MVR did not resolve @blastpackages\/admin\/1/,
  );
  client.core.mvr.resolve = async () => {
    throw new Error("MVR unavailable");
  };
  await assert.rejects(resolveMainnetDeployments(client), /MVR unavailable/);
});

function mvrClient(overrides: Record<string, string> = {}) {
  const packages = Object.fromEntries(
    Object.entries(CANONICAL_MAINNET_MVR_NAMES).map(([name, mvrName]) => [
      mvrName,
      CANONICAL_MAINNET_PACKAGES[
        name as keyof typeof CANONICAL_MAINNET_MVR_NAMES
      ].packageId,
    ]),
  );
  return new SuiGrpcClient({
    network: "mainnet",
    baseUrl: "https://unused.invalid",
    mvr: { overrides: { packages: { ...packages, ...overrides } } },
  });
}
