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
import type { SharedObjectReference } from "../lib/sui.ts";
import { normalizeSharedObjectReference } from "../lib/sui.ts";
import type { CreatorAllocationPlan, FeeSplit } from "./allocation.ts";
import { normalizeAllocationPlan, normalizeFeeSplit } from "./allocation.ts";
import type { ObjectVersionReference } from "./effects.ts";
import { COIN_REGISTRY_ID } from "./effects.ts";
import type { MemeTemplateOptions } from "./template.ts";
import { buildMemePackageBytecode } from "./template.ts";

export type { SharedObjectReference } from "../lib/sui.ts";

const SUI_TYPE = "0x2::sui::SUI";

export type LaunchpadDeployment = {
  packageId: string;
  originalPackageId?: string;
  /**
   * Published `blast_admin` package: it owns `blast_acl::sign_in`, and every
   * generated Meme package lists it as a transitive publish dependency.
   */
  adminPackageId: string;
  /** Published immutable `blast_partners` package, a launchpad dependency. */
  partnersPackageId: string;
  /** Published `blast_fun_timelock` package, a dependency of admin and partners. */
  timelockPackageId: string;
  packageVersion: SharedObjectReference<false>;
  launchConfig: SharedObjectReference<false>;
  runtimeConfig: SharedObjectReference<false>;
  /** The singleton `blast_admin::blast_acl::ACL` every administrator signs in through. */
  acl: SharedObjectReference<false>;
};

/**
 * The typed roles `blast_fun::blast_fun_domain` declares. Each administrator
 * action takes exactly one; the migrators package reuses them.
 */
export const LAUNCHPAD_ADMIN_ROLES = [
  "UpgradeAdmin",
  "CreatorAdmin",
  "BuybackAdmin",
  "TreasuryAdmin",
  "FeeAdmin",
  "ListingAdmin",
  "AdapterAdmin",
  "ClaimSignerAdmin",
  "RewardsAdmin",
] as const;

export type LaunchpadAdminRole = (typeof LAUNCHPAD_ADMIN_ROLES)[number];

export type LaunchTypes = {
  memeType: string;
  quoteType: string;
};

/**
 * The creator's launch settings, applied to a `LaunchInitializer` before
 * `launch::finalize` checks every invariant.
 */
export type LaunchSettings = {
  /** The virtual Quote reserve the curve starts from; positive. */
  virtualQuote: bigint;
  graduationTarget: bigint;
  allocationPlan: CreatorAllocationPlan;
  lpFeeSplit: FeeSplit;
  /** Opening-round length after share; zero or omitted opens trading at share. */
  openingRoundMs?: bigint;
  /** The Blast partner the launch names for good; omitted names none. */
  partner?: SharedObjectReference<false>;
  /**
   * The exact `LaunchConfig.creation_fee` in MIST. When no coin is supplied,
   * the builder draws exactly this amount of SUI with a coin intent.
   */
  creationFee: bigint;
};

/** One owned curve purchase made before the launch is shared, without an opening round. */
export type PreShareBuyInput = {
  quoteAmount: bigint;
  minMemeOut: bigint;
  recipient: string;
};

