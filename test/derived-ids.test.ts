import assert from "node:assert/strict";
import test from "node:test";
import { launchId } from "@interest-protocol/blast-launchpad-sdk/state";
import { presaleId } from "@interest-protocol/blast-presale-sdk/state";
import { vaultId } from "@interest-protocol/blast-vault-sdk/state";
import { DERIVED_ID_FIXTURE as fixture } from "./fixtures/derived-ids.ts";

const registry = (objectId: string) => ({ objectId, initialSharedVersion: 1 });

test("launchId derives the Move LaunchKey<Meme> address", () => {
  assert.equal(
    launchId(
      {
        originalPackageId: fixture.launchpadOriginalPackageId,
        launchRegistry: registry(fixture.launchRegistryId),
      },
      fixture.memeType,
    ),
    fixture.launchId,
  );
});

test("presaleId derives the Move PresaleKey<SaleToken> address", () => {
  assert.equal(
    presaleId(
      {
        originalPackageId: fixture.presaleOriginalPackageId,
        presaleRegistry: registry(fixture.presaleRegistryId),
      },
      fixture.memeType,
    ),
    fixture.presaleId,
  );
});

test("vaultId derives the Move VaultKey address for each product's witness", () => {
  const vault = {
    originalPackageId: fixture.vaultOriginalPackageId,
    registry: registry(fixture.vaultRegistryId),
  };
  assert.equal(
    vaultId(
      vault,
      `${fixture.launchpadOriginalPackageId}::blast_fun::PackageWitness`,
      fixture.launchOriginId,
    ),
    fixture.launchVaultId,
  );
  assert.equal(
    vaultId(
      vault,
      `${fixture.presaleOriginalPackageId}::blast_presale_package::PackageWitness`,
      fixture.presaleOriginId,
    ),
    fixture.presaleVaultId,
  );
});

test("derived IDs accept short and unnormalized addresses alike", () => {
  const short = (id: string) => id.replace(/^0x0+/, "0x");
  assert.equal(
    launchId(
      {
        originalPackageId: short(fixture.launchpadOriginalPackageId),
        launchRegistry: registry(short(fixture.launchRegistryId)),
      },
      fixture.memeType.replace(/^0x0+/, "0x"),
    ),
    fixture.launchId,
  );
  assert.equal(
    vaultId(
      {
        originalPackageId: short(fixture.vaultOriginalPackageId),
        registry: registry(short(fixture.vaultRegistryId)),
      },
      `${short(fixture.launchpadOriginalPackageId)}::blast_fun::PackageWitness`,
      short(fixture.launchOriginId),
    ),
    fixture.launchVaultId,
  );
});
