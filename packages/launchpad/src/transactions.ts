import type { AdminDeployment } from "@interest-protocol/blast-admin-sdk/transactions";
import {
  AdminCalls,
  normalizeAdminDeployment,
  packageRoleType,
} from "@interest-protocol/blast-admin-sdk/transactions";
import { MAX_LP_FEE_BPS } from "@interest-protocol/blast-core/bps";
import type { CoinSourceOptions } from "@interest-protocol/blast-core/coins";
import type { CoreDeployment } from "@interest-protocol/blast-core/deployment";
import {
  CoreCalls,
  normalizeCoreDeployment,
} from "@interest-protocol/blast-core/deployment";
import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import {
  requireBasisPoints,
  requireBasisPointsAtMost,
  requirePositiveU64,
  requireU64,
} from "@interest-protocol/blast-core/integers";
import {
  deploymentObject,
  moveResults,
} from "@interest-protocol/blast-core/ptb";
import type { CoreRole } from "@interest-protocol/blast-core/roles";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import type {
  SharedObjectIdentity,
  SharedObjectReference,
} from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSharedObjectReference,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { MigratorsDeployment } from "@interest-protocol/blast-migrators-sdk/transactions";
import {
  MigratorCalls,
  normalizeMigratorsDeployment,
} from "@interest-protocol/blast-migrators-sdk/transactions";
import type { PartnersDeployment } from "@interest-protocol/blast-partners-sdk/transactions";
import type { VaultDeployment } from "@interest-protocol/blast-vault-sdk/transactions";
import {
  normalizeVaultDeployment,
  VaultCalls,
} from "@interest-protocol/blast-vault-sdk/transactions";
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
import type { CreatorAllocationPlan, RecipientShare } from "./allocation.ts";
import { normalizeAllocationPlan } from "./allocation.ts";
import type { ObjectVersionReference } from "./effects.ts";
import { COIN_REGISTRY_ID } from "./effects.ts";
import type { MemeTemplateOptions } from "./template.ts";
import { buildMemePackageBytecode } from "./template.ts";

/**
 * The `blast_fun` package: its shared `PackageVersion<BLAST_FUN>`,
 * `PackageAdmin<BLAST_FUN>`, `LaunchConfig`, `RuntimeConfig` and
 * `LaunchRegistry`, and the packages its calls and compositions read. Calls
 * target `packageId`; types and roles name `originalPackageId`.
 */
export type LaunchpadDeployment = {
  packageId: string;
  originalPackageId: string;
  packageVersion: SharedObjectIdentity;
  packageAdmin: SharedObjectIdentity;
  launchConfig: SharedObjectIdentity;
  runtimeConfig: SharedObjectIdentity;
  launchRegistry: SharedObjectIdentity;
  core: CoreDeployment;
  admin: AdminDeployment;
  partners: PartnersDeployment;
  vault: VaultDeployment;
  migrators: MigratorsDeployment;
  /**
   * The immutable `blast_fun_vesting` package `blast_core` links; a generated
   * Meme package lists it among its transitive publish dependencies.
   */
  vestingPackageId: string;
};

export type LaunchTypes = {
  memeType: string;
  quoteType: string;
};

/** `constants::min_opening_round_ms`: shortest nonzero opening round `finalize` accepts. */
export const MIN_OPENING_ROUND_MS = 60_000n;
/** `constants::max_opening_round_ms`: longest opening round `finalize` accepts. */
export const MAX_OPENING_ROUND_MS = 300_000n;
/** `constants::max_protocol_allocation_bps`: Blast's largest allocation of each asset. */
export const MAX_PROTOCOL_ALLOCATION_BPS = 1_000n;
/** `constants::max_protocol_fee_share_bps`: Blast's largest share of each trade fee. */
export const MAX_PROTOCOL_FEE_SHARE_BPS = 7_000n;
/** `constants::max_creation_fee_mist`: the largest creation fee, in MIST (10 SUI). */
export const MAX_CREATION_FEE_MIST = 10_000_000_000n;

/** `blast_fun::constants` pause bits; flags may be ORed together. */
export const LAUNCHPAD_PAUSE_BITS = {
  Create: 1,
  Trading: 2,
  Migrate: 4,
} as const;

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
  /** The vault's LP-fee split at migration (core `FeeSplit`). */
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
 * The venue a launch's liquidity migrates to and the tier it reserves at
 * creation (`cetus::prepare` / `bluefin::prepare`). Cetus also needs its
 * `GlobalConfig` and `Pools` shared objects.
 */
export type LaunchVenue =
  | {
      venue: "cetus";
      tier: { tickSpacing: number };
      cetus: { config: SharedObjectIdentity; pools: SharedObjectIdentity };
    }
  | { venue: "bluefin"; tier: { tickSpacing: number; feeRate: bigint } };

/** The venue objects `cetus::migrate` / `bluefin::migrate` read. */
export type MigrationVenue =
  | {
      venue: "cetus";
      cetus: {
        config: SharedObjectIdentity;
        pools: SharedObjectIdentity;
        burnManager: SharedObjectIdentity;
      };
    }
  | {
      venue: "bluefin";
      quoteCurrency: SharedObjectIdentity;
      bluefinConfig: SharedObjectIdentity;
      /** Bluefin's pool creation fee, in MIST, paid from a `Coin<SUI>`. */
      creationFee: bigint;
    };

/**
 * Inputs shared by the launch metadata setters. `launch` is read immutably by
 * Move; pass `mutable: true` only when the same PTB also mutates the launch.
 */
export type MemeMetadataUpdate = LaunchTypes & {
  launch: SharedObjectReference;
  creatorMetadataCap: TransactionObjectInput;
  currency: SharedObjectReference<true>;
};

export type LaunchInitializerInput = LaunchTypes & {
  initializer: TransactionArgument;
};

/** A shared launch, borrowed mutably. */
type LaunchInput = LaunchTypes & { launch: SharedObjectReference<true> };

/** The shared launch, or the owned `Launch` `finalize` returned in this PTB. */
type OwnedOrSharedLaunch = LaunchTypes & {
  launch: SharedObjectReference<true> | TransactionArgument;
};

/** An administrator action's `AdminWitness` (`signIn`'s result). */
type AdminWitnessInput = { adminWitness: TransactionObjectInput };

/** A venue witness type argument (`<migrators>::cetus::Venue`, ...). */
type VenueTypeInput = { venueType: string };

/**
 * `blast_fun` calls, one per public function the SDK builds, in Move argument
 * order; `&mut TxContext` is implicit and the `Clock` is `0x6`. The package
 * version, configurations, registry and core treasury come from the
 * deployment. An `adminWitness` is `signIn`'s result for the named
 * `blast_core::blast_domain` role.
 */
export class LaunchpadCalls {
  readonly deployment: LaunchpadDeployment;
  readonly admin: AdminCalls;
  readonly core: CoreCalls;
  /** `blast_fun::BLAST_FUN`, the package's OTW. */
  readonly otw: string;
  /** `blast_fun::PackageWitness`: the launchpad's vault terms and owner proofs name it. */
  readonly packageWitnessType: string;

  constructor(deployment: LaunchpadDeployment) {
    this.deployment = normalizeDeployment(deployment);
    this.admin = new AdminCalls(this.deployment.admin);
    this.core = new CoreCalls(this.deployment.core);
    const module = `${this.deployment.originalPackageId}::blast_fun`;
    this.otw = normalizeStructTag(`${module}::BLAST_FUN`);
    this.packageWitnessType = normalizeStructTag(`${module}::PackageWitness`);
  }

  /** This PTB's `AdminWitness<Role>` for a `blast_domain` role the `AdminCap` holds. */
  signIn(options: { adminCap: TransactionObjectInput; role: CoreRole }) {
    return this.admin.signIn({
      adminCap: options.adminCap,
      role: coreRoleType(this.deployment.core, options.role),
    });
  }

  // Value constructors.

