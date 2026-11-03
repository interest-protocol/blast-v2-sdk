import type { AdminDeployment } from "@interest-protocol/blast-admin-sdk/transactions";
import {
  AdminCalls,
  normalizeAdminDeployment,
} from "@interest-protocol/blast-admin-sdk/transactions";
import type { CoinSourceOptions } from "@interest-protocol/blast-core/coins";
import {
  requireBasisPoints,
  requirePositiveU64,
  requireU64,
} from "@interest-protocol/blast-core/integers";
import {
  deploymentObject,
  moveResults,
} from "@interest-protocol/blast-core/ptb";
import type {
  SharedObjectIdentity,
  SharedObjectReference,
} from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSharedObjectReference,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type {
  TransactionArgument,
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  fromHex,
  MOVE_STDLIB_ADDRESS,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  SUI_FRAMEWORK_ADDRESS,
} from "@mysten/sui/utils";
import type { CreatorAllocationPlan, FeeSplit } from "./allocation.ts";
import { normalizeAllocationPlan, normalizeFeeSplit } from "./allocation.ts";
import type { ObjectVersionReference } from "./effects.ts";
import { COIN_REGISTRY_ID } from "./effects.ts";
import type { MemeTemplateOptions } from "./template.ts";
import { buildMemePackageBytecode } from "./template.ts";

export type LaunchpadDeployment = {
  packageId: string;
  originalPackageId: string;
  /** `blast_admin`, a transitive Meme publish dependency, and its ACL. */
  admin: AdminDeployment;
  /** Published `blast_partners` package, a transitive Meme publish dependency. */
  partnersPackageId: string;
  packageVersion: SharedObjectIdentity;
  launchConfig: SharedObjectIdentity;
  runtimeConfig: SharedObjectIdentity;
};

/**
 * The typed `blast_fun::blast_fun_domain` roles (contracts ADR 0097). Each
 * administrator action takes the `AdminWitness` of exactly one of them; the
 * migrators reuse the launchpad's roles.
 */
export type BlastFunAdminRole =
  | "PauseAdmin"
  | "UnpauseAdmin"
  | "CancelAdmin"
  | "UpgradeAdmin"
  | "CreatorAdmin"
  | "BuybackAdmin"
  | "TreasuryAdmin"
  | "FeeAdmin"
  | "ListingAdmin"
  | "AdapterAdmin"
  | "ClaimSignerAdmin"
  | "RewardsAdmin";

export type LaunchTypes = {
  memeType: string;
  quoteType: string;
};

/** Shortest nonzero opening round `launch::finalize` accepts. */
export const MIN_OPENING_ROUND_MS = 60_000n;
/** Longest opening round `launch::finalize` accepts. */
export const MAX_OPENING_ROUND_MS = 300_000n;

/**
 * The creator's launch settings, applied to a `LaunchInitializer` before
 * `launch::finalize` checks every invariant.
 */
export type LaunchSettings = {
  /** The virtual Quote reserve the curve starts from; it prices the first purchase. */
  virtualQuote: bigint;
  graduationTarget: bigint;
  /** The creator's plan; finalization adds Blast's shares. */
  allocationPlan: CreatorAllocationPlan;
  lpFeeSplit: FeeSplit;
  /** Opening-round length after share; zero or omitted, trading starts at share. */
  openingRoundMs?: bigint;
  /** A Blast partner `LaunchConfig` accepts; it is the launch's partner for good. */
  partner?: SharedObjectReference<false>;
};

/**
 * The creator's purchase on the owned launch before it is shared. Without an
 * opening round it is a curve buy routed to `recipient`. With one it is the
 * creator's bid in the same pot at the same price: `minMemeOut` and
 * `recipient` are unused, and delivery pays the sender after settlement.
 */
export type PreShareBuyInput = {
  quoteAmount: bigint;
  minMemeOut: bigint;
  recipient: string;
};

/**
 * Inputs shared by the launch metadata setters. `launch` is read immutably by
 * Move; pass `mutable: true` only when the same PTB also mutates the launch.
 */
export type MemeMetadataUpdate = LaunchTypes & {
  launch: SharedObjectReference;
  blastMetadataCap: TransactionObjectInput;
  currency: SharedObjectReference<true>;
};

export type LaunchInitializerInput = LaunchTypes & {
  initializer: TransactionArgument;
};

export class LaunchpadCalls {
  readonly deployment: LaunchpadDeployment;
  readonly admin: AdminCalls;

  constructor(deployment: LaunchpadDeployment) {
    this.deployment = normalizeDeployment(deployment);
    this.admin = new AdminCalls(this.deployment.admin);
  }

  /** The Move type of one `blast_fun_domain` role, for `AdminCalls.grantRole`. */
  roleType(role: BlastFunAdminRole): string {
    return `${this.deployment.originalPackageId}::blast_fun_domain::${role}`;
  }

