import { equal, exec, expectAbort } from "../chain.ts";
import { client, presale, wallets } from "../env.ts";
import type { SaleRecord } from "../sale.ts";
import { mut, types } from "../sale.ts";

/** The sale token's Coin Registry supply state: minted once and sealed at creation. */
export async function assertSealed(
  record: SaleRecord,
  mode: "Fixed" | "BurnOnly",
): Promise<void> {
  const { object } = await client.core.getObject({
    objectId: record.currency.objectId,
    include: { json: true },
  });
  const supply = (object.json as { supply?: { "@variant"?: string } }).supply;
  equal(`supply sealed ${mode}`, supply?.["@variant"], mode);
}

/**
 * `claim_migration_residuals`: a foreign cap aborts; the creator claims any
 * residuals once; a further claim aborts.
 */
export async function residualChecks(
  record: SaleRecord,
  foreignCapId: string,
): Promise<void> {
  const w = wallets();
  if (!record.vault) throw new Error(`${record.scenario} has not migrated`);
  const claim = (capId: string) =>
    presale.tx.claimMigrationResiduals({
      ...types(record),
      vault: mut(record.vault as NonNullable<SaleRecord["vault"]>),
      presaleCapId: capId,
      recipient: w.creator.toSuiAddress(),
    });
  await expectAbort(
    "residuals with another sale's cap",
    w.creator,
    claim(foreignCapId),
    { module: "presale_vault", code: 2 },
  );
  const vault = await presale.getVault(record.vault.objectId);
  if (vault.migrationMemeResidual > 0n || vault.migrationQuoteResidual > 0n) {
    await exec(
      `creator claims residuals (${vault.migrationMemeResidual} meme, ${vault.migrationQuoteResidual} quote)`,
      w.creator,
      claim(record.capId),
    );
  }
  await expectAbort(
    "residuals when none remain",
    w.creator,
    claim(record.capId),
    { module: "presale_vault", code: 0 },
  );
}
