import assert from "node:assert/strict";
import test from "node:test";
import type { PresaleCreatorDeployment } from "@interest-protocol/blast-presale-sdk/creator";
import { createPresaleCreatorClient } from "@interest-protocol/blast-presale-sdk/creator";
import { vaultBcs } from "@interest-protocol/blast-vault-sdk/state";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import {
  fromHex,
  normalizeStructTag,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";
import { assertBuildersMatchAbi, readAbi } from "./abi.ts";
import { PRESALE_DEPLOYMENT } from "./fixtures/presale-deployment.ts";
import { fixture, deployment as vaultDeployment } from "./vault-helpers.ts";

// The Move-printed vault (`test/fixtures/vault-a1a8f6c.move`) under a presale
// deployment whose vault package is the fixture's.
const presale = { ...PRESALE_DEPLOYMENT, vault: vaultDeployment };
const identity: PresaleCreatorDeployment = {
  presale: {
    ...presale,
    migrators: { ...presale.migrators, vault: vaultDeployment },
  },
  venues: {
    cetus: {
      config: { objectId: "0xce1", initialSharedVersion: "1" },
      burnManager: { objectId: "0xce3", initialSharedVersion: "1" },
    },
  },
};
const presaleWitness = normalizeStructTag(
  `${presale.originalPackageId}::blast_presale_package::PackageWitness`,
);
const cetusVenue = normalizeStructTag(
  `${presale.migrators.originalPackageId}::cetus::Venue`,
);
const vaultType = `${fixture.vaultOriginalPackageId}::vault::Vault<${fixture.memeType}, ${fixture.quoteType}>`;
const currencyId = normalizeSuiObjectId("0xcc1");

/** The fixture's vault bytes, optionally sealed under another package witness. */
function vaultBytes(packageWitness?: string): Uint8Array {
  const bytes = fromHex(fixture.objects.vault);
  if (!packageWitness) return bytes;
  const parsed = vaultBcs.parse(bytes);
  return vaultBcs
    .serialize({ ...parsed, terms: { ...parsed.terms, packageWitness } })
    .toBytes();
}

/** A node holding the vault (its position on `venue`), its pool and the Meme's Currency. */
function client(content: Uint8Array, venue: string): ClientWithCoreApi {
  const shared = (objectId: string, type: string, version: string) => ({
    objectId: normalizeSuiObjectId(objectId),
    owner: { $kind: "Shared", Shared: { initialSharedVersion: version } },
    type,
  });
  const core = {
    getObject: async () => ({
      object: { ...shared(fixture.vaultId, vaultType, "9"), content },
    }),
    listDynamicFields: async () => ({
      hasNextPage: false,
      cursor: null,
      dynamicFields: [
        {
          $kind: "DynamicObject",
          name: {
            type: `0x2::dynamic_object_field::Wrapper<${fixture.vaultOriginalPackageId}::vault::PositionKey<${venue}>>`,
            bcs: new Uint8Array([0]),
          },
          childId: normalizeSuiObjectId("0xa1"),
        },
      ],
    }),
    getCoinMetadata: async ({ coinType }: { coinType: string }) => {
      assert.equal(coinType, normalizeStructTag(fixture.memeType));
      return { coinMetadata: { id: currencyId } };
    },
    getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
      objects: objectIds.map((objectId) =>
        normalizeSuiObjectId(objectId) === currencyId
          ? shared(
              objectId,
              `0x2::coin_registry::Currency<${fixture.memeType}>`,
              "11",
            )
          : shared(objectId, "0xce::pool::Pool", "12"),
      ),
    }),
  };
  return { core } as unknown as ClientWithCoreApi;
}

test("a vault the presale did not seal prepares no transaction", async () => {
  // The Move-printed vault is sealed by the fixture's own SaleWitness.
  const prepared = await createPresaleCreatorClient(
    client(vaultBytes(), cetusVenue),
    identity,
  ).transaction(fixture.vaultId, fixture.alice, "collect_fees");
  assert.equal(prepared, null);
});

test("a presale vault on Cetus collects fees through migrators cetus::collect_fees", async () => {
  const prepared = await createPresaleCreatorClient(
    client(vaultBytes(presaleWitness), cetusVenue),
    identity,
  ).transaction(fixture.vaultId, fixture.alice, "collect_fees");
  assert.ok(prepared);
  assert.equal(prepared.presaleId, normalizeSuiObjectId(fixture.saleId));
  assert.equal(prepared.vaultId, normalizeSuiObjectId(fixture.vaultId));
  assert.deepEqual(
    assertBuildersMatchAbi(
      prepared.transaction,
      readAbi("production-migrators-v1.json", "migrators"),
      presale.migrators.packageId,
    ),
    ["cetus::collect_fees"],
  );
  assert.ok(prepared.kindBytes.length > 0);
});

test("a vault on a venue this deployment cannot reach prepares nothing", async () => {
  for (const venue of [fixture.venue, cetusVenue]) {
    const prepared = await createPresaleCreatorClient(
      client(vaultBytes(presaleWitness), venue),
      { ...identity, venues: {} },
    ).transaction(fixture.vaultId, fixture.alice, "collect_fees");
    assert.equal(prepared, null);
  }
});
