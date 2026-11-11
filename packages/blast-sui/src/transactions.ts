import {
  AdminCalls,
  packageRoleType,
  requirePauseBits,
} from "@interest-protocol/blast-admin-sdk/transactions";
import type { CoinSourceOptions } from "@interest-protocol/blast-core/coins";
import { requireU64 } from "@interest-protocol/blast-core/integers";
import { deploymentObject } from "@interest-protocol/blast-core/ptb";
import type {
  TransactionArgument,
  TransactionObjectArgument,
  TransactionObjectInput,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  SUI_TYPE_ARG,
} from "@mysten/sui/utils";
import type { BlastSuiAdminRole, BlastSuiDeployment } from "./types.ts";
import {
  BLAST_SUI_PAUSE_BITS,
  blastSuiType,
  funSuiType,
  normalizeBlastSuiDeployment,
} from "./types.ts";

/** `constants::max_redeem_fee_bps`: the highest blastSUI redemption fee. */
export const MAX_BLAST_SUI_REDEEM_FEE_BPS = 100n;

/** Every `BLAST_SUI_PAUSE_BITS` bit: `constants::valid_pause_bits`. */
const VALID_PAUSE_BITS =
  BLAST_SUI_PAUSE_BITS.funMint |
  BLAST_SUI_PAUSE_BITS.request |
  BLAST_SUI_PAUSE_BITS.claim;

/**
 * Composable `blast_sui` calls. An `adminWitness` is `signIn`'s result for the
 * named `blast_sui_domain` role, or `AdminCalls.signIn`'s for a package role
 * (`packageRoleType`). A `poolId` picks a listed validator's staking pool.
 */
export class BlastSuiCalls {
  readonly deployment: BlastSuiDeployment;
  readonly admin: AdminCalls;
  /** `blast_sui_package::BLAST_SUI_PACKAGE`, the package's OTW. */
  readonly otw: string;

  constructor(deployment: BlastSuiDeployment) {
    this.deployment = normalizeBlastSuiDeployment(deployment);
    this.admin = new AdminCalls(this.deployment.admin);
    this.otw = normalizeStructTag(
      `${this.deployment.originalPackageId}::blast_sui_package::BLAST_SUI_PACKAGE`,
    );
  }

  /** The Move type of one `blast_sui_domain` role, for `AdminCalls.grantRole`. */
  roleType(role: BlastSuiAdminRole): string {
    return `${this.deployment.originalPackageId}::blast_sui_domain::${role}`;
  }

  /** This PTB's `AdminWitness<Role>`; the `AdminCap` must hold `role`. */
  signIn(options: {
    adminCap: TransactionObjectInput;
    role: BlastSuiAdminRole;
  }) {
    return this.admin.signIn({
      adminCap: options.adminCap,
      role: this.roleType(options.role),
    });
  }

  // Users.