  /** Builds one `bps::Bps` value. */
  bps(value: bigint) {
    requireBasisPoints("bps", value);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::bps::new`,
        arguments: [tx.pure.u64(value)],
      });
  }

  /**
   * Builds the creator's `allocation::AllocationPlan` (Blast excluded) through
   * `allocation::recipient` and `allocation::plan`.
   */
  allocationPlan(plan: CreatorAllocationPlan) {
    const normalized = normalizeAllocationPlan(plan);
    return (tx: Transaction): TransactionResult => {
      const recipients = tx.makeMoveVec({
        type: `${this.deployment.originalPackageId}::allocation::Recipient`,
        elements: normalized.recipients.map((recipient) =>
          tx.moveCall({
            target: `${this.deployment.packageId}::allocation::recipient`,
            arguments: [
              tx.pure.address(recipient.destination),
              tx.add(this.bps(recipient.memeBps)),
              tx.add(this.bps(recipient.quoteBps)),
            ],
          }),
        ),
      });
      return tx.moveCall({
        target: `${this.deployment.packageId}::allocation::plan`,
        arguments: [
          tx.add(this.bps(normalized.curveMemeBps)),
          tx.add(this.bps(normalized.lpMemeBps)),
          tx.add(this.bps(normalized.lpQuoteBps)),
          recipients,
        ],
      });
    };
  }

  /** Builds an `allocation::FeeSplit` through `allocation::route` and `allocation::fee_split`. */
  feeSplit(split: FeeSplit) {
    const normalized = normalizeFeeSplit(split);
    return (tx: Transaction): TransactionResult => {
      const recipients = tx.makeMoveVec({
        type: `${this.deployment.originalPackageId}::allocation::Route`,
        elements: normalized.recipients.map((recipient) =>
          tx.moveCall({
            target: `${this.deployment.packageId}::allocation::route`,
            arguments: [
              tx.pure.address(recipient.destination),
              tx.add(this.bps(recipient.bps)),
            ],
          }),
        ),
      });
      return tx.moveCall({
        target: `${this.deployment.packageId}::allocation::fee_split`,
        arguments: [
          tx.add(this.bps(normalized.creatorBps)),
          tx.add(this.bps(normalized.autoLpBps)),
          tx.add(this.bps(normalized.rewardsBps)),
          tx.add(this.bps(normalized.burnBps)),
          recipients,
        ],
      });
    };
  }

  setVirtualQuote(options: LaunchInitializerInput & { virtualQuote: bigint }) {
    requirePositiveU64("virtualQuote", options.virtualQuote);
    return this.#initializerCall("set_virtual_quote", options, (tx) => [
      tx.pure.u64(options.virtualQuote),
    ]);
  }

  setGraduationTarget(
    options: LaunchInitializerInput & { graduationTarget: bigint },
  ) {
    requirePositiveU64("graduationTarget", options.graduationTarget);
    return this.#initializerCall("set_graduation_target", options, (tx) => [
      tx.pure.u64(options.graduationTarget),
    ]);
  }

  setAllocationPlan(
    options: LaunchInitializerInput & { allocationPlan: CreatorAllocationPlan },
  ) {
    const plan = this.allocationPlan(options.allocationPlan);
    return this.#initializerCall("set_allocation_plan", options, (tx) => [
      tx.add(plan),
    ]);
  }

  setLpFeeSplit(options: LaunchInitializerInput & { lpFeeSplit: FeeSplit }) {
    const split = this.feeSplit(options.lpFeeSplit);
    return this.#initializerCall("set_lp_fee_split", options, (tx) => [
      tx.add(split),
    ]);
  }

  /** Zero means no opening round; otherwise one to five minutes. */
  setOpeningRound(
    options: LaunchInitializerInput & { openingRoundMs: bigint },
  ) {
    requireOpeningRoundMs(options.openingRoundMs);
    return this.#initializerCall("set_opening_round", options, (tx) => [
      tx.pure.u64(options.openingRoundMs),
    ]);
  }

  /** Names the launch's partner; `launch_config` must accept it now. */
  setPartner(
    options: LaunchInitializerInput & {
      partner: SharedObjectReference<false>;
    },
  ) {
    return this.#initializerCall("set_partner", options, (tx) => [
      this.#launchConfig(tx),
      sharedObject(tx, "partner", options.partner, false),
      tx.object.clock(),
    ]);
  }

  /**
   * Consumes the initializer, checks every setting, and returns the owned
   * launch. `creationFee` must be a `Coin<SUI>` of exactly the `LaunchConfig`
   * creation fee.
   */
  finalizeLaunch(
    options: LaunchInitializerInput & {
      currency: SharedObjectReference<true>;
      creationFee: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::finalize`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          options.initializer,
          this.#packageVersion(tx),
          sharedObject(tx, "currency", options.currency, true),
          this.#launchConfig(tx),
          tx.object(options.creationFee),
        ],
      });
  }

  /** Shares the finalized launch; trading or the opening round starts now. */
  shareLaunch(options: LaunchTypes & { launch: TransactionArgument }) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::share`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          options.launch,
          this.#packageVersion(tx),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * Applies the creator's settings to an adapter-started initializer, finalizes
   * it, runs the optional purchase on the owned launch, and shares the launch.
   * Without an opening round the purchase is a curve buy, which may reach the
   * graduation target before share, and its `(Coin<Meme>, Coin<Quote>)` result
   * is returned. With one, the purchase is the creator's bid in the round and
   * nothing is returned.
   */
  completeLaunch(
    options: LaunchInitializerInput &
      LaunchSettings & {
        currency: SharedObjectReference<true>;
        creationFee: TransactionObjectInput;
        preShareBuy?: { quoteCoin: TransactionObjectInput; minMemeOut: bigint };
      },
  ) {
    const { openingRoundMs = 0n, partner, preShareBuy } = options;
    const settings = [
      this.setVirtualQuote(options),
      this.setGraduationTarget(options),
      this.setAllocationPlan(options),
      this.setLpFeeSplit(options),
      ...(openingRoundMs > 0n
        ? [this.setOpeningRound({ ...options, openingRoundMs })]
        : []),
      ...(partner ? [this.setPartner({ ...options, partner })] : []),
    ];
    const purchase = preShareBuy && { ...options, ...preShareBuy };
    return (tx: Transaction): TransactionResult | undefined => {
      for (const setting of settings) tx.add(setting);
      const launch = tx.add(this.finalizeLaunch(options));
      let bought: TransactionResult | undefined;
      if (purchase && openingRoundMs > 0n) {
        tx.add(this.#joinCall(purchase, () => launch));
      } else if (purchase) {
        bought = tx.add(this.#buyCall(purchase, () => launch));
      }
      tx.add(this.shareLaunch({ ...options, launch }));
      return bought;
    };
  }

  /**
   * Adds `quoteCoin` to the sender's opening-round bid until the round ends.
   * Bids cannot be withdrawn.
   */
  joinOpeningRound(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      quoteCoin: TransactionObjectInput;
    },
  ) {
    return this.#joinCall(options, (tx) =>
      sharedObject(tx, "launch", options.launch, true),
    );
  }

  /** Settles an ended opening round with one curve purchase; anyone may call it. */
  settleOpeningRound(
    options: LaunchTypes & { launch: SharedObjectReference<true> },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::settle_opening_round`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          this.#runtimeConfig(tx),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * Sends `bidder` its pro-rata share of the settled round's Meme and refunded
   * Quote; anyone may call it, and the coins always go to the bidder.
   */
  deliverOpeningRound(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      bidder: string;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const bidder = normalizeSuiAddress(options.bidder);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::deliver_opening_round`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          tx.pure.address(bidder),
        ],
      });
    };
  }

  buy(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      quoteCoin: TransactionObjectInput;
      minMemeOut: bigint;
    },
  ) {
    return this.#buyCall(options, (tx) =>
      sharedObject(tx, "launch", options.launch, true),
    );
  }

  sell(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      memeCoin: TransactionObjectInput;
      minQuoteOut: bigint;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    requireU64("minQuoteOut", options.minQuoteOut);
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::sell`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          this.#runtimeConfig(tx),
          tx.object(options.memeCoin),
          tx.pure.u64(options.minQuoteOut),
        ],
      });
  }

  /**
   * Issues both creator capabilities. The `CurveFeeCap` also claims the
   * creator's migrated LP fees and changes the LP-fee split.
   */
  claimCreatorCaps(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      accountAttestation?: Uint8Array | null;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::claim_creator_caps`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          this.#runtimeConfig(tx),
          tx.pure.option(
            "vector<u8>",
            options.accountAttestation
              ? Array.from(options.accountAttestation)
              : null,
          ),
          tx.object.clock(),
        ],
      });
  }

  claimCreatorFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      curveFeeCap: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::claim_creator_fees`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          tx.object(options.curveFeeCap),
        ],
      });
  }

  setName(options: MemeMetadataUpdate & { name: string }) {
    return this.#setMemeMetadata("set_name", options, options.name);
  }

  setDescription(options: MemeMetadataUpdate & { description: string }) {
    return this.#setMemeMetadata(
      "set_description",
      options,
      options.description,
    );
  }

  setIconUrl(options: MemeMetadataUpdate & { iconUrl: string }) {
    return this.#setMemeMetadata("set_icon_url", options, options.iconUrl);
  }

  /** This PTB's `AdminWitness<Role>`; the `AdminCap` must hold `role`. */
  signIn(options: {
    adminCap: TransactionObjectInput;
    role: BlastFunAdminRole;
  }) {
    return this.admin.signIn({
      adminCap: options.adminCap,
      role: this.roleType(options.role),
    });
  }

  /**
   * Pays Blast's Meme, Quote, and SUI fees to the `RuntimeConfig` treasury.
   * Anyone may call it. A launch that names a partner needs that `partner`
   * (`claim_protocol_fees_with_partner`), which is paid its share in the call.
   */
  claimProtocolFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      partner?: SharedObjectReference<false> | null;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const { partner } = options;
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::${partner ? "claim_protocol_fees_with_partner" : "claim_protocol_fees"}`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          this.#runtimeConfig(tx),
          ...(partner ? [sharedObject(tx, "partner", partner, false)] : []),
        ],
      });
    };
  }

  /**
   * Shares a published Meme's `Currency<Meme>` through
   * `coin_registry::finalize_registration`; anyone may call it. Each call adds
   * its own `Receiving` input and reuses the PTB's one Coin Registry input, so
   * several Memes register in one PTB.
   */
  finalizeCurrencyRegistration(options: {
    memeType: string;
    currency: ObjectVersionReference;
  }) {
    const memeType = normalizeStructTag(options.memeType);
    const currency = {
      objectId: normalizeSuiObjectId(options.currency.objectId),
      version: options.currency.version,
      digest: options.currency.digest,
    };
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${SUI_FRAMEWORK_ADDRESS}::coin_registry::finalize_registration`,
        typeArguments: [memeType],
        arguments: [tx.object(COIN_REGISTRY_ID), tx.receivingRef(currency)],
      });
    };
  }

  /** `launch_config::set_meme_decimals_allowed` (`ListingAdmin`). */
  setMemeDecimalsAllowed(options: {
    adminWitness: TransactionObjectInput;
    decimals: number;
    allowed: boolean;
  }) {
    return this.#configCall(
      "launch_config::set_meme_decimals_allowed",
      options,
      (tx) => [tx.pure.u8(options.decimals), tx.pure.bool(options.allowed)],
    );
  }

  /** `launch_config::set_quote_allowed<Quote>` (`ListingAdmin`); existing launches keep trading. */
  setQuoteAllowed(options: {
    adminWitness: TransactionObjectInput;
    quoteType: string;
    allowed: boolean;
  }) {
    return this.#configCall(
      "launch_config::set_quote_allowed",
      options,
      (tx) => [tx.pure.bool(options.allowed)],
      [normalizeStructTag(options.quoteType)],
    );
  }

  /** `launch_config::add_partner` (`FeeAdmin`): new launches may name `partner` at once. */
  addPartner(options: {
    adminWitness: TransactionObjectInput;
    partner: SharedObjectReference<false>;
  }) {
    return this.#configCall("launch_config::add_partner", options, (tx) => [
      sharedObject(tx, "partner", options.partner, false),
    ]);
  }

  /**
   * `launch_config::remove_partner` (`FeeAdmin`): new launches stop naming
   * `partner` after `PARTNER_DELAY_MS`; launches that name it keep paying it.
   */
  removePartner(options: {
    adminWitness: TransactionObjectInput;
    partner: SharedObjectReference<false>;
  }) {
    return this.#configCall("launch_config::remove_partner", options, (tx) => [
      sharedObject(tx, "partner", options.partner, false),
      tx.object.clock(),
    ]);
  }

  /**
   * `runtime_config::schedule_creator_claim_signer` (`ClaimSignerAdmin`):
   * proposes admitting an Ed25519 key that may sign account claims, after the
   * signer notice. At most four keys may be live or pending at once.
   */
  scheduleCreatorClaimSigner(options: {
    adminWitness: TransactionObjectInput;
    signerPublicKey: ClaimSignerPublicKey;
  }) {
    const key = claimSignerKey(options.signerPublicKey);
    return this.#configCall(
      "runtime_config::schedule_creator_claim_signer",
      options,
      (tx) => [tx.pure.vector("u8", key), tx.object.clock()],
    );
  }

  /** `runtime_config::apply_creator_claim_signer`: anyone admits a ready signer key. */
  applyCreatorClaimSigner(options: { signerPublicKey: ClaimSignerPublicKey }) {
    const key = claimSignerKey(options.signerPublicKey);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::runtime_config::apply_creator_claim_signer`,
        arguments: [
          this.#runtimeConfig(tx, true),
          this.#packageVersion(tx),
          tx.pure.vector("u8", key),
          tx.object.clock(),
        ],
      });
    };
  }

  /** `runtime_config::cancel_creator_claim_signer` (`CancelAdmin`): discards a pending admission. */
  cancelCreatorClaimSigner(options: {
    adminWitness: TransactionObjectInput;
    signerPublicKey: ClaimSignerPublicKey;
  }) {
    const key = claimSignerKey(options.signerPublicKey);
    return this.#configCall(
      "runtime_config::cancel_creator_claim_signer",
      options,
      (tx) => [tx.pure.vector("u8", key)],
    );
  }

  /**
   * `runtime_config::revoke_creator_claim_signer` (`ClaimSignerAdmin`):
   * removes a live or pending key at once; attestations it signed stop
   * verifying.
   */
  revokeCreatorClaimSigner(options: {
    adminWitness: TransactionObjectInput;
    signerPublicKey: ClaimSignerPublicKey;
  }) {
    const key = claimSignerKey(options.signerPublicKey);
    return this.#configCall(
      "runtime_config::revoke_creator_claim_signer",
      options,
      (tx) => [tx.pure.vector("u8", key)],
    );
  }

  /** `runtime_config::schedule_creator_claim_signer_delay` (`ClaimSignerAdmin`): the next signer notice. */
  scheduleCreatorClaimSignerDelay(options: {
    adminWitness: TransactionObjectInput;
    delayMs: bigint;
  }) {
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#configCall(
      "runtime_config::schedule_creator_claim_signer_delay",
      options,
      (tx) => [tx.pure.u64(delayMs), tx.object.clock()],
    );
  }

  /** `runtime_config::apply_creator_claim_signer_delay`: anyone applies a ready signer notice. */
  applyCreatorClaimSignerDelay() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::runtime_config::apply_creator_claim_signer_delay`,
        arguments: [
          this.#runtimeConfig(tx, true),
          this.#packageVersion(tx),
          tx.object.clock(),
        ],
      });
    };
  }

  /** `runtime_config::cancel_creator_claim_signer_delay` (`CancelAdmin`). */
  cancelCreatorClaimSignerDelay(options: {
    adminWitness: TransactionObjectInput;
  }) {
    return this.#configCall(
      "runtime_config::cancel_creator_claim_signer_delay",
      options,
      () => [],
    );
  }

  /** `launch_config::apply_creation_fee`. Permissionless; the contract validates readiness and ownership. */
  applyCreationFee() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::apply_creation_fee`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch_config::apply_migration_delay`. Permissionless; the contract validates readiness and ownership. */
  applyMigrationDelay() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::apply_migration_delay`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch_config::apply_migration_witness`. Permissionless; the contract validates readiness and ownership. */
  applyMigrationWitness(options: { migrationWitnessType: string }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::apply_migration_witness`,
        typeArguments: [normalizeStructTag(options.migrationWitnessType)],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch_config::apply_protocol_allocation`. Permissionless; the contract validates readiness and ownership. */
  applyProtocolAllocation() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::apply_protocol_allocation`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch_config::apply_trade_fees`. Permissionless; the contract validates readiness and ownership. */
  applyTradeFees() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::apply_trade_fees`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch_config::cancel_creation_fee`. Requires CancelAdmin. */
  cancelCreationFee(options: { adminWitness: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::cancel_creation_fee`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `launch_config::cancel_migration_delay`. Requires CancelAdmin. */
  cancelMigrationDelay(options: { adminWitness: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::cancel_migration_delay`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `launch_config::cancel_migration_witness`. Requires CancelAdmin. */
  cancelMigrationWitness(options: {
    migrationWitnessType: string;
    adminWitness: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::cancel_migration_witness`,
        typeArguments: [normalizeStructTag(options.migrationWitnessType)],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `launch_config::cancel_protocol_allocation`. Requires CancelAdmin. */
  cancelProtocolAllocation(options: { adminWitness: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::cancel_protocol_allocation`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `launch_config::cancel_trade_fees`. Requires CancelAdmin. */
  cancelTradeFees(options: { adminWitness: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::cancel_trade_fees`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `launch_config::remove_migration_witness`. Requires AdapterAdmin. */
  removeMigrationWitness(options: {
    migrationWitnessType: string;
    adminWitness: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::remove_migration_witness`,
        typeArguments: [normalizeStructTag(options.migrationWitnessType)],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `launch_config::schedule_creation_fee`. Requires FeeAdmin. */
  scheduleCreationFee(options: {
    adminWitness: TransactionObjectInput;
    creationFee: bigint;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::schedule_creation_fee`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
          tx.pure.u64(requireU64("creationFee", options.creationFee)),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch_config::schedule_migration_delay`. Requires AdapterAdmin. */
  scheduleMigrationDelay(options: {
    adminWitness: TransactionObjectInput;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::schedule_migration_delay`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch_config::schedule_migration_witness`. Requires AdapterAdmin. */
  scheduleMigrationWitness(options: {
    migrationWitnessType: string;
    adminWitness: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::schedule_migration_witness`,
        typeArguments: [normalizeStructTag(options.migrationWitnessType)],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch_config::schedule_protocol_allocation`. Requires TreasuryAdmin. */
  scheduleProtocolAllocation(options: {
    adminWitness: TransactionObjectInput;
    memeBps: bigint;
    quoteBps: bigint;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::schedule_protocol_allocation`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
          tx.add(this.bps(options.memeBps)),
          tx.add(this.bps(options.quoteBps)),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch_config::schedule_trade_fees`. Requires FeeAdmin. */
  scheduleTradeFees(options: {
    adminWitness: TransactionObjectInput;
    quoteFeeBps: bigint;
    memeFeeBps: bigint;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::schedule_trade_fees`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.launchConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
          tx.add(this.bps(options.quoteFeeBps)),
          tx.add(this.bps(options.memeFeeBps)),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `runtime_config::apply_protocol_fee_share`. Permissionless; the contract validates readiness and ownership. */
  applyProtocolFeeShare() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::runtime_config::apply_protocol_fee_share`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.runtimeConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `runtime_config::apply_treasury`. Permissionless; the contract validates readiness and ownership. */
  applyTreasury() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::runtime_config::apply_treasury`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.runtimeConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `runtime_config::cancel_protocol_fee_share`. Requires CancelAdmin. */
  cancelProtocolFeeShare(options: { adminWitness: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::runtime_config::cancel_protocol_fee_share`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.runtimeConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `runtime_config::cancel_treasury`. Requires CancelAdmin. */
  cancelTreasury(options: { adminWitness: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::runtime_config::cancel_treasury`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.runtimeConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `runtime_config::schedule_protocol_fee_share`. Requires FeeAdmin. */
  scheduleProtocolFeeShare(options: {
    adminWitness: TransactionObjectInput;
    protocolFeeShareBps: bigint;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::runtime_config::schedule_protocol_fee_share`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.runtimeConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
          tx.add(this.bps(options.protocolFeeShareBps)),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `runtime_config::schedule_treasury`. Requires TreasuryAdmin. */
  scheduleTreasury(options: {
    adminWitness: TransactionObjectInput;
    treasury: string;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::runtime_config::schedule_treasury`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.runtimeConfig, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
          tx.pure.address(normalizeSuiAddress(options.treasury)),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch::apply_curve_fee_cap_delay`. Permissionless; applies a ready notice change. */
  applyCurveFeeCapDelay(options: {
    memeType: string;
    quoteType: string;
    launch: SharedObjectReference<true>;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::apply_curve_fee_cap_delay`,
        typeArguments: [
          normalizeStructTag(options.memeType),
          normalizeStructTag(options.quoteType),
        ],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch::apply_curve_fee_cap_reassignment`. Permissionless; hands the cap to the ready recipient. */
  applyCurveFeeCapReassignment(options: {
    memeType: string;
    quoteType: string;
    launch: SharedObjectReference<true>;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::apply_curve_fee_cap_reassignment`,
        typeArguments: [
          normalizeStructTag(options.memeType),
          normalizeStructTag(options.quoteType),
        ],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch::apply_metadata_cap_delay`. Permissionless; applies a ready notice change. */
  applyMetadataCapDelay(options: {
    memeType: string;
    quoteType: string;
    launch: SharedObjectReference<true>;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::apply_metadata_cap_delay`,
        typeArguments: [
          normalizeStructTag(options.memeType),
          normalizeStructTag(options.quoteType),
        ],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch::apply_metadata_cap_reassignment`. Permissionless; hands the cap to the ready recipient. */
  applyMetadataCapReassignment(options: {
    memeType: string;
    quoteType: string;
    launch: SharedObjectReference<true>;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::apply_metadata_cap_reassignment`,
        typeArguments: [
          normalizeStructTag(options.memeType),
          normalizeStructTag(options.quoteType),
        ],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch::cancel_curve_fee_cap_reassignment`. Requires CancelAdmin. */
  cancelCurveFeeCapReassignment(options: {
    memeType: string;
    quoteType: string;
    launch: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::cancel_curve_fee_cap_reassignment`,
        typeArguments: [
          normalizeStructTag(options.memeType),
          normalizeStructTag(options.quoteType),
        ],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `launch::cancel_metadata_cap_reassignment`. Requires CancelAdmin. */
  cancelMetadataCapReassignment(options: {
    memeType: string;
    quoteType: string;
    launch: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::cancel_metadata_cap_reassignment`,
        typeArguments: [
          normalizeStructTag(options.memeType),
          normalizeStructTag(options.quoteType),
        ],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
        ],
      });
    };
  }
  /** `launch::schedule_curve_fee_cap_delay`. Requires CreatorAdmin. */
  scheduleCurveFeeCapDelay(options: {
    memeType: string;
    quoteType: string;
    launch: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::schedule_curve_fee_cap_delay`,
        typeArguments: [
          normalizeStructTag(options.memeType),
          normalizeStructTag(options.quoteType),
        ],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch::schedule_curve_fee_cap_reassignment`. Requires CreatorAdmin. */
  scheduleCurveFeeCapReassignment(options: {
    memeType: string;
    quoteType: string;
    launch: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
    recipient: string;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::schedule_curve_fee_cap_reassignment`,
        typeArguments: [
          normalizeStructTag(options.memeType),
          normalizeStructTag(options.quoteType),
        ],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
          tx.pure.address(normalizeSuiAddress(options.recipient)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch::schedule_metadata_cap_delay`. Requires CreatorAdmin. */
  scheduleMetadataCapDelay(options: {
    memeType: string;
    quoteType: string;
    launch: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
    delayMs: bigint;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::schedule_metadata_cap_delay`,
        typeArguments: [
          normalizeStructTag(options.memeType),
          normalizeStructTag(options.quoteType),
        ],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
          tx.pure.u64(requireU64("delayMs", options.delayMs)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `launch::schedule_metadata_cap_reassignment`. Requires CreatorAdmin. */
  scheduleMetadataCapReassignment(options: {
    memeType: string;
    quoteType: string;
    launch: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
    recipient: string;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::schedule_metadata_cap_reassignment`,
        typeArguments: [
          normalizeStructTag(options.memeType),
          normalizeStructTag(options.quoteType),
        ],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          deploymentObject(tx, this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
          tx.pure.address(normalizeSuiAddress(options.recipient)),
          tx.object.clock(),
        ],
      });
    };
  }
  /** `blast_fun::pause`. Requires PauseAdmin. */
  pause(options: { adminWitness: TransactionObjectInput; bits: number }) {
    if (
      !Number.isInteger(options.bits) ||
      options.bits <= 0 ||
      options.bits > 255 ||
      (options.bits & ~7) !== 0
    )
      throw new RangeError("invalid pause bits");
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::blast_fun::pause`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.packageVersion, true),
          tx.object(options.adminWitness),
          tx.pure.u8(options.bits),
        ],
      });
    };
  }
  /** `blast_fun::unpause`. Requires UnpauseAdmin. */
  unpause(options: { adminWitness: TransactionObjectInput; bits: number }) {
    if (
      !Number.isInteger(options.bits) ||
      options.bits <= 0 ||
      options.bits > 255 ||
      (options.bits & ~7) !== 0
    )
      throw new RangeError("invalid pause bits");
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::blast_fun::unpause`,
        typeArguments: [],
        arguments: [
          deploymentObject(tx, this.deployment.packageVersion, true),
          tx.object(options.adminWitness),
          tx.pure.u8(options.bits),
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
          deploymentObject(tx, this.deployment.packageVersion, false),
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
          deploymentObject(tx, this.deployment.packageVersion, false),
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
          deploymentObject(tx, this.deployment.packageVersion, false),
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
          deploymentObject(tx, this.deployment.packageVersion, true),
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
          deploymentObject(tx, this.deployment.packageVersion, false),
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
          deploymentObject(tx, this.deployment.packageVersion, false),
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
          deploymentObject(tx, this.deployment.packageVersion, false),
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
          deploymentObject(tx, this.deployment.packageVersion, false),
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

  #configCall(
    target: `${"launch_config" | "runtime_config"}::${string}`,
    options: { adminWitness: TransactionObjectInput },
    extra: (tx: Transaction) => TransactionArgument[],
    typeArguments: string[] = [],
  ) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::${target}`,
        typeArguments,
        arguments: [
          target.startsWith("launch_config")
            ? this.#launchConfig(tx, true)
            : this.#runtimeConfig(tx, true),
          this.#packageVersion(tx),
          tx.object(options.adminWitness),
          ...extra(tx),
        ],
      });
    };
  }

  #buyCall(
    options: LaunchTypes & {
      quoteCoin: TransactionObjectInput;
      minMemeOut: bigint;
    },
    launch: (tx: Transaction) => TransactionArgument,
  ) {
    const types = normalizeLaunchTypes(options);
    requireU64("minMemeOut", options.minMemeOut);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::buy`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          launch(tx),
          this.#packageVersion(tx),
          this.#runtimeConfig(tx),
          tx.object(options.quoteCoin),
          tx.pure.u64(options.minMemeOut),
        ],
      });
  }

  #joinCall(
    options: LaunchTypes & { quoteCoin: TransactionObjectInput },
    launch: (tx: Transaction) => TransactionArgument,
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::join_opening_round`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          launch(tx),
          this.#packageVersion(tx),
          tx.object(options.quoteCoin),
          tx.object.clock(),
        ],
      });
    };
  }

  #initializerCall(
    functionName: string,
    options: LaunchInitializerInput,
    extra: (tx: Transaction) => TransactionArgument[],
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::${functionName}`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          options.initializer,
          this.#packageVersion(tx),
          ...extra(tx),
        ],
      });
    };
  }

  #setMemeMetadata(
    functionName: "set_name" | "set_description" | "set_icon_url",
    options: MemeMetadataUpdate,
    value: string,
  ) {
    const types = normalizeLaunchTypes(options);
    if (typeof value !== "string") {
      throw new TypeError(`${functionName} value must be a string`);
    }
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::${functionName}`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, options.launch.mutable),
          this.#packageVersion(tx),
          tx.object(options.blastMetadataCap),
          sharedObject(tx, "currency", options.currency, true),
          tx.pure.string(value),
        ],
      });
    };
  }

  #packageVersion(tx: Transaction): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.packageVersion, false);
  }

  #launchConfig(tx: Transaction, mutable = false): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.launchConfig, mutable);
  }

  #runtimeConfig(tx: Transaction, mutable = false): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.runtimeConfig, mutable);
  }
}

/** A 32-byte Ed25519 public key, as bytes or hex (with or without `0x`). */
export type ClaimSignerPublicKey = Uint8Array | string;

function claimSignerKey(value: ClaimSignerPublicKey): number[] {
  const bytes = typeof value === "string" ? fromHex(value) : value;
  if (bytes.length !== 32)
    throw new RangeError("signerPublicKey must contain 32 bytes");
  return Array.from(bytes);
}

/** Launchpad settings `configureNow` applies at a zero notice. */
export type LaunchpadSettings = {
  tradeFees?: { quoteFeeBps: bigint; memeFeeBps: bigint };
  protocolAllocation?: { memeBps: bigint; quoteBps: bigint };
  /** SUI, in MIST, each launch pays at creation. */
  creationFee?: bigint;
  protocolFeeShareBps?: bigint;
  treasury?: string;
};

/**
 * The notice `armNotices` gives each named value, in milliseconds. A
 * setting restates its applied value beside its new notice. Upgrade custody
 * is not here: `wrap` starts it at a 48-hour notice, which
 * `scheduleUpgradeDelay` changes only after that notice.
 */
export type LaunchpadNotices = {
  tradeFees?: { quoteFeeBps: bigint; memeFeeBps: bigint; delayMs: bigint };
  protocolAllocation?: { memeBps: bigint; quoteBps: bigint; delayMs: bigint };
  creationFee?: { creationFee: bigint; delayMs: bigint };
  protocolFeeShare?: { protocolFeeShareBps: bigint; delayMs: bigint };
  treasury?: { treasury: string; delayMs: bigint };
  /** The notice for each later migration witness admission. */
  migrationDelayMs?: bigint;
  /** The notice for each later account-claim signer admission. */
  claimSignerDelayMs?: bigint;
};

/** Admissions `configureNow` makes while their notices are zero. */
type ZeroNoticeAdmissions = {
  migrationWitnessTypes?: readonly string[];
  /** Keys that may sign account claims; both notices start at zero. */
  creatorClaimSigners?: readonly ClaimSignerPublicKey[];
};

export class LaunchpadTransactions {
  readonly call: LaunchpadCalls;
  readonly #useGasCoin: boolean;

  constructor(
    deployment: LaunchpadDeployment,
    options: CoinSourceOptions = {},
  ) {
    this.call = new LaunchpadCalls(deployment);
    this.#useGasCoin = options.useGasCoin ?? true;
  }

  /**
   * Publishes the generated Meme package and makes it immutable. Its
   * initializer transfers the `LaunchTicket` to the sender, who starts the
   * launch through a migration adapter (`MigratorTransactions.createCetusLaunch`
   * or `createBluefinLaunch`).
   */
  publishMeme(options: MemeTemplateOptions): Transaction {
    const tx = new Transaction();
    const upgradeCap = tx.add(async (innerTx) => {
      const module = await buildMemePackageBytecode(
        options,
        this.call.deployment.originalPackageId,
      );
      return innerTx.publish({
        modules: [Array.from(module)],
        dependencies: [
          MOVE_STDLIB_ADDRESS,
          SUI_FRAMEWORK_ADDRESS,
          this.call.deployment.admin.packageId,
          this.call.deployment.partnersPackageId,
          this.call.deployment.packageId,
        ],
      });
    });
    tx.moveCall({
      target: `${SUI_FRAMEWORK_ADDRESS}::package::make_immutable`,
      arguments: [upgradeCap],
    });
    return tx;
  }

  buy(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      quoteAmount: bigint;
      minMemeOut: bigint;
      recipient: string;
    } & CoinSourceOptions,
  ): Transaction {
    requirePositiveU64("quoteAmount", options.quoteAmount);
    const tx = new Transaction();
    const quoteCoin = tx.coin({
      type: normalizeStructTag(options.quoteType),
      balance: options.quoteAmount,
      useGasCoin: options.useGasCoin ?? this.#useGasCoin,
    });
    const buyResult = tx.add(this.call.buy({ ...options, quoteCoin }));
    tx.transferObjects(
      moveResults(buyResult, 2),
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  sell(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      memeAmount: bigint;
      minQuoteOut: bigint;
      recipient: string;
    },
  ): Transaction {
    requirePositiveU64("memeAmount", options.memeAmount);
    const tx = new Transaction();
    const memeCoin = tx.coin({
      type: normalizeStructTag(options.memeType),
      balance: options.memeAmount,
    });
    const quoteCoin = tx.add(this.call.sell({ ...options, memeCoin }));
    tx.transferObjects([quoteCoin], normalizeSuiAddress(options.recipient));
    return tx;
  }

  claimCreatorCaps(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      recipient: string;
      accountAttestation?: Uint8Array | null;
    },
  ): Transaction {
    const tx = new Transaction();
    const claimResult = tx.add(this.call.claimCreatorCaps(options));
    tx.transferObjects(
      moveResults(claimResult, 2),
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  claimCreatorFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      curveFeeCapId: string;
      recipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const claimResult = tx.add(
      this.call.claimCreatorFees({
        ...options,
        curveFeeCap: options.curveFeeCapId,
      }),
    );
    tx.transferObjects(
      moveResults(claimResult, 2),
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  setName(
    options: Omit<MemeMetadataUpdate, "blastMetadataCap"> & {
      blastMetadataCapId: string;
      name: string;
    },
  ): Transaction {
    const tx = new Transaction();
    tx.add(
      this.call.setName({
        ...options,
        blastMetadataCap: options.blastMetadataCapId,
      }),
    );
    return tx;
  }

  setDescription(
    options: Omit<MemeMetadataUpdate, "blastMetadataCap"> & {
      blastMetadataCapId: string;
      description: string;
    },
  ): Transaction {
    const tx = new Transaction();
    tx.add(
      this.call.setDescription({
        ...options,
        blastMetadataCap: options.blastMetadataCapId,
      }),
    );
    return tx;
  }

  setIconUrl(
    options: Omit<MemeMetadataUpdate, "blastMetadataCap"> & {
      blastMetadataCapId: string;
      iconUrl: string;
    },
  ): Transaction {
    const tx = new Transaction();
    tx.add(
      this.call.setIconUrl({
        ...options,
        blastMetadataCap: options.blastMetadataCapId,
      }),
    );
    return tx;
  }

  /**
   * Pays Blast's fees to the `RuntimeConfig` treasury; any sender may claim.
   * Pass the launch's `partner` when `LaunchState.partnerId` is set.
   */
  claimProtocolFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      partner?: SharedObjectReference<false> | null;
    },
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.claimProtocolFees(options));
    return tx;
  }

  /**
   * Shares a published Meme's `Currency<Meme>` through
   * `coin_registry::finalize_registration`, the step between publication and
   * launch creation. Anyone may run it; `readCurrencyRegistration` reads the
   * shared currency from its effects.
   */
  finalizeCurrencyRegistration(options: {
    memeType: string;
    currency: ObjectVersionReference;
  }): Transaction {
    const tx = new Transaction();
    tx.add(this.call.finalizeCurrencyRegistration(options));
    return tx;
  }

  /** Adds a bid of `quoteAmount` to the sender's opening-round bid. */
  joinOpeningRound(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      quoteAmount: bigint;
    } & CoinSourceOptions,
  ): Transaction {
    requirePositiveU64("quoteAmount", options.quoteAmount);
    const tx = new Transaction();
    const quoteCoin = tx.coin({
      type: normalizeStructTag(options.quoteType),
      balance: options.quoteAmount,
      useGasCoin: options.useGasCoin ?? this.#useGasCoin,
    });
    tx.add(this.call.joinOpeningRound({ ...options, quoteCoin }));
    return tx;
  }

  settleOpeningRound(
    options: LaunchTypes & { launch: SharedObjectReference<true> },
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.settleOpeningRound(options));
    return tx;
  }

  /** Delivers each bidder's share of a settled opening round in one PTB. */
  deliverOpeningRound(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      bidders: readonly string[];
    },
  ): Transaction {
    const tx = new Transaction();
    for (const bidder of options.bidders) {
      tx.add(this.call.deliverOpeningRound({ ...options, bidder }));
    }
    return tx;
  }

  setMemeDecimalsAllowed(options: {
    adminCapId: string;
    decimals: number;
    allowed: boolean;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "ListingAdmin", (adminWitness) =>
      this.call.setMemeDecimalsAllowed({ ...options, adminWitness }),
    );
  }

  setQuoteAllowed(options: {
    adminCapId: string;
    quoteType: string;
    allowed: boolean;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "ListingAdmin", (adminWitness) =>
      this.call.setQuoteAllowed({ ...options, adminWitness }),
    );
  }

  addPartner(options: {
    adminCapId: string;
    partner: SharedObjectReference<false>;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.addPartner({ ...options, adminWitness }),
    );
  }

  removePartner(options: {
    adminCapId: string;
    partner: SharedObjectReference<false>;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.removePartner({ ...options, adminWitness }),
    );
  }

  scheduleCreatorClaimSigner(options: {
    adminCapId: string;
    signerPublicKey: ClaimSignerPublicKey;
  }): Transaction {
    return this.#asAdmin(
      options.adminCapId,
      "ClaimSignerAdmin",
      (adminWitness) =>
        this.call.scheduleCreatorClaimSigner({ ...options, adminWitness }),
    );
  }

  applyCreatorClaimSigner(options: {
    signerPublicKey: ClaimSignerPublicKey;
  }): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyCreatorClaimSigner(options));
    return tx;
  }

  cancelCreatorClaimSigner(options: {
    adminCapId: string;
    signerPublicKey: ClaimSignerPublicKey;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelCreatorClaimSigner({ ...options, adminWitness }),
    );
  }

  scheduleCreatorClaimSignerDelay(options: {
    adminCapId: string;
    delayMs: bigint;
  }): Transaction {
    return this.#asAdmin(
      options.adminCapId,
      "ClaimSignerAdmin",
      (adminWitness) =>
        this.call.scheduleCreatorClaimSignerDelay({ ...options, adminWitness }),
    );
  }

  applyCreatorClaimSignerDelay(): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyCreatorClaimSignerDelay());
    return tx;
  }

  cancelCreatorClaimSignerDelay(options: { adminCapId: string }): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelCreatorClaimSignerDelay({ adminWitness }),
    );
  }

  /** Signs in as `role` and runs one administrator call in the same PTB. */
  applyCreationFee(): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyCreationFee());
    return tx;
  }
  applyMigrationDelay(): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyMigrationDelay());
    return tx;
  }
  applyMigrationWitness(
    options: Parameters<LaunchpadCalls["applyMigrationWitness"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyMigrationWitness(options));
    return tx;
  }
  applyProtocolAllocation(): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyProtocolAllocation());
    return tx;
  }
  applyTradeFees(): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyTradeFees());
    return tx;
  }
  cancelCreationFee(
    options: Omit<
      Parameters<LaunchpadCalls["cancelCreationFee"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelCreationFee({ ...options, adminWitness }),
    );
  }
  cancelMigrationDelay(
    options: Omit<
      Parameters<LaunchpadCalls["cancelMigrationDelay"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelMigrationDelay({ ...options, adminWitness }),
    );
  }
  cancelMigrationWitness(
    options: Omit<
      Parameters<LaunchpadCalls["cancelMigrationWitness"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelMigrationWitness({ ...options, adminWitness }),
    );
  }
  cancelProtocolAllocation(
    options: Omit<
      Parameters<LaunchpadCalls["cancelProtocolAllocation"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelProtocolAllocation({ ...options, adminWitness }),
    );
  }
  cancelTradeFees(
    options: Omit<
      Parameters<LaunchpadCalls["cancelTradeFees"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelTradeFees({ ...options, adminWitness }),
    );
  }
  removeMigrationWitness(
    options: Omit<
      Parameters<LaunchpadCalls["removeMigrationWitness"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "AdapterAdmin", (adminWitness) =>
      this.call.removeMigrationWitness({ ...options, adminWitness }),
    );
  }
  scheduleCreationFee(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleCreationFee"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.scheduleCreationFee({ ...options, adminWitness }),
    );
  }
  scheduleMigrationDelay(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleMigrationDelay"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "AdapterAdmin", (adminWitness) =>
      this.call.scheduleMigrationDelay({ ...options, adminWitness }),
    );
  }
  scheduleMigrationWitness(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleMigrationWitness"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "AdapterAdmin", (adminWitness) =>
      this.call.scheduleMigrationWitness({ ...options, adminWitness }),
    );
  }
  scheduleProtocolAllocation(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleProtocolAllocation"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "TreasuryAdmin", (adminWitness) =>
      this.call.scheduleProtocolAllocation({ ...options, adminWitness }),
    );
  }
  scheduleTradeFees(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleTradeFees"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.scheduleTradeFees({ ...options, adminWitness }),
    );
  }
  applyProtocolFeeShare(): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyProtocolFeeShare());
    return tx;
  }
  applyTreasury(): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyTreasury());
    return tx;
  }
  cancelProtocolFeeShare(
    options: Omit<
      Parameters<LaunchpadCalls["cancelProtocolFeeShare"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelProtocolFeeShare({ ...options, adminWitness }),
    );
  }
  cancelTreasury(
    options: Omit<
      Parameters<LaunchpadCalls["cancelTreasury"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelTreasury({ ...options, adminWitness }),
    );
  }
  revokeCreatorClaimSigner(
    options: Omit<
      Parameters<LaunchpadCalls["revokeCreatorClaimSigner"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(
      options.adminCapId,
      "ClaimSignerAdmin",
      (adminWitness) =>
        this.call.revokeCreatorClaimSigner({ ...options, adminWitness }),
    );
  }
  scheduleProtocolFeeShare(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleProtocolFeeShare"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.scheduleProtocolFeeShare({ ...options, adminWitness }),
    );
  }
  scheduleTreasury(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleTreasury"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "TreasuryAdmin", (adminWitness) =>
      this.call.scheduleTreasury({ ...options, adminWitness }),
    );
  }
  applyCurveFeeCapDelay(
    options: Parameters<LaunchpadCalls["applyCurveFeeCapDelay"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyCurveFeeCapDelay(options));
    return tx;
  }
  applyCurveFeeCapReassignment(
    options: Parameters<LaunchpadCalls["applyCurveFeeCapReassignment"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyCurveFeeCapReassignment(options));
    return tx;
  }
  applyMetadataCapDelay(
    options: Parameters<LaunchpadCalls["applyMetadataCapDelay"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyMetadataCapDelay(options));
    return tx;
  }
  applyMetadataCapReassignment(
    options: Parameters<LaunchpadCalls["applyMetadataCapReassignment"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyMetadataCapReassignment(options));
    return tx;
  }
  cancelCurveFeeCapReassignment(
    options: Omit<
      Parameters<LaunchpadCalls["cancelCurveFeeCapReassignment"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelCurveFeeCapReassignment({ ...options, adminWitness }),
    );
  }
  cancelMetadataCapReassignment(
    options: Omit<
      Parameters<LaunchpadCalls["cancelMetadataCapReassignment"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelMetadataCapReassignment({ ...options, adminWitness }),
    );
  }
  scheduleCurveFeeCapDelay(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleCurveFeeCapDelay"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CreatorAdmin", (adminWitness) =>
      this.call.scheduleCurveFeeCapDelay({ ...options, adminWitness }),
    );
  }
  scheduleCurveFeeCapReassignment(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleCurveFeeCapReassignment"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CreatorAdmin", (adminWitness) =>
      this.call.scheduleCurveFeeCapReassignment({ ...options, adminWitness }),
    );
  }
  scheduleMetadataCapDelay(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleMetadataCapDelay"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CreatorAdmin", (adminWitness) =>
      this.call.scheduleMetadataCapDelay({ ...options, adminWitness }),
    );
  }
  scheduleMetadataCapReassignment(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleMetadataCapReassignment"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CreatorAdmin", (adminWitness) =>
      this.call.scheduleMetadataCapReassignment({ ...options, adminWitness }),
    );
  }
  pause(
    options: Omit<Parameters<LaunchpadCalls["pause"]>[0], "adminWitness"> & {
      adminCapId: string;
    },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "PauseAdmin", (adminWitness) =>
      this.call.pause({ ...options, adminWitness }),
    );
  }
  unpause(
    options: Omit<Parameters<LaunchpadCalls["unpause"]>[0], "adminWitness"> & {
      adminCapId: string;
    },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "UnpauseAdmin", (adminWitness) =>
      this.call.unpause({ ...options, adminWitness }),
    );
  }
  applyUpgradeDelay(
    options: Parameters<LaunchpadCalls["applyUpgradeDelay"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.applyUpgradeDelay(options));
    return tx;
  }
  cancelUpgradeAction(
    options: Omit<
      Parameters<LaunchpadCalls["cancelUpgradeAction"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelUpgradeAction({ ...options, adminWitness }),
    );
  }
  makeImmutable(
    options: Omit<
      Parameters<LaunchpadCalls["makeImmutable"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "UpgradeAdmin", (adminWitness) =>
      this.call.makeImmutable({ ...options, adminWitness }),
    );
  }
  scheduleMakeImmutable(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleMakeImmutable"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "UpgradeAdmin", (adminWitness) =>
      this.call.scheduleMakeImmutable({ ...options, adminWitness }),
    );
  }
  scheduleUpgrade(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleUpgrade"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "UpgradeAdmin", (adminWitness) =>
      this.call.scheduleUpgrade({ ...options, adminWitness }),
    );
  }
  scheduleUpgradeDelay(
    options: Omit<
      Parameters<LaunchpadCalls["scheduleUpgradeDelay"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "UpgradeAdmin", (adminWitness) =>
      this.call.scheduleUpgradeDelay({ ...options, adminWitness }),
    );
  }

  /**
   * Applies launchpad settings at once on a fresh deployment whose notices
   * are still zero: each is a schedule and its apply in this PTB, keeping a
   * zero notice. Name only settings that change; an unchanged schedule aborts.
   * Then call `armNotices`. The cap needs each setting's role.
   */
  configureNow(
    options: { adminCapId: string } & LaunchpadSettings & ZeroNoticeAdmissions,
  ): Transaction {
    const delayMs = 0n;
    const { tradeFees, protocolAllocation, creationFee, treasury } = options;
    const { protocolFeeShareBps, migrationWitnessTypes } = options;
    const { creatorClaimSigners } = options;
    return this.#atZeroNotice(options.adminCapId, {
      ...(tradeFees ? { tradeFees: { ...tradeFees, delayMs } } : {}),
      ...(protocolAllocation
        ? { protocolAllocation: { ...protocolAllocation, delayMs } }
        : {}),
      ...(creationFee === undefined
        ? {}
        : { creationFee: { creationFee, delayMs } }),
      ...(protocolFeeShareBps === undefined
        ? {}
        : { protocolFeeShare: { protocolFeeShareBps, delayMs } }),
      ...(treasury === undefined ? {} : { treasury: { treasury, delayMs } }),
      ...(migrationWitnessTypes ? { migrationWitnessTypes } : {}),
      ...(creatorClaimSigners ? { creatorClaimSigners } : {}),
    });
  }

  /**
   * Raises each named notice from zero in one PTB: a schedule and its apply.
   * A setting restates its applied value, since its schedule proposes a value
   * and next notice together. Run after `configureNow`; once armed, every
   * later change waits its notice.
   */
  armNotices(options: { adminCapId: string } & LaunchpadNotices): Transaction {
    return this.#atZeroNotice(options.adminCapId, options);
  }

  #atZeroNotice(
    adminCapId: string,
    notices: LaunchpadNotices & ZeroNoticeAdmissions,
  ): Transaction {
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
    if (notices.tradeFees) {
      tx.add(
        call.scheduleTradeFees({
          ...notices.tradeFees,
          adminWitness: as("FeeAdmin"),
        }),
      );
      tx.add(call.applyTradeFees());
    }
    if (notices.protocolAllocation) {
      tx.add(
        call.scheduleProtocolAllocation({
          ...notices.protocolAllocation,
          adminWitness: as("TreasuryAdmin"),
        }),
      );
      tx.add(call.applyProtocolAllocation());
    }
    if (notices.creationFee) {
      tx.add(
        call.scheduleCreationFee({
          ...notices.creationFee,
          adminWitness: as("FeeAdmin"),
        }),
      );
      tx.add(call.applyCreationFee());
    }
    if (notices.protocolFeeShare) {
      tx.add(
        call.scheduleProtocolFeeShare({
          ...notices.protocolFeeShare,
          adminWitness: as("FeeAdmin"),
        }),
      );
      tx.add(call.applyProtocolFeeShare());
    }
    if (notices.treasury) {
      tx.add(
        call.scheduleTreasury({
          ...notices.treasury,
          adminWitness: as("TreasuryAdmin"),
        }),
      );
      tx.add(call.applyTreasury());
    }
    for (const migrationWitnessType of notices.migrationWitnessTypes ?? []) {
      tx.add(
        call.scheduleMigrationWitness({
          migrationWitnessType,
          adminWitness: as("AdapterAdmin"),
        }),
      );
      tx.add(call.applyMigrationWitness({ migrationWitnessType }));
    }
    if (notices.migrationDelayMs !== undefined) {
      tx.add(
        call.scheduleMigrationDelay({
          delayMs: notices.migrationDelayMs,
          adminWitness: as("AdapterAdmin"),
        }),
      );
      tx.add(call.applyMigrationDelay());
    }
    for (const signerPublicKey of notices.creatorClaimSigners ?? []) {
      tx.add(
        call.scheduleCreatorClaimSigner({
          signerPublicKey,
          adminWitness: as("ClaimSignerAdmin"),
        }),
      );
      tx.add(call.applyCreatorClaimSigner({ signerPublicKey }));
    }
    if (notices.claimSignerDelayMs !== undefined) {
      tx.add(
        call.scheduleCreatorClaimSignerDelay({
          delayMs: notices.claimSignerDelayMs,
          adminWitness: as("ClaimSignerAdmin"),
        }),
      );
      tx.add(call.applyCreatorClaimSignerDelay());
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
}

/**
 * Completes an adapter-started launch in `tx`: pays the exact SUI
 * `creationFee` and the optional purchase's Quote as `useGasCoin` directs,
 * applies the settings, finalizes, runs the optional purchase or opening-round
 * bid on the owned launch and routes its coins, then shares.
 */
export function addLaunchCompletion(
  tx: Transaction,
  calls: LaunchpadCalls,
  options: LaunchInitializerInput &
    LaunchSettings & {
      currency: SharedObjectReference<true>;
      /** `LaunchConfig.creation_fee`, in MIST (`LaunchpadClient.getLaunchConfig`). */
      creationFee: bigint;
      preShareBuy?: PreShareBuyInput;
    } & CoinSourceOptions,
): void {
  const { preShareBuy, useGasCoin = true, ...rest } = options;
  const settings = {
    ...rest,
    creationFee: tx.coin({
      type: "0x2::sui::SUI",
      balance: requireU64("creationFee", options.creationFee),
      useGasCoin,
    }),
  };
  if (!preShareBuy) {
    tx.add(calls.completeLaunch(settings));
    return;
  }
  requirePositiveU64("quoteAmount", preShareBuy.quoteAmount);
  const quoteCoin = tx.coin({
    type: normalizeStructTag(options.quoteType),
    balance: preShareBuy.quoteAmount,
    useGasCoin,
  });
  const bought = tx.add(
    calls.completeLaunch({
      ...settings,
      preShareBuy: { quoteCoin, minMemeOut: preShareBuy.minMemeOut },
    }),
  );
  if (bought) {
    tx.transferObjects(
      moveResults(bought, 2),
      normalizeSuiAddress(preShareBuy.recipient),
    );
  }
}

function normalizeDeployment(
  deployment: LaunchpadDeployment,
): LaunchpadDeployment {
  return {
    ...normalizeSuiPackageReference("launchpad", deployment),
    admin: normalizeAdminDeployment(deployment.admin),
    partnersPackageId: normalizeSuiObjectId(deployment.partnersPackageId),
    packageVersion: normalizeSharedObjectIdentity(
      "packageVersion",
      deployment.packageVersion,
    ),
    launchConfig: normalizeSharedObjectIdentity(
      "launchConfig",
      deployment.launchConfig,
    ),
    runtimeConfig: normalizeSharedObjectIdentity(
      "runtimeConfig",
      deployment.runtimeConfig,
    ),
  };
}

function requireOpeningRoundMs(value: bigint): void {
  if (
    value !== 0n &&
    (value < MIN_OPENING_ROUND_MS || value > MAX_OPENING_ROUND_MS)
  ) {
    throw new RangeError(
      "openingRoundMs must be zero or between 60,000 and 300,000",
    );
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

export function normalizeLaunchTypes(types: LaunchTypes): LaunchTypes {
  return {
    memeType: normalizeStructTag(types.memeType),
    quoteType: normalizeStructTag(types.quoteType),
  };
}

/** Flags may be ORed together; each package has its own migration bit. */
export const LAUNCHPAD_PAUSE_BITS = {
  Create: 1,
  Trading: 2,
  Migrate: 4,
} as const;
