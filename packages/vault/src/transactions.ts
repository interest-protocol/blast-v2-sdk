import type { AdminDeployment } from "@interest-protocol/blast-admin-sdk/transactions";
import { normalizeAdminDeployment } from "@interest-protocol/blast-admin-sdk/transactions";
import type { CoreDeployment } from "@interest-protocol/blast-core/deployment";
import { normalizeCoreDeployment } from "@interest-protocol/blast-core/deployment";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type {
  Transaction,
  TransactionArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";

/**
 * The `blast_vault` package: its shared `VaultRegistry`, `PackageVersion`
 * and `PackageAdmin` (both typed by `BLAST_VAULT_PACKAGE`), and the core and
 * admin deployments its calls read. Calls target `packageId`; types name
 * `originalPackageId`.
 */
export type VaultDeployment = {
  packageId: string;
  originalPackageId: string;
  registry: SharedObjectIdentity;
  packageVersion: SharedObjectIdentity;
  packageAdmin: SharedObjectIdentity;
  core: CoreDeployment;
  admin: AdminDeployment;
};

/** `blast_vault::constants`' pause bits: `Admin` gates admin actions only. */
export const VAULT_PAUSE_BITS = { Admin: 1 } as const;

export function normalizeVaultDeployment(
  deployment: VaultDeployment,
): VaultDeployment {
  return {
    ...normalizeSuiPackageReference("vault", deployment),
    registry: normalizeSharedObjectIdentity(
      "vault.registry",
      deployment.registry,
    ),
    packageVersion: normalizeSharedObjectIdentity(
      "vault.packageVersion",
      deployment.packageVersion,
    ),
    packageAdmin: normalizeSharedObjectIdentity(
      "vault.packageAdmin",
      deployment.packageAdmin,
    ),
    core: normalizeCoreDeployment(deployment.core),
    admin: normalizeAdminDeployment(deployment.admin),
  };
}

/** A vault's or round's `Meme` and `Quote` type arguments. */
type VaultTypes = { memeType: string; quoteType: string };

/** One `Vault<Meme, Quote>` shared object. */
type VaultInput = VaultTypes & { vault: SharedObjectIdentity };

/** One `holder_rewards::Round<Meme, Quote>` shared object. */
type RoundInput = VaultTypes & { round: SharedObjectIdentity };

/**
 * `blast_vault` calls the SDK may build, one per public function, in Move
 * argument order; `&mut TxContext` is implicit and the `Clock` is `0x6`. The
 * registry, package version and treasury come from the deployment. An
 * `adminWitness` is `AdminCalls.signIn`'s result for the named
 * `blast_core::blast_domain` role; an owner `proof` is the `OwnerProof` result
 * of the product's `prove_owner`; a `proposed` split is `CoreCalls.feeSplit`'s.
 * Venue-only functions (`new`, `share_with_position`, `split_fees`, ...) are
 * Move composition and have no builder.
 */
export class VaultCalls {
  readonly deployment: VaultDeployment;
  /** `blast_vault_package::BLAST_VAULT_PACKAGE`, the package's OTW. */
  readonly otw: string;
  /** `blast_vault_package::PackageWitness`, the package witness (display only). */
  readonly packageWitnessType: string;

  constructor(deployment: VaultDeployment) {
    this.deployment = normalizeVaultDeployment(deployment);
    const module = `${this.deployment.originalPackageId}::blast_vault_package`;
    this.otw = normalizeStructTag(`${module}::BLAST_VAULT_PACKAGE`);
    this.packageWitnessType = normalizeStructTag(`${module}::PackageWitness`);
  }

  // Owner, with an `OwnerProof` of the vault's sale.

  /** `vault::claim_owner_balances`: returns `[Coin<Meme>, Coin<Quote>]` to consume. */
  claimOwnerBalances(
    _options: VaultInput & { proof: TransactionArgument },
  ): (tx: Transaction) => TransactionResult {
    throw notYet("claimOwnerBalances");
  }

  /** `vault::schedule_fee_split` of a `CoreCalls.feeSplit` result. */
  scheduleFeeSplit(
    _options: VaultInput & {
      proof: TransactionArgument;
      proposed: TransactionArgument;
    },
  ): (tx: Transaction) => void {
    throw notYet("scheduleFeeSplit");
  }

  /** `vault::cancel_fee_split`. */
  cancelFeeSplit(
    _options: VaultInput & { proof: TransactionArgument },
  ): (tx: Transaction) => void {
    throw notYet("cancelFeeSplit");
  }

  // Anyone.

  /** `vault::pay_protocol_fees_with_partner` to the core treasury and `partner`. */
  payProtocolFeesWithPartner(
    _options: VaultInput & { partner: SharedObjectIdentity },
  ): (tx: Transaction) => void {
    throw notYet("payProtocolFeesWithPartner");
  }

  /** `vault::apply_protocol_bps`, once ready. */
  applyProtocolBps(_options: VaultInput): (tx: Transaction) => void {
    throw notYet("applyProtocolBps");
  }

  /** `vault::assert_fee_split_ready`: aborts unless a scheduled split is ready. */
  assertFeeSplitReady(_options: VaultInput): (tx: Transaction) => void {
    throw notYet("assertFeeSplitReady");
  }

  /** `holder_rewards::publish_round` of the ready scheduled round. */
  publishRound(_options: VaultInput): (tx: Transaction) => void {
    throw notYet("publishRound");
  }

  /** `holder_rewards::claim` of one leaf with its positional proof. */
  claim(
    _options: RoundInput & {
      index: bigint;
      beneficiary: string;
      memeAmount: bigint;
      quoteAmount: bigint;
      proof: readonly Uint8Array[];
    },
  ): (tx: Transaction) => void {
    throw notYet("claim");
  }

  /** `holder_rewards::close_round` at or after the claim deadline. */
  closeRound(
    _options: RoundInput & { vault: SharedObjectIdentity },
  ): (tx: Transaction) => void {
    throw notYet("closeRound");
  }

  /** `holder_rewards::apply_round_delay`, once ready. */
  applyRoundDelay(_options: VaultInput): (tx: Transaction) => void {
    throw notYet("applyRoundDelay");
  }

  /** `blast_vault_package::apply_witness<Witness>`, once ready. */
  applyWitness(_options: { witnessType: string }): (tx: Transaction) => void {
    throw notYet("applyWitness");
  }

  /** `blast_vault_package::apply_witness_delay`, once ready. */
  applyWitnessDelay(): (tx: Transaction) => void {
    throw notYet("applyWitnessDelay");
  }

  /** `vault::pool_id`: the venue pool's ID, as a result. */
  poolId(_options: VaultInput): (tx: Transaction) => TransactionResult {
    throw notYet("poolId");
  }

  // Admin, with a `blast_domain` role witness.

  /** `vault::schedule_protocol_bps` (`FeeAdmin`); each rate at most `MAX_LP_FEE_BPS`. */
  scheduleProtocolBps(
    _options: VaultInput & {
      adminWitness: TransactionObjectInput;
      memeBps: bigint;
      quoteBps: bigint;
    },
  ): (tx: Transaction) => void {
    throw notYet("scheduleProtocolBps");
  }

  /** `vault::cancel_protocol_bps` (`CancelAdmin`). */
  cancelProtocolBps(
    _options: VaultInput & { adminWitness: TransactionObjectInput },
  ): (tx: Transaction) => void {
    throw notYet("cancelProtocolBps");
  }

  /** `holder_rewards::schedule_round` (`RewardsAdmin`). */
  scheduleRound(
    _options: VaultInput & {
      adminWitness: TransactionObjectInput;
      number: bigint;
      startCheckpoint: bigint;
      endCheckpoint: bigint;
      root: Uint8Array;
      manifestDigest: Uint8Array;
      leafCount: bigint;
      memeAmount: bigint;
      quoteAmount: bigint;
      gasReserveAmount: bigint;
      claimWindowDurationMs: bigint;
      expectedTreasury: string;
    },
  ): (tx: Transaction) => void {
    throw notYet("scheduleRound");
  }

  /** `holder_rewards::cancel_round` (`CancelAdmin`). */
  cancelRound(
    _options: VaultInput & { adminWitness: TransactionObjectInput },
  ): (tx: Transaction) => void {
    throw notYet("cancelRound");
  }

  /** `holder_rewards::schedule_round_delay` (`RewardsAdmin`). */
  scheduleRoundDelay(
    _options: VaultInput & {
      adminWitness: TransactionObjectInput;
      delayMs: bigint;
    },
  ): (tx: Transaction) => void {
    throw notYet("scheduleRoundDelay");
  }

  /** `holder_rewards::cancel_round_delay` (`CancelAdmin`). */
  cancelRoundDelay(
    _options: VaultInput & { adminWitness: TransactionObjectInput },
  ): (tx: Transaction) => void {
    throw notYet("cancelRoundDelay");
  }

  /** `holder_rewards::settle_gas_reserve` (`RewardsAdmin`). */
  settleGasReserve(
    _options: RoundInput & {
      adminWitness: TransactionObjectInput;
      vault: SharedObjectIdentity;
      reimbursementAmount: bigint;
    },
  ): (tx: Transaction) => void {
    throw notYet("settleGasReserve");
  }

  /** `blast_vault_package::schedule_witness<Witness>` (`VenueAdmin`). */
  scheduleWitness(_options: {
    witnessType: string;
    adminWitness: TransactionObjectInput;
  }): (tx: Transaction) => void {
    throw notYet("scheduleWitness");
  }

  /** `blast_vault_package::remove_witness<Witness>` (`VenueAdmin`). */
  removeWitness(_options: {
    witnessType: string;
    adminWitness: TransactionObjectInput;
  }): (tx: Transaction) => void {
    throw notYet("removeWitness");
  }

  /** `blast_vault_package::cancel_witness<Witness>` (`CancelAdmin`). */
  cancelWitness(_options: {
    witnessType: string;
    adminWitness: TransactionObjectInput;
  }): (tx: Transaction) => void {
    throw notYet("cancelWitness");
  }

  /** `blast_vault_package::schedule_witness_delay` (`VenueAdmin`). */
  scheduleWitnessDelay(_options: {
    adminWitness: TransactionObjectInput;
    delayMs: bigint;
  }): (tx: Transaction) => void {
    throw notYet("scheduleWitnessDelay");
  }

  /** `blast_vault_package::cancel_witness_delay` (`CancelAdmin`). */
  cancelWitnessDelay(_options: {
    adminWitness: TransactionObjectInput;
  }): (tx: Transaction) => void {
    throw notYet("cancelWitnessDelay");
  }

  /**
   * `blast_vault_package::unpause` with an
   * `UnpauseAdmin<BLAST_VAULT_PACKAGE>` witness (`packageRoleType`).
   */
  unpause(_options: {
    unpauseAdmin: TransactionObjectInput;
    bits: number;
  }): (tx: Transaction) => void {
    throw notYet("unpause");
  }

  /**
   * `blast_vault_package::make_immutable` with an
   * `UpgradeAdmin<BLAST_VAULT_PACKAGE>` witness, once the scheduled action is
   * ready.
   */
  makeImmutable(_options: {
    upgradeAdmin: TransactionObjectInput;
  }): (tx: Transaction) => void {
    throw notYet("makeImmutable");
  }
}

function notYet(method: string): Error {
  return new Error(`WP1: VaultCalls.${method} is not implemented yet`);
}