  /** `vault::mint_fun_sui`: delegates to the listed `poolId`. */
  mintFunSui(options: { poolId: string; suiCoin: TransactionObjectInput }) {
    const poolId = normalizeSuiObjectId(options.poolId);
    return (tx: Transaction): TransactionObjectArgument =>
      this.#vaultCall(tx, "mint_fun_sui", [
        this.#system(tx),
        tx.pure.id(poolId),
        tx.object(options.suiCoin),
      ]);
  }

  redeemFunSui(options: { funSuiCoin: TransactionObjectInput }) {
    return (tx: Transaction): TransactionObjectArgument =>
      this.#vaultCall(tx, "redeem_fun_sui", [
        this.#system(tx),
        tx.object(options.funSuiCoin),
      ]);
  }

  /** `vault::request_blast_sui`: stakes with the listed `poolId` for a receipt. */
  requestBlastSui(options: {
    poolId: string;
    suiCoin: TransactionObjectInput;
  }) {
    const poolId = normalizeSuiObjectId(options.poolId);
    return (tx: Transaction): TransactionObjectArgument =>
      this.#vaultCall(tx, "request_blast_sui", [
        this.#system(tx),
        tx.pure.id(poolId),
        tx.object(options.suiCoin),
      ]);
  }

  keepDepositReceipt(options: { receipt: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("deposit_receipt", "keep"),
        arguments: [tx.object(options.receipt)],
      });
    };
  }

  claimBlastSui(options: {
    receipt: TransactionObjectInput;
    minBlastOut: bigint;
  }) {
    const minBlastOut = requireU64("minBlastOut", options.minBlastOut);
    return (tx: Transaction): TransactionObjectArgument =>
      this.#vaultCall(tx, "claim_blast_sui", [
        this.#system(tx),
        tx.object(options.receipt),
        tx.pure.u64(minBlastOut),
      ]);
  }

  cancelDepositReceipt(options: { receipt: TransactionObjectInput }) {
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: this.#target("deposit_receipt", "cancel"),
        arguments: [tx.object(options.receipt), this.#system(tx)],
      });
  }

  donateSui(options: { suiCoin: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "donate_sui", [
        this.#system(tx),
        tx.object(options.suiCoin),
      ]);
    };
  }

  /** `vault::top_up_fun_reserve`: SUI into the funSUI rounding reserve. */
  topUpFunReserve(options: { suiCoin: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "top_up_fun_reserve", [tx.object(options.suiCoin)]);
    };
  }

  redeemBlastSui(options: {
    blastSuiCoin: TransactionObjectInput;
    minSuiOut: bigint;
  }) {
    const minSuiOut = requireU64("minSuiOut", options.minSuiOut);
    return (tx: Transaction): TransactionObjectArgument =>
      this.#vaultCall(tx, "redeem_blast_sui", [
        this.#system(tx),
        tx.object(options.blastSuiCoin),
        tx.pure.u64(minSuiOut),
      ]);
  }

  syncVault() {
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "sync", [this.#system(tx)]);
    };
  }

  // Anyone, once a scheduled change is ready.

  applyRedeemFee() {
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "apply_redeem_fee", [tx.object.clock()]);
    };
  }

  /** `vault::apply_validator`: lists `poolId` once its admission is ready. */
  applyValidator(options: { poolId: string }) {
    const poolId = normalizeSuiObjectId(options.poolId);
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "apply_validator", [
        this.#system(tx),
        tx.pure.id(poolId),
        tx.object.clock(),
      ]);
    };
  }

  applyValidatorDelay() {
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "apply_validator_delay", [tx.object.clock()]);
    };
  }

  // Admin.

  /**
   * `vault::schedule_redeem_fee` (`FeeAdmin`): a fee of at most
   * `MAX_BLAST_SUI_REDEEM_FEE_BPS` and the delay in force once it applies.
   */
  scheduleRedeemFee(options: {
    adminWitness: TransactionObjectInput;
    redeemFeeBps: bigint;
    delayMs: bigint;
  }) {
    const redeemFeeBps = requireU64("redeemFeeBps", options.redeemFeeBps);
    if (redeemFeeBps > MAX_BLAST_SUI_REDEEM_FEE_BPS)
      throw new RangeError(
        `redeemFeeBps must be at most ${MAX_BLAST_SUI_REDEEM_FEE_BPS}`,
      );
    const delayMs = requireU64("delayMs", options.delayMs);
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "schedule_redeem_fee", [
        tx.object(options.adminWitness),
        tx.pure.u64(redeemFeeBps),
        tx.pure.u64(delayMs),
        tx.object.clock(),
      ]);
    };
  }

  /** `vault::cancel_redeem_fee` (`CancelAdmin`). */
  cancelRedeemFee(options: { adminWitness: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "cancel_redeem_fee", [
        tx.object(options.adminWitness),
      ]);
    };
  }

  /** `vault::schedule_validator` (`ValidatorAdmin`): a delayed admission. */
  scheduleValidator(options: {
    adminWitness: TransactionObjectInput;
    poolId: string;
  }) {
    const poolId = normalizeSuiObjectId(options.poolId);
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "schedule_validator", [
        tx.object(options.adminWitness),
        tx.pure.id(poolId),
        tx.object.clock(),
      ]);
    };
  }

  /** `vault::cancel_validator` (`CancelAdmin`): drops a pending admission. */
  cancelValidator(options: {
    adminWitness: TransactionObjectInput;
    poolId: string;
  }) {
    const poolId = normalizeSuiObjectId(options.poolId);
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "cancel_validator", [
        tx.object(options.adminWitness),
        tx.pure.id(poolId),
      ]);
    };
  }

  /**
   * `vault::remove_validator` (`ValidatorAdmin`): unlists `poolId` at once,
   * unwinding its positions, or drops its pending admission.
   */
  removeValidator(options: {
    adminWitness: TransactionObjectInput;
    poolId: string;
  }) {
    const poolId = normalizeSuiObjectId(options.poolId);
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "remove_validator", [
        tx.object(options.adminWitness),
        this.#system(tx),
        tx.pure.id(poolId),
      ]);
    };
  }

  /** `vault::schedule_validator_delay` (`ValidatorAdmin`). */
  scheduleValidatorDelay(options: {
    adminWitness: TransactionObjectInput;
    delayMs: bigint;
  }) {
    const delayMs = requireU64("delayMs", options.delayMs);
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "schedule_validator_delay", [
        tx.object(options.adminWitness),
        tx.pure.u64(delayMs),
        tx.object.clock(),
      ]);
    };
  }

  /** `vault::cancel_validator_delay` (`CancelAdmin`). */
  cancelValidatorDelay(options: { adminWitness: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      this.#vaultCall(tx, "cancel_validator_delay", [
        tx.object(options.adminWitness),
      ]);
    };
  }

  /**
   * `vault::unpause` with an `UnpauseAdmin<BLAST_SUI_PACKAGE>` witness
   * (`packageRoleType`): aborts with `EUnguardedDelay` while a delay is
   * unguarded or an admission is pending.
   */
  unpause(options: { unpauseAdmin: TransactionObjectInput; bits: number }) {
    const bits = requirePauseBits(options.bits, VALID_PAUSE_BITS);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("vault", "unpause"),
        arguments: [
          deploymentObject(tx, this.deployment.vault, false),
          deploymentObject(tx, this.deployment.packageVersion, true),
          tx.object(options.unpauseAdmin),
          deploymentObject(tx, this.deployment.packageAdmin, false),
          tx.pure.u8(bits),
        ],
      });
    };
  }

  /** `vault::<functionName>(vault, package_version, ...rest)`. */
  #vaultCall(
    tx: Transaction,
    functionName: string,
    rest: TransactionArgument[],
  ): TransactionObjectArgument {
    return tx.moveCall({
      target: this.#target("vault", functionName),
      arguments: [
        deploymentObject(tx, this.deployment.vault, true),
        deploymentObject(tx, this.deployment.packageVersion, false),
        ...rest,
      ],
    });
  }

  #system(tx: Transaction): TransactionObjectArgument {
    return tx.object.system({ mutable: true });
  }

  #target(module: string, functionName: string): string {
    return `${this.deployment.packageId}::${module}::${functionName}`;
  }
}

