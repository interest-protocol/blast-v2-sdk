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
import type {
  AllocationChannelRole,
  AllocationPlan,
  FeeSplit,
} from "./allocation.ts";
import { normalizeAllocationPlan, normalizeFeeSplit } from "./allocation.ts";
import type { MemeTemplateOptions } from "./template.ts";
import { buildMemePackageBytecode } from "./template.ts";

export type { SharedObjectReference } from "../lib/sui.ts";

export type LaunchpadDeployment = {
  packageId: string;
  originalPackageId?: string;
  /**
   * Published `blast_admin` package: it owns `acl::sign_in`, and every
   * generated Meme package lists it as a transitive publish dependency.
   */
  adminPackageId: string;
  packageVersion: SharedObjectReference<false>;
  launchConfig: SharedObjectReference<false>;
  runtimeConfig: SharedObjectReference<false>;
  /** `blast_admin::acl::Authority<BLAST_FUN_DOMAIN>`. */
  protocolAuthority: SharedObjectReference<false>;
};

export type LaunchTypes = {
  memeType: string;
  quoteType: string;
};

/** Public curve-purchase protection; omitted, protection stays disabled. */
export type LaunchProtectionInput = {
  windowMs: bigint;
  cumulativeSenderBps: bigint;
  perTransactionBps: bigint;
};

/**
 * The creator's launch settings, applied to a `LaunchInitializer` before
 * `launch::finalize` checks every invariant.
 */
export type LaunchSettings = {
  graduationTarget: bigint;
  allocationPlan: AllocationPlan;
  lpFeeSplit: FeeSplit;
  protection?: LaunchProtectionInput;
};

/** One owned curve purchase made before the launch is shared. */
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

