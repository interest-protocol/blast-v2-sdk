import { AdminCalls } from "@interest-protocol/blast-admin-sdk/transactions";
import { cetusMemeSide } from "@interest-protocol/blast-core/cetus";
import { grossGasBudget } from "@interest-protocol/blast-core/gas";
import {
  requirePositiveU64,
  requireU64,
  requireU128,
} from "@interest-protocol/blast-core/integers";
import { deploymentObject } from "@interest-protocol/blast-core/ptb";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { VaultDeployment } from "@interest-protocol/blast-vault-sdk/transactions";
import { normalizeVaultDeployment } from "@interest-protocol/blast-vault-sdk/transactions";
import type {
  TransactionArgument,
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
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

/** `constants::bluefin_max_tick_spacing`: Bluefin pool creation's own bound. */
export const BLUEFIN_MAX_TICK_SPACING = 400;

/** `constants::bluefin_max_fee_rate`: Bluefin pool creation's own bound (1,000,000 is 100%). */
export const BLUEFIN_MAX_FEE_RATE = 20_000n;

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

/** A vault's `Meme` and `Quote`; pass original (defining) type addresses. */
type PairTypes = { memeType: string; quoteType: string };

/** The Cetus `config::GlobalConfig` and LP Burn `lp_burn::BurnManager` fee routes read. */
type CetusFeeObjects = {
  config: SharedObjectIdentity;
  burnManager: SharedObjectIdentity;
};

/**
 * One Cetus vault: `vault` is the `Vault<Meme, Quote>` and `pool` its own
 * `Pool<CoinA, CoinB>`; `currency` is the Meme's Coin Registry
 * `Currency<Meme>`, which the burn route burns through.
 */
type CetusVaultInput = PairTypes & {
  vault: SharedObjectIdentity;
  currency: SharedObjectIdentity;
  cetus: CetusFeeObjects;
  pool: SharedObjectIdentity;
};

/** One Bluefin vault: its `Vault<Meme, Quote>`, `Pool<Meme, Quote>` and `Currency<Meme>`. */
type BluefinVaultInput = PairTypes & {
  vault: SharedObjectIdentity;
  currency: SharedObjectIdentity;
  bluefinConfig: SharedObjectIdentity;
  pool: SharedObjectIdentity;
};

/** A Cetus vault's auto-LP compounding inputs: the vault, Cetus's config and the pool. */
type CetusCompoundInput = PairTypes & {
  vault: SharedObjectIdentity;
  cetus: { config: SharedObjectIdentity };
  pool: SharedObjectIdentity;
};

/** A Bluefin vault's auto-LP compounding inputs: the vault, Bluefin's config and the pool. */
type BluefinCompoundInput = PairTypes & {
  vault: SharedObjectIdentity;
  bluefinConfig: SharedObjectIdentity;
  pool: SharedObjectIdentity;
};

/** A buyback's admin witness and swap bounds; `quoteIn` is atomic Quote. */
type BuybackInput = {
  adminWitness: TransactionObjectInput;
  quoteIn: bigint;
  minMemeOut: bigint;
};

/**
 * `blast_migrators` venue calls, in Move argument order; `&mut TxContext` is
 * implicit and the `Clock` is `0x6`. The migrators and vault package
 * versions, the `VenueConfig`, the `VaultRegistry` and the core treasury
 * come from the deployment. `prepare*` return the `VenueTicket<Meme, Quote>`
 * the product's `new` consumes; `migrate*` consume the product's
 * `Migration<Meme, Quote>` in the same PTB. Cetus calls take
 * `<Meme, Quote, CoinA, CoinB>` with the pool's coin order from
 * `cetusMemeSide`, so pass original (defining) type addresses.
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
   * cetus_config, pools, &mut sealed_treasury_cap, admission, tick_spacing)`:
   * borrows the coin's sealed `TreasuryCap` with the product's `VenueAdmission`
   * of this venue (`launch_config::venue_admission` or
   * `creation_policy::venue_admission`, built earlier in the same PTB),
   * reserves the Meme's Cetus pool and returns its `VenueTicket`.
   */
  prepareCetus(options: {
    memeType: string;
    quoteType: string;
    cetus: { config: SharedObjectIdentity; pools: SharedObjectIdentity };
    sealedTreasuryCap: TransactionObjectInput;
    admission: TransactionArgument;
    tickSpacing: number;
  }): (tx: Transaction) => TransactionResult {
    const types = pair(options);
    const tickSpacing = requireU32("tickSpacing", options.tickSpacing);
    const cetus = {
      config: normalizeSharedObjectIdentity(
        "cetus.config",
        options.cetus.config,
      ),
      pools: normalizeSharedObjectIdentity("cetus.pools", options.cetus.pools),
    };
    return (tx) =>
      tx.moveCall({
        target: this.#target("cetus", "prepare"),
        typeArguments: types,
        arguments: [
          this.#migratorsVersion(tx),
          deploymentObject(tx, this.deployment.venueConfig, true),
          deploymentObject(tx, cetus.config, false),
          deploymentObject(tx, cetus.pools, true),
          tx.object(options.sealedTreasuryCap),
          options.admission,
          tx.pure.u32(tickSpacing),
        ],
      });
  }

  /**
   * `bluefin::prepare<Meme, Quote>(migrators_version, venue_config,
   * &sealed_treasury_cap, &currency, tick_spacing, fee_rate)`: records the
   * Meme's Bluefin tier and returns its `VenueTicket`. The sealed cap only
   * proves control of the coin; Bluefin reserves nothing, so it is never
   * borrowed. Rejects a tier outside
   * Bluefin's own bounds (`EInvalidTier`: tick spacing 1..=400, fee rate
   * 1..=20,000); the contract also aborts with `ESymbolTooLong` when the
   * Meme symbol exceeds 32 bytes.
   */
  prepareBluefin(options: {
    memeType: string;
    quoteType: string;
    sealedTreasuryCap: TransactionObjectInput;
    currency: SharedObjectIdentity;
    tickSpacing: number;
    feeRate: bigint;
  }): (tx: Transaction) => TransactionResult {
    const types = pair(options);
    const tickSpacing = requireU32("tickSpacing", options.tickSpacing);
    const feeRate = requireU64("feeRate", options.feeRate);
    if (
      tickSpacing === 0 ||
      tickSpacing > BLUEFIN_MAX_TICK_SPACING ||
      feeRate === 0n ||
      feeRate > BLUEFIN_MAX_FEE_RATE
    ) {
      throw new RangeError(
        `a Bluefin tier needs a tick spacing in 1..=${BLUEFIN_MAX_TICK_SPACING} and a fee rate in 1..=${BLUEFIN_MAX_FEE_RATE}`,
      );
    }
    const currency = normalizeSharedObjectIdentity(
      "currency",
      options.currency,
    );
    return (tx) =>
      tx.moveCall({
        target: this.#target("bluefin", "prepare"),
        typeArguments: types,
        arguments: [
          this.#migratorsVersion(tx),
          deploymentObject(tx, this.deployment.venueConfig, true),
          tx.object(options.sealedTreasuryCap),
          deploymentObject(tx, currency, false),
          tx.pure.u32(tickSpacing),
          tx.pure.u64(feeRate),
        ],
      });
  }

  /**
   * `cetus::migrate<Meme, Quote, CoinA, CoinB>(migration, migrators_version,
   * venue_config, cetus_config, pools, burn_manager, registry, vault_version,
   * treasury, clock)`; `CoinA`/`CoinB` follow `cetusMemeSide`. Cetus writes
   * a clock-dependent amount of storage, so the PTB is budgeted at gross
   * cost (`grossGasBudget`).
   */
  migrateCetus(options: {
    migration: TransactionArgument;
    memeType: string;
    quoteType: string;
    cetus: {
      config: SharedObjectIdentity;
      pools: SharedObjectIdentity;
      burnManager: SharedObjectIdentity;
    };
  }): (tx: Transaction) => void {
    const typeArguments = cetusTypeArguments(options);
    const cetus = {
      config: normalizeSharedObjectIdentity(
        "cetus.config",
        options.cetus.config,
      ),
      pools: normalizeSharedObjectIdentity("cetus.pools", options.cetus.pools),
      burnManager: normalizeSharedObjectIdentity(
        "cetus.burnManager",
        options.cetus.burnManager,
      ),
    };
    return (tx) => {
      tx.addBuildPlugin(grossGasBudget());
      tx.moveCall({
        target: this.#target("cetus", "migrate"),
        typeArguments,
        arguments: [
          options.migration,
          this.#migratorsVersion(tx),
          deploymentObject(tx, this.deployment.venueConfig, false),
          deploymentObject(tx, cetus.config, false),
          deploymentObject(tx, cetus.pools, true),
          deploymentObject(tx, cetus.burnManager, true),
          deploymentObject(tx, this.deployment.vault.registry, true),
          this.#vaultVersion(tx),
          this.#treasury(tx),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * `bluefin::migrate<Meme, Quote>(migration, migrators_version,
   * venue_config, currency, quote_currency, bluefin_config, registry,
   * vault_version, treasury, creation_fee, clock)`; `creationFee` is a
   * `Coin<SUI>` of Bluefin's pool creation fee.
   */
  migrateBluefin(options: {
    migration: TransactionArgument;
    memeType: string;
    quoteType: string;
    currency: SharedObjectIdentity;
    quoteCurrency: SharedObjectIdentity;
    bluefinConfig: SharedObjectIdentity;
    creationFee: TransactionArgument;
  }): (tx: Transaction) => void {
    const types = pair(options);
    const currency = normalizeSharedObjectIdentity(
      "currency",
      options.currency,
    );
    const quoteCurrency = normalizeSharedObjectIdentity(
      "quoteCurrency",
      options.quoteCurrency,
    );
    const bluefinConfig = normalizeSharedObjectIdentity(
      "bluefinConfig",
      options.bluefinConfig,
    );
    return (tx) => {
      tx.moveCall({
        target: this.#target("bluefin", "migrate"),
        typeArguments: types,
        arguments: [
          options.migration,
          this.#migratorsVersion(tx),
          deploymentObject(tx, this.deployment.venueConfig, false),
          deploymentObject(tx, currency, false),
          deploymentObject(tx, quoteCurrency, false),
          deploymentObject(tx, bluefinConfig, true),
          deploymentObject(tx, this.deployment.vault.registry, true),
          this.#vaultVersion(tx),
          this.#treasury(tx),
          options.creationFee,
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * `cetus::collect_fees<Meme, Quote, CoinA, CoinB>(vault, migrators_version,
   * vault_version, treasury, currency, cetus_config, burn_manager, pool)`:
   * collects both positions' fees, splits them and burns the burn share's
   * Meme; the auto-LP share waits in the vault for `compoundCetusAutoLp`.
   * Anyone may call it.
   */
  collectCetusFees(options: CetusVaultInput): (tx: Transaction) => void {
    return this.#cetusFees("collect_fees", options);
  }

  /**
   * `cetus::settle_and_apply_fee_split(..., pool, clock)`: `collectCetusFees`
   * under the current split, then applies the ready scheduled split. Anyone
   * may call it.
   */
  settleAndApplyCetusFeeSplit(
    options: CetusVaultInput,
  ): (tx: Transaction) => void {
    return this.#cetusFees("settle_and_apply_fee_split", options);
  }

  /**
   * `bluefin::collect_fees<Meme, Quote>(vault, migrators_version,
   * vault_version, treasury, currency, bluefin_config, pool, clock)`: the
   * auto-LP share waits in the vault for `compoundBluefinAutoLp`. Anyone may
   * call it.
   */
  collectBluefinFees(options: BluefinVaultInput): (tx: Transaction) => void {
    return this.#bluefinFees("collect_fees", options);
  }

  /** `bluefin::settle_and_apply_fee_split`, same arguments as `collectBluefinFees`. */
  settleAndApplyBluefinFeeSplit(
    options: BluefinVaultInput,
  ): (tx: Transaction) => void {
    return this.#bluefinFees("settle_and_apply_fee_split", options);
  }

  /** Adds waiting auto-LP balances under AutoLpAdmin and keeper price bounds.
   * The private entry consumes and re-shares the pool, so put it last in a PTB.
   * Bounds are inclusive Q64.64 sqrt prices in venue pool coin order.
   */
  compoundCetusAutoLp(
    options: PairTypes &
      AutoLpInput & {
        vault: SharedObjectIdentity;
        cetus: { config: SharedObjectIdentity };
        pool: SharedObjectIdentity;
      },
  ): (tx: Transaction) => void {
    const typeArguments = cetusTypeArguments(options);
    const objects = {
      vault: normalizeSharedObjectIdentity("vault", options.vault),
      config: normalizeSharedObjectIdentity(
        "cetus.config",
        options.cetus.config,
      ),
      pool: normalizeSharedObjectIdentity("pool", options.pool),
    };
    const [min, max] = autoLpPriceBounds(options);
    return (tx) => {
      tx.moveCall({
        target: this.#target("cetus", "compound_auto_lp"),
        typeArguments,
        arguments: [
          deploymentObject(tx, objects.vault, true),
          this.#migratorsVersion(tx),
          this.#vaultVersion(tx),
          deploymentObject(tx, this.deployment.vault.admin.acl, false),
          tx.object(options.adminCap),
          deploymentObject(tx, objects.config, false),
          deploymentObject(tx, objects.pool, true),
          tx.pure.u128(min),
          tx.pure.u128(max),
          tx.object.clock(),
        ],
      });
    };
  }

  /** Bluefin's private AutoLpAdmin entry; see compoundCetusAutoLp. */
  compoundBluefinAutoLp(
    options: PairTypes &
      AutoLpInput & {
        vault: SharedObjectIdentity;
        bluefinConfig: SharedObjectIdentity;
        pool: SharedObjectIdentity;
      },
  ): (tx: Transaction) => void {
    const types = pair(options);
    const objects = {
      vault: normalizeSharedObjectIdentity("vault", options.vault),
      config: normalizeSharedObjectIdentity(
        "bluefinConfig",
        options.bluefinConfig,
      ),
      pool: normalizeSharedObjectIdentity("pool", options.pool),
    };
    const [min, max] = autoLpPriceBounds(options);
    return (tx) => {
      tx.moveCall({
        target: this.#target("bluefin", "compound_auto_lp"),
        typeArguments: types,
        arguments: [
          deploymentObject(tx, objects.vault, true),
          this.#migratorsVersion(tx),
          this.#vaultVersion(tx),
          deploymentObject(tx, this.deployment.vault.admin.acl, false),
          tx.object(options.adminCap),
          deploymentObject(tx, objects.config, false),
          deploymentObject(tx, objects.pool, true),
          tx.pure.u128(min),
          tx.pure.u128(max),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * `cetus::buyback_and_burn<Meme, Quote, CoinA, CoinB>(vault,
   * migrators_version, vault_version, admin_witness, currency, cetus_config,
   * pool, quote_in, min_meme_out, clock)` under a `BuybackAdmin` witness.
   * Swaps `quoteIn` of the vault's burn Quote and burns the Meme bought;
   * aborts unless the swap returns at least `minMemeOut`, which the admin
   * sets from an off-chain price.
   */
  buybackAndBurnCetus(
    options: PairTypes &
      BuybackInput & {
        vault: SharedObjectIdentity;
        currency: SharedObjectIdentity;
        cetus: { config: SharedObjectIdentity };
        pool: SharedObjectIdentity;
      },
  ): (tx: Transaction) => void {
    const typeArguments = cetusTypeArguments(options);
    const objects = {
      vault: normalizeSharedObjectIdentity("vault", options.vault),
      currency: normalizeSharedObjectIdentity("currency", options.currency),
      config: normalizeSharedObjectIdentity(
        "cetus.config",
        options.cetus.config,
      ),
      pool: normalizeSharedObjectIdentity("pool", options.pool),
    };
    const amounts = buybackAmounts(options);
    return (tx) => {
      tx.moveCall({
        target: this.#target("cetus", "buyback_and_burn"),
        typeArguments,
        arguments: [
          deploymentObject(tx, objects.vault, true),
          this.#migratorsVersion(tx),
          this.#vaultVersion(tx),
          tx.object(options.adminWitness),
          deploymentObject(tx, objects.currency, true),
          deploymentObject(tx, objects.config, false),
          deploymentObject(tx, objects.pool, true),
          tx.pure.u64(amounts.quoteIn),
          tx.pure.u64(amounts.minMemeOut),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * `bluefin::buyback_and_burn<Meme, Quote>(vault, migrators_version,
   * vault_version, admin_witness, currency, bluefin_config, pool, quote_in,
   * min_meme_out, clock)`; see `buybackAndBurnCetus`.
   */
  buybackAndBurnBluefin(
    options: PairTypes &
      BuybackInput & {
        vault: SharedObjectIdentity;
        currency: SharedObjectIdentity;
        bluefinConfig: SharedObjectIdentity;
        pool: SharedObjectIdentity;
      },
  ): (tx: Transaction) => void {
    const types = pair(options);
    const objects = {
      vault: normalizeSharedObjectIdentity("vault", options.vault),
      currency: normalizeSharedObjectIdentity("currency", options.currency),
      config: normalizeSharedObjectIdentity(
        "bluefinConfig",
        options.bluefinConfig,
      ),
      pool: normalizeSharedObjectIdentity("pool", options.pool),
    };
    const amounts = buybackAmounts(options);
    return (tx) => {
      tx.moveCall({
        target: this.#target("bluefin", "buyback_and_burn"),
        typeArguments: types,
        arguments: [
          deploymentObject(tx, objects.vault, true),
          this.#migratorsVersion(tx),
          this.#vaultVersion(tx),
          tx.object(options.adminWitness),
          deploymentObject(tx, objects.currency, true),
          deploymentObject(tx, objects.config, false),
          deploymentObject(tx, objects.pool, true),
          tx.pure.u64(amounts.quoteIn),
          tx.pure.u64(amounts.minMemeOut),
          tx.object.clock(),
        ],
      });
    };
  }

  #cetusFees(
    name: "collect_fees" | "settle_and_apply_fee_split",
    options: CetusVaultInput,
  ): (tx: Transaction) => void {
    const typeArguments = cetusTypeArguments(options);
    const objects = {
      vault: normalizeSharedObjectIdentity("vault", options.vault),
      currency: normalizeSharedObjectIdentity("currency", options.currency),
      config: normalizeSharedObjectIdentity(
        "cetus.config",
        options.cetus.config,
      ),
      burnManager: normalizeSharedObjectIdentity(
        "cetus.burnManager",
        options.cetus.burnManager,
      ),
      pool: normalizeSharedObjectIdentity("pool", options.pool),
    };
    return (tx) => {
      tx.moveCall({
        target: this.#target("cetus", name),
        typeArguments,
        arguments: [
          deploymentObject(tx, objects.vault, true),
          this.#migratorsVersion(tx),
          this.#vaultVersion(tx),
          this.#treasury(tx),
          deploymentObject(tx, objects.currency, true),
          deploymentObject(tx, objects.config, false),
          deploymentObject(tx, objects.burnManager, false),
          deploymentObject(tx, objects.pool, true),
          // Only the split's apply reads the clock.
          ...(name === "settle_and_apply_fee_split" ? [tx.object.clock()] : []),
        ],
      });
    };
  }

  #bluefinFees(
    name: "collect_fees" | "settle_and_apply_fee_split",
    options: BluefinVaultInput,
  ): (tx: Transaction) => void {
    const types = pair(options);
    const objects = {
      vault: normalizeSharedObjectIdentity("vault", options.vault),
      currency: normalizeSharedObjectIdentity("currency", options.currency),
      config: normalizeSharedObjectIdentity(
        "bluefinConfig",
        options.bluefinConfig,
      ),
      pool: normalizeSharedObjectIdentity("pool", options.pool),
    };
    return (tx) => {
      tx.moveCall({
        target: this.#target("bluefin", name),
        typeArguments: types,
        arguments: [
          deploymentObject(tx, objects.vault, true),
          this.#migratorsVersion(tx),
          this.#vaultVersion(tx),
          this.#treasury(tx),
          deploymentObject(tx, objects.currency, true),
          deploymentObject(tx, objects.config, false),
          deploymentObject(tx, objects.pool, true),
          tx.object.clock(),
        ],
      });
    };
  }

  #target(module: MigratorVenue, name: string): string {
    return `${this.deployment.packageId}::${module}::${name}`;
  }

  #migratorsVersion(tx: Transaction): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.packageVersion, false);
  }

  #vaultVersion(tx: Transaction): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.vault.packageVersion, false);
  }

  #treasury(tx: Transaction): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.vault.core.treasury, false);
  }
}

/**
 * One-call PTBs for a migrated vault's venue routes: fee collection,
 * settlement and auto-LP compounding (anyone) and buybacks (an `AdminCap` holding
 * `blast_domain::BuybackAdmin`). Preparation and migration are composed
 * with the product's own calls by the launchpad and presale packages.
 */
export class MigratorTransactions {
  readonly call: MigratorCalls;
  readonly admin: AdminCalls;

  constructor(deployment: MigratorsDeployment) {
    this.call = new MigratorCalls(deployment);
    this.admin = new AdminCalls(this.call.deployment.vault.admin);
  }

  collectCetusFees(options: CetusVaultInput): Transaction {
    return single(this.call.collectCetusFees(options));
  }

  settleAndApplyCetusFeeSplit(options: CetusVaultInput): Transaction {
    return single(this.call.settleAndApplyCetusFeeSplit(options));
  }

  collectBluefinFees(options: BluefinVaultInput): Transaction {
    return single(this.call.collectBluefinFees(options));
  }

  settleAndApplyBluefinFeeSplit(options: BluefinVaultInput): Transaction {
    return single(this.call.settleAndApplyBluefinFeeSplit(options));
  }

  compoundCetusAutoLp(
    options: Parameters<MigratorCalls["compoundCetusAutoLp"]>[0],
  ): Transaction {
    return single(this.call.compoundCetusAutoLp(options));
  }

  compoundBluefinAutoLp(
    options: Parameters<MigratorCalls["compoundBluefinAutoLp"]>[0],
  ): Transaction {
    return single(this.call.compoundBluefinAutoLp(options));
  }

  /** Signs in as `BuybackAdmin` with `adminCapId`, then `buybackAndBurnCetus`. */
  buybackAndBurnCetus(
    options: Omit<
      Parameters<MigratorCalls["buybackAndBurnCetus"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asBuybackAdmin(options.adminCapId, (adminWitness) =>
      this.call.buybackAndBurnCetus({ ...options, adminWitness }),
    );
  }

  /** Signs in as `BuybackAdmin` with `adminCapId`, then `buybackAndBurnBluefin`. */
  buybackAndBurnBluefin(
    options: Omit<
      Parameters<MigratorCalls["buybackAndBurnBluefin"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asBuybackAdmin(options.adminCapId, (adminWitness) =>
      this.call.buybackAndBurnBluefin({ ...options, adminWitness }),
    );
  }

  #asBuybackAdmin(
    adminCapId: string,
    call: (
      adminWitness: TransactionObjectArgument,
    ) => (tx: Transaction) => void,
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.admin.signIn({
        adminCap: adminCapId,
        role: coreRoleType(this.call.deployment.vault.core, "BuybackAdmin"),
      }),
    );
    tx.add(call(adminWitness));
    return tx;
  }
}

function single(step: (tx: Transaction) => void): Transaction {
  const tx = new Transaction();
  tx.add(step);
  return tx;
}

function pair(types: PairTypes): [string, string] {
  return [
    normalizeStructTag(types.memeType),
    normalizeStructTag(types.quoteType),
  ];
}

/** `<Meme, Quote, CoinA, CoinB>`, with the pool's coin order from `cetusMemeSide`. */
function cetusTypeArguments(types: PairTypes): string[] {
  const [meme, quote] = pair(types);
  return cetusMemeSide(meme, quote) === "a"
    ? [meme, quote, meme, quote]
    : [meme, quote, quote, meme];
}

function buybackAmounts(options: BuybackInput) {
  return {
    quoteIn: requirePositiveU64("quoteIn", options.quoteIn),
    minMemeOut: requireU64("minMemeOut", options.minMemeOut),
  };
}

function requireU32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be a u32`);
  }
  return value;
}

/** Authority and inclusive pool-order Q64.64 bounds for a private auto-LP entry. */
export type AutoLpInput = {
  adminCap: TransactionObjectInput;
  minSqrtPrice: bigint;
  maxSqrtPrice: bigint;
};

function autoLpPriceBounds(options: AutoLpInput): readonly [bigint, bigint] {
  const min = requireU128("minSqrtPrice", options.minSqrtPrice);
  const max = requireU128("maxSqrtPrice", options.maxSqrtPrice);
  if (min === 0n || min > max) {
    throw new RangeError("auto-LP needs 0 < minSqrtPrice <= maxSqrtPrice");
  }
  return [min, max];
}
