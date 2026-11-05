import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { VaultDeployment } from "@interest-protocol/blast-vault-sdk/transactions";
import { normalizeVaultDeployment } from "@interest-protocol/blast-vault-sdk/transactions";
import type {
  Transaction,
  TransactionArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";

/**
 * The product-agnostic `blast_migrators` package: its shared
 * `PackageVersion<BLAST_MIGRATORS>`, `PackageAdmin<BLAST_MIGRATORS>` and
 * `venue_config::VenueConfig`, and the vault deployment (with core and admin)
 * every venue call reads.
 */
export type MigratorsDeployment = {
  packageId: string;
  originalPackageId: string;
  packageVersion: SharedObjectIdentity;
  packageAdmin: SharedObjectIdentity;
  venueConfig: SharedObjectIdentity;
  vault: VaultDeployment;
};

/** The venues `blast_migrators` defines, one module each. */
export const MIGRATOR_VENUES = ["bluefin", "cetus"] as const;
export type MigratorVenue = (typeof MIGRATOR_VENUES)[number];

export function normalizeMigratorsDeployment(
  deployment: MigratorsDeployment,
): MigratorsDeployment {
  return {
    ...normalizeSuiPackageReference("migrators", deployment),
    packageVersion: normalizeSharedObjectIdentity(
      "migrators.packageVersion",
      deployment.packageVersion,
    ),
    packageAdmin: normalizeSharedObjectIdentity(
      "migrators.packageAdmin",
      deployment.packageAdmin,
    ),
    venueConfig: normalizeSharedObjectIdentity(
      "migrators.venueConfig",
      deployment.venueConfig,
    ),
    vault: normalizeVaultDeployment(deployment.vault),
  };
}

/**
 * `<migrators original>::<venue>::Venue`: the witness a venue seals tickets
 * and redeems migrations under, and that a product and the vault registry
 * admit.
 */
export function venueWitnessType(
  migrators: Pick<MigratorsDeployment, "originalPackageId">,
  venue: MigratorVenue,
): string {
  if (!MIGRATOR_VENUES.includes(venue))
    throw new TypeError(`unknown migrators venue ${String(venue)}`);
  return normalizeStructTag(`${migrators.originalPackageId}::${venue}::Venue`);
}

/**
 * The migrators venue a `Launch.venue` or `Presale.venue` `TypeName`
 * (original-ID form) names, or null for any other venue.
 */
export function venueOf(
  migrators: Pick<MigratorsDeployment, "originalPackageId">,
  typeName: string,
): MigratorVenue | null {
  const type = normalizeStructTag(typeName);
  return (
    MIGRATOR_VENUES.find(
      (venue) => venueWitnessType(migrators, venue) === type,
    ) ?? null
  );
}

/**
 * `blast_migrators` venue calls, in Move argument order; `&mut TxContext` is
 * implicit and the `Clock` is `0x6`. The migrators and vault package
 * versions, the `VenueConfig`, the `VaultRegistry` and the core treasury
 * come from the deployment. `prepare*` return the `VenueTicket<Meme, Quote>`
 * the product's `new` consumes; `migrate*` consume the product's
 * `Migration<Meme, Quote>` in the same PTB.
 */
export class MigratorCalls {
  readonly deployment: MigratorsDeployment;
  /** `blast_migrators::BLAST_MIGRATORS`, the package's OTW. */
  readonly otw: string;

  constructor(deployment: MigratorsDeployment) {
    this.deployment = normalizeMigratorsDeployment(deployment);
    this.otw = normalizeStructTag(
      `${this.deployment.originalPackageId}::blast_migrators::BLAST_MIGRATORS`,
    );
  }

  /**
   * `cetus::prepare<Meme, Quote>(migrators_version, venue_config,
   * cetus_config, pools, &mut treasury_cap, tick_spacing)`: reserves the
   * Meme's Cetus pool and returns its `VenueTicket`.
   */
  prepareCetus(_options: {
    memeType: string;
    quoteType: string;
    cetus: { config: SharedObjectIdentity; pools: SharedObjectIdentity };
    treasuryCap: TransactionObjectInput;
    tickSpacing: number;
  }): (tx: Transaction) => TransactionResult {
    throw notYet("prepareCetus");
  }

  /**
   * `bluefin::prepare<Meme, Quote>(migrators_version, venue_config,
   * &treasury_cap, &currency, tick_spacing, fee_rate)`: records the Meme's
   * Bluefin tier and returns its `VenueTicket`.
   */
  prepareBluefin(_options: {
    memeType: string;
    quoteType: string;
    treasuryCap: TransactionObjectInput;
    currency: SharedObjectIdentity;
    tickSpacing: number;
    feeRate: bigint;
  }): (tx: Transaction) => TransactionResult {
    throw notYet("prepareBluefin");
  }

  /**
   * `cetus::migrate<Meme, Quote, CoinA, CoinB>(migration, migrators_version,
   * venue_config, cetus_config, pools, burn_manager, registry, vault_version,
   * treasury, clock)`; `CoinA`/`CoinB` follow `cetusMemeSide`.
   */
  migrateCetus(_options: {
    migration: TransactionArgument;
    memeType: string;
    quoteType: string;
    cetus: {
      config: SharedObjectIdentity;
      pools: SharedObjectIdentity;
      burnManager: SharedObjectIdentity;
    };
  }): (tx: Transaction) => void {
    throw notYet("migrateCetus");
  }

  /**
   * `bluefin::migrate<Meme, Quote>(migration, migrators_version,
   * venue_config, currency, quote_currency, bluefin_config, registry,
   * vault_version, treasury, creation_fee, clock)`; `creationFee` is a
   * `Coin<SUI>` of Bluefin's pool creation fee.
   */
  migrateBluefin(_options: {
    migration: TransactionArgument;
    memeType: string;
    quoteType: string;
    currency: SharedObjectIdentity;
    quoteCurrency: SharedObjectIdentity;
    bluefinConfig: SharedObjectIdentity;
    creationFee: TransactionArgument;
  }): (tx: Transaction) => void {
    throw notYet("migrateBluefin");
  }
}

function notYet(method: string): Error {
  return new Error(`WP2: MigratorCalls.${method} is not implemented yet`);
}
