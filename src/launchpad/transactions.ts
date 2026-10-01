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
  SUI_TYPE_ARG,
} from "@mysten/sui/utils";

import {
  requireBasisPoints,
  requirePositiveU64,
  requireU64,
} from "../lib/integers.ts";
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
  /** Published `blast_admin` package: it owns `blast_acl::sign_in`. */
  adminPackageId: string;
  /** Published `blast_partners` package, a launchpad dependency. */
  partnersPackageId: string;
  /** Published `blast_fun_timelock` package, a dependency of `blast_admin` and `blast_partners`. */
  timelockPackageId: string;
  packageVersion: SharedObjectReference<false>;
  launchConfig: SharedObjectReference<false>;
  runtimeConfig: SharedObjectReference<false>;
  /** The shared singleton `blast_admin::blast_acl::ACL`. */
  acl: SharedObjectReference<false>;
};

/**
 * `blast_fun_domain` administrator roles. `blast_acl::sign_in<Role>` returns
 * the `AdminWitness<Role>` the one function family naming that role accepts;
 * the migrators package uses these roles too.
 */
export type LaunchpadAdminRole =
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

/**
 * The creator's launch settings, applied to a `LaunchInitializer` before
 * `launch::finalize` checks every invariant.
 */
export type LaunchSettings = {
  /** Virtual Quote reserve the curve starts from, in Quote atomic units. */
  virtualQuote: bigint;
  graduationTarget: bigint;
  allocationPlan: CreatorAllocationPlan;
  lpFeeSplit: FeeSplit;
  /** Opening-round length after share; zero or omitted has none. */
  openingRoundMs?: bigint;
  /** The immutable shared `blast_partners::Partner` the launch names for good. */
  partner?: SharedObjectReference<false>;
};

/**
 * One owned curve purchase made before the launch is shared. Only a launch
 * without an opening round trades before share.
 */
export type PreShareBuyInput = {
  quoteAmount: bigint;
  minMemeOut: bigint;
  recipient: string;
};

/**
 * Everything `addLaunchCompletion` applies after the adapter starts a launch.
 * `creationFee` is the exact `LaunchConfig` creation fee in MIST
 * (`getLaunchConfig`), paid from gas; `openingRoundBid` is the creator's
 * opening-round bid, joined before share.
 */
