import type { AdminDeployment } from "@interest-protocol/blast-admin-sdk/transactions";
import {
  AdminCalls,
  normalizeAdminDeployment,
  packageRoleType,
  requirePauseBits,
} from "@interest-protocol/blast-admin-sdk/transactions";
import { MAX_LP_FEE_BPS } from "@interest-protocol/blast-core/bps";
import type { CoreDeployment } from "@interest-protocol/blast-core/deployment";
import {
  CoreCalls,
  normalizeCoreDeployment,
} from "@interest-protocol/blast-core/deployment";
import { requireU64 } from "@interest-protocol/blast-core/integers";
import { deploymentObject } from "@interest-protocol/blast-core/ptb";
import type { CoreRole } from "@interest-protocol/blast-core/roles";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type {
  TransactionArgument,
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

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

/** A `holder_rewards::claim` leaf: its index, payee, amounts and positional proof. */
type RewardLeafInput = {
  index: bigint;
  beneficiary: string;
  memeAmount: bigint;
  quoteAmount: bigint;
  proof: readonly Uint8Array[];
};

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
  readonly #core: CoreCalls;

  constructor(deployment: VaultDeployment) {
    this.deployment = normalizeVaultDeployment(deployment);
    const module = `${this.deployment.originalPackageId}::blast_vault_package`;
    this.otw = normalizeStructTag(`${module}::BLAST_VAULT_PACKAGE`);
    this.#core = new CoreCalls(this.deployment.core);
  }

  // Owner, with an `OwnerProof` of the vault's sale.

  /**
   * `vault::claim_owner_balances`: returns `[Coin<Meme>, Coin<Quote>]` to
   * consume. Aborts (`ENothingToClaim`) when both owner balances are zero.
   */
  claimOwnerBalances(
    options: VaultInput & { proof: TransactionArgument },
  ): (tx: Transaction) => TransactionResult {
    return (tx) =>
      this.#call(tx, "vault", "claim_owner_balances", options, [
        this.#vault(tx, options),
        options.proof,
        this.#packageVersion(tx),
      ]);
  }

  /** `vault::schedule_fee_split` of a `CoreCalls.feeSplit` result. */
  scheduleFeeSplit(
    options: VaultInput & {
      proof: TransactionArgument;
      proposed: TransactionArgument;
    },
  ): (tx: Transaction) => void {
    return (tx) => {
      this.#call(tx, "vault", "schedule_fee_split", options, [
        this.#vault(tx, options),
        options.proof,
        this.#packageVersion(tx),
        options.proposed,
        tx.object.clock(),
      ]);
    };
  }

  /** `vault::cancel_fee_split`. */
  cancelFeeSplit(
    options: VaultInput & { proof: TransactionArgument },
  ): (tx: Transaction) => void {
    return (tx) => {
      this.#call(tx, "vault", "cancel_fee_split", options, [
        this.#vault(tx, options),
        options.proof,
        this.#packageVersion(tx),
      ]);
    };
  }

  // Anyone.

  /** `vault::pay_protocol_fees_with_partner` to the core treasury and `partner`. */
  payProtocolFeesWithPartner(
    options: VaultInput & { partner: SharedObjectIdentity },
  ): (tx: Transaction) => void {
    const partner = normalizeSharedObjectIdentity("partner", options.partner);
    return (tx) => {
      this.#call(tx, "vault", "pay_protocol_fees_with_partner", options, [
        this.#vault(tx, options),
        this.#packageVersion(tx),
        this.#treasury(tx),
        deploymentObject(tx, partner, false),
      ]);
    };
  }

  /** `vault::apply_protocol_bps`, once ready. */
  applyProtocolBps(options: VaultInput): (tx: Transaction) => void {
    return (tx) => {
      this.#call(tx, "vault", "apply_protocol_bps", options, [
        this.#vault(tx, options),
        this.#packageVersion(tx),
        tx.object.clock(),
      ]);
    };
  }

  /** `vault::assert_fee_split_ready`: aborts unless a scheduled split is ready. */
  assertFeeSplitReady(options: VaultInput): (tx: Transaction) => void {
    return (tx) => {
      this.#call(tx, "vault", "assert_fee_split_ready", options, [
        this.#vault(tx, options, false),
        tx.object.clock(),
      ]);
    };
  }

  /** `holder_rewards::publish_round` of the ready scheduled round. */
  publishRound(options: VaultInput): (tx: Transaction) => void {
    return (tx) => {
      this.#call(tx, "holder_rewards", "publish_round", options, [
        this.#vault(tx, options),
        this.#packageVersion(tx),
        this.#treasury(tx),
        tx.object.clock(),
      ]);
    };
  }

  /** `holder_rewards::claim` of one leaf with its positional proof. */
  claim(options: RoundInput & RewardLeafInput): (tx: Transaction) => void {
    const index = requireU64("index", options.index);
    const beneficiary = normalizeSuiAddress(options.beneficiary);
    const memeAmount = requireU64("memeAmount", options.memeAmount);
    const quoteAmount = requireU64("quoteAmount", options.quoteAmount);
    const proof = options.proof.map((sibling) =>
      Array.from(requireDigest("proof sibling", sibling)),
    );
    return (tx) => {
      this.#call(tx, "holder_rewards", "claim", options, [
        this.#round(tx, options),
        this.#packageVersion(tx),
        tx.pure.u64(index),
        tx.pure.address(beneficiary),
        tx.pure.u64(memeAmount),
        tx.pure.u64(quoteAmount),
        tx.pure.vector("vector<u8>", proof),
        tx.object.clock(),
      ]);
    };
  }

  /** `holder_rewards::close_round` at or after the claim deadline. */
  closeRound(
    options: RoundInput & { vault: SharedObjectIdentity },
  ): (tx: Transaction) => void {
    return (tx) => {
      this.#call(tx, "holder_rewards", "close_round", options, [
        this.#round(tx, options),
        this.#packageVersion(tx),
        this.#vault(tx, options),
        tx.object.clock(),
      ]);
    };
  }

  /** `holder_rewards::apply_round_delay`, once ready. */
  applyRoundDelay(options: VaultInput): (tx: Transaction) => void {
    return (tx) => {
      this.#call(tx, "holder_rewards", "apply_round_delay", options, [
        this.#vault(tx, options),
        this.#packageVersion(tx),
        tx.object.clock(),
      ]);
    };
  }

  /** `blast_vault_package::apply_witness<Witness>`, once ready. */
  applyWitness(options: { witnessType: string }): (tx: Transaction) => void {
    return this.#witnessCall("apply_witness", options, (tx) => [
      tx.object.clock(),
    ]);
  }

  /** `blast_vault_package::apply_witness_delay`, once ready. */
  applyWitnessDelay(): (tx: Transaction) => void {
    return this.#registryCall("apply_witness_delay", (tx) => [
      tx.object.clock(),
    ]);
  }

  /** `vault::pool_id`: the venue pool's ID, as a result. */
  poolId(options: VaultInput): (tx: Transaction) => TransactionResult {
    return (tx) =>
      this.#call(tx, "vault", "pool_id", options, [
        this.#vault(tx, options, false),
      ]);
  }

  // Admin, with a `blast_domain` role witness.

  /** `vault::schedule_protocol_bps` (`FeeAdmin`); each rate at most `MAX_LP_FEE_BPS`. */
  scheduleProtocolBps(
    options: VaultInput & {
      adminWitness: TransactionObjectInput;
      memeBps: bigint;
      quoteBps: bigint;
    },
  ): (tx: Transaction) => void {
    if (options.memeBps > MAX_LP_FEE_BPS || options.quoteBps > MAX_LP_FEE_BPS)
      throw new RangeError(
        `Blast's vault share is at most ${MAX_LP_FEE_BPS} basis points per asset`,
      );
    const memeBps = this.#core.bps(options.memeBps);
    const quoteBps = this.#core.bps(options.quoteBps);
    return (tx) => {
      this.#call(tx, "vault", "schedule_protocol_bps", options, [
        this.#vault(tx, options),
        tx.object(options.adminWitness),
        this.#packageVersion(tx),
        memeBps(tx),
        quoteBps(tx),
        tx.object.clock(),
      ]);
    };
  }

  /** `vault::cancel_protocol_bps` (`CancelAdmin`). */
  cancelProtocolBps(
    options: VaultInput & { adminWitness: TransactionObjectInput },
  ): (tx: Transaction) => void {
    return this.#adminVaultCall("vault", "cancel_protocol_bps", options);
  }

  /**
   * `holder_rewards::schedule_round` (`RewardsAdmin`): `root` and
   * `manifestDigest` are 32 bytes; the contract checks the rest against the
   * vault now and again at publication.
   */
  scheduleRound(
    options: VaultInput & {
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
    const u64s = [
      requireU64("number", options.number),
      requireU64("startCheckpoint", options.startCheckpoint),
      requireU64("endCheckpoint", options.endCheckpoint),
    ];
    const root = Array.from(requireDigest("root", options.root));
    const manifestDigest = Array.from(
      requireDigest("manifestDigest", options.manifestDigest),
    );
    const amounts = [
      requireU64("leafCount", options.leafCount),
      requireU64("memeAmount", options.memeAmount),
      requireU64("quoteAmount", options.quoteAmount),
      requireU64("gasReserveAmount", options.gasReserveAmount),
      requireU64("claimWindowDurationMs", options.claimWindowDurationMs),
    ];
    const expectedTreasury = normalizeSuiAddress(options.expectedTreasury);
    return (tx) => {
      this.#call(tx, "holder_rewards", "schedule_round", options, [
        this.#vault(tx, options),
        tx.object(options.adminWitness),
        this.#packageVersion(tx),
        ...u64s.map((value) => tx.pure.u64(value)),
        tx.pure.vector("u8", root),
        tx.pure.vector("u8", manifestDigest),
        ...amounts.map((value) => tx.pure.u64(value)),
        tx.pure.address(expectedTreasury),
        tx.object.clock(),
      ]);
    };
  }

  /** `holder_rewards::cancel_round` (`CancelAdmin`). */
  cancelRound(
    options: VaultInput & { adminWitness: TransactionObjectInput },
  ): (tx: Transaction) => void {
    return this.#adminVaultCall("holder_rewards", "cancel_round", options);
  }

  /** `holder_rewards::schedule_round_delay` (`RewardsAdmin`). */
  scheduleRoundDelay(
    options: VaultInput & {
      adminWitness: TransactionObjectInput;
      delayMs: bigint;
    },
  ): (tx: Transaction) => void {
    const delayMs = requireU64("delayMs", options.delayMs);
    return (tx) => {
      this.#call(tx, "holder_rewards", "schedule_round_delay", options, [
        this.#vault(tx, options),
        tx.object(options.adminWitness),
        this.#packageVersion(tx),
        tx.pure.u64(delayMs),
        tx.object.clock(),
      ]);
    };
  }

  /** `holder_rewards::cancel_round_delay` (`CancelAdmin`). */
  cancelRoundDelay(
    options: VaultInput & { adminWitness: TransactionObjectInput },
  ): (tx: Transaction) => void {
    return this.#adminVaultCall(
      "holder_rewards",
      "cancel_round_delay",
      options,
    );
  }

  /** `holder_rewards::settle_gas_reserve` (`RewardsAdmin`). */
  settleGasReserve(
    options: RoundInput & {
      adminWitness: TransactionObjectInput;
      vault: SharedObjectIdentity;
      reimbursementAmount: bigint;
    },
  ): (tx: Transaction) => void {
    const reimbursementAmount = requireU64(
      "reimbursementAmount",
      options.reimbursementAmount,
    );
    return (tx) => {
      this.#call(tx, "holder_rewards", "settle_gas_reserve", options, [
        this.#round(tx, options),
        tx.object(options.adminWitness),
        this.#packageVersion(tx),
        this.#vault(tx, options),
        tx.pure.u64(reimbursementAmount),
      ]);
    };
  }

  /** `blast_vault_package::schedule_witness<Witness>` (`VenueAdmin`). */
  scheduleWitness(options: {
    witnessType: string;
    adminWitness: TransactionObjectInput;
  }): (tx: Transaction) => void {
    return this.#witnessCall("schedule_witness", options, (tx) => [
      tx.object.clock(),
    ]);
  }

  /** `blast_vault_package::remove_witness<Witness>` (`VenueAdmin`). */
  removeWitness(options: {
    witnessType: string;
    adminWitness: TransactionObjectInput;
  }): (tx: Transaction) => void {
    return this.#witnessCall("remove_witness", options, () => []);
  }

  /** `blast_vault_package::cancel_witness<Witness>` (`CancelAdmin`). */
  cancelWitness(options: {
    witnessType: string;
    adminWitness: TransactionObjectInput;
  }): (tx: Transaction) => void {
    return this.#witnessCall("cancel_witness", options, () => []);
  }

  /** `blast_vault_package::schedule_witness_delay` (`VenueAdmin`). */
  scheduleWitnessDelay(options: {
    adminWitness: TransactionObjectInput;
    delayMs: bigint;
  }): (tx: Transaction) => void {
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#registryCall(
      "schedule_witness_delay",
      (tx) => [tx.pure.u64(delayMs), tx.object.clock()],
      options.adminWitness,
    );
  }

  /** `blast_vault_package::cancel_witness_delay` (`CancelAdmin`). */
  cancelWitnessDelay(options: {
    adminWitness: TransactionObjectInput;
  }): (tx: Transaction) => void {
    return this.#registryCall(
      "cancel_witness_delay",
      () => [],
      options.adminWitness,
    );
  }

  /**
   * `blast_vault_package::unpause` with an
   * `UnpauseAdmin<BLAST_VAULT_PACKAGE>` witness (`packageRoleType`).
   */
  unpause(options: {
    unpauseAdmin: TransactionObjectInput;
    bits: number;
  }): (tx: Transaction) => void {
    const bits = requirePauseBits(options.bits, VAULT_PAUSE_BITS.Admin);
    return (tx) => {
      tx.moveCall({
        target: this.#target("blast_vault_package", "unpause"),
        arguments: [
          deploymentObject(tx, this.deployment.registry, false),
          tx.object(options.unpauseAdmin),
          deploymentObject(tx, this.deployment.packageAdmin, false),
          this.#packageVersion(tx, true),
          tx.pure.u8(bits),
        ],
      });
    };
  }

  /**
   * `blast_vault_package::make_immutable` with an
   * `UpgradeAdmin<BLAST_VAULT_PACKAGE>` witness, once the scheduled action is
   * ready.
   */
  makeImmutable(options: {
    upgradeAdmin: TransactionObjectInput;
  }): (tx: Transaction) => void {
    return (tx) => {
      tx.moveCall({
        target: this.#target("blast_vault_package", "make_immutable"),
        arguments: [
          deploymentObject(tx, this.deployment.packageAdmin, true),
          tx.object(options.upgradeAdmin),
          this.#packageVersion(tx),
          tx.object.clock(),
        ],
      });
    };
  }

  /** A `vault` or `holder_rewards` call typed `<Meme, Quote>`. */
  #call(
    tx: Transaction,
    module: "vault" | "holder_rewards",
    functionName: string,
    types: VaultTypes,
    args: TransactionArgument[],
  ): TransactionResult {
    return tx.moveCall({
      target: this.#target(module, functionName),
      typeArguments: [
        normalizeStructTag(types.memeType),
        normalizeStructTag(types.quoteType),
      ],
      arguments: args,
    });
  }

  /** `(vault, admin_witness, package_version)`: the admin cancels. */
  #adminVaultCall(
    module: "vault" | "holder_rewards",
    functionName: string,
    options: VaultInput & { adminWitness: TransactionObjectInput },
  ): (tx: Transaction) => void {
    return (tx) => {
      this.#call(tx, module, functionName, options, [
        this.#vault(tx, options),
        tx.object(options.adminWitness),
        this.#packageVersion(tx),
      ]);
    };
  }

  /** `(registry, [admin_witness,] package_version, ...rest)` typed `<Witness>`. */
  #witnessCall(
    functionName: string,
    options: { witnessType: string; adminWitness?: TransactionObjectInput },
    rest: (tx: Transaction) => TransactionArgument[],
  ): (tx: Transaction) => void {
    const witnessType = normalizeStructTag(options.witnessType);
    return (tx) => {
      tx.moveCall({
        target: this.#target("blast_vault_package", functionName),
        typeArguments: [witnessType],
        arguments: this.#registryArguments(tx, options.adminWitness, rest),
      });
    };
  }

  /** `(registry, [admin_witness,] package_version, ...rest)`. */
  #registryCall(
    functionName: string,
    rest: (tx: Transaction) => TransactionArgument[],
    adminWitness?: TransactionObjectInput,
  ): (tx: Transaction) => void {
    return (tx) => {
      tx.moveCall({
        target: this.#target("blast_vault_package", functionName),
        arguments: this.#registryArguments(tx, adminWitness, rest),
      });
    };
  }

  #registryArguments(
    tx: Transaction,
    adminWitness: TransactionObjectInput | undefined,
    rest: (tx: Transaction) => TransactionArgument[],
  ): TransactionArgument[] {
    return [
      deploymentObject(tx, this.deployment.registry, true),
      ...(adminWitness === undefined ? [] : [tx.object(adminWitness)]),
      this.#packageVersion(tx),
      ...rest(tx),
    ];
  }

  #target(module: string, functionName: string): string {
    return `${this.deployment.packageId}::${module}::${functionName}`;
  }

  #vault(tx: Transaction, options: VaultInput, mutable = true) {
    return deploymentObject(tx, options.vault, mutable);
  }

  /** A `Round` is taken mutably by `claim` and `settle_gas_reserve`, by value by `close_round`. */
  #round(tx: Transaction, options: RoundInput) {
    return deploymentObject(tx, options.round, true);
  }

  #packageVersion(tx: Transaction, mutable = false) {
    return deploymentObject(tx, this.deployment.packageVersion, mutable);
  }

  #treasury(tx: Transaction) {
    return deploymentObject(tx, this.deployment.core.treasury, false);
  }
}

