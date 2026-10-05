import type {
  TransactionArgument,
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  MOVE_STDLIB_ADDRESS,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  SUI_FRAMEWORK_ADDRESS,
} from "@mysten/sui/utils";

import type { AdminDeployment } from "../admin/transactions.ts";
import { AdminCalls, normalizeAdminDeployment } from "../admin/transactions.ts";
import {
  requireBasisPoints,
  requirePositiveU64,
  requireU64,
} from "../lib/integers.ts";
import { deploymentObject, moveResults } from "../lib/ptb.ts";
import type {
  SharedObjectIdentity,
  SharedObjectReference,
} from "../lib/sui.ts";
import {
  normalizeSharedObjectIdentity,
  normalizeSharedObjectReference,
  normalizeSuiPackageReference,
} from "../lib/sui.ts";
import type { CreatorAllocationPlan, FeeSplit } from "./allocation.ts";
import { normalizeAllocationPlan, normalizeFeeSplit } from "./allocation.ts";
import type { MemeTemplateOptions } from "./template.ts";
import { buildMemePackageBytecode } from "./template.ts";

export type LaunchpadDeployment = {
  packageId: string;
  originalPackageId: string;
  /** `blast_admin`, a transitive Meme publish dependency, and its ACL. */
  admin: AdminDeployment;
  /** Published `blast_partners` package, a transitive Meme publish dependency. */
  partnersPackageId: string;
  /** Published immutable `blast_fun_timelock`, a transitive Meme publish dependency. */
  timelockPackageId: string;
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
        arguments: [options.launch, tx.object.clock()],
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
          ...(partner
            ? [sharedObject(tx, "partner", partner, false), tx.object.clock()]
            : []),
        ],
      });
    };
  }

  /** `launch_config::set_protocol_allocation` (`TreasuryAdmin`): Blast's share of future launches. */
  setProtocolAllocation(options: {
    adminWitness: TransactionObjectInput;
    memeBps: bigint;
    quoteBps: bigint;
  }) {
    const meme = this.bps(options.memeBps);
    const quote = this.bps(options.quoteBps);
    return this.#configCall(
      "launch_config::set_protocol_allocation",
      options,
      (tx) => [tx.add(meme), tx.add(quote)],
    );
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

  /** `launch_config::set_trade_fees` (`FeeAdmin`): the fees later launches snapshot. */
  setTradeFees(options: {
    adminWitness: TransactionObjectInput;
    quoteFeeBps: bigint;
    memeFeeBps: bigint;
  }) {
    const quote = this.bps(options.quoteFeeBps);
    const meme = this.bps(options.memeFeeBps);
    return this.#configCall("launch_config::set_trade_fees", options, (tx) => [
      tx.add(quote),
      tx.add(meme),
    ]);
  }

  /** `launch_config::set_creation_fee` (`FeeAdmin`), in MIST. */
  setCreationFee(options: {
    adminWitness: TransactionObjectInput;
    creationFee: bigint;
  }) {
    const creationFee = requireU64("creationFee", options.creationFee);
    return this.#configCall(
      "launch_config::set_creation_fee",
      options,
      (tx) => [tx.pure.u64(creationFee)],
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
   * `launch_config::set_migration_witness_allowed<W>` (`AdapterAdmin`); see
   * `MigratorCalls.migrationWitnessType`.
   */
  setMigrationWitnessAllowed(options: {
    adminWitness: TransactionObjectInput;
    migrationWitnessType: string;
    allowed: boolean;
  }) {
    return this.#configCall(
      "launch_config::set_migration_witness_allowed",
      options,
      (tx) => [tx.pure.bool(options.allowed)],
      [normalizeStructTag(options.migrationWitnessType)],
    );
  }

  /**
   * `runtime_config::set_creator_claim_signer` (`ClaimSignerAdmin`): the
   * Ed25519 key that signs account claims; empty revokes it.
   */
  setCreatorClaimSigner(options: {
    adminWitness: TransactionObjectInput;
    signerPublicKey: Uint8Array;
  }) {
    return this.#configCall(
      "runtime_config::set_creator_claim_signer",
      options,
      (tx) => [tx.pure.vector("u8", Array.from(options.signerPublicKey))],
    );
  }

  /** `runtime_config::set_protocol_fee_share` (`FeeAdmin`): Blast's share of every curve fee. */
  setProtocolFeeShare(options: {
    adminWitness: TransactionObjectInput;
    protocolFeeShareBps: bigint;
  }) {
    const share = this.bps(options.protocolFeeShareBps);
    return this.#configCall(
      "runtime_config::set_protocol_fee_share",
      options,
      (tx) => [tx.add(share)],
    );
  }

  /**
   * `runtime_config::set_treasury` (`TreasuryAdmin`): where every later
   * protocol fee claim pays Blast.
   */
  setTreasury(options: {
    adminWitness: TransactionObjectInput;
    treasury: string;
  }) {
    const treasury = normalizeSuiAddress(options.treasury);
    return this.#configCall("runtime_config::set_treasury", options, (tx) => [
      tx.pure.address(treasury),
    ]);
  }

  /**
   * `launch::reassign_curve_fee_cap` (`CreatorAdmin`): retires the pending
   * claim or live cap and sends a fresh `CurveFeeCap` to `recipient`.
   */
  reassignCurveFeeCap(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
      recipient: string;
    },
  ) {
    return this.#reassign("reassign_curve_fee_cap", options);
  }

  /** `launch::reassign_metadata_cap` (`CreatorAdmin`), for the `BlastMetadataCap`. */
  reassignMetadataCap(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
      recipient: string;
    },
  ) {
    return this.#reassign("reassign_metadata_cap", options);
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

  #reassign(
    functionName: "reassign_curve_fee_cap" | "reassign_metadata_cap",
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
      recipient: string;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const recipient = normalizeSuiAddress(options.recipient);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::${functionName}`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          tx.object(options.adminWitness),
          tx.pure.address(recipient),
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
        arguments: [options.initializer, ...extra(tx)],
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

export class LaunchpadTransactions {
  readonly call: LaunchpadCalls;

  constructor(deployment: LaunchpadDeployment) {
    this.call = new LaunchpadCalls(deployment);
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
          this.call.deployment.timelockPackageId,
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
    },
  ): Transaction {
    requirePositiveU64("quoteAmount", options.quoteAmount);
    const tx = new Transaction();
    const quoteCoin = tx.coin({
      type: normalizeStructTag(options.quoteType),
      balance: options.quoteAmount,
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

  /** Adds a bid of `quoteAmount` to the sender's opening-round bid. */
  joinOpeningRound(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      quoteAmount: bigint;
    },
  ): Transaction {
    requirePositiveU64("quoteAmount", options.quoteAmount);
    const tx = new Transaction();
    const quoteCoin = tx.coin({
      type: normalizeStructTag(options.quoteType),
      balance: options.quoteAmount,
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

  setProtocolAllocation(options: {
    adminCapId: string;
    memeBps: bigint;
    quoteBps: bigint;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "TreasuryAdmin", (adminWitness) =>
      this.call.setProtocolAllocation({ ...options, adminWitness }),
    );
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

  setTradeFees(options: {
    adminCapId: string;
    quoteFeeBps: bigint;
    memeFeeBps: bigint;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.setTradeFees({ ...options, adminWitness }),
    );
  }

  setCreationFee(options: {
    adminCapId: string;
    creationFee: bigint;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.setCreationFee({ ...options, adminWitness }),
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

  setMigrationWitnessAllowed(options: {
    adminCapId: string;
    migrationWitnessType: string;
    allowed: boolean;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "AdapterAdmin", (adminWitness) =>
      this.call.setMigrationWitnessAllowed({ ...options, adminWitness }),
    );
  }

  setCreatorClaimSigner(options: {
    adminCapId: string;
    signerPublicKey: Uint8Array;
  }): Transaction {
    return this.#asAdmin(
      options.adminCapId,
      "ClaimSignerAdmin",
      (adminWitness) =>
        this.call.setCreatorClaimSigner({ ...options, adminWitness }),
    );
  }

  setProtocolFeeShare(options: {
    adminCapId: string;
    protocolFeeShareBps: bigint;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.setProtocolFeeShare({ ...options, adminWitness }),
    );
  }

  setTreasury(options: { adminCapId: string; treasury: string }): Transaction {
    return this.#asAdmin(options.adminCapId, "TreasuryAdmin", (adminWitness) =>
      this.call.setTreasury({ ...options, adminWitness }),
    );
  }

  reassignCurveFeeCap(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminCapId: string;
      recipient: string;
    },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CreatorAdmin", (adminWitness) =>
      this.call.reassignCurveFeeCap({ ...options, adminWitness }),
    );
  }

  reassignMetadataCap(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminCapId: string;
      recipient: string;
    },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "CreatorAdmin", (adminWitness) =>
      this.call.reassignMetadataCap({ ...options, adminWitness }),
    );
  }

  /** Signs in as `role` and runs one administrator call in the same PTB. */
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
 * `creationFee` from gas, applies the settings, finalizes, runs the optional
 * purchase or opening-round bid on the owned launch and routes its coins, then
 * shares.
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
    },
): void {
  const { preShareBuy, ...rest } = options;
  const settings = {
    ...rest,
    creationFee: tx.coin({
      type: "0x2::sui::SUI",
      balance: requireU64("creationFee", options.creationFee),
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
    timelockPackageId: normalizeSuiObjectId(deployment.timelockPackageId),
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