/**
 * Deployment-bound blast Sui PTBs, each one `Transaction`. Admin calls sign in
 * with `adminCapId` for the call's role first.
 */
export class BlastSuiTransactions {
  readonly call: BlastSuiCalls;
  readonly #useGasCoin: boolean;

  constructor(deployment: BlastSuiDeployment, options: CoinSourceOptions = {}) {
    this.call = new BlastSuiCalls(deployment);
    this.#useGasCoin = options.useGasCoin ?? true;
  }

  mintFunSui(
    options: {
      poolId: string;
      amount: bigint;
      recipient: string;
    } & CoinSourceOptions,
  ): Transaction {
    const tx = new Transaction();
    const suiCoin = this.#suiCoin(tx, options);
    const funSuiCoin = tx.add(
      this.call.mintFunSui({ poolId: options.poolId, suiCoin }),
    );
    transfer(tx, funSuiCoin, options.recipient);
    return tx;
  }

  redeemFunSui(options: { amount: bigint; recipient: string }): Transaction {
    requireU64("amount", options.amount);
    const tx = new Transaction();
    const funSuiCoin = tx.coin({
      type: funSuiType(this.call.deployment.originalPackageId),
      balance: options.amount,
    });
    const suiCoin = tx.add(this.call.redeemFunSui({ funSuiCoin }));
    transfer(tx, suiCoin, options.recipient);
    return tx;
  }

  requestBlastSui(
    options: { poolId: string; amount: bigint } & CoinSourceOptions,
  ): Transaction {
    const tx = new Transaction();
    const suiCoin = this.#suiCoin(tx, options);
    const receipt = tx.add(
      this.call.requestBlastSui({ poolId: options.poolId, suiCoin }),
    );
    tx.add(this.call.keepDepositReceipt({ receipt }));
    return tx;
  }

  claimBlastSui(options: {
    receiptId: string;
    minBlastOut: bigint;
    recipient: string;
  }): Transaction {
    const tx = new Transaction();
    const blastSuiCoin = tx.add(
      this.call.claimBlastSui({
        receipt: options.receiptId,
        minBlastOut: options.minBlastOut,
      }),
    );
    transfer(tx, blastSuiCoin, options.recipient);
    return tx;
  }

  cancelDepositReceipt(options: {
    receiptId: string;
    recipient: string;
  }): Transaction {
    const tx = new Transaction();
    const suiCoin = tx.add(
      this.call.cancelDepositReceipt({ receipt: options.receiptId }),
    );
    transfer(tx, suiCoin, options.recipient);
    return tx;
  }