/**
 * Deployment-bound vault PTBs, each one `Transaction`. Admin calls sign in
 * with `adminCapId` for the call's role first: a `blast_domain` role, or the
 * vault's `UnpauseAdmin`/`UpgradeAdmin<BLAST_VAULT_PACKAGE>`. Owner calls
 * need the product's `prove_owner` in the same PTB, so they are composed by
 * `LaunchpadTransactions` and `PresaleTransactions`.
 */
export class VaultTransactions {
  readonly call: VaultCalls;
  readonly #admin: AdminCalls;

  constructor(deployment: VaultDeployment) {
    this.call = new VaultCalls(deployment);
    this.#admin = new AdminCalls(this.call.deployment.admin);
  }

  // Anyone.

  payProtocolFeesWithPartner(
    options: Parameters<VaultCalls["payProtocolFeesWithPartner"]>[0],
  ): Transaction {
    return single(this.call.payProtocolFeesWithPartner(options));
  }

  applyProtocolBps(
    options: Parameters<VaultCalls["applyProtocolBps"]>[0],
  ): Transaction {
    return single(this.call.applyProtocolBps(options));
  }

  publishRound(
    options: Parameters<VaultCalls["publishRound"]>[0],
  ): Transaction {
    return single(this.call.publishRound(options));
  }

