import type { CoinSourceOptions } from "@interest-protocol/blast-core/coins";
import { grossGasBudget } from "@interest-protocol/blast-core/gas";
import { requireU64 } from "@interest-protocol/blast-core/integers";
import {
  deploymentObject,
  moveResults,
} from "@interest-protocol/blast-core/ptb";
import type {
  RewardManifest,
  RewardProof,
} from "@interest-protocol/blast-core/rewards/allocations";
import {
  MIGRATOR_REWARD_LEAF_DOMAIN,
  rewardAddress,
  rewardDigest,
  validateRewardManifest,
} from "@interest-protocol/blast-core/rewards/allocations";
import type {
  SharedObjectIdentity,
  SharedObjectReference,
} from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSharedObjectReference,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { FeeSplit } from "@interest-protocol/blast-launchpad-sdk/allocation";
import type {
  BlastFunAdminRole,
  LaunchpadDeployment,
  LaunchSettings,
  LaunchTypes,
  PreShareBuyInput,
} from "@interest-protocol/blast-launchpad-sdk/transactions";
import {
  addLaunchCompletion,
  LaunchpadCalls,
  normalizeLaunchTypes,
} from "@interest-protocol/blast-launchpad-sdk/transactions";
import type {
  TransactionArgument,
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import type { MigratorVenue } from "./state.ts";

/**
 * The vault's partner, when `LpVaultState.partnerId` is set: the collection
 * then pays it and Blast the LP fees the vault held.
 */
export type LpFeePartner = {
  partner?: SharedObjectReference<false> | null;
};

export type MigratorsDeployment = {
  packageId: string;
  originalPackageId: string;
  launchpad: LaunchpadDeployment;
  /** Migrators `blast_fun_migrators::PackageVersion` checked by every protected entry. */
  migratorsVersion: SharedObjectIdentity;
  /** Migrators `lp_fee_policy::LpFeePolicy` read by every LP-fee collection. */
  lpFeePolicy: SharedObjectIdentity;
  /** Migrators `venue_config::VenueConfig`, holding each Meme's Cetus `PoolCreationCap`. */
  venueConfig: SharedObjectIdentity;
};

import type { CetusMemeSide } from "@interest-protocol/blast-core/cetus";

export type { CetusMemeSide } from "@interest-protocol/blast-core/cetus";

/** The Cetus CLMM `config::GlobalConfig` every Cetus route reads. */
export type CetusObjects = {
  /** Cetus CLMM `config::GlobalConfig`. */
  cetusConfig: SharedObjectReference<false>;
};

/** Settings for starting a launch through an adapter in one transaction. */
export type CreateLaunchOptions = LaunchTypes &
  LaunchSettings &
  CoinSourceOptions & {
    /** The `LaunchTicket<Meme>` the generated package's initializer transferred to its publisher. */
    ticket: TransactionObjectInput;
    /** The Meme `Currency<Meme>` in the Coin Registry, fixed at finalization. */
    memeCurrency: SharedObjectReference<true>;
    /** `LaunchConfig.creation_fee` in MIST, paid as an exact SUI coin. */
    creationFee: bigint;
    preShareBuy?: PreShareBuyInput;
  };

/** Maximum Merkle proof depth the holder-reward leaf count (65,536) allows. */
export const MAX_HOLDER_REWARD_PROOF_DEPTH = 16;

export class MigratorCalls {
  readonly deployment: MigratorsDeployment;
  readonly launchpad: LaunchpadCalls;

  constructor(deployment: MigratorsDeployment) {
    this.launchpad = new LaunchpadCalls(deployment.launchpad);
    this.deployment = {
      ...normalizeSuiPackageReference("migrators", deployment),
      launchpad: this.launchpad.deployment,
      migratorsVersion: normalizeSharedObjectIdentity(
        "migratorsVersion",
        deployment.migratorsVersion,
      ),
      lpFeePolicy: normalizeSharedObjectIdentity(
        "lpFeePolicy",
        deployment.lpFeePolicy,
      ),
      venueConfig: normalizeSharedObjectIdentity(
        "venueConfig",
        deployment.venueConfig,
      ),
    };
  }

  /** The adapter witness type a launch stores as its `migration_witness`. */
  migrationWitnessType(venue: MigratorVenue): string {
    return normalizeStructTag(
      `${this.deployment.originalPackageId}::${venue}::Witness`,
    );
  }

  signIn(options: {
    adminCap: TransactionObjectInput;
    role: BlastFunAdminRole;
  }) {
    return this.launchpad.signIn(options);
  }

  /**
   * Starts a Cetus launch at `tickSpacing`: Cetus derives the fee rate, and the
   * Meme type's single `PoolCreationCap` is minted and reserved for the pair.
   * Returns the `LaunchInitializer`, which the same PTB must finalize.
   */
  newCetusLaunch(
    options: LaunchTypes &
      CetusObjects & {
        ticket: TransactionObjectInput;
        cetusPools: SharedObjectReference<true>;
        tickSpacing: number;
      },
  ) {
    const types = normalizeLaunchTypes(options);
    const tickSpacing = requireU32("tickSpacing", options.tickSpacing);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::cetus::new`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          tx.object(options.ticket),
          this.#migratorsVersion(tx),
          this.#launchpadVersion(tx),
          this.#launchConfig(tx),
          deploymentObject(tx, this.deployment.venueConfig, true),
          sharedObject(tx, "cetusConfig", options.cetusConfig, false),
          sharedObject(tx, "cetusPools", options.cetusPools, true),
          tx.pure.u32(tickSpacing),
        ],
      });
  }

  /**
   * Starts a Bluefin launch at the creator's tier (tick spacing 1-400, fee rate
   * 1-20,000, Bluefin's own bounds). Returns the `LaunchInitializer`.
   */
  newBluefinLaunch(
    options: LaunchTypes & {
      ticket: TransactionObjectInput;
      tickSpacing: number;
      feeRate: bigint;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const tickSpacing = requireU32("tickSpacing", options.tickSpacing);
    requireU64("feeRate", options.feeRate);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::bluefin::new`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          tx.object(options.ticket),
          this.#migratorsVersion(tx),
          this.#launchpadVersion(tx),
          this.#launchConfig(tx),
          tx.pure.u32(tickSpacing),
          tx.pure.u64(options.feeRate),
        ],
      });
  }

  /**
   * Migrates a MigrationReady Cetus launch: creates the pool with the reserved
   * capability, seeds full-range liquidity, and burns the position through
   * Cetus LP Burn. Anyone may call it.
   */
  migrateCetus(
    options: LaunchTypes &
      CetusObjects & {
        memeSide: CetusMemeSide;
        launch: SharedObjectReference<true>;
        memeCurrency: SharedObjectReference<true>;
        cetusPools: SharedObjectReference<true>;
        /** Cetus LP Burn `lp_burn::BurnManager`. */
        burnManager: SharedObjectReference<true>;
      },
  ) {
    const types = normalizeLaunchTypes(options);
    const memeSide = normalizeMemeSide(options.memeSide);
    return (tx: Transaction): void => {
      // Cetus seeds a new pool's tick skip list from the clock, so its storage
      // differs between simulation and execution by up to 18 bytes, more than
      // the default budget's headroom: budget this transaction at gross cost.
      tx.addBuildPlugin(grossGasBudget());
      tx.moveCall({
        target: `${this.deployment.packageId}::cetus::migrate`,
        typeArguments: cetusTypeArguments(types, memeSide),
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#migratorsVersion(tx),
          this.#launchpadVersion(tx),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          deploymentObject(tx, this.deployment.venueConfig, false),
          sharedObject(tx, "cetusConfig", options.cetusConfig, false),
          sharedObject(tx, "cetusPools", options.cetusPools, true),
          sharedObject(tx, "burnManager", options.burnManager, true),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * Migrates a MigrationReady Bluefin launch into a new `Pool<Meme, Quote>`.
   * `creationFee` must be exactly Bluefin's configured SUI pool-creation fee.
   */
  migrateBluefin(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      memeCurrency: SharedObjectReference<true>;
      quoteCurrency: SharedObjectReference<false>;
      bluefinConfig: SharedObjectReference<true>;
      creationFee: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::bluefin::migrate`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#migratorsVersion(tx),
          this.#launchpadVersion(tx),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "quoteCurrency", options.quoteCurrency, false),
          sharedObject(tx, "bluefinConfig", options.bluefinConfig, true),
          tx.object(options.creationFee),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * Collects the burned migration position's and the auto-LP position's fees,
   * pays Blast's live share, splits the rest, burns the burn share's Meme, and
   * adds the auto-LP share back. Anyone may call it.
   */
  collectCetusFees(
    options: LaunchTypes &
      CetusObjects & {
        memeSide: CetusMemeSide;
        vault: SharedObjectReference<true>;
        memeCurrency: SharedObjectReference<true>;
        burnManager: SharedObjectReference<false>;
        pool: SharedObjectReference<true>;
      },
  ) {
    const types = normalizeLaunchTypes(options);
    const memeSide = normalizeMemeSide(options.memeSide);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::cetus::collect_fees`,
        typeArguments: cetusTypeArguments(types, memeSide),
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          this.#lpFeePolicy(tx),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "cetusConfig", options.cetusConfig, false),
          sharedObject(tx, "burnManager", options.burnManager, false),
          sharedObject(tx, "pool", options.pool, true),
          tx.object.clock(),
        ],
      });
    };
  }

  /** Collects, splits, burns, and adds auto-LP for a Bluefin vault. Anyone may call it. */
  collectBluefinFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      memeCurrency: SharedObjectReference<true>;
      bluefinConfig: SharedObjectReference<false>;
      pool: SharedObjectReference<true>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::bluefin::collect_fees`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          this.#lpFeePolicy(tx),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "bluefinConfig", options.bluefinConfig, false),
          sharedObject(tx, "pool", options.pool, true),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * Settles the fees accrued under the current split, then commits `feeSplit`
   * as the vault's split. Only the launch's live `CurveFeeCap` authorizes it.
   * `launch` is read immutably by Move.
   */
  settleAndUpdateCetusFeeSplit(
    options: LaunchTypes &
      CetusObjects & {
        memeSide: CetusMemeSide;
        vault: SharedObjectReference<true>;
        launch: SharedObjectReference;
        curveFeeCap: TransactionObjectInput;
        memeCurrency: SharedObjectReference<true>;
        burnManager: SharedObjectReference<false>;
        pool: SharedObjectReference<true>;
        feeSplit: FeeSplit;
      },
  ) {
    const types = normalizeLaunchTypes(options);
    const memeSide = normalizeMemeSide(options.memeSide);
    const feeSplit = this.launchpad.feeSplit(options.feeSplit);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::cetus::settle_and_update_fee_split`,
        typeArguments: cetusTypeArguments(types, memeSide),
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          this.#lpFeePolicy(tx),
          sharedObject(tx, "launch", options.launch, options.launch.mutable),
          tx.object(options.curveFeeCap),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "cetusConfig", options.cetusConfig, false),
          sharedObject(tx, "burnManager", options.burnManager, false),
          sharedObject(tx, "pool", options.pool, true),
          tx.add(feeSplit),
          tx.object.clock(),
        ],
      });
    };
  }

  /** Bluefin counterpart of `settleAndUpdateCetusFeeSplit`. */
  settleAndUpdateBluefinFeeSplit(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      launch: SharedObjectReference;
      curveFeeCap: TransactionObjectInput;
      memeCurrency: SharedObjectReference<true>;
      bluefinConfig: SharedObjectReference<false>;
      pool: SharedObjectReference<true>;
      feeSplit: FeeSplit;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const feeSplit = this.launchpad.feeSplit(options.feeSplit);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::bluefin::settle_and_update_fee_split`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          this.#lpFeePolicy(tx),
          sharedObject(tx, "launch", options.launch, options.launch.mutable),
          tx.object(options.curveFeeCap),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "bluefinConfig", options.bluefinConfig, false),
          sharedObject(tx, "pool", options.pool, true),
          tx.add(feeSplit),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * Swaps the vault's whole burn Quote for Meme in its Cetus pool and burns
   * it, under a `BuybackAdmin` witness. Aborts unless the swap returns at least
   * `minMemeOut`; set it from an off-chain price, since anyone can move the
   * pool's price within a transaction. Unspent Quote waits for the next one.
   */
  buybackAndBurnCetus(
    options: LaunchTypes &
      CetusObjects & {
        memeSide: CetusMemeSide;
        vault: SharedObjectReference<true>;
        adminWitness: TransactionObjectInput;
        memeCurrency: SharedObjectReference<true>;
        pool: SharedObjectReference<true>;
        minMemeOut: bigint;
      },
  ) {
    const types = normalizeLaunchTypes(options);
    const memeSide = normalizeMemeSide(options.memeSide);
    const minMemeOut = requireU64("minMemeOut", options.minMemeOut);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::cetus::buyback_and_burn`,
        typeArguments: cetusTypeArguments(types, memeSide),
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          tx.object(options.adminWitness),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "cetusConfig", options.cetusConfig, false),
          sharedObject(tx, "pool", options.pool, true),
          tx.pure.u64(minMemeOut),
          tx.object.clock(),
        ],
      });
    };
  }

  /** Bluefin counterpart of `buybackAndBurnCetus`. */
  buybackAndBurnBluefin(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
      memeCurrency: SharedObjectReference<true>;
      bluefinConfig: SharedObjectReference<false>;
      pool: SharedObjectReference<true>;
      minMemeOut: bigint;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const minMemeOut = requireU64("minMemeOut", options.minMemeOut);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::bluefin::buyback_and_burn`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          tx.object(options.adminWitness),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "bluefinConfig", options.bluefinConfig, false),
          sharedObject(tx, "pool", options.pool, true),
          tx.pure.u64(minMemeOut),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * Claims the creator's accrued LP fees with the launch's live `CurveFeeCap`.
   * `launch` is read immutably by Move.
   */
  claimCreatorFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      launch: SharedObjectReference;
      curveFeeCap: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::claim_creator_fees`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          sharedObject(tx, "launch", options.launch, options.launch.mutable),
          tx.object(options.curveFeeCap),
        ],
      });
  }

  /**
   * `vault::claim_protocol_lp_fees_with_partner`: pays a partnered vault's held
   * Blast LP fees, the launch's partner its cut in force of each asset, rounded
   * down, and the `LpFeePolicy` destination the rest. Anyone may call it;
   * holding nothing pays nothing.
   */
  claimProtocolLpFeesWithPartner(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      partner: SharedObjectReference<false>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::claim_protocol_lp_fees_with_partner`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          this.#lpFeePolicy(tx),
          sharedObject(tx, "partner", options.partner, false),
          tx.object.clock(),
        ],
      });
    };
  }

  /** Claims the protocol-owned migration residuals under a `TreasuryAdmin` witness. */
  claimProtocolFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::claim_protocol_fees`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          tx.object(options.adminWitness),
        ],
      });
  }

  /** Changes Blast's default Meme and Quote LP-fee shares for coins without their own pair (`FeeAdmin`). */
  setLpFeeDefaultShares(options: {
    adminWitness: TransactionObjectInput;
    memeBps: bigint;
    quoteBps: bigint;
  }) {
    return this.#lpFeePolicyAdmin("set_default_shares", [], options, (tx) => [
      tx.add(this.launchpad.bps(options.memeBps)),
      tx.add(this.launchpad.bps(options.quoteBps)),
    ]);
  }

  /** Sets Blast's LP-fee shares for one original Meme type (`FeeAdmin`). */
  setLpFeeCoinShares(options: {
    memeType: string;
    adminWitness: TransactionObjectInput;
    memeBps: bigint;
    quoteBps: bigint;
  }) {
    return this.#lpFeePolicyAdmin(
      "set_coin_shares",
      [normalizeStructTag(options.memeType)],
      options,
      (tx) => [
        tx.add(this.launchpad.bps(options.memeBps)),
        tx.add(this.launchpad.bps(options.quoteBps)),
      ],
    );
  }

  /** Removes one Meme type's own pair so its collections use the defaults again (`FeeAdmin`). */
  clearLpFeeCoinShares(options: {
    memeType: string;
    adminWitness: TransactionObjectInput;
  }) {
    return this.#lpFeePolicyAdmin(
      "clear_coin_shares",
      [normalizeStructTag(options.memeType)],
      options,
      () => [],
    );
  }

  /** Redirects every later protocol LP-fee payout (`TreasuryAdmin`). */
  setLpFeeProtocolDestination(options: {
    adminWitness: TransactionObjectInput;
    destination: string;
  }) {
    const destination = normalizeSuiAddress(options.destination);
    return this.#lpFeePolicyAdmin(
      "set_protocol_destination",
      [],
      options,
      (tx) => [tx.pure.address(destination)],
    );
  }

  /**
   * Publishes a holder-reward round from a validated manifest, reserving its
   * budget from the vault's rewards balance, and shares the `Round`
   * (`RewardsAdmin`).
   */
  publishHolderRewardRound(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
      manifest: RewardManifest;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const manifest = validateRewardManifest(
      options.manifest,
      MIGRATOR_REWARD_LEAF_DOMAIN,
    );
    if (
      rewardAddress(manifest.vaultId) !== rewardAddress(options.vault.objectId)
    ) {
      throw new TypeError("manifest belongs to another vault");
    }
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::blast_holder_rewards::publish_round`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          tx.object(options.adminWitness),
          tx.pure.u64(manifest.number),
          tx.pure.u64(manifest.startCheckpoint),
          tx.pure.u64(manifest.endCheckpoint),
          tx.pure.vector("u8", rewardDigest(manifest.root)),
          tx.pure.vector("u8", rewardDigest(manifest.manifestDigest)),
          tx.pure.u64(manifest.allocations.length),
          tx.pure.u64(manifest.memeAmount),
          tx.pure.u64(manifest.quoteAmount),
        ],
      });
    };
  }

  /** Relays one allocation's proof; the round pays its committed beneficiary. */
  claimHolderReward(
    options: LaunchTypes & {
      round: SharedObjectReference<true>;
      allocation: RewardProof;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const { allocation } = options;
    const index = requireU64("index", BigInt(allocation.index));
    const memeAmount = requireU64("memeAmount", BigInt(allocation.memeAmount));
    const quoteAmount = requireU64(
      "quoteAmount",
      BigInt(allocation.quoteAmount),
    );
    const beneficiary = rewardAddress(allocation.beneficiary);
    if (allocation.proof.length > MAX_HOLDER_REWARD_PROOF_DEPTH) {
      throw new RangeError(
        `proof exceeds ${MAX_HOLDER_REWARD_PROOF_DEPTH} siblings`,
      );
    }
    const proof = allocation.proof.map((sibling) =>
      Array.from(rewardDigest(sibling)),
    );
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::blast_holder_rewards::claim`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "round", options.round, true),
          this.#migratorsVersion(tx),
          tx.pure.u64(index),
          tx.pure.address(beneficiary),
          tx.pure.u64(memeAmount),
          tx.pure.u64(quoteAmount),
          tx.pure.vector("vector<u8>", proof),
        ],
      });
    };
  }

  #lpFeePolicyAdmin(
    functionName: string,
    typeArguments: string[],
    options: { adminWitness: TransactionObjectInput },
    extra: (tx: Transaction) => TransactionArgument[],
  ) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::lp_fee_policy::${functionName}`,
        typeArguments,
        arguments: [
          deploymentObject(tx, this.deployment.lpFeePolicy, true),
          this.#migratorsVersion(tx),
          tx.object(options.adminWitness),
          ...extra(tx),
        ],
      });
    };
  }

  #migratorsVersion(tx: Transaction): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.migratorsVersion, false);
  }

  #launchpadVersion(tx: Transaction): TransactionObjectArgument {
    return deploymentObject(
      tx,
      this.deployment.launchpad.packageVersion,
      false,
    );
  }

  #launchConfig(tx: Transaction): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.launchpad.launchConfig, false);
  }

  #lpFeePolicy(tx: Transaction): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.lpFeePolicy, false);
  }
}

export class MigratorTransactions {
  readonly call: MigratorCalls;
  readonly #useGasCoin: boolean;

  constructor(
    deployment: MigratorsDeployment,
    options: CoinSourceOptions = {},
  ) {
    this.call = new MigratorCalls(deployment);
    this.#useGasCoin = options.useGasCoin ?? true;
  }

  /**
   * Starts, configures, finalizes, and shares a Cetus launch atomically, with
   * an optional purchase on the owned launch, routed to its recipient.
   */
  createCetusLaunch(
    options: CreateLaunchOptions &
      CetusObjects & {
        cetusPools: SharedObjectReference<true>;
        tickSpacing: number;
      },
  ): Transaction {
    const tx = new Transaction();
    const initializer = tx.add(this.call.newCetusLaunch(options));
    addLaunchCompletion(tx, this.call.launchpad, {
      ...options,
      initializer,
      currency: options.memeCurrency,
      useGasCoin: options.useGasCoin ?? this.#useGasCoin,
    });
    return tx;
  }

  /** Bluefin counterpart of `createCetusLaunch`. */
  createBluefinLaunch(
    options: CreateLaunchOptions & { tickSpacing: number; feeRate: bigint },
  ): Transaction {
    const tx = new Transaction();
    const initializer = tx.add(this.call.newBluefinLaunch(options));
    addLaunchCompletion(tx, this.call.launchpad, {
      ...options,
      initializer,
      currency: options.memeCurrency,
      useGasCoin: options.useGasCoin ?? this.#useGasCoin,
    });
    return tx;
  }

  migrateCetus(
    options: Parameters<MigratorCalls["migrateCetus"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.migrateCetus(options));
    return tx;
  }

  /** Pays Bluefin's SUI pool-creation fee as an exact-balance coin. */
  migrateBluefin(
    options: Omit<
      Parameters<MigratorCalls["migrateBluefin"]>[0],
      "creationFee"
    > & {
      creationFee: bigint;
    } & CoinSourceOptions,
  ): Transaction {
    requireU64("creationFee", options.creationFee);
    const tx = new Transaction();
    const creationFee = tx.coin({
      type: "0x2::sui::SUI",
      balance: options.creationFee,
      useGasCoin: options.useGasCoin ?? this.#useGasCoin,
    });
    tx.add(this.call.migrateBluefin({ ...options, creationFee }));
    return tx;
  }

  /** Then pays the vault's partner when `partner` is given; see `claimProtocolLpFeesWithPartner`. */
  collectCetusFees(
    options: Parameters<MigratorCalls["collectCetusFees"]>[0] & LpFeePartner,
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.collectCetusFees(options));
    return this.#claimProtocolLpFeesWithPartnerAfter(tx, options);
  }

  /** Then pays the vault's partner when `partner` is given; see `claimProtocolLpFeesWithPartner`. */
  collectBluefinFees(
    options: Parameters<MigratorCalls["collectBluefinFees"]>[0] & LpFeePartner,
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.collectBluefinFees(options));
    return this.#claimProtocolLpFeesWithPartnerAfter(tx, options);
  }

  /** Pays a partnered vault's partner and Blast the LP fees its collections held. */
  claimProtocolLpFeesWithPartner(
    options: Parameters<MigratorCalls["claimProtocolLpFeesWithPartner"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.claimProtocolLpFeesWithPartner(options));
    return tx;
  }

  settleAndUpdateCetusFeeSplit(
    options: Omit<
      Parameters<MigratorCalls["settleAndUpdateCetusFeeSplit"]>[0],
      "curveFeeCap"
    > & { curveFeeCapId: string },
  ): Transaction {
    const tx = new Transaction();
    tx.add(
      this.call.settleAndUpdateCetusFeeSplit({
        ...options,
        curveFeeCap: options.curveFeeCapId,
      }),
    );
    return tx;
  }

  settleAndUpdateBluefinFeeSplit(
    options: Omit<
      Parameters<MigratorCalls["settleAndUpdateBluefinFeeSplit"]>[0],
      "curveFeeCap"
    > & { curveFeeCapId: string },
  ): Transaction {
    const tx = new Transaction();
    tx.add(
      this.call.settleAndUpdateBluefinFeeSplit({
        ...options,
        curveFeeCap: options.curveFeeCapId,
      }),
    );
    return tx;
  }

  claimCreatorFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      launch: SharedObjectReference;
      curveFeeCapId: string;
      recipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const result = tx.add(
      this.call.claimCreatorFees({
        ...options,
        curveFeeCap: options.curveFeeCapId,
      }),
    );
    tx.transferObjects(
      moveResults(result, 2),
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  claimProtocolFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      adminCapId: string;
      recipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn({ adminCap: options.adminCapId, role: "TreasuryAdmin" }),
    );
    const result = tx.add(
      this.call.claimProtocolFees({ ...options, adminWitness }),
    );
    tx.transferObjects(
      moveResults(result, 2),
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  setLpFeeDefaultShares(options: {
    adminCapId: string;
    memeBps: bigint;
    quoteBps: bigint;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.setLpFeeDefaultShares({ ...options, adminWitness }),
    );
  }

  setLpFeeCoinShares(options: {
    memeType: string;
    adminCapId: string;
    memeBps: bigint;
    quoteBps: bigint;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.setLpFeeCoinShares({ ...options, adminWitness }),
    );
  }

  clearLpFeeCoinShares(options: {
    memeType: string;
    adminCapId: string;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.clearLpFeeCoinShares({ ...options, adminWitness }),
    );
  }

  setLpFeeProtocolDestination(options: {
    adminCapId: string;
    destination: string;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "TreasuryAdmin", (adminWitness) =>
      this.call.setLpFeeProtocolDestination({ ...options, adminWitness }),
    );
  }

  buybackAndBurnCetus(
    options: Omit<
      Parameters<MigratorCalls["buybackAndBurnCetus"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "BuybackAdmin", (adminWitness) =>
      this.call.buybackAndBurnCetus({ ...options, adminWitness }),
    );
  }

  buybackAndBurnBluefin(
    options: Omit<
      Parameters<MigratorCalls["buybackAndBurnBluefin"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "BuybackAdmin", (adminWitness) =>
      this.call.buybackAndBurnBluefin({ ...options, adminWitness }),
    );
  }

  publishHolderRewardRound(
    options: Omit<
      Parameters<MigratorCalls["publishHolderRewardRound"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "RewardsAdmin", (adminWitness) =>
      this.call.publishHolderRewardRound({ ...options, adminWitness }),
    );
  }

  /** Relays up to `allocations.length` proofs of one round in a single PTB. */
  claimHolderRewards(
    options: LaunchTypes & {
      round: SharedObjectReference<true>;
      allocations: readonly RewardProof[];
    },
  ): Transaction {
    const tx = new Transaction();
    for (const allocation of options.allocations) {
      tx.add(this.call.claimHolderReward({ ...options, allocation }));
    }
    return tx;
  }

  #asAdmin(
    adminCapId: string,
    role: BlastFunAdminRole,
    call: (
      adminWitness: TransactionObjectArgument,
    ) => (tx: Transaction) => void,
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn({ adminCap: adminCapId, role }),
    );
    tx.add(call(adminWitness));
    return tx;
  }

  #claimProtocolLpFeesWithPartnerAfter(
    tx: Transaction,
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
    } & LpFeePartner,
  ): Transaction {
    const { partner } = options;
    if (partner)
      tx.add(this.call.claimProtocolLpFeesWithPartner({ ...options, partner }));
    return tx;
  }
}

function sharedObject<const Mutable extends boolean>(
  tx: Transaction,
  name: string,
  reference: SharedObjectReference<Mutable>,
  mutable: Mutable,
): TransactionObjectArgument {
  return tx.sharedObjectRef(
    normalizeSharedObjectReference(name, reference, mutable),
  );
}

/** `[Meme, Quote, CoinA, CoinB]`, the pool's coins in Cetus order. */
function cetusTypeArguments(
  types: LaunchTypes,
  memeSide: CetusMemeSide,
): string[] {
  const { memeType, quoteType } = types;
  return memeSide === "a"
    ? [memeType, quoteType, memeType, quoteType]
    : [memeType, quoteType, quoteType, memeType];
}

function normalizeMemeSide(value: CetusMemeSide): CetusMemeSide {
  if (value !== "a" && value !== "b") {
    throw new RangeError("memeSide must be a or b");
  }
  return value;
}

function requireU32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be a u32`);
  }
  return value;
}