/** The creator's own opening-round bid, joined before the launch is shared. */
export type CreatorBidInput = { quoteAmount: bigint };

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
type LaunchRef = SharedObjectReference<true>;
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

  /** Sets the opening round's length after share; zero, the default, has none. */
  setOpeningRound(
    options: LaunchInitializerInput & { openingRoundMs: bigint },
  ) {
    requireU64("openingRoundMs", options.openingRoundMs);
    return this.#initializerCall("set_opening_round", options, (tx) => [
      tx.pure.u64(options.openingRoundMs),
    ]);
  }

  /** Names the launch's Blast partner for good; `LaunchConfig` must accept it now. */
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
   * Consumes the initializer with the exact creation fee and returns the owned
   * launch. `launch::finalize` takes no package version: `new` checked it.
   */
  finalizeLaunch(
    options: LaunchInitializerInput & {
      currency: SharedObjectReference<true>;
      creationFeeCoin: TransactionObjectInput;
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
          tx.object(options.creationFeeCoin),
        ],
      });
  }

  /** Shares the finalized launch; public time, or the opening round, starts now. */
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
   * it with the creation fee, runs the creator's optional first action on the
   * owned launch, and shares it. Without an opening round that action is a
   * purchase, whose `(Coin<Meme>, Coin<Quote>)` result this returns; it may
   * reach the graduation target. With one it is the creator's bid, which joins
   * the same pot at the same price and returns nothing.
   */
  completeLaunch(
    options: LaunchInitializerInput &
      LaunchSettings & {
        currency: SharedObjectReference<true>;
        /** A SUI coin of exactly `creationFee`; omitted, a coin intent draws it. */
        creationFeeCoin?: TransactionObjectInput;
        preShareBuy?: { quoteCoin: TransactionObjectInput; minMemeOut: bigint };
        creatorBid?: { quoteCoin: TransactionObjectInput };
      },
  ) {
    const openingRoundMs = requireU64(
      "openingRoundMs",
      options.openingRoundMs ?? 0n,
    );
    requireU64("creationFee", options.creationFee);
    if (openingRoundMs > 0n && options.preShareBuy) {
      throw new RangeError(
        "a launch with an opening round cannot trade before the round settles; bid instead",
      );
    }
    if (openingRoundMs === 0n && options.creatorBid) {
      throw new RangeError("a creator bid needs an opening round");
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
      const creationFeeCoin =
        options.creationFeeCoin ??
        tx.coin({ type: SUI_TYPE, balance: options.creationFee });
      const launch = tx.add(
        this.finalizeLaunch({ ...options, creationFeeCoin }),
      );
      const bought = options.preShareBuy
        ? tx.add(
            this.#buyCall({ ...options, ...options.preShareBuy }, () => launch),
          )
        : undefined;
      if (options.creatorBid) {
        tx.add(
          this.#joinCall(
            { ...options, quoteCoin: options.creatorBid.quoteCoin },
            () => launch,
          ),
        );
      }
      tx.add(this.shareLaunch({ ...options, launch }));
      return bought;
    };
  }

  /** Adds `quoteCoin` to the sender's bid while the opening round runs. */
  joinOpeningRound(
    options: LaunchTypes & {
      launch: LaunchRef;
      quoteCoin: TransactionObjectInput;
    },
  ) {
    return this.#joinCall(options, (tx) =>
      sharedObject(tx, "launch", options.launch, true),
    );
  }

  /** Closes an ended opening round with one curve purchase; anyone may call it. */
  settleOpeningRound(options: LaunchTypes & { launch: LaunchRef }) {
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
   * Sends `bidder` its pro-rata Meme and refund of the settled round. The
   * contract transfers both coins to `bidder`; nothing returns to the PTB.
   */
  deliverOpeningRound(
    options: LaunchTypes & { launch: LaunchRef; bidder: string },
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

  /** The Move type of one `blast_fun_domain` role, for `AdminCalls.grantRole`. */
  roleType(role: LaunchpadAdminRole): string {
    return `${this.deployment.originalPackageId}::blast_fun_domain::${role}`;
  }

  /**
   * Signs in to the singleton `blast_admin::blast_acl::ACL` and returns this
   * PTB's `AdminWitness<Role>`; the cap must hold `role`.
   */
  signIn(options: {
    adminCap: TransactionObjectInput;
    role: LaunchpadAdminRole;
  }) {
    if (!LAUNCHPAD_ADMIN_ROLES.includes(options.role)) {
      throw new RangeError(
        `unknown blast_fun administrator role: ${String(options.role)}`,
      );
    }
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
   * Claims Blast's fees and creation fee from a launch that names no partner
   * with an `AdminWitness<TreasuryAdmin>`. Returns `(Coin<Meme>, Coin<Quote>,
   * Coin<SUI>)`.
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
   * Claims Blast's fees from a launch that names `partner`, paying the partner
   * its share in the same call. Returns Blast's `(Coin<Meme>, Coin<Quote>,
   * Coin<SUI>)`.
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
        // The whole transitive closure of the template's dependencies.
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
    tx.moveCall({
      target: `${SUI_FRAMEWORK_ADDRESS}::coin_registry::finalize_registration`,
      typeArguments: [normalizeStructTag(options.memeType)],
      arguments: [
        tx.object(COIN_REGISTRY_ID),
        tx.receivingRef({
          objectId: normalizeSuiObjectId(options.currency.objectId),
          version: options.currency.version,
          digest: options.currency.digest,
        }),
      ],
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

  /** Joins the opening round with exactly `quoteAmount` of the Quote. */
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

  deliverOpeningRound(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      bidder: string;
    },
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.deliverOpeningRound(options));
    return tx;
  }

  /**
   * Signs in as `TreasuryAdmin` and claims Blast's fees, through the partner
   * route when the launch names `partner`, then sends the Meme, Quote, and SUI
   * coins to `recipient`.
   */
  claimProtocolFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminCapId: string;
      recipient: string;
      partner?: SharedObjectReference<false>;
    },
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn({ adminCap: options.adminCapId, role: "TreasuryAdmin" }),
    );
    const claimResult = tx.add(
      options.partner
        ? this.call.claimProtocolFeesWithPartner({
            ...options,
            partner: options.partner,
            adminWitness,
          })
        : this.call.claimProtocolFees({ ...options, adminWitness }),
    );
    tx.transferObjects(
      [claimResult[0]!, claimResult[1]!, claimResult[2]!],
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }
}

/**
 * Completes an adapter-started launch in `tx`: applies the settings, finalizes
 * with the creation fee, runs the creator's optional purchase (routing its
 * coins) or opening-round bid on the owned launch, then shares.
 */
export function addLaunchCompletion(
  tx: Transaction,
  calls: LaunchpadCalls,
  options: LaunchInitializerInput &
    LaunchSettings & {
      currency: SharedObjectReference<true>;
      preShareBuy?: PreShareBuyInput;
      creatorBid?: CreatorBidInput;
    },
): void {
  const { preShareBuy, creatorBid, ...settings } = options;
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
      ...(preShareBuy
        ? {
            preShareBuy: {
              quoteCoin: quoteCoin(preShareBuy.quoteAmount),
              minMemeOut: preShareBuy.minMemeOut,
            },
          }
        : {}),
      ...(creatorBid
        ? { creatorBid: { quoteCoin: quoteCoin(creatorBid.quoteAmount) } }
        : {}),
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