  /** Relays one round's leaves, one `claim` each, in a single PTB. */
  claimRewards(
    options: RoundInput & { leaves: readonly RewardLeafInput[] },
  ): Transaction {
    if (options.leaves.length === 0)
      throw new RangeError("claimRewards needs at least one leaf");
    const tx = new Transaction();
    for (const leaf of options.leaves) {
      tx.add(this.call.claim({ ...options, ...leaf }));
    }
    return tx;
  }

  closeRound(options: Parameters<VaultCalls["closeRound"]>[0]): Transaction {
    return single(this.call.closeRound(options));
  }

  applyRoundDelay(
    options: Parameters<VaultCalls["applyRoundDelay"]>[0],
  ): Transaction {
    return single(this.call.applyRoundDelay(options));
  }

  applyWitness(
    options: Parameters<VaultCalls["applyWitness"]>[0],
  ): Transaction {
    return single(this.call.applyWitness(options));
  }

  applyWitnessDelay(): Transaction {
    return single(this.call.applyWitnessDelay());
  }

  // Admin.

  scheduleProtocolBps(
    options: AsAdmin<VaultCalls["scheduleProtocolBps"]>,
  ): Transaction {
    return this.#asCoreAdmin("FeeAdmin", options, (adminWitness) =>
      this.call.scheduleProtocolBps({ ...options, adminWitness }),
    );
  }

  cancelProtocolBps(
    options: AsAdmin<VaultCalls["cancelProtocolBps"]>,
  ): Transaction {
    return this.#asCoreAdmin("CancelAdmin", options, (adminWitness) =>
      this.call.cancelProtocolBps({ ...options, adminWitness }),
    );
  }

  scheduleRound(options: AsAdmin<VaultCalls["scheduleRound"]>): Transaction {
    return this.#asCoreAdmin("RewardsAdmin", options, (adminWitness) =>
      this.call.scheduleRound({ ...options, adminWitness }),
    );
  }

  /**
   * Schedules a round and publishes it in one PTB. Valid only once the
   * vault's round delay has been lowered to zero; vaults start at two hours,
   * and at any other delay the publish aborts.
   */
  scheduleAndPublishRound(
    options: AsAdmin<VaultCalls["scheduleRound"]>,
  ): Transaction {
    const tx = this.scheduleRound(options);
    tx.add(this.call.publishRound(options));
    return tx;
  }

  cancelRound(options: AsAdmin<VaultCalls["cancelRound"]>): Transaction {
    return this.#asCoreAdmin("CancelAdmin", options, (adminWitness) =>
      this.call.cancelRound({ ...options, adminWitness }),
    );
  }

  scheduleRoundDelay(
    options: AsAdmin<VaultCalls["scheduleRoundDelay"]>,
  ): Transaction {
    return this.#asCoreAdmin("RewardsAdmin", options, (adminWitness) =>
      this.call.scheduleRoundDelay({ ...options, adminWitness }),
    );
  }

  cancelRoundDelay(
    options: AsAdmin<VaultCalls["cancelRoundDelay"]>,
  ): Transaction {
    return this.#asCoreAdmin("CancelAdmin", options, (adminWitness) =>
      this.call.cancelRoundDelay({ ...options, adminWitness }),
    );
  }

  settleGasReserve(
    options: AsAdmin<VaultCalls["settleGasReserve"]>,
  ): Transaction {
    return this.#asCoreAdmin("RewardsAdmin", options, (adminWitness) =>
      this.call.settleGasReserve({ ...options, adminWitness }),
    );
  }

  scheduleWitness(
    options: AsAdmin<VaultCalls["scheduleWitness"]>,
  ): Transaction {
    return this.#asCoreAdmin("VenueAdmin", options, (adminWitness) =>
      this.call.scheduleWitness({ ...options, adminWitness }),
    );
  }

  removeWitness(options: AsAdmin<VaultCalls["removeWitness"]>): Transaction {
    return this.#asCoreAdmin("VenueAdmin", options, (adminWitness) =>
      this.call.removeWitness({ ...options, adminWitness }),
    );
  }

  cancelWitness(options: AsAdmin<VaultCalls["cancelWitness"]>): Transaction {
    return this.#asCoreAdmin("CancelAdmin", options, (adminWitness) =>
      this.call.cancelWitness({ ...options, adminWitness }),
    );
  }

  scheduleWitnessDelay(
    options: AsAdmin<VaultCalls["scheduleWitnessDelay"]>,
  ): Transaction {
    return this.#asCoreAdmin("VenueAdmin", options, (adminWitness) =>
      this.call.scheduleWitnessDelay({ ...options, adminWitness }),
    );
  }

  cancelWitnessDelay(
    options: AsAdmin<VaultCalls["cancelWitnessDelay"]>,
  ): Transaction {
    return this.#asCoreAdmin("CancelAdmin", options, (adminWitness) =>
      this.call.cancelWitnessDelay({ ...options, adminWitness }),
    );
  }

  unpause(options: { adminCapId: string; bits: number }): Transaction {
    return this.#asAdmin(
      options.adminCapId,
      this.#packageRole("UnpauseAdmin"),
      (unpauseAdmin) => this.call.unpause({ unpauseAdmin, bits: options.bits }),
    );
  }

  makeImmutable(options: { adminCapId: string }): Transaction {
    return this.#asAdmin(
      options.adminCapId,
      this.#packageRole("UpgradeAdmin"),
      (upgradeAdmin) => this.call.makeImmutable({ upgradeAdmin }),
    );
  }

  #packageRole(role: "UnpauseAdmin" | "UpgradeAdmin"): string {
    return packageRoleType(this.call.deployment.admin, this.call.otw, role);
  }

  #asCoreAdmin(
    role: CoreRole,
    options: { adminCapId: string },
    call: (
      adminWitness: TransactionObjectArgument,
    ) => (tx: Transaction) => void,
  ): Transaction {
    return this.#asAdmin(
      options.adminCapId,
      coreRoleType(this.call.deployment.core, role),
      call,
    );
  }

  #asAdmin(
    adminCapId: string,
    role: string,
    call: (
      adminWitness: TransactionObjectArgument,
    ) => (tx: Transaction) => void,
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.#admin.signIn({ adminCap: adminCapId, role }),
    );
    tx.add(call(adminWitness));
    return tx;
  }
}

/** A `VaultCalls` method's options with the witness replaced by the `AdminCap` that signs in. */
type AsAdmin<Method extends (options: never) => unknown> = Omit<
  Parameters<Method>[0],
  "adminWitness"
> & { adminCapId: string };

/** A 32-byte digest, root or proof sibling. */
function requireDigest(name: string, bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32) throw new RangeError(`${name} must be 32 bytes`);
  return bytes;
}

function single(call: (tx: Transaction) => void): Transaction {
  const tx = new Transaction();
  tx.add(call);
  return tx;
}