  /** `allocation::recipient_share` of a core `payout::recipient` and its two rates. */
  recipientShare(share: RecipientShare) {
    const recipient = this.core.recipient(share.recipient);
    const memeBps = this.core.bps(share.memeBps);
    const quoteBps = this.core.bps(share.quoteBps);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("allocation", "recipient_share"),
        arguments: [recipient(tx), memeBps(tx), quoteBps(tx)],
      });
  }

  /** The creator's `allocation::plan` (Blast's shares are added at finalization). */
  allocationPlan(plan: CreatorAllocationPlan) {
    const normalized = normalizeAllocationPlan(plan);
    const shares = normalized.recipients.map((share) =>
      this.recipientShare(share),
    );
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("allocation", "plan"),
        arguments: [
          this.core.bps(normalized.curveMemeBps)(tx),
          this.core.bps(normalized.lpMemeBps)(tx),
          this.core.bps(normalized.lpQuoteBps)(tx),
          tx.makeMoveVec({
            type: `${this.deployment.originalPackageId}::allocation::RecipientShare`,
            elements: shares.map((share) => share(tx)),
          }),
        ],
      });
  }

  // Creation, in PTB order: `newLaunch`, the setters, `finalize`, `share`.

  /**
   * `launch::new`: starts the launch from the publisher's ticket and
   * `TreasuryCap` and the venue's `VenueTicket` (`MigratorCalls.prepare*`),
   * returning the `LaunchInitializer` hot potato.
   */
  newLaunch(
    options: LaunchTypes & {
      ticket: TransactionObjectInput;
      treasuryCap: TransactionObjectInput;
      venueTicket: TransactionArgument;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch", "new"),
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          tx.object(options.ticket),
          tx.object(options.treasuryCap),
          this.#packageVersion(tx),
          this.#launchConfig(tx),
          options.venueTicket,
        ],
      });
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
      plan(tx),
    ]);
  }

  setLpFeeSplit(options: LaunchInitializerInput & { lpFeeSplit: FeeSplit }) {
    const split = this.core.feeSplit(options.lpFeeSplit);
    return this.#initializerCall("set_lp_fee_split", options, (tx) => [
      split(tx),
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

  /** Names the launch's partner; `LaunchConfig` must accept it now. */
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
   * `launch::finalize`: consumes the initializer, checks every setting and
   * returns the owned launch, its ID derived from the `LaunchRegistry`.
   * `creationFee` is a `Coin<SUI>` of exactly the `LaunchConfig` creation fee.
   */
  finalize(
    options: LaunchInitializerInput & {
      currency: SharedObjectReference<true>;
      creationFee: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch", "finalize"),
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          options.initializer,
          this.#packageVersion(tx),
          deploymentObject(tx, this.deployment.launchRegistry, true),
          sharedObject(tx, "currency", options.currency, true),
          this.#launchConfig(tx),
          tx.object(options.creationFee),
        ],
      });
  }

  /** `launch::share`: trading or the opening round starts now. */
  share(options: LaunchTypes & { launch: TransactionArgument }) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch", "share"),
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          options.launch,
          this.#packageVersion(tx),
          tx.object.clock(),
        ],
      });
  }

  // Trading and claims.

  /**
   * Adds `quoteCoin` to the sender's opening-round bid until the round ends.
   * `launch` is the shared launch, or the owned `finalize` result before share.
   */
  joinOpeningRound(
    options: OwnedOrSharedLaunch & { quoteCoin: TransactionObjectInput },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch", "join_opening_round"),
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          launchArgument(tx, options.launch),
          this.#packageVersion(tx),
          tx.object(options.quoteCoin),
          tx.object.clock(),
        ],
      });
  }

  /** Settles an ended opening round with one curve purchase; anyone may call it. */
  settleOpeningRound(options: LaunchInput) {
    return this.#launchCall("settle_opening_round", options, (tx) => [
      this.#runtimeConfig(tx),
      tx.object.clock(),
    ]);
  }

  /**
   * Sends `bidder` its pro-rata share of the settled round's Meme and refunded
   * Quote; anyone may call it, and the coins always go to the bidder.
   */
  deliverOpeningRound(options: LaunchInput & { bidder: string }) {
    const bidder = normalizeSuiAddress(options.bidder);
    return this.#launchCall("deliver_opening_round", options, (tx) => [
      tx.pure.address(bidder),
    ]);
  }

  /**
   * `launch::buy`: returns `[Coin<Meme>, Coin<Quote>]`, the Meme and any
   * refund. `launch` is the shared launch, or the owned `finalize` result
   * before share.
   */
  buy(
    options: OwnedOrSharedLaunch & {
      quoteCoin: TransactionObjectInput;
      minMemeOut: bigint;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const minMemeOut = requireU64("minMemeOut", options.minMemeOut);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch", "buy"),
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          launchArgument(tx, options.launch),
          this.#packageVersion(tx),
          this.#runtimeConfig(tx),
          tx.object(options.quoteCoin),
          tx.pure.u64(minMemeOut),
        ],
      });
  }

  /** `launch::sell`: returns the `Coin<Quote>`. */
  sell(
    options: LaunchInput & {
      memeCoin: TransactionObjectInput;
      minQuoteOut: bigint;
    },
  ) {
    const minQuoteOut = requireU64("minQuoteOut", options.minQuoteOut);
    return this.#launchCall("sell", options, (tx) => [
      this.#runtimeConfig(tx),
      tx.object(options.memeCoin),
      tx.pure.u64(minQuoteOut),
    ]);
  }

  /**
   * `launch::claim_creator_caps`: returns `[CurveFeeCap, CreatorMetadataCap]`.
   * The `CurveFeeCap` also proves ownership of the launch's vault.
   */
  claimCreatorCaps(
    options: LaunchInput & { accountAttestation?: Uint8Array | null },
  ) {
    return this.#launchCall("claim_creator_caps", options, (tx) => [
      this.#runtimeConfig(tx),
      tx.pure.option(
        "vector<u8>",
        options.accountAttestation
          ? Array.from(options.accountAttestation)
          : null,
      ),
      tx.object.clock(),
    ]);
  }

  /** `launch::claim_creator_fees`: returns `[Coin<Meme>, Coin<Quote>]`. */
  claimCreatorFees(
    options: LaunchInput & { curveFeeCap: TransactionObjectInput },
  ) {
    return this.#launchCall("claim_creator_fees", options, (tx) => [
      tx.object(options.curveFeeCap),
    ]);
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
   * `launch::claim_protocol_fees`: pays Blast's fees on a launch that names no
   * partner to the core `Treasury`. Anyone may call it.
   */
  claimProtocolFees(options: LaunchInput) {
    return this.#launchCall("claim_protocol_fees", options, (tx) => [
      this.#treasury(tx),
    ]);
  }

  /**
   * `launch::claim_protocol_fees_with_partner`: on a launch that names
   * `partner`, pays the partner its share and the core `Treasury` the rest.
   */
  claimProtocolFeesWithPartner(
    options: LaunchInput & { partner: SharedObjectReference<false> },
  ) {
    return this.#launchCall(
      "claim_protocol_fees_with_partner",
      options,
      (tx) => [
        this.#treasury(tx),
        sharedObject(tx, "partner", options.partner, false),
      ],
    );
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
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${SUI_FRAMEWORK_ADDRESS}::coin_registry::finalize_registration`,
        typeArguments: [memeType],
        arguments: [tx.object(COIN_REGISTRY_ID), tx.receivingRef(currency)],
      });
  }

  // Migration and ownership.

  /**
   * `launch::migrate`: pays the plan's recipients, accrues Blast's migration
   * fee, disposes of the unsold Meme, and returns the `Migration<Meme, Quote>`
   * the launch's venue must redeem in the same PTB (`MigratorCalls.migrate*`).
   */
  migrate(options: LaunchInput & { currency: SharedObjectReference<true> }) {
    return this.#launchCall("migrate", options, (tx) => [
      this.#launchConfig(tx),
      sharedObject(tx, "currency", options.currency, true),
      tx.object.clock(),
    ]);
  }

  /**
   * `launch::prove_owner`: the `OwnerProof` the launch's vault accepts from the
   * holder of its live `CurveFeeCap`, for one owner call in the same PTB.
   * `launch` is read immutably; pass `mutable: true` only when the same PTB
   * also mutates it.
   */
  proveOwner(
    options: LaunchTypes & {
      launch: SharedObjectReference;
      curveFeeCap: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch", "prove_owner"),
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, options.launch.mutable),
          this.#packageVersion(tx),
          tx.object(options.curveFeeCap),
        ],
      });
  }

  // `launch_config`.

  /** `TreasuryAdmin`; each share at most `MAX_PROTOCOL_ALLOCATION_BPS`. */
  scheduleProtocolAllocation(
    options: AdminWitnessInput & {
      memeBps: bigint;
      quoteBps: bigint;
      delayMs: bigint;
    },
  ) {
    const memeBps = requireBasisPointsAtMost(
      "memeBps",
      options.memeBps,
      MAX_PROTOCOL_ALLOCATION_BPS,
    );
    const quoteBps = requireBasisPointsAtMost(
      "quoteBps",
      options.quoteBps,
      MAX_PROTOCOL_ALLOCATION_BPS,
    );
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#configCall("schedule_protocol_allocation", options, (tx) => [
      this.core.bps(memeBps)(tx),
      this.core.bps(quoteBps)(tx),
      tx.pure.u64(delayMs),
      tx.object.clock(),
    ]);
  }

  applyProtocolAllocation() {
    return this.#applyConfig("apply_protocol_allocation");
  }

  /** `CancelAdmin`. */
  cancelProtocolAllocation(options: AdminWitnessInput) {
    return this.#configCall("cancel_protocol_allocation", options);
  }

  /** `FeeAdmin`; each share at most core `MAX_LP_FEE_BPS` (3,000). */
  scheduleProtocolLpFees(
    options: AdminWitnessInput & {
      memeBps: bigint;
      quoteBps: bigint;
      delayMs: bigint;
    },
  ) {
    const memeBps = requireBasisPointsAtMost(
      "memeBps",
      options.memeBps,
      MAX_LP_FEE_BPS,
    );
    const quoteBps = requireBasisPointsAtMost(
      "quoteBps",
      options.quoteBps,
      MAX_LP_FEE_BPS,
    );
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#configCall("schedule_protocol_lp_fees", options, (tx) => [
      this.core.bps(memeBps)(tx),
      this.core.bps(quoteBps)(tx),
      tx.pure.u64(delayMs),
      tx.object.clock(),
    ]);
  }

  applyProtocolLpFees() {
    return this.#applyConfig("apply_protocol_lp_fees");
  }

  /** `CancelAdmin`. */
  cancelProtocolLpFees(options: AdminWitnessInput) {
    return this.#configCall("cancel_protocol_lp_fees", options);
  }

  /** `ListingAdmin`. */
  setMemeDecimalsAllowed(
    options: AdminWitnessInput & { decimals: number; allowed: boolean },
  ) {
    return this.#configCall("set_meme_decimals_allowed", options, (tx) => [
      tx.pure.u8(options.decimals),
      tx.pure.bool(options.allowed),
    ]);
  }

  /** `ListingAdmin`; existing launches keep trading in the Quote. */
  setQuoteAllowed(
    options: AdminWitnessInput & { quoteType: string; allowed: boolean },
  ) {
    return this.#configCall(
      "set_quote_allowed",
      options,
      (tx) => [tx.pure.bool(options.allowed)],
      [normalizeStructTag(options.quoteType)],
    );
  }

  /** `FeeAdmin`. */
  scheduleTradeFees(
    options: AdminWitnessInput & {
      quoteFeeBps: bigint;
      memeFeeBps: bigint;
      delayMs: bigint;
    },
  ) {
    const quoteFeeBps = requireBasisPoints("quoteFeeBps", options.quoteFeeBps);
    const memeFeeBps = requireBasisPoints("memeFeeBps", options.memeFeeBps);
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#configCall("schedule_trade_fees", options, (tx) => [
      this.core.bps(quoteFeeBps)(tx),
      this.core.bps(memeFeeBps)(tx),
      tx.pure.u64(delayMs),
      tx.object.clock(),
    ]);
  }

  applyTradeFees() {
    return this.#applyConfig("apply_trade_fees");
  }

  /** `CancelAdmin`. */
  cancelTradeFees(options: AdminWitnessInput) {
    return this.#configCall("cancel_trade_fees", options);
  }

  /** `FeeAdmin`; at most `MAX_CREATION_FEE_MIST` (10 SUI). */
  scheduleCreationFee(
    options: AdminWitnessInput & { creationFee: bigint; delayMs: bigint },
  ) {
    const creationFee = requireU64("creationFee", options.creationFee);
    if (creationFee > MAX_CREATION_FEE_MIST) {
      throw new RangeError("creationFee exceeds 10 SUI");
    }
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#configCall("schedule_creation_fee", options, (tx) => [
      tx.pure.u64(creationFee),
      tx.pure.u64(delayMs),
      tx.object.clock(),
    ]);
  }

  applyCreationFee() {
    return this.#applyConfig("apply_creation_fee");
  }

  /** `CancelAdmin`. */
  cancelCreationFee(options: AdminWitnessInput) {
    return this.#configCall("cancel_creation_fee", options);
  }

  /** `FeeAdmin`: new launches may name `partner` at once. */
  addPartner(
    options: AdminWitnessInput & { partner: SharedObjectReference<false> },
  ) {
    return this.#configCall("add_partner", options, (tx) => [
      sharedObject(tx, "partner", options.partner, false),
    ]);
  }

  /**
   * `FeeAdmin`: new launches stop naming `partner` after `PARTNER_DELAY_MS`;
   * launches that name it keep paying it.
   */
  removePartner(
    options: AdminWitnessInput & { partner: SharedObjectReference<false> },
  ) {
    return this.#configCall("remove_partner", options, (tx) => [
      sharedObject(tx, "partner", options.partner, false),
      tx.object.clock(),
    ]);
  }

  /** `VenueAdmin`: admits `venueType` after the applied admission delay. */
  scheduleVenue(options: AdminWitnessInput & VenueTypeInput) {
    return this.#configCall(
      "schedule_venue",
      options,
      (tx) => [tx.object.clock()],
      [normalizeStructTag(options.venueType)],
    );
  }

  applyVenue(options: VenueTypeInput) {
    return this.#applyConfig("apply_venue", [
      normalizeStructTag(options.venueType),
    ]);
  }

  /** `CancelAdmin`. */
  cancelVenue(options: AdminWitnessInput & VenueTypeInput) {
    return this.#configCall("cancel_venue", options, () => [], [
      normalizeStructTag(options.venueType),
    ]);
  }

  /** `VenueAdmin`: removes the venue for new launches at once. */
  removeVenue(options: AdminWitnessInput & VenueTypeInput) {
    return this.#configCall("remove_venue", options, () => [], [
      normalizeStructTag(options.venueType),
    ]);
  }

  /** `VenueAdmin`. */
  scheduleVenueDelay(options: AdminWitnessInput & { delayMs: bigint }) {
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#configCall("schedule_venue_delay", options, (tx) => [
      tx.pure.u64(delayMs),
      tx.object.clock(),
    ]);
  }

  applyVenueDelay() {
    return this.#applyConfig("apply_venue_delay");
  }

  /** `CancelAdmin`. */
  cancelVenueDelay(options: AdminWitnessInput) {
    return this.#configCall("cancel_venue_delay", options);
  }

  /**
   * `launch_config::unpause`: clears `bits` once every launchpad delay is
   * guarded. `unpauseAdmin` is `AdminWitness<UnpauseAdmin<BLAST_FUN>>`
   * (`packageRoleType(admin, otw, "UnpauseAdmin")`).
   */
  unpause(options: { unpauseAdmin: TransactionObjectInput; bits: number }) {
    const { bits } = options;
    if (
      !Number.isInteger(bits) ||
      bits <= 0 ||
      (bits &
        ~(
          LAUNCHPAD_PAUSE_BITS.Create |
          LAUNCHPAD_PAUSE_BITS.Trading |
          LAUNCHPAD_PAUSE_BITS.Migrate
        )) !==
        0
    ) {
      throw new RangeError("invalid pause bits");
    }
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch_config", "unpause"),
        arguments: [
          this.#launchConfig(tx),
          deploymentObject(tx, this.deployment.packageVersion, true),
          tx.object(options.unpauseAdmin),
          deploymentObject(tx, this.deployment.packageAdmin, false),
          this.#runtimeConfig(tx),
          tx.pure.u8(bits),
        ],
      });
  }

  // `runtime_config`.

  /**
   * `ClaimSignerAdmin`: proposes admitting an Ed25519 key that may sign
   * account claims, after the signer delay. At most four keys may be live or
   * pending at once.
   */
  scheduleCreatorClaimSigner(
    options: AdminWitnessInput & { signerPublicKey: ClaimSignerPublicKey },
  ) {
    const key = claimSignerKey(options.signerPublicKey);
    return this.#runtimeCall("schedule_creator_claim_signer", options, (tx) => [
      tx.pure.vector("u8", key),
      tx.object.clock(),
    ]);
  }

  /** Anyone admits a ready signer key. */
  applyCreatorClaimSigner(options: { signerPublicKey: ClaimSignerPublicKey }) {
    const key = claimSignerKey(options.signerPublicKey);
    return this.#runtimeCall("apply_creator_claim_signer", null, (tx) => [
      tx.pure.vector("u8", key),
      tx.object.clock(),
    ]);
  }

  /** `CancelAdmin`: discards a pending admission. */
  cancelCreatorClaimSigner(
    options: AdminWitnessInput & { signerPublicKey: ClaimSignerPublicKey },
  ) {
    const key = claimSignerKey(options.signerPublicKey);
    return this.#runtimeCall("cancel_creator_claim_signer", options, (tx) => [
      tx.pure.vector("u8", key),
    ]);
  }

  /**
   * `ClaimSignerAdmin`: removes a live or pending key at once; attestations
   * it signed stop verifying.
   */
  revokeCreatorClaimSigner(
    options: AdminWitnessInput & { signerPublicKey: ClaimSignerPublicKey },
  ) {
    const key = claimSignerKey(options.signerPublicKey);
    return this.#runtimeCall("revoke_creator_claim_signer", options, (tx) => [
      tx.pure.vector("u8", key),
    ]);
  }

  /** `ClaimSignerAdmin`: the delay of later signer admissions. */
  scheduleCreatorClaimSignerDelay(
    options: AdminWitnessInput & { delayMs: bigint },
  ) {
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#runtimeCall(
      "schedule_creator_claim_signer_delay",
      options,
      (tx) => [tx.pure.u64(delayMs), tx.object.clock()],
    );
  }

  applyCreatorClaimSignerDelay() {
    return this.#runtimeCall("apply_creator_claim_signer_delay", null, (tx) => [
      tx.object.clock(),
    ]);
  }

  /** `CancelAdmin`. */
  cancelCreatorClaimSignerDelay(options: AdminWitnessInput) {
    return this.#runtimeCall("cancel_creator_claim_signer_delay", options);
  }

  /** `FeeAdmin`; at most `MAX_PROTOCOL_FEE_SHARE_BPS` (7,000). */
  scheduleProtocolFeeShare(
    options: AdminWitnessInput & {
      protocolFeeShareBps: bigint;
      delayMs: bigint;
    },
  ) {
    const share = requireBasisPointsAtMost(
      "protocolFeeShareBps",
      options.protocolFeeShareBps,
      MAX_PROTOCOL_FEE_SHARE_BPS,
    );
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#runtimeCall("schedule_protocol_fee_share", options, (tx) => [
      this.core.bps(share)(tx),
      tx.pure.u64(delayMs),
      tx.object.clock(),
    ]);
  }

  applyProtocolFeeShare() {
    return this.#runtimeCall("apply_protocol_fee_share", null, (tx) => [
      tx.object.clock(),
    ]);
  }

  /** `CancelAdmin`. */
  cancelProtocolFeeShare(options: AdminWitnessInput) {
    return this.#runtimeCall("cancel_protocol_fee_share", options);
  }

  // `launch` creator-cap governance.

  /** `CreatorAdmin`: this launch's curve-fee cap reassignment delay. */
  scheduleCurveFeeCapDelay(
    options: LaunchInput & AdminWitnessInput & { delayMs: bigint },
  ) {
    return this.#capDelay("schedule_curve_fee_cap_delay", options);
  }

  /** `CreatorAdmin`: a replacement curve-fee cap recipient, after the delay. */
  scheduleCurveFeeCapReassignment(
    options: LaunchInput & AdminWitnessInput & { recipient: string },
  ) {
    return this.#capReassignment(
      "schedule_curve_fee_cap_reassignment",
      options,
    );
  }

  /** `CancelAdmin`. */
  cancelCurveFeeCapReassignment(options: LaunchInput & AdminWitnessInput) {
    return this.#launchCall(
      "cancel_curve_fee_cap_reassignment",
      options,
      (tx) => [tx.object(options.adminWitness)],
    );
  }

  applyCurveFeeCapDelay(options: LaunchInput) {
    return this.#launchCall("apply_curve_fee_cap_delay", options, (tx) => [
      tx.object.clock(),
    ]);
  }

  /** Anyone: issues a fresh curve-fee cap to the ready recipient. */
  applyCurveFeeCapReassignment(options: LaunchInput) {
    return this.#launchCall(
      "apply_curve_fee_cap_reassignment",
      options,
      (tx) => [tx.object.clock()],
    );
  }

  /** `CreatorAdmin`: this launch's creator metadata cap reassignment delay. */
  scheduleCreatorMetadataCapDelay(
    options: LaunchInput & AdminWitnessInput & { delayMs: bigint },
  ) {
    return this.#capDelay("schedule_creator_metadata_cap_delay", options);
  }

  /** `CreatorAdmin`: a replacement creator metadata cap recipient, after the delay. */
  scheduleCreatorMetadataCapReassignment(
    options: LaunchInput & AdminWitnessInput & { recipient: string },
  ) {
    return this.#capReassignment(
      "schedule_creator_metadata_cap_reassignment",
      options,
    );
  }

  /** `CancelAdmin`. */
  cancelCreatorMetadataCapReassignment(
    options: LaunchInput & AdminWitnessInput,
  ) {
    return this.#launchCall(
      "cancel_creator_metadata_cap_reassignment",
      options,
      (tx) => [tx.object(options.adminWitness)],
    );
  }

  applyCreatorMetadataCapDelay(options: LaunchInput) {
    return this.#launchCall(
      "apply_creator_metadata_cap_delay",
      options,
      (tx) => [tx.object.clock()],
    );
  }

  /** Anyone: issues a fresh creator metadata cap to the ready recipient. */
  applyCreatorMetadataCapReassignment(options: LaunchInput) {
    return this.#launchCall(
      "apply_creator_metadata_cap_reassignment",
      options,
      (tx) => [tx.object.clock()],
    );
  }

  #capDelay(
    functionName: string,
    options: LaunchInput & AdminWitnessInput & { delayMs: bigint },
  ) {
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#launchCall(functionName, options, (tx) => [
      tx.object(options.adminWitness),
      tx.pure.u64(delayMs),
      tx.object.clock(),
    ]);
  }

  #capReassignment(
    functionName: string,
    options: LaunchInput & AdminWitnessInput & { recipient: string },
  ) {
    const recipient = normalizeSuiAddress(options.recipient);
    if (BigInt(recipient) === 0n) {
      throw new RangeError("recipient must be a nonzero Sui address");
    }
    return this.#launchCall(functionName, options, (tx) => [
      tx.object(options.adminWitness),
      tx.pure.address(recipient),
      tx.object.clock(),
    ]);
  }

  /** `launch_config::<fn>(config (mut), package_version, admin_witness, ...)`. */
  #configCall(
    functionName: string,
    options: AdminWitnessInput,
    extra: (tx: Transaction) => TransactionArgument[] = () => [],
    typeArguments: string[] = [],
  ) {
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch_config", functionName),
        typeArguments,
        arguments: [
          this.#launchConfig(tx, true),
          this.#packageVersion(tx),
          tx.object(options.adminWitness),
          ...extra(tx),
        ],
      });
  }

  /** `launch_config::apply_*(config (mut), package_version, clock)`. */
  #applyConfig(functionName: string, typeArguments: string[] = []) {
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch_config", functionName),
        typeArguments,
        arguments: [
          this.#launchConfig(tx, true),
          this.#packageVersion(tx),
          tx.object.clock(),
        ],
      });
  }

  /** `runtime_config::<fn>(config (mut), package_version, [admin_witness], ...)`. */
  #runtimeCall(
    functionName: string,
    options: AdminWitnessInput | null,
    extra: (tx: Transaction) => TransactionArgument[] = () => [],
  ) {
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("runtime_config", functionName),
        arguments: [
          this.#runtimeConfig(tx, true),
          this.#packageVersion(tx),
          ...(options ? [tx.object(options.adminWitness)] : []),
          ...extra(tx),
        ],
      });
  }

  /** `launch::<fn><Meme, Quote>(launch (mut), package_version, ...)`. */
  #launchCall(
    functionName: string,
    options: LaunchInput,
    extra: (tx: Transaction) => TransactionArgument[],
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch", functionName),
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          this.#packageVersion(tx),
          ...extra(tx),
        ],
      });
  }

  #initializerCall(
    functionName: string,
    options: LaunchInitializerInput,
    extra: (tx: Transaction) => TransactionArgument[],
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch", functionName),
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          options.initializer,
          this.#packageVersion(tx),
          ...extra(tx),
        ],
      });
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
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("launch", functionName),
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, options.launch.mutable),
          this.#packageVersion(tx),
          tx.object(options.creatorMetadataCap),
          sharedObject(tx, "currency", options.currency, true),
          tx.pure.string(value),
        ],
      });
  }

  #target(module: string, functionName: string): string {
    return `${this.deployment.packageId}::${module}::${functionName}`;
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

  #treasury(tx: Transaction): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.core.treasury, false);
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

/** Launchpad settings `configureNow` applies at a zero delay. */
export type LaunchpadSettings = {
  tradeFees?: { quoteFeeBps: bigint; memeFeeBps: bigint };
  protocolAllocation?: { memeBps: bigint; quoteBps: bigint };
  protocolLpFees?: { memeBps: bigint; quoteBps: bigint };
  /** SUI, in MIST, each launch pays at creation. */
  creationFee?: bigint;
  protocolFeeShareBps?: bigint;
};

/**
 * The delay `armNotices` gives each named value, in milliseconds. A setting
 * restates its applied value beside its new delay. The upgrade delay is the
 * generic administration's (`AdminCalls.scheduleUpgradeDelay`).
 */
export type LaunchpadNotices = {
  tradeFees?: { quoteFeeBps: bigint; memeFeeBps: bigint; delayMs: bigint };
  protocolAllocation?: { memeBps: bigint; quoteBps: bigint; delayMs: bigint };
  protocolLpFees?: { memeBps: bigint; quoteBps: bigint; delayMs: bigint };
  creationFee?: { creationFee: bigint; delayMs: bigint };
  protocolFeeShare?: { protocolFeeShareBps: bigint; delayMs: bigint };
  /** The delay of each later venue admission. */
  venueDelayMs?: bigint;
  /** The delay of each later account-claim signer admission. */
  claimSignerDelayMs?: bigint;
};

/** Admissions `configureNow` makes: venues and signers at a zero delay, the rest at once. */
type ImmediateAdmissions = {
  /** Venue witness types (`venueWitnessType`). */
  venueTypes?: readonly string[];
  /** Keys that may sign account claims; both delays start at zero. */
  creatorClaimSigners?: readonly ClaimSignerPublicKey[];
  quoteTypes?: readonly string[];
  /** Meme precisions to admit beyond the published six and nine. */
  memeDecimals?: readonly number[];
  partners?: readonly SharedObjectReference<false>[];
};

/** The owned objects a Meme publication sends the publisher (`readMemePublication`). */
export type LaunchTicketInput = {
  ticket: TransactionObjectInput;
  treasuryCap: TransactionObjectInput;
};

/** A launch's vault and the curve-fee cap that proves ownership of it. */
type VaultOwnerInput = LaunchTypes & {
  launch: SharedObjectReference;
  curveFeeCapId: string;
  vault: SharedObjectIdentity;
};

export class LaunchpadTransactions {
  readonly call: LaunchpadCalls;
  readonly migrators: MigratorCalls;
  readonly vault: VaultCalls;
  readonly #useGasCoin: boolean;

  constructor(
    deployment: LaunchpadDeployment,
    options: CoinSourceOptions = {},
  ) {
    this.call = new LaunchpadCalls(deployment);
    this.migrators = new MigratorCalls(this.call.deployment.migrators);
    this.vault = new VaultCalls(this.call.deployment.vault);
    this.#useGasCoin = options.useGasCoin ?? true;
  }

  /**
   * Publishes the generated Meme package and makes it immutable. Its
   * initializer transfers the `LaunchTicket<Meme>` and the `TreasuryCap<Meme>`
   * to the sender (`readMemePublication`), who then runs `createLaunch`.
   */
  publishMeme(options: MemeTemplateOptions): Transaction {
    const { deployment } = this.call;
    const tx = new Transaction();
    const upgradeCap = tx.add(async (innerTx) => {
      const module = await buildMemePackageBytecode(
        options,
        deployment.originalPackageId,
      );
      return innerTx.publish({
        modules: [Array.from(module)],
        dependencies: [
          MOVE_STDLIB_ADDRESS,
          SUI_FRAMEWORK_ADDRESS,
          deployment.admin.packageId,
          deployment.partners.packageId,
          deployment.vestingPackageId,
          deployment.core.packageId,
          deployment.packageId,
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
   * One PTB from a published Meme to a shared launch: the venue's `prepare`
   * (the `TreasuryCap` by reference) returns the `VenueTicket`, `launch::new`
   * takes the ticket and the cap by value, the settings follow, the exact SUI
   * `creationFee` (`LaunchConfigState.creationFee`) pays `finalize`, the
   * optional purchase or opening-round bid runs on the owned launch and its
   * coins go to `preShareBuy.recipient`, and `share` opens it. `currency` is
   * the shared `Currency<Meme>` (`readCurrencyRegistration`).
   */
  createLaunch(
    options: LaunchTypes &
      LaunchTicketInput &
      LaunchVenue &
      LaunchSettings & {
        currency: SharedObjectReference<true>;
        creationFee: bigint;
        preShareBuy?: PreShareBuyInput;
      } & CoinSourceOptions,
  ): Transaction {
    const { call } = this;
    const { openingRoundMs = 0n, partner, preShareBuy } = options;
    const useGasCoin = options.useGasCoin ?? this.#useGasCoin;
    const creationFee = requireU64("creationFee", options.creationFee);
    if (preShareBuy) requirePositiveU64("quoteAmount", preShareBuy.quoteAmount);
    const tx = new Transaction();
    const treasuryCap = tx.object(options.treasuryCap);
    const venueTicket = tx.add(
      options.venue === "cetus"
        ? this.migrators.prepareCetus({
            ...options,
            cetus: options.cetus,
            treasuryCap,
            tickSpacing: options.tier.tickSpacing,
          })
        : this.migrators.prepareBluefin({
            ...options,
            treasuryCap,
            currency: options.currency,
            tickSpacing: options.tier.tickSpacing,
            feeRate: options.tier.feeRate,
          }),
    );
    const initializer = tx.add(
      call.newLaunch({ ...options, treasuryCap, venueTicket }),
    );
    const settings = { ...options, initializer };
    tx.add(call.setVirtualQuote(settings));
    tx.add(call.setGraduationTarget(settings));
    tx.add(call.setAllocationPlan(settings));
    tx.add(call.setLpFeeSplit(settings));
    if (openingRoundMs > 0n)
      tx.add(call.setOpeningRound({ ...settings, openingRoundMs }));
    if (partner) tx.add(call.setPartner({ ...settings, partner }));
    const launch = tx.add(
      call.finalize({
        ...settings,
        creationFee: tx.coin({
          type: "0x2::sui::SUI",
          balance: creationFee,
          useGasCoin,
        }),
      }),
    );
    if (preShareBuy) {
      const quoteCoin = tx.coin({
        type: normalizeStructTag(options.quoteType),
        balance: preShareBuy.quoteAmount,
        useGasCoin,
      });
      if (openingRoundMs > 0n) {
        tx.add(call.joinOpeningRound({ ...options, launch, quoteCoin }));
      } else {
        const bought = tx.add(
          call.buy({
            ...options,
            launch,
            quoteCoin,
            minMemeOut: preShareBuy.minMemeOut,
          }),
        );
        tx.transferObjects(
          moveResults(bought, 2),
          normalizeSuiAddress(preShareBuy.recipient),
        );
      }
    }
    tx.add(call.share({ ...options, launch }));
    return tx;
  }

  /**
   * The two-call migration, one PTB, anyone: `launch::migrate` returns the
   * `Migration`, which the launch's venue (`LaunchState.venue`, `venueOf`)
   * redeems at once into its pool and vault.
   */
  migrate(
    options: LaunchInput &
      MigrationVenue & {
        currency: SharedObjectReference<true>;
      } & CoinSourceOptions,
  ): Transaction {
    const tx = new Transaction();
    const migration = tx.add(this.call.migrate(options));
    if (options.venue === "cetus") {
      tx.add(
        this.migrators.migrateCetus({
          ...options,
          migration,
          cetus: options.cetus,
        }),
      );
    } else {
      tx.add(
        this.migrators.migrateBluefin({
          ...options,
          migration,
          currency: options.currency,
          quoteCurrency: options.quoteCurrency,
          bluefinConfig: options.bluefinConfig,
          creationFee: tx.coin({
            type: "0x2::sui::SUI",
            balance: requireU64("creationFee", options.creationFee),
            useGasCoin: options.useGasCoin ?? this.#useGasCoin,
          }),
        }),
      );
    }
    return tx;
  }

  /**
   * `prove_owner` with the launch's live `CurveFeeCap`, then
   * `vault::claim_owner_balances`; both coins go to `recipient`. The vault
   * aborts when both owner balances are zero (`VaultState.ownerMeme`,
   * `ownerQuote`).
   */
  claimOwnerBalances(
    options: VaultOwnerInput & { recipient: string },
  ): Transaction {
    const tx = new Transaction();
    const proof = tx.add(this.#proveOwner(options));
    const coins = tx.add(this.vault.claimOwnerBalances({ ...options, proof }));
    tx.transferObjects(
      moveResults(coins, 2),
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  /** `prove_owner`, then `vault::schedule_fee_split` of `feeSplit`. */
  scheduleFeeSplit(
    options: VaultOwnerInput & { feeSplit: FeeSplit },
  ): Transaction {
    const split = this.call.core.feeSplit(options.feeSplit);
    const tx = new Transaction();
    const proof = tx.add(this.#proveOwner(options));
    tx.add(
      this.vault.scheduleFeeSplit({ ...options, proof, proposed: split(tx) }),
    );
    return tx;
  }

  /** `prove_owner`, then `vault::cancel_fee_split`. */
  cancelFeeSplit(options: VaultOwnerInput): Transaction {
    const tx = new Transaction();
    const proof = tx.add(this.#proveOwner(options));
    tx.add(this.vault.cancelFeeSplit({ ...options, proof }));
    return tx;
  }

  buy(
    options: LaunchInput & {
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
    const bought = tx.add(this.call.buy({ ...options, quoteCoin }));
    tx.transferObjects(
      moveResults(bought, 2),
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  sell(
    options: LaunchInput & {
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
    options: LaunchInput & {
      recipient: string;
      accountAttestation?: Uint8Array | null;
    },
  ): Transaction {
    const tx = new Transaction();
    const caps = tx.add(this.call.claimCreatorCaps(options));
    tx.transferObjects(
      moveResults(caps, 2),
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  claimCreatorFees(
    options: LaunchInput & { curveFeeCapId: string; recipient: string },
  ): Transaction {
    const tx = new Transaction();
    const fees = tx.add(
      this.call.claimCreatorFees({
        ...options,
        curveFeeCap: options.curveFeeCapId,
      }),
    );
    tx.transferObjects(
      moveResults(fees, 2),
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  setName(
    options: Omit<MemeMetadataUpdate, "creatorMetadataCap"> & {
      creatorMetadataCapId: string;
      name: string;
    },
  ): Transaction {
    return single(
      this.call.setName({
        ...options,
        creatorMetadataCap: options.creatorMetadataCapId,
      }),
    );
  }

  setDescription(
    options: Omit<MemeMetadataUpdate, "creatorMetadataCap"> & {
      creatorMetadataCapId: string;
      description: string;
    },
  ): Transaction {
    return single(
      this.call.setDescription({
        ...options,
        creatorMetadataCap: options.creatorMetadataCapId,
      }),
    );
  }

  setIconUrl(
    options: Omit<MemeMetadataUpdate, "creatorMetadataCap"> & {
      creatorMetadataCapId: string;
      iconUrl: string;
    },
  ): Transaction {
    return single(
      this.call.setIconUrl({
        ...options,
        creatorMetadataCap: options.creatorMetadataCapId,
      }),
    );
  }

  /**
   * Pays Blast's launch fees to the core treasury; any sender may claim. Pass
   * the launch's `partner` exactly when `LaunchState.partnerId` is set.
   */
  claimProtocolFees(
    options: LaunchInput & { partner?: SharedObjectReference<false> | null },
  ): Transaction {
    const { partner } = options;
    return single(
      partner
        ? this.call.claimProtocolFeesWithPartner({ ...options, partner })
        : this.call.claimProtocolFees(options),
    );
  }

  /**
   * Shares a published Meme's `Currency<Meme>` through
   * `coin_registry::finalize_registration`, the step between publication and
   * `createLaunch`. Anyone may run it; `readCurrencyRegistration` reads the
   * shared currency from its effects.
   */
  finalizeCurrencyRegistration(options: {
    memeType: string;
    currency: ObjectVersionReference;
  }): Transaction {
    return single(this.call.finalizeCurrencyRegistration(options));
  }

  /** Adds a bid of `quoteAmount` to the sender's opening-round bid. */
  joinOpeningRound(
    options: LaunchInput & { quoteAmount: bigint } & CoinSourceOptions,
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

  settleOpeningRound(options: LaunchInput): Transaction {
    return single(this.call.settleOpeningRound(options));
  }

  /** Delivers each bidder's share of a settled opening round in one PTB. */
  deliverOpeningRound(
    options: LaunchInput & { bidders: readonly string[] },
  ): Transaction {
    const tx = new Transaction();
    for (const bidder of options.bidders) {
      tx.add(this.call.deliverOpeningRound({ ...options, bidder }));
    }
    return tx;
  }

  // Administrator actions, each signed in as its role in the same PTB.

  setMemeDecimalsAllowed(
    options: AdminCap & { decimals: number; allowed: boolean },
  ): Transaction {
    return this.#asAdmin(options, "ListingAdmin", (adminWitness) =>
      this.call.setMemeDecimalsAllowed({ ...options, adminWitness }),
    );
  }

  setQuoteAllowed(
    options: AdminCap & { quoteType: string; allowed: boolean },
  ): Transaction {
    return this.#asAdmin(options, "ListingAdmin", (adminWitness) =>
      this.call.setQuoteAllowed({ ...options, adminWitness }),
    );
  }

  addPartner(
    options: AdminCap & { partner: SharedObjectReference<false> },
  ): Transaction {
    return this.#asAdmin(options, "FeeAdmin", (adminWitness) =>
      this.call.addPartner({ ...options, adminWitness }),
    );
  }

  removePartner(
    options: AdminCap & { partner: SharedObjectReference<false> },
  ): Transaction {
    return this.#asAdmin(options, "FeeAdmin", (adminWitness) =>
      this.call.removePartner({ ...options, adminWitness }),
    );
  }

  scheduleProtocolAllocation(
    options: AdminCap & { memeBps: bigint; quoteBps: bigint; delayMs: bigint },
  ): Transaction {
    return this.#asAdmin(options, "TreasuryAdmin", (adminWitness) =>
      this.call.scheduleProtocolAllocation({ ...options, adminWitness }),
    );
  }

  applyProtocolAllocation(): Transaction {
    return single(this.call.applyProtocolAllocation());
  }

  cancelProtocolAllocation(options: AdminCap): Transaction {
    return this.#asAdmin(options, "CancelAdmin", (adminWitness) =>
      this.call.cancelProtocolAllocation({ adminWitness }),
    );
  }

  scheduleProtocolLpFees(
    options: AdminCap & { memeBps: bigint; quoteBps: bigint; delayMs: bigint },
  ): Transaction {
    return this.#asAdmin(options, "FeeAdmin", (adminWitness) =>
      this.call.scheduleProtocolLpFees({ ...options, adminWitness }),
    );
  }

  applyProtocolLpFees(): Transaction {
    return single(this.call.applyProtocolLpFees());
  }

  cancelProtocolLpFees(options: AdminCap): Transaction {
    return this.#asAdmin(options, "CancelAdmin", (adminWitness) =>
      this.call.cancelProtocolLpFees({ adminWitness }),
    );
  }

  scheduleTradeFees(
    options: AdminCap & {
      quoteFeeBps: bigint;
      memeFeeBps: bigint;
      delayMs: bigint;
    },
  ): Transaction {
    return this.#asAdmin(options, "FeeAdmin", (adminWitness) =>
      this.call.scheduleTradeFees({ ...options, adminWitness }),
    );
  }

  applyTradeFees(): Transaction {
    return single(this.call.applyTradeFees());
  }

  cancelTradeFees(options: AdminCap): Transaction {
    return this.#asAdmin(options, "CancelAdmin", (adminWitness) =>
      this.call.cancelTradeFees({ adminWitness }),
    );
  }

  scheduleCreationFee(
    options: AdminCap & { creationFee: bigint; delayMs: bigint },
  ): Transaction {
    return this.#asAdmin(options, "FeeAdmin", (adminWitness) =>
      this.call.scheduleCreationFee({ ...options, adminWitness }),
    );
  }

  applyCreationFee(): Transaction {
    return single(this.call.applyCreationFee());
  }

  cancelCreationFee(options: AdminCap): Transaction {
    return this.#asAdmin(options, "CancelAdmin", (adminWitness) =>
      this.call.cancelCreationFee({ adminWitness }),
    );
  }

  scheduleVenue(options: AdminCap & VenueTypeInput): Transaction {
    return this.#asAdmin(options, "VenueAdmin", (adminWitness) =>
      this.call.scheduleVenue({ ...options, adminWitness }),
    );
  }

  applyVenue(options: VenueTypeInput): Transaction {
    return single(this.call.applyVenue(options));
  }

  cancelVenue(options: AdminCap & VenueTypeInput): Transaction {
    return this.#asAdmin(options, "CancelAdmin", (adminWitness) =>
      this.call.cancelVenue({ ...options, adminWitness }),
    );
  }

  removeVenue(options: AdminCap & VenueTypeInput): Transaction {
    return this.#asAdmin(options, "VenueAdmin", (adminWitness) =>
      this.call.removeVenue({ ...options, adminWitness }),
    );
  }

  scheduleVenueDelay(options: AdminCap & { delayMs: bigint }): Transaction {
    return this.#asAdmin(options, "VenueAdmin", (adminWitness) =>
      this.call.scheduleVenueDelay({ ...options, adminWitness }),
    );
  }

  applyVenueDelay(): Transaction {
    return single(this.call.applyVenueDelay());
  }

  cancelVenueDelay(options: AdminCap): Transaction {
    return this.#asAdmin(options, "CancelAdmin", (adminWitness) =>
      this.call.cancelVenueDelay({ adminWitness }),
    );
  }

  /** Signs in as `UnpauseAdmin<BLAST_FUN>` and runs `launch_config::unpause`. */
  unpause(options: AdminCap & { bits: number }): Transaction {
    const { call } = this;
    const tx = new Transaction();
    const unpauseAdmin = tx.add(
      call.admin.signIn({
        adminCap: options.adminCapId,
        role: packageRoleType(call.deployment.admin, call.otw, "UnpauseAdmin"),
      }),
    );
    tx.add(call.unpause({ unpauseAdmin, bits: options.bits }));
    return tx;
  }

  scheduleCreatorClaimSigner(
    options: AdminCap & { signerPublicKey: ClaimSignerPublicKey },
  ): Transaction {
    return this.#asAdmin(options, "ClaimSignerAdmin", (adminWitness) =>
      this.call.scheduleCreatorClaimSigner({ ...options, adminWitness }),
    );
  }

  applyCreatorClaimSigner(options: {
    signerPublicKey: ClaimSignerPublicKey;
  }): Transaction {
    return single(this.call.applyCreatorClaimSigner(options));
  }

  cancelCreatorClaimSigner(
    options: AdminCap & { signerPublicKey: ClaimSignerPublicKey },
  ): Transaction {
    return this.#asAdmin(options, "CancelAdmin", (adminWitness) =>
      this.call.cancelCreatorClaimSigner({ ...options, adminWitness }),
    );
  }

  revokeCreatorClaimSigner(
    options: AdminCap & { signerPublicKey: ClaimSignerPublicKey },
  ): Transaction {
    return this.#asAdmin(options, "ClaimSignerAdmin", (adminWitness) =>
      this.call.revokeCreatorClaimSigner({ ...options, adminWitness }),
    );
  }

  scheduleCreatorClaimSignerDelay(
    options: AdminCap & { delayMs: bigint },
  ): Transaction {
    return this.#asAdmin(options, "ClaimSignerAdmin", (adminWitness) =>
      this.call.scheduleCreatorClaimSignerDelay({ ...options, adminWitness }),
    );
  }

  applyCreatorClaimSignerDelay(): Transaction {
    return single(this.call.applyCreatorClaimSignerDelay());
  }

  cancelCreatorClaimSignerDelay(options: AdminCap): Transaction {
    return this.#asAdmin(options, "CancelAdmin", (adminWitness) =>
      this.call.cancelCreatorClaimSignerDelay({ adminWitness }),
    );
  }

  scheduleProtocolFeeShare(
    options: AdminCap & { protocolFeeShareBps: bigint; delayMs: bigint },
  ): Transaction {
    return this.#asAdmin(options, "FeeAdmin", (adminWitness) =>
      this.call.scheduleProtocolFeeShare({ ...options, adminWitness }),
    );
  }

  applyProtocolFeeShare(): Transaction {
    return single(this.call.applyProtocolFeeShare());
  }

  cancelProtocolFeeShare(options: AdminCap): Transaction {
    return this.#asAdmin(options, "CancelAdmin", (adminWitness) =>
      this.call.cancelProtocolFeeShare({ adminWitness }),
    );
  }

  scheduleCurveFeeCapDelay(
    options: AdminCap & LaunchInput & { delayMs: bigint },
  ): Transaction {
    return this.#asAdmin(options, "CreatorAdmin", (adminWitness) =>
      this.call.scheduleCurveFeeCapDelay({ ...options, adminWitness }),
    );
  }

  scheduleCurveFeeCapReassignment(
    options: AdminCap & LaunchInput & { recipient: string },
  ): Transaction {
    return this.#asAdmin(options, "CreatorAdmin", (adminWitness) =>
      this.call.scheduleCurveFeeCapReassignment({ ...options, adminWitness }),
    );
  }

  cancelCurveFeeCapReassignment(options: AdminCap & LaunchInput): Transaction {
    return this.#asAdmin(options, "CancelAdmin", (adminWitness) =>
      this.call.cancelCurveFeeCapReassignment({ ...options, adminWitness }),
    );
  }

  applyCurveFeeCapDelay(options: LaunchInput): Transaction {
    return single(this.call.applyCurveFeeCapDelay(options));
  }

  applyCurveFeeCapReassignment(options: LaunchInput): Transaction {
    return single(this.call.applyCurveFeeCapReassignment(options));
  }

  scheduleCreatorMetadataCapDelay(
    options: AdminCap & LaunchInput & { delayMs: bigint },
  ): Transaction {
    return this.#asAdmin(options, "CreatorAdmin", (adminWitness) =>
      this.call.scheduleCreatorMetadataCapDelay({ ...options, adminWitness }),
    );
  }

  scheduleCreatorMetadataCapReassignment(
    options: AdminCap & LaunchInput & { recipient: string },
  ): Transaction {
    return this.#asAdmin(options, "CreatorAdmin", (adminWitness) =>
      this.call.scheduleCreatorMetadataCapReassignment({
        ...options,
        adminWitness,
      }),
    );
  }

  cancelCreatorMetadataCapReassignment(
    options: AdminCap & LaunchInput,
  ): Transaction {
    return this.#asAdmin(options, "CancelAdmin", (adminWitness) =>
      this.call.cancelCreatorMetadataCapReassignment({
        ...options,
        adminWitness,
      }),
    );
  }

  applyCreatorMetadataCapDelay(options: LaunchInput): Transaction {
    return single(this.call.applyCreatorMetadataCapDelay(options));
  }

  applyCreatorMetadataCapReassignment(options: LaunchInput): Transaction {
    return single(this.call.applyCreatorMetadataCapReassignment(options));
  }

  /**
   * Configures a fresh launchpad whose delays are still zero, in one PTB:
   * each setting is a schedule and its apply, keeping a zero delay; each
   * venue and claim signer is admitted the same way; Quotes, decimals and
   * partners are admitted at once. Name only settings that change; an
   * unchanged schedule aborts. Then call `armNotices`. The cap needs each
   * setting's role.
   */
  configureNow(
    options: AdminCap & LaunchpadSettings & ImmediateAdmissions,
  ): Transaction {
    const delayMs = 0n;
    const { tradeFees, protocolAllocation, protocolLpFees } = options;
    const { creationFee, protocolFeeShareBps } = options;
    const { venueTypes, creatorClaimSigners, quoteTypes } = options;
    const { memeDecimals, partners } = options;
    return this.#atZeroNotice(options.adminCapId, {
      ...(tradeFees ? { tradeFees: { ...tradeFees, delayMs } } : {}),
      ...(protocolAllocation
        ? { protocolAllocation: { ...protocolAllocation, delayMs } }
        : {}),
      ...(protocolLpFees
        ? { protocolLpFees: { ...protocolLpFees, delayMs } }
        : {}),
      ...(creationFee === undefined
        ? {}
        : { creationFee: { creationFee, delayMs } }),
      ...(protocolFeeShareBps === undefined
        ? {}
        : { protocolFeeShare: { protocolFeeShareBps, delayMs } }),
      ...(venueTypes ? { venueTypes } : {}),
      ...(creatorClaimSigners ? { creatorClaimSigners } : {}),
      ...(quoteTypes ? { quoteTypes } : {}),
      ...(memeDecimals ? { memeDecimals } : {}),
      ...(partners ? { partners } : {}),
    });
  }

  /**
   * Raises each named delay from zero in one PTB: a schedule and its apply.
   * A setting restates its applied value, since its schedule proposes a value
   * and next delay together. Run after `configureNow`; once armed, every
   * later change waits its delay, and `unpause` may run.
   */
  armNotices(options: AdminCap & LaunchpadNotices): Transaction {
    return this.#atZeroNotice(options.adminCapId, options);
  }

  #atZeroNotice(
    adminCapId: string,
    notices: LaunchpadNotices & ImmediateAdmissions,
  ): Transaction {
    const tx = new Transaction();
    const witnesses = new Map<CoreRole, TransactionObjectArgument>();
    const as = (role: CoreRole) => {
      let adminWitness = witnesses.get(role);
      if (!adminWitness) {
        adminWitness = tx.add(this.call.signIn({ adminCap: adminCapId, role }));
        witnesses.set(role, adminWitness);
      }
      return adminWitness;
    };
    this.#admitNow(tx, as, notices);
    this.#scheduleSettings(tx, as, notices);
    this.#scheduleSets(tx, as, notices);
    return tx;
  }

  /** Quotes, decimals and partners, admitted at once. */
  #admitNow(tx: Transaction, as: SignIn, notices: ImmediateAdmissions): void {
    const { call } = this;
    for (const quoteType of notices.quoteTypes ?? []) {
      tx.add(
        call.setQuoteAllowed({
          quoteType,
          allowed: true,
          adminWitness: as("ListingAdmin"),
        }),
      );
    }
    for (const decimals of notices.memeDecimals ?? []) {
      tx.add(
        call.setMemeDecimalsAllowed({
          decimals,
          allowed: true,
          adminWitness: as("ListingAdmin"),
        }),
      );
    }
    for (const partner of notices.partners ?? []) {
      tx.add(call.addPartner({ partner, adminWitness: as("FeeAdmin") }));
    }
  }

  /** Each named setting: a schedule and its apply. */
  #scheduleSettings(
    tx: Transaction,
    as: SignIn,
    notices: LaunchpadNotices,
  ): void {
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
    if (notices.protocolLpFees) {
      tx.add(
        call.scheduleProtocolLpFees({
          ...notices.protocolLpFees,
          adminWitness: as("FeeAdmin"),
        }),
      );
      tx.add(call.applyProtocolLpFees());
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
  }

  /** Venue and signer admissions and delays: a schedule and its apply each. */
  #scheduleSets(
    tx: Transaction,
    as: SignIn,
    notices: LaunchpadNotices & ImmediateAdmissions,
  ): void {
    const { call } = this;
    for (const venueType of notices.venueTypes ?? []) {
      tx.add(call.scheduleVenue({ venueType, adminWitness: as("VenueAdmin") }));
      tx.add(call.applyVenue({ venueType }));
    }
    if (notices.venueDelayMs !== undefined) {
      tx.add(
        call.scheduleVenueDelay({
          delayMs: notices.venueDelayMs,
          adminWitness: as("VenueAdmin"),
        }),
      );
      tx.add(call.applyVenueDelay());
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
  }

  #proveOwner(options: VaultOwnerInput) {
    return this.call.proveOwner({
      ...options,
      curveFeeCap: options.curveFeeCapId,
    });
  }

  /** Signs in as `role` and runs one administrator call in the same PTB. */
  #asAdmin(
    options: AdminCap,
    role: CoreRole,
    call: (
      adminWitness: TransactionObjectArgument,
    ) => (tx: Transaction) => TransactionResult,
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn({ adminCap: options.adminCapId, role }),
    );
    tx.add(call(adminWitness));
    return tx;
  }
}

/** The `AdminCap` an administrator signs in with. */
type AdminCap = { adminCapId: string };

/** This PTB's one `AdminWitness` per role. */
type SignIn = (role: CoreRole) => TransactionObjectArgument;

function single(step: (tx: Transaction) => TransactionResult): Transaction {
  const tx = new Transaction();
  tx.add(step);
  return tx;
}

function normalizeDeployment(
  deployment: LaunchpadDeployment,
): LaunchpadDeployment {
  const shared = (name: keyof LaunchpadDeployment & string) =>
    normalizeSharedObjectIdentity(
      `launchpad.${name}`,
      deployment[name] as SharedObjectIdentity,
    );
  return {
    ...normalizeSuiPackageReference("launchpad", deployment),
    packageVersion: shared("packageVersion"),
    packageAdmin: shared("packageAdmin"),
    launchConfig: shared("launchConfig"),
    runtimeConfig: shared("runtimeConfig"),
    launchRegistry: shared("launchRegistry"),
    core: normalizeCoreDeployment(deployment.core),
    admin: normalizeAdminDeployment(deployment.admin),
    partners: {
      packageId: normalizeSuiObjectId(deployment.partners.packageId),
      admin: normalizeAdminDeployment(deployment.partners.admin),
    },
    vault: normalizeVaultDeployment(deployment.vault),
    migrators: normalizeMigratorsDeployment(deployment.migrators),
    vestingPackageId: normalizeSuiObjectId(deployment.vestingPackageId),
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

function launchArgument(
  tx: Transaction,
  launch: SharedObjectReference<true> | TransactionArgument,
): TransactionArgument {
  return "objectId" in launch
    ? sharedObject(tx, "launch", launch, true)
    : launch;
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