const CHANNEL_ROLE_CONSTRUCTORS: Record<AllocationChannelRole, string> = {
  Liquidity: "liquidity_role",
  Protocol: "protocol_role",
  External: "external_role",
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

  /** Builds a canonical `allocation::AllocationPlan` through its constructors. */
  allocationPlan(plan: AllocationPlan) {
    const normalized = normalizeAllocationPlan(plan);
    const original = this.deployment.originalPackageId;
    return (tx: Transaction): TransactionResult => {
      const channels = tx.makeMoveVec({
        type: `${original}::allocation::Channel`,
        elements: normalized.channels.map((channel) =>
          tx.moveCall({
            target: `${this.deployment.packageId}::allocation::channel`,
            arguments: [
              tx.pure.u64(channel.channelId),
              tx.moveCall({
                target: `${this.deployment.packageId}::allocation::${CHANNEL_ROLE_CONSTRUCTORS[channel.role]}`,
              }),
              tx.pure.address(channel.destination),
            ],
          }),
        ),
      });
      const weights = (table: AllocationPlan["meme"]) =>
        tx.makeMoveVec({
          type: `${original}::allocation::Weight`,
          elements: table.map((weight) =>
            tx.moveCall({
              target: `${this.deployment.packageId}::allocation::weight`,
              arguments: [
                tx.pure.u64(weight.channelId),
                tx.add(this.bps(weight.bps)),
              ],
            }),
          ),
        });
      return tx.moveCall({
        target: `${this.deployment.packageId}::allocation::new`,
        arguments: [
          channels,
          weights(normalized.meme),
          weights(normalized.quote),
        ],
      });
    };
  }

  /** Builds a canonical `allocation::FeeSplit` through its constructors. */
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
          recipients,
        ],
      });
    };
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
    options: LaunchInitializerInput & { allocationPlan: AllocationPlan },
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

  setProtection(options: LaunchInitializerInput & LaunchProtectionInput) {
    requireU64("windowMs", options.windowMs);
    const cumulative = this.bps(options.cumulativeSenderBps);
    const perTransaction = this.bps(options.perTransactionBps);
    return this.#initializerCall("set_protection", options, (tx) => [
      tx.pure.u64(options.windowMs),
      tx.add(cumulative),
      tx.add(perTransaction),
    ]);
  }

  /** Consumes the initializer, checks every setting, and returns the owned launch. */
  finalizeLaunch(
    options: LaunchInitializerInput & { currency: SharedObjectReference<true> },
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
          sharedObject(tx, "launchConfig", this.deployment.launchConfig, false),
        ],
      });
  }

  /** The one owned purchase before public opening; it cannot reach the target. */
  preShareBuy(
    options: LaunchTypes & {
      launch: TransactionArgument;
      quoteCoin: TransactionObjectInput;
      minMemeOut: bigint;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    requireU64("minMemeOut", options.minMemeOut);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::pre_share_buy`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          options.launch,
          this.#packageVersion(tx),
          this.#runtimeConfig(tx),
          tx.object(options.quoteCoin),
          tx.pure.u64(options.minMemeOut),
        ],
      });
  }

  /** Shares the finalized launch; public time and protection start now. */
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
   * it, runs the optional pre-share purchase, and shares the launch. Returns the
   * pre-share purchase's `(Coin<Meme>, Coin<Quote>)` result, if any.
   */
  completeLaunch(
    options: LaunchInitializerInput &
      LaunchSettings & {
        currency: SharedObjectReference<true>;
        preShareBuy?: { quoteCoin: TransactionObjectInput; minMemeOut: bigint };
      },
  ) {
    const settings = [
      this.setGraduationTarget(options),
      this.setAllocationPlan(options),
      this.setLpFeeSplit(options),
      ...(options.protection
        ? [this.setProtection({ ...options, ...options.protection })]
        : []),
    ];
    return (tx: Transaction): TransactionResult | undefined => {
      for (const setting of settings) tx.add(setting);
      const launch = tx.add(this.finalizeLaunch(options));
      const bought = options.preShareBuy
        ? tx.add(
            this.preShareBuy({ ...options, ...options.preShareBuy, launch }),
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
    const types = normalizeLaunchTypes(options);
    requireU64("minMemeOut", options.minMemeOut);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::buy`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          this.#runtimeConfig(tx),
          tx.object(options.quoteCoin),
          tx.pure.u64(options.minMemeOut),
          tx.object.clock(),
        ],
      });
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

  /** Signs in to `blast_admin::acl` and returns this PTB's `AdminWitness<BLAST_FUN_DOMAIN>`. */
  signIn(options: { adminCap: TransactionObjectInput }) {
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.adminPackageId}::acl::sign_in`,
        typeArguments: [
          `${this.deployment.originalPackageId}::blast_fun_domain::BLAST_FUN_DOMAIN`,
        ],
        arguments: [
          sharedObject(
            tx,
            "protocolAuthority",
            this.deployment.protocolAuthority,
            false,
          ),
          tx.object(options.adminCap),
        ],
      });
  }

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
          this.call.deployment.adminPackageId,
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

  claimProtocolFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      adminCapId: string;
      recipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn({ adminCap: options.adminCapId }),
    );
    const claimResult = tx.add(
      this.call.claimProtocolFees({ ...options, adminWitness }),
    );
    tx.transferObjects(
      [claimResult[0]!, claimResult[1]!],
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }
}

/**
 * Completes an adapter-started launch in `tx`: applies the settings, finalizes,
 * runs the optional pre-share purchase and routes its coins, then shares.
 */
export function addLaunchCompletion(
  tx: Transaction,
  calls: LaunchpadCalls,
  options: LaunchInitializerInput &
    LaunchSettings & {
      currency: SharedObjectReference<true>;
      preShareBuy?: PreShareBuyInput;
    },
): void {
  const { preShareBuy, ...settings } = options;
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
    protocolAuthority: normalizeSharedObjectReference(
      "protocolAuthority",
      deployment.protocolAuthority,
      false,
    ),
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