  donateSui(options: { amount: bigint } & CoinSourceOptions): Transaction {
    const tx = new Transaction();
    tx.add(this.call.donateSui({ suiCoin: this.#suiCoin(tx, options) }));
    return tx;
  }

  topUpFunReserve(
    options: { amount: bigint } & CoinSourceOptions,
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.topUpFunReserve({ suiCoin: this.#suiCoin(tx, options) }));
    return tx;
  }

  redeemBlastSui(options: {
    amount: bigint;
    minSuiOut: bigint;
    recipient: string;
  }): Transaction {
    requireU64("amount", options.amount);
    const tx = new Transaction();
    const blastSuiCoin = tx.coin({
      type: blastSuiType(this.call.deployment.originalPackageId),
      balance: options.amount,
    });
    const suiCoin = tx.add(
      this.call.redeemBlastSui({ blastSuiCoin, minSuiOut: options.minSuiOut }),
    );
    transfer(tx, suiCoin, options.recipient);
    return tx;
  }

  syncVault(): Transaction {
    return single(this.call.syncVault());
  }

  // Anyone, once ready.

  applyRedeemFee(): Transaction {
    return single(this.call.applyRedeemFee());
  }

  applyValidator(options: { poolId: string }): Transaction {
    return single(this.call.applyValidator(options));
  }

  applyValidatorDelay(): Transaction {
    return single(this.call.applyValidatorDelay());
  }

  // Admin.

  scheduleRedeemFee(
    options: AsAdmin<BlastSuiCalls["scheduleRedeemFee"]>,
  ): Transaction {
    return this.#asRole("FeeAdmin", options, (adminWitness) =>
      this.call.scheduleRedeemFee({ ...options, adminWitness }),
    );
  }

  cancelRedeemFee(options: { adminCapId: string }): Transaction {
    return this.#asRole("CancelAdmin", options, (adminWitness) =>
      this.call.cancelRedeemFee({ adminWitness }),
    );
  }

  scheduleValidator(
    options: AsAdmin<BlastSuiCalls["scheduleValidator"]>,
  ): Transaction {
    return this.#asRole("ValidatorAdmin", options, (adminWitness) =>
      this.call.scheduleValidator({ ...options, adminWitness }),
    );
  }

  cancelValidator(
    options: AsAdmin<BlastSuiCalls["cancelValidator"]>,
  ): Transaction {
    return this.#asRole("CancelAdmin", options, (adminWitness) =>
      this.call.cancelValidator({ ...options, adminWitness }),
    );
  }

  removeValidator(
    options: AsAdmin<BlastSuiCalls["removeValidator"]>,
  ): Transaction {
    return this.#asRole("ValidatorAdmin", options, (adminWitness) =>
      this.call.removeValidator({ ...options, adminWitness }),
    );
  }

  scheduleValidatorDelay(
    options: AsAdmin<BlastSuiCalls["scheduleValidatorDelay"]>,
  ): Transaction {
    return this.#asRole("ValidatorAdmin", options, (adminWitness) =>
      this.call.scheduleValidatorDelay({ ...options, adminWitness }),
    );
  }

  cancelValidatorDelay(options: { adminCapId: string }): Transaction {
    return this.#asRole("CancelAdmin", options, (adminWitness) =>
      this.call.cancelValidatorDelay({ adminWitness }),
    );
  }

  /** Signs in as `UnpauseAdmin<BLAST_SUI_PACKAGE>` and clears `bits`. */
  unpause(options: { adminCapId: string; bits: number }): Transaction {
    const role = packageRoleType(
      this.call.deployment.admin,
      this.call.otw,
      "UnpauseAdmin",
    );
    return this.#asAdmin(options.adminCapId, role, (unpauseAdmin) =>
      this.call.unpause({ unpauseAdmin, bits: options.bits }),
    );
  }

  #suiCoin(
    tx: Transaction,
    options: { amount: bigint } & CoinSourceOptions,
  ): TransactionObjectArgument {
    requireU64("amount", options.amount);
    return tx.coin({
      type: SUI_TYPE_ARG,
      balance: options.amount,
      useGasCoin: options.useGasCoin ?? this.#useGasCoin,
    });
  }

  #asRole(
    role: BlastSuiAdminRole,
    options: { adminCapId: string },
    call: (
      adminWitness: TransactionObjectArgument,
    ) => (tx: Transaction) => void,
  ): Transaction {
    return this.#asAdmin(options.adminCapId, this.call.roleType(role), call);
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
      this.call.admin.signIn({ adminCap: adminCapId, role }),
    );
    tx.add(call(adminWitness));
    return tx;
  }
}

/** A `BlastSuiCalls` method's options with the witness replaced by the `AdminCap` that signs in. */
type AsAdmin<Method extends (options: never) => unknown> = Omit<
  Parameters<Method>[0],
  "adminWitness"
> & { adminCapId: string };

function single(call: (tx: Transaction) => void): Transaction {
  const tx = new Transaction();
  tx.add(call);
  return tx;
}

function transfer(
  tx: Transaction,
  object: TransactionObjectArgument,
  recipient: string,
): void {
  tx.transferObjects([object], normalizeSuiAddress(recipient));
}