export type LaunchCompletionInput = LaunchSettings & {
  creationFee: bigint;
  preShareBuy?: PreShareBuyInput;
  openingRoundBid?: { quoteAmount: bigint };
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
type AsAdmin<Options> = Omit<Options, "adminWitness"> & { adminCapId: string };
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
    options: LaunchInitializerInput & {
      allocationPlan: CreatorAllocationPlan;
    },
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

  setOpeningRound(
    options: LaunchInitializerInput & { openingRoundMs: bigint },
  ) {
    requireU64("openingRoundMs", options.openingRoundMs);
    return this.#initializerCall("set_opening_round", options, (tx) => [
      tx.pure.u64(options.openingRoundMs),
    ]);
  }

  /** Names a partner the `LaunchConfig` accepts now; it is the launch's for good. */
  setPartner(
    options: LaunchInitializerInput & { partner: SharedObjectReference<false> },
  ) {
    return this.#initializerCall("set_partner", options, (tx) => [
      this.#launchConfig(tx),
      sharedObject(tx, "partner", options.partner, false),
      tx.object.clock(),
    ]);
  }

  /**
   * Consumes the initializer, checks every setting, and returns the owned
   * launch. `creationFee` is a `Coin<SUI>` of exactly the configured fee.
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

  /** Shares the finalized launch; trading, or the opening round, starts now. */
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
   * it, runs the creator's optional purchase or opening-round bid on the owned
   * launch, and shares the launch. Returns that purchase's
   * `(Coin<Meme>, Coin<Quote>)` result, if any. The purchase may reach the
   * graduation target, which makes the launch migration-ready before it is
   * shared.
   */
  completeLaunch(
    options: LaunchInitializerInput &
      LaunchSettings & {
        currency: SharedObjectReference<true>;
        creationFee: TransactionObjectInput;
        preShareBuy?: { quoteCoin: TransactionObjectInput; minMemeOut: bigint };
        openingRoundBid?: { quoteCoin: TransactionObjectInput };
      },
  ) {
    const openingRoundMs = options.openingRoundMs ?? 0n;
    if (openingRoundMs > 0n ? options.preShareBuy : options.openingRoundBid) {
      throw new TypeError(
        "a pre-share purchase needs no opening round; a bid needs one",
      );
    }
    const settings = [
      this.setVirtualQuote(options),
      this.setGraduationTarget(options),
      this.setAllocationPlan(options),
      this.setLpFeeSplit(options),
      ...(openingRoundMs > 0n
        ? [this.setOpeningRound({ ...options, openingRoundMs })]
        : []),
      ...(options.partner
        ? [this.setPartner({ ...options, partner: options.partner })]
        : []),
    ];
    return (tx: Transaction): TransactionResult | undefined => {
      for (const setting of settings) tx.add(setting);
      const launch = tx.add(this.finalizeLaunch(options));
      if (options.openingRoundBid) {
        tx.add(
          this.#joinCall(
            { ...options, ...options.openingRoundBid },
            () => launch,
          ),
        );
      }
      const bought = options.preShareBuy
        ? tx.add(
            this.#buyCall({ ...options, ...options.preShareBuy }, () => launch),
          )
        : undefined;
      tx.add(this.shareLaunch({ ...options, launch }));
      return bought;
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

  /** Adds `quoteCoin` to the sender's bid until the opening round ends. */
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

  /** Buys once with the ended round's whole pot; anyone may settle. */
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
   * Sends `bidder` its pro-rata share of the settled round; the contract
   * transfers to the bidder, never the caller.
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

  /** `blast_acl::sign_in<Role>`: this PTB's `AdminWitness<Role>` for one launchpad role. */
  signIn(
    role: LaunchpadAdminRole,
    options: { adminCap: TransactionObjectInput },
  ) {
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.adminPackageId}::blast_acl::sign_in`,
        typeArguments: [
          `${this.deployment.originalPackageId}::blast_fun_domain::${role}`,
        ],
        arguments: [
          sharedObject(tx, "acl", this.deployment.acl, false),
          tx.object(options.adminCap),
        ],
      });
  }

  /**
   * Claims Blast's Meme, Quote, and SUI fees from a launch that names no
   * partner, with a `TreasuryAdmin` witness.
   */
  claimProtocolFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::claim_protocol_fees`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          tx.object(options.adminWitness),
        ],
      });
  }

  /**
   * Claims Blast's fees from a launch naming `partner` (its `partnerId`),
   * paying the partner its share of each in the same call; returns the rest.
   */
  claimProtocolFeesWithPartner(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
      partner: SharedObjectReference<false>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::claim_protocol_fees_with_partner`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          tx.object(options.adminWitness),
          sharedObject(tx, "partner", options.partner, false),
          tx.object.clock(),
        ],
      });
  }

  /** `TreasuryAdmin`: Blast's one-time shares future launches snapshot. */
  setProtocolAllocation(options: {
    adminWitness: TransactionArgument;
    memeBps: bigint;
    quoteBps: bigint;
  }) {
    const meme = this.bps(options.memeBps);
    const quote = this.bps(options.quoteBps);
    return this.#configCall("set_protocol_allocation", options, (tx) => [
      tx.add(meme),
      tx.add(quote),
    ]);
  }

  /** `ListingAdmin`: admits or removes a Meme precision for new launches. */
  setMemeDecimalsAllowed(options: {
    adminWitness: TransactionArgument;
    decimals: number;
    allowed: boolean;
  }) {
    return this.#configCall("set_meme_decimals_allowed", options, (tx) => [
      tx.pure.u8(options.decimals),
      tx.pure.bool(options.allowed),
    ]);
  }

  /** `ListingAdmin`: admits or removes `quoteType` for new launches. */
  setQuoteAllowed(options: {
    adminWitness: TransactionArgument;
    quoteType: string;
    allowed: boolean;
  }) {
    return this.#configCall(
      "set_quote_allowed",
      options,
      (tx) => [tx.pure.bool(options.allowed)],
      normalizeStructTag(options.quoteType),
    );
  }

  /** `FeeAdmin`: the trade fees launches created afterward snapshot. */
  setTradeFees(options: {
    adminWitness: TransactionArgument;
    quoteFeeBps: bigint;
    memeFeeBps: bigint;
  }) {
    const quote = this.bps(options.quoteFeeBps);
    const meme = this.bps(options.memeFeeBps);
    return this.#configCall("set_trade_fees", options, (tx) => [
      tx.add(quote),
      tx.add(meme),
    ]);
  }

  /** `FeeAdmin`: the SUI, in MIST, every launch created afterward pays. */
  setCreationFee(options: {
    adminWitness: TransactionArgument;
    creationFee: bigint;
  }) {
    requireU64("creationFee", options.creationFee);
    return this.#configCall("set_creation_fee", options, (tx) => [
      tx.pure.u64(options.creationFee),
    ]);
  }

  /** `FeeAdmin`: lets new launches name `partner` at once. */
  addPartner(options: {
    adminWitness: TransactionArgument;
    partner: SharedObjectReference<false>;
  }) {
    return this.#configCall("add_partner", options, (tx) => [
      sharedObject(tx, "partner", options.partner, false),
    ]);
  }

  /** `FeeAdmin`: stops new launches naming `partner` after the partners notice delay. */
  removePartner(options: {
    adminWitness: TransactionArgument;
    partner: SharedObjectReference<false>;
  }) {
    return this.#configCall("remove_partner", options, (tx) => [
      sharedObject(tx, "partner", options.partner, false),
      tx.object.clock(),
    ]);
  }

  /** `AdapterAdmin`: admits or removes a migration adapter's witness type. */
  setMigrationWitnessAllowed(options: {
    adminWitness: TransactionArgument;
    migrationWitnessType: string;
    allowed: boolean;
  }) {
    return this.#configCall(
      "set_migration_witness_allowed",
      options,
      (tx) => [tx.pure.bool(options.allowed)],
      normalizeStructTag(options.migrationWitnessType),
    );
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

  /** One mutable-`LaunchConfig` administrator call, in Move argument order. */
  #configCall(
    functionName: string,
    options: { adminWitness: TransactionArgument },
    extra: (tx: Transaction) => TransactionArgument[],
    typeArgument?: string,
  ) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch_config::${functionName}`,
        typeArguments: typeArgument ? [typeArgument] : [],
        arguments: [
          sharedObject(
            tx,
            "launchConfig",
            { ...this.deployment.launchConfig, mutable: true },
            true,
          ),
          this.#packageVersion(tx),
          options.adminWitness,
          ...extra(tx),
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

  #launchConfig(tx: Transaction): TransactionObjectArgument {
    return sharedObject(
      tx,
      "launchConfig",
      this.deployment.launchConfig,
      false,
    );
  }

  #packageVersion(tx: Transaction): TransactionObjectArgument {
    return sharedObject(
      tx,
      "packageVersion",
      this.deployment.packageVersion,
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
      [buyResult[0]!, buyResult[1]!],
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  /** Joins the opening round with an exact-balance Quote coin. */
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

  /** Delivers each bidder's share of the settled round in one PTB. */
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
      [claimResult[0]!, claimResult[1]!],
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
      [claimResult[0]!, claimResult[1]!],
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
   * Signs in as `TreasuryAdmin`, claims Blast's fees, and routes the Meme,
   * Quote, and SUI coins. Pass the launch's `partner` when it names one.
   */
  claimProtocolFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminCapId: string;
      partner?: SharedObjectReference<false>;
      recipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn("TreasuryAdmin", { adminCap: options.adminCapId }),
    );
    const claimResult = tx.add(
      options.partner
        ? this.call.claimProtocolFeesWithPartner({
            ...options,
            adminWitness,
            partner: options.partner,
          })
        : this.call.claimProtocolFees({ ...options, adminWitness }),
    );
    tx.transferObjects(
      [claimResult[0]!, claimResult[1]!, claimResult[2]!],
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  setProtocolAllocation(
    options: AsAdmin<Parameters<LaunchpadCalls["setProtocolAllocation"]>[0]>,
  ): Transaction {
    return this.#asAdmin("TreasuryAdmin", options, (adminWitness) =>
      this.call.setProtocolAllocation({ ...options, adminWitness }),
    );
  }

  setMemeDecimalsAllowed(
    options: AsAdmin<Parameters<LaunchpadCalls["setMemeDecimalsAllowed"]>[0]>,
  ): Transaction {
    return this.#asAdmin("ListingAdmin", options, (adminWitness) =>
      this.call.setMemeDecimalsAllowed({ ...options, adminWitness }),
    );
  }

  setQuoteAllowed(
    options: AsAdmin<Parameters<LaunchpadCalls["setQuoteAllowed"]>[0]>,
  ): Transaction {
    return this.#asAdmin("ListingAdmin", options, (adminWitness) =>
      this.call.setQuoteAllowed({ ...options, adminWitness }),
    );
  }

  setTradeFees(
    options: AsAdmin<Parameters<LaunchpadCalls["setTradeFees"]>[0]>,
  ): Transaction {
    return this.#asAdmin("FeeAdmin", options, (adminWitness) =>
      this.call.setTradeFees({ ...options, adminWitness }),
    );
  }

  setCreationFee(
    options: AsAdmin<Parameters<LaunchpadCalls["setCreationFee"]>[0]>,
  ): Transaction {
    return this.#asAdmin("FeeAdmin", options, (adminWitness) =>
      this.call.setCreationFee({ ...options, adminWitness }),
    );
  }

  addPartner(
    options: AsAdmin<Parameters<LaunchpadCalls["addPartner"]>[0]>,
  ): Transaction {
    return this.#asAdmin("FeeAdmin", options, (adminWitness) =>
      this.call.addPartner({ ...options, adminWitness }),
    );
  }

  removePartner(
    options: AsAdmin<Parameters<LaunchpadCalls["removePartner"]>[0]>,
  ): Transaction {
    return this.#asAdmin("FeeAdmin", options, (adminWitness) =>
      this.call.removePartner({ ...options, adminWitness }),
    );
  }

  setMigrationWitnessAllowed(
    options: AsAdmin<
      Parameters<LaunchpadCalls["setMigrationWitnessAllowed"]>[0]
    >,
  ): Transaction {
    return this.#asAdmin("AdapterAdmin", options, (adminWitness) =>
      this.call.setMigrationWitnessAllowed({ ...options, adminWitness }),
    );
  }

  #asAdmin(
    role: LaunchpadAdminRole,
    options: { adminCapId: string },
    call: (
      adminWitness: TransactionObjectArgument,
    ) => (tx: Transaction) => void,
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn(role, { adminCap: options.adminCapId }),
    );
    tx.add(call(adminWitness));
    return tx;
  }
}

