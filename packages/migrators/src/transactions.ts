import type { CoinSourceOptions } from "@interest-protocol/blast-core/coins";
import { grossGasBudget } from "@interest-protocol/blast-core/gas";
import {
  requirePositiveU64,
  requireU64,
} from "@interest-protocol/blast-core/integers";
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
   * Settles accrued fees under the applied split, then applies the ready proposal.
   * Permissionless; the adapter enforces readiness before collecting.
   */
  settleAndApplyCetusFeeSplit(
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
        target: `${this.deployment.packageId}::cetus::settle_and_apply_fee_split`,
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

  /** Bluefin counterpart of `settleAndApplyCetusFeeSplit`. */
  settleAndApplyBluefinFeeSplit(
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
        target: `${this.deployment.packageId}::bluefin::settle_and_apply_fee_split`,
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

  /** Proposes a split and next notice; the currently applied notice governs this wait. */
  scheduleFeeSplit(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      launch: SharedObjectReference;
      curveFeeCap: TransactionObjectInput;
      feeSplit: FeeSplit;
      delayMs: bigint;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const split = this.launchpad.feeSplit(options.feeSplit);
    const delay = requireU64("delayMs", options.delayMs);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::schedule_fee_split`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          sharedObject(tx, "launch", options.launch, false),
          tx.object(options.curveFeeCap),
          tx.add(split),
          tx.pure.u64(delay),
          tx.object.clock(),
        ],
      });
    };
  }

  cancelFeeSplit(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      launch: SharedObjectReference;
      curveFeeCap: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::cancel_fee_split`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          sharedObject(tx, "launch", options.launch, false),
          tx.object(options.curveFeeCap),
        ],
      });
    };
  }

  /**
   * Swaps `quoteIn` atomic units of the vault's burn Quote for Meme in its
   * Cetus pool and burns it, under a `BuybackAdmin` witness. The contract
   * aborts with `EBuybackQuoteOutOfRange` when `quoteIn` exceeds the vault's
   * burn Quote, and unless the swap returns at least `minMemeOut`; set it from
   * an off-chain price, since anyone can move the pool's price within a
   * transaction. Unspent Quote waits for the next buyback.
   */
  buybackAndBurnCetus(
    options: LaunchTypes &
      CetusObjects & {
        memeSide: CetusMemeSide;
        vault: SharedObjectReference<true>;
        adminWitness: TransactionObjectInput;
        memeCurrency: SharedObjectReference<true>;
        pool: SharedObjectReference<true>;
        quoteIn: bigint;
        minMemeOut: bigint;
      },
  ) {
    const types = normalizeLaunchTypes(options);
    const memeSide = normalizeMemeSide(options.memeSide);
    const quoteIn = requirePositiveU64("quoteIn", options.quoteIn);
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
          tx.pure.u64(quoteIn),
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
      quoteIn: bigint;
      minMemeOut: bigint;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const quoteIn = requirePositiveU64("quoteIn", options.quoteIn);
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
          tx.pure.u64(quoteIn),
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
      claimDeadlineMs: bigint;
      gasReserveAmount: bigint;
      expectedTreasury: string;
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
    const deadline = requireU64("claimDeadlineMs", options.claimDeadlineMs);
    const reserve = requireU64("gasReserveAmount", options.gasReserveAmount);
    const treasury = normalizeSuiAddress(options.expectedTreasury);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::blast_holder_rewards::publish_round`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#migratorsVersion(tx),
          tx.object(options.adminWitness),
          this.#lpFeePolicy(tx),
          tx.pure.address(treasury),
          tx.pure.u64(manifest.number),
          tx.pure.u64(manifest.startCheckpoint),
          tx.pure.u64(manifest.endCheckpoint),
          tx.pure.vector("u8", rewardDigest(manifest.root)),
          tx.pure.vector("u8", rewardDigest(manifest.manifestDigest)),
          tx.pure.u64(manifest.allocations.length),
          tx.pure.u64(manifest.memeAmount),
          tx.pure.u64(manifest.quoteAmount),
          tx.pure.u64(reserve),
          tx.pure.u64(deadline),
          tx.object.clock(),
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
          tx.object.clock(),
        ],
      });
    };
  }

  /** Settles optional gas custody once; holder claims remain independently funded. */
  settleHolderRewardGasReserve(
    options: LaunchTypes & {
      round: SharedObjectReference<true>;
      vault: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
      reimbursementAmount: bigint;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const amount = requireU64(
      "reimbursementAmount",
      options.reimbursementAmount,
    );
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::blast_holder_rewards::settle_gas_reserve`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "round", options.round, true),
          this.#migratorsVersion(tx),
          tx.object(options.adminWitness),
          sharedObject(tx, "vault", options.vault, true),
          tx.pure.u64(amount),
        ],
      });
    };
  }

  /** Permissionlessly destroys an expired round and returns all remaining custody to its vault. */
  closeHolderRewardRound(
    options: LaunchTypes & {
      round: SharedObjectReference<true>;
      vault: SharedObjectReference<true>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::blast_holder_rewards::close_round`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "round", options.round, true),
          this.#migratorsVersion(tx),
          sharedObject(tx, "vault", options.vault, true),
          tx.object.clock(),
        ],
      });
    };
  }

  /** `lp_fee_policy::apply_coin_shares`. Permissionless; the contract validates readiness and ownership. */
  applyLpFeeCoinShares(options: { memeType: string }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::lp_fee_policy::apply_coin_shares`,
        typeArguments: [normalizeStructTag(options.memeType)],
        arguments: [
          deploymentObject(tx, this.deployment.lpFeePolicy, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `lp_fee_policy::apply_default_shares`. Permissionless; the contract validates readiness and ownership. */
  applyLpFeeDefaultShares() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::lp_fee_policy::apply_default_shares`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.lpFeePolicy, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `lp_fee_policy::apply_protocol_destination`. Permissionless; the contract validates readiness and ownership. */
  applyLpFeeProtocolDestination() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::lp_fee_policy::apply_protocol_destination`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.lpFeePolicy, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `lp_fee_policy::cancel_coin_shares`. Requires CancelAdmin. */
  cancelLpFeeCoinShares(options: {
    memeType: string;
    adminWitness: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::lp_fee_policy::cancel_coin_shares`,
        typeArguments: [normalizeStructTag(options.memeType)],
        arguments: [
          deploymentObject(tx, this.deployment.lpFeePolicy, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `lp_fee_policy::cancel_default_shares`. Requires CancelAdmin. */
  cancelLpFeeDefaultShares(options: { adminWitness: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::lp_fee_policy::cancel_default_shares`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.lpFeePolicy, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `lp_fee_policy::cancel_protocol_destination`. Requires CancelAdmin. */
  cancelLpFeeProtocolDestination(options: {
    adminWitness: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::lp_fee_policy::cancel_protocol_destination`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.lpFeePolicy, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `lp_fee_policy::schedule_clear_coin_shares`. Requires FeeAdmin. */
  scheduleClearLpFeeCoinShares(options: {
    memeType: string;
    adminWitness: TransactionObjectInput;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::lp_fee_policy::schedule_clear_coin_shares`,
        typeArguments: [normalizeStructTag(options.memeType)],
        arguments: [
          deploymentObject(tx, this.deployment.lpFeePolicy, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `lp_fee_policy::schedule_coin_shares`. Requires FeeAdmin. */
  scheduleLpFeeCoinShares(options: {
    memeType: string;
    adminWitness: TransactionObjectInput;
    memeBps: bigint;
    quoteBps: bigint;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::lp_fee_policy::schedule_coin_shares`,
        typeArguments: [normalizeStructTag(options.memeType)],
        arguments: [
          deploymentObject(tx, this.deployment.lpFeePolicy, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
          tx.add(this.launchpad.bps(options.memeBps)),
          tx.add(this.launchpad.bps(options.quoteBps)),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `lp_fee_policy::schedule_default_shares`. Requires FeeAdmin. */
  scheduleLpFeeDefaultShares(options: {
    adminWitness: TransactionObjectInput;
    memeBps: bigint;
    quoteBps: bigint;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::lp_fee_policy::schedule_default_shares`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.lpFeePolicy, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
          tx.add(this.launchpad.bps(options.memeBps)),
          tx.add(this.launchpad.bps(options.quoteBps)),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `lp_fee_policy::schedule_protocol_destination`. Requires TreasuryAdmin. */
  scheduleLpFeeProtocolDestination(options: {
    adminWitness: TransactionObjectInput;
    destination: string;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::lp_fee_policy::schedule_protocol_destination`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.lpFeePolicy, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
          tx.pure.address(normalizeSuiAddress(options.destination)),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `package_admin::apply_upgrade_delay`. Permissionless; the contract validates readiness and ownership. */
  applyUpgradeDelay(options: { packageAdmin: SharedObjectReference<true> }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::package_admin::apply_upgrade_delay`,
        typeArguments: [],
        arguments: [
          sharedObject(tx, "packageAdmin", options.packageAdmin, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `package_admin::authorize_upgrade`. Requires UpgradeAdmin. */
  authorizeUpgrade(options: {
    packageAdmin: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
    digest: Uint8Array;
  }) {
    if (options.digest.length !== 32)
      throw new RangeError("digest must contain 32 bytes");
    return (tx: Transaction): TransactionResult => {
      return tx.moveCall({
        target: `${this.deployment.packageId}::package_admin::authorize_upgrade`,
        typeArguments: [],
        arguments: [
          sharedObject(tx, "packageAdmin", options.packageAdmin, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
          tx.pure.vector("u8", Array.from(options.digest)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `package_admin::cancel_upgrade_action`. Requires CancelAdmin. */
  cancelUpgradeAction(options: {
    packageAdmin: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::package_admin::cancel_upgrade_action`,
        typeArguments: [],
        arguments: [
          sharedObject(tx, "packageAdmin", options.packageAdmin, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `package_admin::commit_upgrade_and_advance`. Requires UpgradeAdmin. */
  commitUpgradeAndAdvance(options: {
    packageAdmin: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
    receipt: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::package_admin::commit_upgrade_and_advance`,
        typeArguments: [],
        arguments: [
          sharedObject(tx, "packageAdmin", options.packageAdmin, true),
          deploymentObject(tx, this.deployment.migratorsVersion, true),
          tx.object(options.adminWitness),
          tx.object(options.receipt),
        ],
      });
    };
  }
  /** `package_admin::make_immutable`. Requires UpgradeAdmin. */
  makeImmutable(options: {
    packageAdmin: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::package_admin::make_immutable`,
        typeArguments: [],
        arguments: [
          sharedObject(tx, "packageAdmin", options.packageAdmin, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `package_admin::schedule_make_immutable`. Requires UpgradeAdmin. */
  scheduleMakeImmutable(options: {
    packageAdmin: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::package_admin::schedule_make_immutable`,
        typeArguments: [],
        arguments: [
          sharedObject(tx, "packageAdmin", options.packageAdmin, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `package_admin::schedule_upgrade`. Requires UpgradeAdmin. */
  scheduleUpgrade(options: {
    packageAdmin: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
    digest: Uint8Array;
  }) {
    if (options.digest.length !== 32)
      throw new RangeError("digest must contain 32 bytes");
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::package_admin::schedule_upgrade`,
        typeArguments: [],
        arguments: [
          sharedObject(tx, "packageAdmin", options.packageAdmin, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
          tx.pure.vector("u8", Array.from(options.digest)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `package_admin::schedule_upgrade_delay`. Requires UpgradeAdmin. */
  scheduleUpgradeDelay(options: {
    packageAdmin: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::package_admin::schedule_upgrade_delay`,
        typeArguments: [],
        arguments: [
          sharedObject(tx, "packageAdmin", options.packageAdmin, true),
          deploymentObject(tx, this.deployment.migratorsVersion, false),
          tx.object(options.adminWitness),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `package_admin::wrap`. Permissionless; the contract validates readiness and ownership. */
  wrapPublication(options: {
    publication: TransactionObjectInput;
    upgradeCap: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::package_admin::wrap`,
        typeArguments: [],
        arguments: [
          tx.object(options.publication),
          tx.object(options.upgradeCap),
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

/** LP-fee settings `configureNow` applies at a zero notice. */
export type MigratorsSettings = {
  /** Where every collection pays Blast's LP-fee share. */
  protocolDestination?: string;
  defaultShares?: { memeBps: bigint; quoteBps: bigint };
};

/**
 * The notice `armNotices` gives each named value, in milliseconds. A
 * setting restates its applied value beside its new notice.
 */
export type MigratorsNotices = {
  protocolDestination?: { destination: string; delayMs: bigint };
  defaultShares?: { memeBps: bigint; quoteBps: bigint; delayMs: bigint };
  upgrade?: { packageAdmin: SharedObjectReference<true>; delayMs: bigint };
};

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

  settleAndApplyCetusFeeSplit(
    options: Parameters<MigratorCalls["settleAndApplyCetusFeeSplit"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.settleAndApplyCetusFeeSplit(options));
    return tx;
  }

  settleAndApplyBluefinFeeSplit(
    options: Parameters<MigratorCalls["settleAndApplyBluefinFeeSplit"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.settleAndApplyBluefinFeeSplit(options));
    return tx;
  }

  scheduleFeeSplit(
    options: Parameters<MigratorCalls["scheduleFeeSplit"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.scheduleFeeSplit(options));
    return tx;
  }

  cancelFeeSplit(
    options: Parameters<MigratorCalls["cancelFeeSplit"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.cancelFeeSplit(options));
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

  settleHolderRewardGasReserve(
    options: Omit<
      Parameters<MigratorCalls["settleHolderRewardGasReserve"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "RewardsAdmin", (adminWitness) =>
      this.call.settleHolderRewardGasReserve({ ...options, adminWitness }),
    );
  }

  closeHolderRewardRound(
    options: Parameters<MigratorCalls["closeHolderRewardRound"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.closeHolderRewardRound(options));
    return tx;
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

  applyLpFeeCoinShares(
    options: Parameters<MigratorCalls["applyLpFeeCoinShares"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyLpFeeCoinShares(options));
    return tx;
  }
  applyLpFeeDefaultShares(): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyLpFeeDefaultShares());
    return tx;
  }
  applyLpFeeProtocolDestination(): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyLpFeeProtocolDestination());
    return tx;
  }
  cancelLpFeeCoinShares(
    options: Omit<
      Parameters<MigratorCalls["cancelLpFeeCoinShares"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelLpFeeCoinShares({ ...options, adminWitness }),
    );
  }
  cancelLpFeeDefaultShares(
    options: Omit<
      Parameters<MigratorCalls["cancelLpFeeDefaultShares"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelLpFeeDefaultShares({ ...options, adminWitness }),
    );
  }
  cancelLpFeeProtocolDestination(
    options: Omit<
      Parameters<MigratorCalls["cancelLpFeeProtocolDestination"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelLpFeeProtocolDestination({ ...options, adminWitness }),
    );
  }
  scheduleClearLpFeeCoinShares(
    options: Omit<
      Parameters<MigratorCalls["scheduleClearLpFeeCoinShares"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.scheduleClearLpFeeCoinShares({ ...options, adminWitness }),
    );
  }
  scheduleLpFeeCoinShares(
    options: Omit<
      Parameters<MigratorCalls["scheduleLpFeeCoinShares"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.scheduleLpFeeCoinShares({ ...options, adminWitness }),
    );
  }
  scheduleLpFeeDefaultShares(
    options: Omit<
      Parameters<MigratorCalls["scheduleLpFeeDefaultShares"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.scheduleLpFeeDefaultShares({ ...options, adminWitness }),
    );
  }
  scheduleLpFeeProtocolDestination(
    options: Omit<
      Parameters<MigratorCalls["scheduleLpFeeProtocolDestination"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "TreasuryAdmin", (adminWitness) =>
      this.call.scheduleLpFeeProtocolDestination({ ...options, adminWitness }),
    );
  }
  applyUpgradeDelay(
    options: Parameters<MigratorCalls["applyUpgradeDelay"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyUpgradeDelay(options));
    return tx;
  }
  cancelUpgradeAction(
    options: Omit<
      Parameters<MigratorCalls["cancelUpgradeAction"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelUpgradeAction({ ...options, adminWitness }),
    );
  }
  makeImmutable(
    options: Omit<
      Parameters<MigratorCalls["makeImmutable"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "UpgradeAdmin", (adminWitness) =>
      this.call.makeImmutable({ ...options, adminWitness }),
    );
  }
  scheduleMakeImmutable(
    options: Omit<
      Parameters<MigratorCalls["scheduleMakeImmutable"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "UpgradeAdmin", (adminWitness) =>
      this.call.scheduleMakeImmutable({ ...options, adminWitness }),
    );
  }
  scheduleUpgrade(
    options: Omit<
      Parameters<MigratorCalls["scheduleUpgrade"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "UpgradeAdmin", (adminWitness) =>
      this.call.scheduleUpgrade({ ...options, adminWitness }),
    );
  }
  scheduleUpgradeDelay(
    options: Omit<
      Parameters<MigratorCalls["scheduleUpgradeDelay"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "UpgradeAdmin", (adminWitness) =>
      this.call.scheduleUpgradeDelay({ ...options, adminWitness }),
    );
  }

  /**
   * Applies LP-fee settings at once on a fresh deployment whose notices are
   * still zero: each is a schedule and its apply in this PTB, keeping a zero
   * notice. Name only settings that change; an unchanged schedule aborts.
   * Then call `armNotices`. The cap needs each setting's role.
   */
  configureNow(
    options: { adminCapId: string } & MigratorsSettings,
  ): Transaction {
    const delayMs = 0n;
    const { protocolDestination, defaultShares } = options;
    return this.#atZeroNotice(options.adminCapId, {
      ...(protocolDestination === undefined
        ? {}
        : {
            protocolDestination: { destination: protocolDestination, delayMs },
          }),
      ...(defaultShares
        ? { defaultShares: { ...defaultShares, delayMs } }
        : {}),
    });
  }

  /**
   * Raises each named notice from zero in one PTB: a schedule and its apply.
   * A setting restates its applied value, since its schedule proposes a value
   * and next notice together. Run after `configureNow`; once armed, every
   * later change waits its notice.
   */
  armNotices(options: { adminCapId: string } & MigratorsNotices): Transaction {
    return this.#atZeroNotice(options.adminCapId, options);
  }

  #atZeroNotice(adminCapId: string, notices: MigratorsNotices): Transaction {
    const tx = new Transaction();
    const witnesses = new Map<BlastFunAdminRole, TransactionObjectArgument>();
    const as = (role: BlastFunAdminRole) => {
      let adminWitness = witnesses.get(role);
      if (!adminWitness) {
        adminWitness = tx.add(this.call.signIn({ adminCap: adminCapId, role }));
        witnesses.set(role, adminWitness);
      }
      return adminWitness;
    };
    const { call } = this;
    if (notices.protocolDestination) {
      tx.add(
        call.scheduleLpFeeProtocolDestination({
          ...notices.protocolDestination,
          adminWitness: as("TreasuryAdmin"),
        }),
      );
      tx.add(call.applyLpFeeProtocolDestination());
    }
    if (notices.defaultShares) {
      tx.add(
        call.scheduleLpFeeDefaultShares({
          ...notices.defaultShares,
          adminWitness: as("FeeAdmin"),
        }),
      );
      tx.add(call.applyLpFeeDefaultShares());
    }
    if (notices.upgrade) {
      tx.add(
        call.scheduleUpgradeDelay({
          ...notices.upgrade,
          adminWitness: as("UpgradeAdmin"),
        }),
      );
      tx.add(call.applyUpgradeDelay(notices.upgrade));
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
