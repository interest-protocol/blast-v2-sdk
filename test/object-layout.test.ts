import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { vaultTermsBcs } from "@interest-protocol/blast-core/migration";
import {
  launchBcs,
  launchConfigBcs,
  launchTicketBcs,
  runtimeConfigBcs,
} from "@interest-protocol/blast-launchpad-sdk/state";
import { poolCreationBcs } from "@interest-protocol/blast-presale-sdk/aftermath-dao";
import { presaleBcs } from "@interest-protocol/blast-presale-sdk/state";
import {
  roundBcs,
  vaultBcs,
  vaultRegistryBcs,
} from "@interest-protocol/blast-vault-sdk/state";
import type { BcsType } from "@mysten/sui/bcs";
import { fromHex } from "@mysten/sui/utils";
import { launchpadFixture } from "./fixtures/launchpad-68db57b.ts";
import { PRESALE_FIXTURE } from "./fixtures/presale-a1a8f6c.ts";
import { VAULT_FIXTURE } from "./fixtures/vault-a1a8f6c.ts";

type FrozenStruct = { name: string; fields: { name: string }[] };
type Artifact = {
  packages: Record<
    string,
    { modules: Record<string, { structs: FrozenStruct[] }> }
  >;
};

function frozenFields(
  file: string,
  packageKey: string,
  moduleName: string,
  structName: string,
): string[] {
  const artifact = JSON.parse(
    readFileSync(new URL(`../abi/${file}`, import.meta.url), "utf8"),
  ) as Artifact;
  const frozen = artifact.packages[packageKey]?.modules[
    moduleName
  ]?.structs.find(({ name }) => name === structName);
  assert.ok(frozen, `${moduleName}::${structName} is in abi/${file}`);
  return frozen.fields.map(({ name }) => name);
}

/**
 * Each layout parses bytes the Move test runner printed at the baseline, and a
 * BCS struct reads its fields in declaration order, so the parsed keys must be
 * the frozen Move fields in order.
 */
test("SDK object layouts parse Move bytes in the frozen field order", () => {
  const layouts: [
    file: string,
    packageKey: string,
    moduleName: string,
    structName: string,
    schema: BcsType<unknown, unknown>,
    bytes: Uint8Array,
  ][] = [
    [
      "production-launchpad-v1.json",
      "launchpad",
      "launch",
      "Launch",
      launchBcs as never,
      launchpadFixture("launchFinalized"),
    ],
    [
      "production-launchpad-v1.json",
      "launchpad",
      "launch_config",
      "LaunchConfig",
      launchConfigBcs as never,
      launchpadFixture("launchConfig"),
    ],
    [
      "production-launchpad-v1.json",
      "launchpad",
      "runtime_config",
      "RuntimeConfig",
      runtimeConfigBcs as never,
      launchpadFixture("runtimeConfig"),
    ],
    [
      "production-launchpad-v1.json",
      "launchpad",
      "launch_ticket",
      "LaunchTicket",
      launchTicketBcs as never,
      launchpadFixture("launchTicket"),
    ],
    [
      "production-core-v1.json",
      "core",
      "migration",
      "VaultTerms",
      vaultTermsBcs as never,
      launchpadFixture("migrationTerms"),
    ],
    [
      "production-presale-v1.json",
      "presale",
      "blast_presale",
      "Presale",
      presaleBcs as never,
      fromHex(PRESALE_FIXTURE.presaleOpenObject),
    ],
    [
      "production-core-v1.json",
      "core",
      "migration",
      "VaultTerms",
      vaultTermsBcs as never,
      fromHex(PRESALE_FIXTURE.vaultTerms),
    ],
    [
      "production-aftermath-dao-presale-v1.json",
      "aftermathDaoPresale",
      "blast_aftermath_dao_presale",
      "PoolCreation",
      poolCreationBcs as never,
      fromHex(PRESALE_FIXTURE.poolCreation),
    ],
    [
      "production-vault-v1.json",
      "vault",
      "vault",
      "Vault",
      vaultBcs as never,
      fromHex(VAULT_FIXTURE.objects.vault),
    ],
    [
      "production-vault-v1.json",
      "vault",
      "blast_vault_package",
      "VaultRegistry",
      vaultRegistryBcs as never,
      fromHex(VAULT_FIXTURE.objects.registry),
    ],
    [
      "production-vault-v1.json",
      "vault",
      "holder_rewards",
      "Round",
      roundBcs as never,
      fromHex(VAULT_FIXTURE.objects.roundPublished),
    ],
  ];
  for (const [file, packageKey, moduleName, structName, schema, bytes] of [
    ...layouts,
  ]) {
    const parsed = schema.parse(bytes);
    // Transformed layouts (VaultTerms) read camelCase keys.
    assert.deepEqual(
      Object.keys(parsed as object).map((key) =>
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      ),
      frozenFields(file, packageKey, moduleName, structName),
      structName,
    );
  }
});