/**
 * Completes an adapter-started launch in `tx`: applies the settings, pays the
 * exact creation fee from gas, finalizes, runs the creator's optional purchase
 * (routing its coins) or opening-round bid on the owned launch, then shares.
 */
export function addLaunchCompletion(
  tx: Transaction,
  calls: LaunchpadCalls,
  options: LaunchInitializerInput &
    LaunchCompletionInput & { currency: SharedObjectReference<true> },
): void {
  const { preShareBuy, openingRoundBid, ...settings } = options;
  requireU64("creationFee", options.creationFee);
  const quoteCoin = (quoteAmount: bigint) => {
    requirePositiveU64("quoteAmount", quoteAmount);
    return tx.coin({
      type: normalizeStructTag(options.quoteType),
      balance: quoteAmount,
    });
  };
  const bought = tx.add(
    calls.completeLaunch({
      ...settings,
      creationFee: tx.coin({
        type: SUI_TYPE_ARG,
        balance: options.creationFee,
      }),
      ...(preShareBuy && {
        preShareBuy: {
          quoteCoin: quoteCoin(preShareBuy.quoteAmount),
          minMemeOut: preShareBuy.minMemeOut,
        },
      }),
      ...(openingRoundBid && {
        openingRoundBid: { quoteCoin: quoteCoin(openingRoundBid.quoteAmount) },
      }),
    }),
  );
  if (bought && preShareBuy) {
    tx.transferObjects(
      [bought[0]!, bought[1]!],
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
