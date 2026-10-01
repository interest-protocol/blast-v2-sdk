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

import {
  requireBasisPoints,
  requirePositiveU64,
  requireU64,
} from "../lib/integers.ts";
import { moveResults } from "../lib/ptb.ts";
import type { SharedObjectReference } from "../lib/sui.ts";
import { normalizeSharedObjectReference } from "../lib/sui.ts";
import type { CreatorAllocationPlan, FeeSplit } from "./allocation.ts";
import { normalizeAllocationPlan, normalizeFeeSplit } from "./allocation.ts";
import type { MemeTemplateOptions } from "./template.ts";
import { buildMemePackageBytecode } from "./template.ts";

export type { SharedObjectReference } from "../lib/sui.ts";

export type LaunchpadDeployment = {
  packageId: string;
  originalPackageId?: string;
  /**
   * Published `blast_admin` package: it owns `blast_acl::sign_in`, and every
   * generated Meme package lists it as a transitive publish dependency.
   */
  adminPackageId: string;
  /** Published `blast_partners` package, a transitive Meme publish dependency. */
  partnersPackageId: string;
  /** Published immutable `blast_fun_timelock`, a transitive Meme publish dependency. */
  timelockPackageId: string;
  packageVersion: SharedObjectReference<false>;
  launchConfig: SharedObjectReference<false>;
  runtimeConfig: SharedObjectReference<false>;
  /** The singleton `blast_admin::blast_acl::ACL` every Blast package signs in to. */
  acl: SharedObjectReference<false>;
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

type NormalizedDeployment = Required<LaunchpadDeployment>;
export type LaunchInitializerInput = LaunchTypes & {
  initializer: TransactionArgument;
};

export class LaunchpadCalls {
  readonly deployment: NormalizedDeployment;

  constructor(deployment: LaunchpadDeployment) {
    this.deployment = normalizeDeployment(deployment);
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

  /**
   * Signs in to `blast_admin::blast_acl` and returns this PTB's
   * `AdminWitness<Role>`; the `AdminCap` must hold `role`.
   */
  signIn(options: {
    adminCap: TransactionObjectInput;
    role: BlastFunAdminRole;
  }) {
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.adminPackageId}::blast_acl::sign_in`,
        typeArguments: [
          `${this.deployment.originalPackageId}::blast_fun_domain::${options.role}`,
        ],
        arguments: [
          sharedObject(tx, "acl", this.deployment.acl, false),
          tx.object(options.adminCap),
        ],
      });
  }

  /**
   * Claims Blast's Meme, Quote, and SUI fees under a `TreasuryAdmin` witness.
   * A launch that names a partner needs that `partner`
   * (`claim_protocol_fees_with_partner`), which is paid its share in the call.
   */
  claimProtocolFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
      partner?: SharedObjectReference<false> | null;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const { partner } = options;
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::${partner ? "claim_protocol_fees_with_partner" : "claim_protocol_fees"}`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          tx.object(options.adminWitness),
          ...(partner
            ? [sharedObject(tx, "partner", partner, false), tx.object.clock()]
            : []),
        ],
      });
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
    return sharedObject(
      tx,
      "packageVersion",
      this.deployment.packageVersion,
      false,
    );
  }

  #launchConfig(tx: Transaction): TransactionObjectArgument {
    return sharedObject(
      tx,
      "launchConfig",
      this.deployment.launchConfig,
      false,
    );
  }

  #runtimeConfig(tx: Transaction): TransactionObjectArgument {
    return sharedObject(
      tx,
      "runtimeConfig",
      this.deployment.runtimeConfig,
      false,
    );
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
          this.call.deployment.adminPackageId,
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

  /** Pass the launch's `partner` when `LaunchState.partnerId` is set. */
  claimProtocolFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminCapId: string;
      recipient: string;
      partner?: SharedObjectReference<false> | null;
    },
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn({ adminCap: options.adminCapId, role: "TreasuryAdmin" }),
    );
    const claimResult = tx.add(
      this.call.claimProtocolFees({ ...options, adminWitness }),
    );
    tx.transferObjects(
      moveResults(claimResult, 3),
      normalizeSuiAddress(options.recipient),
    );
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
): NormalizedDeployment {
  const packageId = normalizeSuiObjectId(deployment.packageId);
  return {
    packageId,
    originalPackageId: normalizeSuiObjectId(
      deployment.originalPackageId ?? packageId,
    ),
    adminPackageId: normalizeSuiObjectId(deployment.adminPackageId),
    partnersPackageId: normalizeSuiObjectId(deployment.partnersPackageId),
    timelockPackageId: normalizeSuiObjectId(deployment.timelockPackageId),
    packageVersion: normalizeSharedObjectReference(
      "packageVersion",
      deployment.packageVersion,
      false,
    ),
    launchConfig: normalizeSharedObjectReference(
      "launchConfig",
      deployment.launchConfig,
      false,
    ),
    runtimeConfig: normalizeSharedObjectReference(
      "runtimeConfig",
      deployment.runtimeConfig,
      false,
    ),
    acl: normalizeSharedObjectReference("acl", deployment.acl, false),
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
