import type {
  AdminDeployment,
  PackageRole,
} from "@interest-protocol/blast-admin-sdk/transactions";
import {
  AdminCalls,
  normalizeAdminDeployment,
  packageRoleType,
  requirePauseBits,
} from "@interest-protocol/blast-admin-sdk/transactions";
import { MAX_LP_FEE_BPS } from "@interest-protocol/blast-core/bps";
import type { CoinSourceOptions } from "@interest-protocol/blast-core/coins";
import type { CoreDeployment } from "@interest-protocol/blast-core/deployment";
import {
  CoreCalls,
  normalizeCoreDeployment,
} from "@interest-protocol/blast-core/deployment";
import type { ObjectVersionReference } from "@interest-protocol/blast-core/effects";
import { finalizeCurrencyRegistration } from "@interest-protocol/blast-core/effects";
import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import {
  requireBasisPointsAtMost,
  requireU64,
} from "@interest-protocol/blast-core/integers";
import type { VestingTerms } from "@interest-protocol/blast-core/payout";
import {
  deploymentObject,
  moveResults,
} from "@interest-protocol/blast-core/ptb";
import type { CoreRole } from "@interest-protocol/blast-core/roles";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import type { MigratorsDeployment } from "@interest-protocol/blast-migrators-sdk/transactions";
import {
  MigratorCalls,
  normalizeMigratorsDeployment,
  venueWitnessType,
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
  isValidSuiAddress,
  MOVE_STDLIB_ADDRESS,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
  SUI_FRAMEWORK_ADDRESS,
} from "@mysten/sui/utils";
import type { AftermathDaoPresaleDeployment } from "./aftermath-dao.ts";
import {
  AftermathDaoPresaleCalls,
  normalizeAftermathDaoPresaleDeployment,
} from "./aftermath-dao.ts";
import type { AftermathLpCoin } from "./aftermath-lp.ts";
import { assertAftermathLpCoin } from "./aftermath-lp.ts";
import type { AllowlistProof } from "./allowlist.ts";
import {
  allowlistedEligibility,
  openEligibility,
  uncappedForAnyone,
} from "./math.ts";
import type {
  EligibilityPolicy,
  HardCap,
  ProtocolFees,
  RecipientShare,
  UncappedPhase,
} from "./state.ts";
import type { PresaleCoinTemplateOptions } from "./template.ts";
import { buildPresaleCoinPackageBytecode } from "./template.ts";

/**
 * The `blast_presale` package and every package its calls and compositions
 * read: its shared `PackageVersion<BLAST_PRESALE_PACKAGE>`,
 * `PackageAdmin<BLAST_PRESALE_PACKAGE>`, `CreationPolicy`, `FeePolicy` and
 * `PresaleRegistry`; core (the treasury), admin (the ACL), partners, the
 * vault, the migrators venues, the vesting package a sale-token publication
 * links, and the Aftermath DAO-pool vendor when published. Calls target
 * `packageId`; types name `originalPackageId`.
 */
export type PresaleDeployment = {
  packageId: string;
  originalPackageId: string;
  packageVersion: SharedObjectIdentity;
  packageAdmin: SharedObjectIdentity;
  creationPolicy: SharedObjectIdentity;
  feePolicy: SharedObjectIdentity;
  presaleRegistry: SharedObjectIdentity;
  core: CoreDeployment;
  admin: AdminDeployment;
  partners: PartnersDeployment;
  vault: VaultDeployment;
  migrators: MigratorsDeployment;
  /** `blast_fun_vesting`, which core links; `publishPresaleCoin` lists it. */
  vestingPackageId: string;
  aftermathDaoPresale?: AftermathDaoPresaleDeployment;
};

/** A sale's type arguments: `<SaleToken, Quote>`. */
export type PresaleTypes = { saleTokenType: string; quoteType: string };

/** One shared `Presale<SaleToken, Quote>` and its types. */
export type PresaleInput = PresaleTypes & { presale: SharedObjectIdentity };

/** Largest Blast share of a sale's raise `fee_policy` accepts. */
export const MAX_PROTOCOL_RAISE_BPS = 1_000n;
/** Largest Blast share of a sale's tokens `fee_policy` accepts. */
export const MAX_PROTOCOL_TOKEN_BPS = 1_000n;

/** `constants::{create,commit,migration}_pause_bit`; flags may be ORed together. */
export const PRESALE_PAUSE_BITS = { Create: 1, Commit: 2, Migrate: 4 } as const;
const PRESALE_PAUSE_MASK =
  PRESALE_PAUSE_BITS.Create |
  PRESALE_PAUSE_BITS.Commit |
  PRESALE_PAUSE_BITS.Migrate;

export function normalizePresaleDeployment(
  deployment: PresaleDeployment,
): PresaleDeployment {
  const shared = (name: keyof PresaleDeployment) =>
    normalizeSharedObjectIdentity(
      `presale.${name}`,
      deployment[name] as SharedObjectIdentity,
    );
  return {
    ...normalizeSuiPackageReference("presale", deployment),
    packageVersion: shared("packageVersion"),
    packageAdmin: shared("packageAdmin"),
    creationPolicy: shared("creationPolicy"),
    feePolicy: shared("feePolicy"),
    presaleRegistry: shared("presaleRegistry"),
    core: normalizeCoreDeployment(deployment.core),
    admin: normalizeAdminDeployment(deployment.admin),
    partners: {
      packageId: normalizeSuiObjectId(deployment.partners.packageId),
      admin: normalizeAdminDeployment(deployment.partners.admin),
    },
    vault: normalizeVaultDeployment(deployment.vault),
    migrators: normalizeMigratorsDeployment(deployment.migrators),
    vestingPackageId: normalizeSuiObjectId(deployment.vestingPackageId),
    ...(deployment.aftermathDaoPresale === undefined
      ? {}
      : {
          aftermathDaoPresale: normalizeAftermathDaoPresaleDeployment(
            deployment.aftermathDaoPresale,
          ),
        }),
  };
}

/**
 * `blast_presale` calls, one per public function the SDK builds, in Move
 * argument order; `&mut TxContext` is implicit, the `Clock` is `0x6`, and the
 * package version, policies, registry and core treasury come from the
 * deployment. An `adminWitness` is `AdminCalls.signIn`'s result for the named
 * `blast_core::blast_domain` role. Value constructors return the value as a
 * transaction result for the setter that takes it.
 */
export class PresaleCalls {
  readonly deployment: PresaleDeployment;
  /** `blast_presale_package::BLAST_PRESALE_PACKAGE`, the package's OTW. */
  readonly otw: string;
  /** `blast_presale_package::PackageWitness`, which seals every sale's vault terms. */
  readonly packageWitnessType: string;
  readonly core: CoreCalls;

  constructor(deployment: PresaleDeployment) {
    this.deployment = normalizePresaleDeployment(deployment);
    this.otw = this.#type("blast_presale_package::BLAST_PRESALE_PACKAGE");
    this.packageWitnessType = this.#type(
      "blast_presale_package::PackageWitness",
    );
    this.core = new CoreCalls(this.deployment.core);
  }

  // Value constructors.

  /** `blast_presale::open_eligibility`. */
  openEligibility(options: {
    walletCap: bigint;
    maxParticipants: bigint;
    minCommitment: bigint;
  }) {
    const { walletCap, maxParticipants, minCommitment } = options;
    openEligibility(walletCap, maxParticipants, minCommitment);
    return (tx: Transaction): TransactionResult =>
      this.#call(tx, "open_eligibility", [
        tx.pure.u64(walletCap),
        tx.pure.u64(maxParticipants),
        tx.pure.u64(minCommitment),
      ]);
  }

  /** `blast_presale::allowlisted_eligibility`; `root` is 32 hex bytes. */
  allowlistedEligibility(options: { root: string; leafCount: bigint }) {
    allowlistedEligibility(options.root, options.leafCount);
    return (tx: Transaction): TransactionResult =>
      this.#call(tx, "allowlisted_eligibility", [
        tx.pure.vector("u8", fromHex(options.root)),
        tx.pure.u64(options.leafCount),
      ]);
  }

  /** `blast_presale::uncapped_for_eligible`. */
  uncappedForEligible(options: { startDelayMs: bigint }) {
    const startDelayMs = requireU64("startDelayMs", options.startDelayMs);
    return (tx: Transaction): TransactionResult =>
      this.#call(tx, "uncapped_for_eligible", [tx.pure.u64(startDelayMs)]);
  }

  /** `blast_presale::uncapped_for_anyone`. */
  uncappedForAnyone(options: {
    startDelayMs: bigint;
    maxParticipants: bigint;
    minCommitment: bigint;
  }) {
    const startDelayMs = requireU64("startDelayMs", options.startDelayMs);
    uncappedForAnyone(
      startDelayMs,
      options.maxParticipants,
      options.minCommitment,
    );
    return (tx: Transaction): TransactionResult =>
      this.#call(tx, "uncapped_for_anyone", [
        tx.pure.u64(startDelayMs),
        tx.pure.u64(options.maxParticipants),
        tx.pure.u64(options.minCommitment),
      ]);
  }

  /**
   * `blast_presale::recipient_share` over core `payout::recipient` (with
   * `vesting_terms` when the recipient vests) and `bps::new`.
   */
  recipientShare(share: RecipientShare) {
    const recipient = this.core.recipient(share.recipient);
    const bps = this.core.bps(share.bps);
    return (tx: Transaction): TransactionResult =>
      this.#call(tx, "recipient_share", [recipient(tx), bps(tx)]);
  }

  // Creation, in one PTB: the presale's venue admission (Cetus), a venue's
  // `prepare`, `new`, the setters, `finalize` and `share`.

  /**
   * `creation_policy::venue_admission<Venue>(creation_policy)`: the presale's
   * `VenueAdmission` of the migrators venue `venueType` (`venueWitnessType`),
   * with which that venue's `prepare` borrows the sale token's sealed
   * `TreasuryCap`. Aborts with `EVenueNotAllowed` unless the venue is admitted
   * now. Ephemeral: consumed by `prepare` in the same PTB.
   */
  venueAdmission(options: { venueType: string }) {
    const venueType = normalizeStructTag(options.venueType);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("creation_policy", "venue_admission"),
        typeArguments: [venueType],
        arguments: [
          deploymentObject(tx, this.deployment.creationPolicy, false),
        ],
      });
  }

  /**
   * `blast_presale::new(sealed_treasury_cap, package_version, venue_ticket,
   * creation_policy, fee_policy)`: opens the sale token's seal
   * (`sale_token::new` sealed it at publication), redeems the venue's
   * `VenueTicket` and returns the `PresaleInitializer` the same PTB
   * configures and finalizes.
   */
  new(
    options: PresaleTypes & {
      sealedTreasuryCap: TransactionObjectInput;
      venueTicket: TransactionArgument;
    },
  ) {
    return (tx: Transaction): TransactionResult =>
      this.#call(
        tx,
        "new",
        [
          tx.object(options.sealedTreasuryCap),
          this.#version(tx),
          options.venueTicket,
          deploymentObject(tx, this.deployment.creationPolicy, false),
          deploymentObject(tx, this.deployment.feePolicy, false),
        ],
        options,
      );
  }

  /** `set_supply`: the complete supply `finalize` mints, then burn-only or fixed. */
  setSupply(options: Initializer & { tokenSupply: bigint; burnable: boolean }) {
    const tokenSupply = requireU64("tokenSupply", options.tokenSupply);
    return this.#setter(options, "set_supply", (tx) => [
      tx.pure.u64(tokenSupply),
      tx.pure.bool(options.burnable),
    ]);
  }

  /** `set_token_allocations`: the buyers', LP's and each recipient's BPS of the supply. */
  setTokenAllocations(
    options: Initializer & {
      tokenAllocationBps: bigint;
      liquidityTokenAllocationBps: bigint;
      recipientAllocations: readonly RecipientShare[];
    },
  ) {
    const token = this.core.bps(options.tokenAllocationBps);
    const liquidity = this.core.bps(options.liquidityTokenAllocationBps);
    const recipients = this.#recipientShares(options.recipientAllocations);
    return this.#setter(options, "set_token_allocations", (tx) => [
      token(tx),
      liquidity(tx),
      recipients(tx),
    ]);
  }

  /** `set_participant_vesting`: each claim locks its tokens under `vestingTerms`. */
  setParticipantVesting(options: Initializer & { vestingTerms: VestingTerms }) {
    const terms = this.core.vestingTerms(options.vestingTerms);
    return this.#setter(options, "set_participant_vesting", (tx) => [
      terms(tx),
    ]);
  }

  /** `set_raise`: the Quote raised and each recipient's BPS of it. */
  setRaise(
    options: Initializer & {
      raiseTarget: bigint;
      raiseAllocations: readonly RecipientShare[];
    },
  ) {
    const raiseTarget = requireU64("raiseTarget", options.raiseTarget);
    const recipients = this.#recipientShares(options.raiseAllocations);
    return this.#setter(options, "set_raise", (tx) => [
      tx.pure.u64(raiseTarget),
      recipients(tx),
    ]);
  }

  /** `set_windows`: the commitment window and the liquidity window after it. */
  setWindows(
    options: Initializer & {
      commitmentDurationMs: bigint;
      liquidityWindowDurationMs: bigint;
    },
  ) {
    const commitment = requireU64(
      "commitmentDurationMs",
      options.commitmentDurationMs,
    );
    const liquidity = requireU64(
      "liquidityWindowDurationMs",
      options.liquidityWindowDurationMs,
    );
    return this.#setter(options, "set_windows", (tx) => [
      tx.pure.u64(commitment),
      tx.pure.u64(liquidity),
    ]);
  }

  /** `set_eligibility` of an `open_eligibility` or `allowlisted_eligibility` value. */
  setEligibility(options: Initializer & { eligibility: EligibilityPolicy }) {
    const { eligibility } = options;
    const policy =
      eligibility.kind === "open"
        ? this.openEligibility(eligibility)
        : this.allowlistedEligibility(eligibility);
    return this.#setter(options, "set_eligibility", (tx) => [policy(tx)]);
  }

  /** `set_uncapped_phase` of an `uncapped_for_eligible` or `uncapped_for_anyone` value. */
  setUncappedPhase(options: Initializer & { uncapped: UncappedPhase }) {
    const { startsAfterMs: startDelayMs, access } = options.uncapped;
    const phase =
      access.kind === "anyone"
        ? this.uncappedForAnyone({ startDelayMs, ...access })
        : this.uncappedForEligible({ startDelayMs });
    return this.#setter(options, "set_uncapped_phase", (tx) => [phase(tx)]);
  }

  /** `set_hard_cap(start_delay_ms, closes_when_filled)`. */
  setHardCap(
    options: Initializer & { startDelayMs: bigint; closesWhenFilled: boolean },
  ) {
    const startDelayMs = requireU64("startDelayMs", options.startDelayMs);
    return this.#setter(options, "set_hard_cap", (tx) => [
      tx.pure.u64(startDelayMs),
      tx.pure.bool(options.closesWhenFilled),
    ]);
  }

  /** `set_fee_split` of a core `fee_split::new` value: the vault's LP-fee split. */
  setFeeSplit(options: Initializer & { feeSplit: FeeSplit }) {
    const split = this.core.feeSplit(options.feeSplit);
    return this.#setter(options, "set_fee_split", (tx) => [split(tx)]);
  }

  /** `set_partner`: a Blast partner the `CreationPolicy` accepts now. */
  setPartner(options: Initializer & { partner: SharedObjectIdentity }) {
    return this.#setter(options, "set_partner", (tx) => [
      deploymentObject(tx, this.deployment.creationPolicy, false),
      deploymentObject(tx, options.partner, false),
      tx.object.clock(),
    ]);
  }

  /**
   * `finalize(initializer, package_version, registry, currency)`: checks every
   * setting, mints and seals the supply, and returns `[Presale, PresaleCap]`;
   * the same PTB must `share` the presale.
   */
  finalize(
    options: Initializer & {
      /** The sale token's confirmed unregulated Coin Registry `Currency`. */
      currency: SharedObjectIdentity;
    },
  ) {
    return (tx: Transaction): TransactionResult =>
      this.#call(
        tx,
        "finalize",
        [
          options.initializer,
          this.#version(tx),
          deploymentObject(tx, this.deployment.presaleRegistry, true),
          deploymentObject(tx, options.currency, true),
        ],
        options,
      );
  }

  /**
   * `share(presale, package_version, commitment_starts_at_ms, clock)`: shares
   * the new sale and fixes its windows from `commitmentStartsAtMs`, or from
   * execution once that has passed.
   */
  share(
    options: PresaleTypes & {
      presale: TransactionArgument;
      commitmentStartsAtMs: bigint;
    },
  ) {
    const startsAtMs = requireU64(
      "commitmentStartsAtMs",
      options.commitmentStartsAtMs,
    );
    return (tx: Transaction): void => {
      this.#call(
        tx,
        "share",
        [
          options.presale,
          this.#version(tx),
          tx.pure.u64(startsAtMs),
          tx.object.clock(),
        ],
        options,
      );
    };
  }

  /**
   * `set_protocol_fees` (`FeeAdmin`): replaces the sale's snapshot of Blast's
   * rates before its window starts, within the applied `FeePolicy`; once
   * shared each rate may only stay or fall. `presale` is the shared sale or
   * `finalize`'s result in its creation PTB.
   */
  setProtocolFees(
    options: PresaleTypes & {
      presale: SharedObjectIdentity | TransactionArgument;
      adminWitness: TransactionObjectInput;
      fees: ProtocolFees;
    },
  ) {
    const rates = rateCalls(this.core, options.fees);
    const { presale } = options;
    return (tx: Transaction): void => {
      this.#call(
        tx,
        "set_protocol_fees",
        [
          "objectId" in presale ? deploymentObject(tx, presale, true) : presale,
          this.#version(tx),
          tx.object(options.adminWitness),
          deploymentObject(tx, this.deployment.feePolicy, false),
          ...rates.map((rate) => rate(tx)),
          tx.object.clock(),
        ],
        options,
      );
    };
  }

  // Sale.

  /** `commit_open`; returns the `Coin<Quote>` a hard cap did not accept. */
  commitOpen(options: PresaleInput & { quoteIn: TransactionArgument }) {
    return this.#presaleCall(options, "commit_open", (tx) => [
      options.quoteIn,
      tx.object.clock(),
    ]);
  }

  /** `commit_allowlisted` with the sender's leaf; returns the change coin. */
  commitAllowlisted(
    options: PresaleInput & {
      quoteIn: TransactionArgument;
      allowlist: AllowlistProof;
    },
  ) {
    const { index, walletCap, proof } = options.allowlist;
    requireU64("index", index);
    requireU64("walletCap", walletCap);
    const siblings = proof.map((sibling) => {
      const bytes = fromHex(sibling);
      if (bytes.length !== 32) throw new RangeError("a proof node is 32 bytes");
      return Array.from(bytes);
    });
    return this.#presaleCall(options, "commit_allowlisted", (tx) => [
      options.quoteIn,
      tx.pure.u64(index),
      tx.pure.u64(walletCap),
      tx.pure.vector("vector<u8>", siblings),
      tx.object.clock(),
    ]);
  }

  /** `commit_uncapped` once a phase open to anyone started; returns the change coin. */
  commitUncapped(options: PresaleInput & { quoteIn: TransactionArgument }) {
    return this.#presaleCall(options, "commit_uncapped", (tx) => [
      options.quoteIn,
      tx.object.clock(),
    ]);
  }

  /** `settle`: funds or cancels the sale after its window, or once it can close early. */
  settle(options: PresaleInput) {
    return this.#presaleCall(options, "settle", (tx) => [tx.object.clock()]);
  }

  /** `cancel_unlaunched`: from the LP deadline, cancels an unmigrated funded sale. */
  cancelUnlaunched(options: PresaleInput) {
    return this.#presaleCall(options, "cancel_unlaunched", (tx) => [
      tx.object.clock(),
    ]);
  }

  /** `claim`: pays or vests `participant`'s tokens and refunds its Quote. Anyone may relay. */
  claim(options: PresaleInput & { participant: string }) {
    const participant = normalizeSuiAddress(options.participant);
    return this.#presaleCall(options, "claim", (tx) => [
      tx.pure.address(participant),
      tx.object.clock(),
    ]);
  }

  /**
   * `migrate(presale, package_version, treasury, clock)`: pays Blast's and
   * the raise recipients' shares (or holds Blast's for a partnered sale),
   * releases the recipients' tokens and returns the `Migration<SaleToken,
   * Quote>` the sale's venue must redeem in the same PTB.
   */
  migrate(options: PresaleInput) {
    return this.#presaleCall(options, "migrate", (tx) => [
      deploymentObject(tx, this.deployment.core.treasury, false),
      tx.object.clock(),
    ]);
  }

  /**
   * `prove_owner(presale, package_version, cap)`: the `OwnerProof` the sale's
   * vault takes for one owner call in the same PTB.
   */
  proveOwner(options: PresaleInput & { presaleCap: TransactionObjectInput }) {
    return (tx: Transaction): TransactionResult =>
      this.#call(
        tx,
        "prove_owner",
        [
          deploymentObject(tx, options.presale, false),
          this.#version(tx),
          tx.object(options.presaleCap),
        ],
        options,
      );
  }

  /**
   * `pay_protocol_fees_with_partner(presale, package_version, treasury,
   * partner)`: pays a migrated partnered sale's held Blast fees, the partner
   * its cut of each rounded down and the treasury the rest. Anyone may call.
   */
  payProtocolFeesWithPartner(
    options: PresaleInput & { partner: SharedObjectIdentity },
  ) {
    return this.#presaleCall(
      options,
      "pay_protocol_fees_with_partner",
      (tx) => [
        deploymentObject(tx, this.deployment.core.treasury, false),
        deploymentObject(tx, options.partner, false),
      ],
    );
  }

  /** `destroy_cap(presale, cap)`: deletes a cancelled sale's `PresaleCap`. */
  destroyCap(options: PresaleInput & { presaleCap: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      this.#call(
        tx,
        "destroy_cap",
        [
          deploymentObject(tx, options.presale, false),
          tx.object(options.presaleCap),
        ],
        options,
      );
    };
  }

  // `creation_policy`.

  /** `creation_policy::set_quote_allowed<Quote>` (`ListingAdmin`). */
  setQuoteAllowed(options: {
    quoteType: string;
    adminWitness: TransactionObjectInput;
    allowed: boolean;
  }) {
    return this.#policyCall(
      "set_quote_allowed",
      [normalizeStructTag(options.quoteType)],
      (tx) => [tx.object(options.adminWitness), tx.pure.bool(options.allowed)],
    );
  }

  /** `creation_policy::schedule_venue<Venue>` (`VenueAdmin`). */
  scheduleVenue(options: {
    venueType: string;
    adminWitness: TransactionObjectInput;
  }) {
    return this.#policyCall(
      "schedule_venue",
      [venueType(options.venueType)],
      (tx) => [tx.object(options.adminWitness), tx.object.clock()],
    );
  }

  /** `creation_policy::apply_venue<Venue>`: anyone, once ready. */
  applyVenue(options: { venueType: string }) {
    return this.#policyCall(
      "apply_venue",
      [venueType(options.venueType)],
      (tx) => [tx.object.clock()],
    );
  }

  /** `creation_policy::cancel_venue<Venue>` (`CancelAdmin`). */
  cancelVenue(options: {
    venueType: string;
    adminWitness: TransactionObjectInput;
  }) {
    return this.#policyCall(
      "cancel_venue",
      [venueType(options.venueType)],
      (tx) => [tx.object(options.adminWitness)],
    );
  }

  /** `creation_policy::remove_venue<Venue>` (`VenueAdmin`): at once, for new sales. */
  removeVenue(options: {
    venueType: string;
    adminWitness: TransactionObjectInput;
  }) {
    return this.#policyCall(
      "remove_venue",
      [venueType(options.venueType)],
      (tx) => [tx.object(options.adminWitness)],
    );
  }

  /** `creation_policy::schedule_venue_delay` (`VenueAdmin`). */
  scheduleVenueDelay(options: {
    adminWitness: TransactionObjectInput;
    delayMs: bigint;
  }) {
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#policyCall("schedule_venue_delay", [], (tx) => [
      tx.object(options.adminWitness),
      tx.pure.u64(delayMs),
      tx.object.clock(),
    ]);
  }

  /** `creation_policy::apply_venue_delay`: anyone, once ready. */
  applyVenueDelay() {
    return this.#policyCall("apply_venue_delay", [], (tx) => [
      tx.object.clock(),
    ]);
  }

  /** `creation_policy::cancel_venue_delay` (`CancelAdmin`). */
  cancelVenueDelay(options: { adminWitness: TransactionObjectInput }) {
    return this.#policyCall("cancel_venue_delay", [], (tx) => [
      tx.object(options.adminWitness),
    ]);
  }

  /** `creation_policy::add_partner` (`FeeAdmin`): new sales may name `partner` at once. */
  addPartner(options: {
    adminWitness: TransactionObjectInput;
    partner: SharedObjectIdentity;
  }) {
    return this.#policyCall("add_partner", [], (tx) => [
      tx.object(options.adminWitness),
      deploymentObject(tx, options.partner, false),
    ]);
  }

  /**
   * `creation_policy::remove_partner` (`FeeAdmin`): new sales stop naming
   * `partner` after `blast_partners`' delay; sales naming it keep paying it.
   */
  removePartner(options: {
    adminWitness: TransactionObjectInput;
    partner: SharedObjectIdentity;
  }) {
    return this.#policyCall("remove_partner", [], (tx) => [
      tx.object(options.adminWitness),
      deploymentObject(tx, options.partner, false),
      tx.object.clock(),
    ]);
  }

  /**
   * `creation_policy::unpause(creation_policy, package_version,
   * unpause_admin, package_admin, fee_policy, treasury, bits)` with an
   * `UnpauseAdmin<BLAST_PRESALE_PACKAGE>` witness: aborts with
   * `EUnguardedDelay` unless the venue, fee and core treasury delays are
   * guarded.
   */
  unpause(options: { unpauseAdmin: TransactionObjectInput; bits: number }) {
    const bits = requirePauseBits(options.bits, PRESALE_PAUSE_MASK);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("creation_policy", "unpause"),
        arguments: [
          deploymentObject(tx, this.deployment.creationPolicy, false),
          deploymentObject(tx, this.deployment.packageVersion, true),
          tx.object(options.unpauseAdmin),
          deploymentObject(tx, this.deployment.packageAdmin, false),
          deploymentObject(tx, this.deployment.feePolicy, false),
          deploymentObject(tx, this.deployment.core.treasury, false),
          tx.pure.u8(bits),
        ],
      });
    };
  }

  // `fee_policy`.

  /** `fee_policy::schedule_fees` (`FeeAdmin`): the rates new sales snapshot, after the delay. */
  scheduleFees(options: {
    adminWitness: TransactionObjectInput;
    fees: ProtocolFees;
    delayMs: bigint;
  }) {
    const rates = rateCalls(this.core, options.fees);
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#feePolicyCall("schedule_fees", (tx) => [
      tx.object(options.adminWitness),
      ...rates.map((rate) => rate(tx)),
      tx.pure.u64(delayMs),
      tx.object.clock(),
    ]);
  }

  /** `fee_policy::apply_fees`: anyone, once ready. */
  applyFees() {
    return this.#feePolicyCall("apply_fees", (tx) => [tx.object.clock()]);
  }

  /** `fee_policy::cancel_fees` (`CancelAdmin`). */
  cancelFees(options: { adminWitness: TransactionObjectInput }) {
    return this.#feePolicyCall("cancel_fees", (tx) => [
      tx.object(options.adminWitness),
    ]);
  }

  #recipientShares(shares: readonly RecipientShare[]) {
    const elements = shares.map((share) => this.recipientShare(share));
    return (tx: Transaction): TransactionResult =>
      tx.makeMoveVec({
        type: this.#type("blast_presale::RecipientShare"),
        elements: elements.map((element) => element(tx)),
      });
  }

  #setter(
    options: Initializer,
    functionName: string,
    args: (tx: Transaction) => TransactionArgument[],
  ) {
    return (tx: Transaction): void => {
      this.#call(
        tx,
        functionName,
        [options.initializer, this.#version(tx), ...args(tx)],
        options,
      );
    };
  }

  /** A call on a shared presale, mutable, after its package version. */
  #presaleCall(
    options: PresaleInput,
    functionName: string,
    args: (tx: Transaction) => TransactionArgument[],
  ) {
    return (tx: Transaction): TransactionResult =>
      this.#call(
        tx,
        functionName,
        [
          deploymentObject(tx, options.presale, true),
          this.#version(tx),
          ...args(tx),
        ],
        options,
      );
  }

  #policyCall(
    functionName: string,
    typeArguments: string[],
    args: (tx: Transaction) => TransactionArgument[],
  ) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("creation_policy", functionName),
        typeArguments,
        arguments: [
          deploymentObject(tx, this.deployment.creationPolicy, true),
          this.#version(tx),
          ...args(tx),
        ],
      });
    };
  }

  #feePolicyCall(
    functionName: string,
    args: (tx: Transaction) => TransactionArgument[],
  ) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("fee_policy", functionName),
        arguments: [
          deploymentObject(tx, this.deployment.feePolicy, true),
          this.#version(tx),
          ...args(tx),
        ],
      });
    };
  }

  /** Calls `blast_presale::<functionName>`, typed `<SaleToken, Quote>` when given. */
  #call(
    tx: Transaction,
    functionName: string,
    args: TransactionArgument[],
    types?: PresaleTypes,
  ): TransactionResult {
    return tx.moveCall({
      target: this.#target("blast_presale", functionName),
      typeArguments: types ? saleTypeArguments(types) : [],
      arguments: args,
    });
  }

  #version(tx: Transaction): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.packageVersion, false);
  }

  #target(module: string, functionName: string): string {
    return `${this.deployment.packageId}::${module}::${functionName}`;
  }

  #type(name: string): string {
    return normalizeStructTag(`${this.deployment.originalPackageId}::${name}`);
  }
}

/** A setter's `PresaleInitializer` and the sale's types. */
type Initializer = PresaleTypes & { initializer: TransactionArgument };

/** Per-sale terms the `PresaleInitializer` setters record, in setter order. */
export type PresaleSettings = {
  tokenSupply: bigint;
  /** Coin Registry supply state after minting: burn-only when true, else fixed. */
  burnable: boolean;
  tokenAllocationBps: bigint;
  liquidityTokenAllocationBps: bigint;
  recipientAllocations: readonly RecipientShare[];
  /** Terms each claim locks a participant's tokens under; null pays them out. */
  participantVesting: VestingTerms | null;
  raiseTarget: bigint;
  raiseAllocations: readonly RecipientShare[];
  commitmentDurationMs: bigint;
  liquidityWindowDurationMs: bigint;
  eligibility: EligibilityPolicy;
  uncapped: UncappedPhase | null;
  /** Null overflows for the whole window. */
  hardCap: HardCap | null;
  /** The vault's LP-fee split. */
  feeSplit: FeeSplit;
  /** A Blast partner the `CreationPolicy` accepts; the sale's partner for good. */
  partner: SharedObjectIdentity | null;
};

/** A `MigratorCalls` method's options, less the ones the composition fills. */
type VenueOptions<
  Call extends (options: never) => unknown,
  Filled extends string,
> = Omit<Parameters<Call>[0], Filled | "memeType" | "quoteType">;

/** The venue a sale is created for and the objects its `prepare` takes. */
export type PresaleVenueCreation =
  | ({ venue: "cetus" } & VenueOptions<
      MigratorCalls["prepareCetus"],
      "sealedTreasuryCap" | "admission"
    >)
  | ({ venue: "bluefin" } & VenueOptions<
      MigratorCalls["prepareBluefin"],
      "sealedTreasuryCap" | "currency"
    >)
  | {
      venue: "aftermathDao";
      /** The vendor's `AdminCap`, owned by the sender with the sealed `TreasuryCap`. */
      adminCap: TransactionObjectInput;
      /** The verified fresh LP coin whose `CreatePoolCapV2` the sale reserves. */
      lpCoin: AftermathLpCoin;
    };

/** The venue a funded sale migrates to and the objects its `migrate` takes. */
export type PresaleVenueMigration =
  | ({ venue: "cetus" } & VenueOptions<
      MigratorCalls["migrateCetus"],
      "migration"
    >)
  | ({ venue: "bluefin" } & VenueOptions<
      MigratorCalls["migrateBluefin"],
      "migration" | "creationFee"
    > & {
        /** Bluefin's pool creation fee in MIST (`deployments` `bluefinPoolCreationFee`). */
        creationFee: bigint;
      })
  | {
      venue: "aftermathDao";
      lpType: string;
      /** The sale token's shared `PoolCreation<Lp, SaleToken>`. */
      poolCreation: SharedObjectIdentity;
    };

/** Presale policy `configureNow` applies on a fresh deployment, at zero delays. */
export type PresalePolicySettings = {
  /** The `FeePolicy` rates new sales snapshot. */
  fees?: ProtocolFees;
  /** Quote types to allow or disallow. */
  quotes?: readonly { quoteType: string; allowed: boolean }[];
  /** Venue witness types to admit (migrators venues, the vendor's `Venue`). */
  venueTypes?: readonly string[];
  /** Blast partners new sales may name. */
  partners?: readonly SharedObjectIdentity[];
};

/**
 * The delays `armNotices` gives the policies, in milliseconds. The fee delay
 * restates the applied rates beside it, since a schedule proposes both.
 */
export type PresaleNotices = {
  fees?: { fees: ProtocolFees; delayMs: bigint };
  venueDelayMs?: bigint;
};

/**
 * Deployment-bound presale PTBs: one-PTB creation and migration through the
 * sale's venue, owner actions through `prove_owner`, sale calls, and admin
 * calls signed in with an `AdminCap`.
 */
export class PresaleTransactions {
  readonly call: PresaleCalls;
  readonly admin: AdminCalls;
  readonly migrators: MigratorCalls;
  readonly vault: VaultCalls;
  /** Null until the deployment names the vendor package. */
  readonly aftermathDaoPresale: AftermathDaoPresaleCalls | null;
  readonly #useGasCoin: boolean;

  constructor(deployment: PresaleDeployment, options: CoinSourceOptions = {}) {
    this.call = new PresaleCalls(deployment);
    const { admin, migrators, vault, aftermathDaoPresale } =
      this.call.deployment;
    this.admin = new AdminCalls(admin);
    this.migrators = new MigratorCalls(migrators);
    this.vault = new VaultCalls(vault);
    this.aftermathDaoPresale = aftermathDaoPresale
      ? new AftermathDaoPresaleCalls(aftermathDaoPresale, this.call.deployment)
      : null;
    this.#useGasCoin = options.useGasCoin ?? true;
  }

  /**
   * Publishes the generated sale-token package and makes it immutable. Its
   * initializer transfers the `SealedTreasuryCap<SaleToken>` to the sender
   * (`readPresaleCoinPublication`) and delivers or deletes the `MetadataCap`;
   * the `Currency` goes to the Coin Registry address
   * (`finalizeCurrencyRegistration`). The publisher then runs `createPresale`.
   */
  publishPresaleCoin(options: PresaleCoinTemplateOptions): Transaction {
    const { deployment } = this.call;
    const tx = new Transaction();
    const upgradeCap = tx.add(async (innerTx) => {
      const module = await buildPresaleCoinPackageBytecode(options, deployment);
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
   * Shares a published sale token's pending `Currency` from the Coin Registry
   * address, so `finalize` can fix its supply. Anyone may run it.
   */
  finalizeCurrencyRegistration(options: {
    saleTokenType: string;
    currency: ObjectVersionReference;
    coinRegistry: SharedObjectIdentity;
  }): Transaction {
    const tx = new Transaction();
    tx.add(
      finalizeCurrencyRegistration({
        ...options,
        coinType: options.saleTokenType,
      }),
    );
    return tx;
  }

  /**
   * One PTB: for Cetus the presale's `venue_admission`, then the venue's
   * `prepare`, `new`, every setter (`set_participant_vesting`,
   * `set_uncapped_phase`, `set_hard_cap` and `set_partner` when given),
   * `finalize`, `set_protocol_fees` when `protocolFees` names a `FeeAdmin`
   * cap, `share` from `commitmentStartsAtMs`, and the `PresaleCap` to
   * `capRecipient`. The sender holds the sealed zero-supply `TreasuryCap`
   * (`readPresaleCoinPublication`; for the vendor, also its `AdminCap`);
   * `prepare` borrows the cap through the seal and `new` opens it.
   */
  createPresale(
    options: PresaleTypes &
      PresaleSettings &
      PresaleVenueCreation & {
        sealedTreasuryCap: TransactionObjectInput;
        /** The sale token's confirmed unregulated Coin Registry `Currency`. */
        currency: SharedObjectIdentity;
        commitmentStartsAtMs: bigint;
        capRecipient: string;
        protocolFees?: { adminCapId: string; fees: ProtocolFees };
      },
  ): Transaction {
    const capRecipient = normalizeSuiAddress(options.capRecipient);
    const tx = new Transaction();
    const venueTicket = tx.add(this.#prepare(tx, options));
    const { call } = this;
    const initializer = tx.add(call.new({ ...options, venueTicket }));
    const set = { ...options, initializer };
    tx.add(call.setSupply(set));
    tx.add(call.setTokenAllocations(set));
    if (options.participantVesting) {
      tx.add(
        call.setParticipantVesting({
          ...set,
          vestingTerms: options.participantVesting,
        }),
      );
    }
    tx.add(call.setRaise(set));
    tx.add(call.setWindows(set));
    tx.add(call.setEligibility(set));
    if (options.uncapped) {
      tx.add(call.setUncappedPhase({ ...set, uncapped: options.uncapped }));
    }
    if (options.hardCap) {
      tx.add(
        call.setHardCap({
          ...set,
          startDelayMs: options.hardCap.startsAfterMs,
          closesWhenFilled: options.hardCap.closesWhenFilled,
        }),
      );
    }
    tx.add(call.setFeeSplit(set));
    if (options.partner) {
      tx.add(call.setPartner({ ...set, partner: options.partner }));
    }
    const [presale, presaleCap] = moveResults(tx.add(call.finalize(set)), 2);
    if (options.protocolFees) {
      const adminWitness = tx.add(
        this.#signIn(options.protocolFees.adminCapId, "FeeAdmin"),
      );
      tx.add(
        call.setProtocolFees({
          ...options,
          presale,
          adminWitness,
          fees: options.protocolFees.fees,
        }),
      );
    }
    tx.add(call.share({ ...options, presale }));
    tx.transferObjects([presaleCap], capRecipient);
    return tx;
  }

  /**
   * Commits `amount` Quote from the sender's coins through `route` and sends
   * the returned change (zero outside a hard-capped phase) to `recipient`.
   */
  commit(
    options: PresaleInput & {
      amount: bigint;
      recipient: string;
    } & CoinSourceOptions &
      (
        | { route: "open" | "uncapped" }
        | { route: "allowlisted"; allowlist: AllowlistProof }
      ),
  ): Transaction {
    const amount = requireU64("amount", options.amount);
    const recipient = normalizeSuiAddress(options.recipient);
    const tx = new Transaction();
    const quoteIn = tx.coin({
      type: normalizeStructTag(options.quoteType),
      balance: amount,
      useGasCoin: options.useGasCoin ?? this.#useGasCoin,
    });
    const change = tx.add(
      options.route === "allowlisted"
        ? this.call.commitAllowlisted({ ...options, quoteIn })
        : options.route === "open"
          ? this.call.commitOpen({ ...options, quoteIn })
          : this.call.commitUncapped({ ...options, quoteIn }),
    );
    tx.transferObjects([change], recipient);
    return tx;
  }

  settle(options: PresaleInput): Transaction {
    return single(this.call.settle(options));
  }

  cancelUnlaunched(options: PresaleInput): Transaction {
    return single(this.call.cancelUnlaunched(options));
  }

  /** Relays one claim per participant in a single PTB. */
  claim(
    options: PresaleInput & { participants: readonly string[] },
  ): Transaction {
    if (options.participants.length === 0) {
      throw new RangeError("claim needs a participant");
    }
    const tx = new Transaction();
    for (const participant of options.participants) {
      tx.add(this.call.claim({ ...options, participant }));
    }
    return tx;
  }

  destroyCap(
    options: PresaleInput & { presaleCap: TransactionObjectInput },
  ): Transaction {
    return single(this.call.destroyCap(options));
  }

  /**
   * One PTB, anyone: `settle` first when `settle` is true, then `migrate`, the
   * venue's `migrate` redeeming its `Migration`, and, when `partner` is the
   * sale's partner, `pay_protocol_fees_with_partner`.
   */
  migrate(
    options: PresaleInput &
      PresaleVenueMigration & {
        settle?: boolean;
        partner?: SharedObjectIdentity | null;
      } & CoinSourceOptions,
  ): Transaction {
    const tx = new Transaction();
    if (options.settle) tx.add(this.call.settle(options));
    const migration = tx.add(this.call.migrate(options));
    const memeTypes = {
      memeType: options.saleTokenType,
      quoteType: options.quoteType,
    };
    switch (options.venue) {
      case "cetus":
        tx.add(
          this.migrators.migrateCetus({
            ...memeTypes,
            migration,
            cetus: options.cetus,
          }),
        );
        break;
      case "bluefin": {
        const creationFee = tx.coin({
          type: "0x2::sui::SUI",
          balance: requireU64("creationFee", options.creationFee),
          useGasCoin: options.useGasCoin ?? this.#useGasCoin,
        });
        tx.add(
          this.migrators.migrateBluefin({
            ...memeTypes,
            migration,
            currency: options.currency,
            quoteCurrency: options.quoteCurrency,
            bluefinConfig: options.bluefinConfig,
            creationFee,
          }),
        );
        break;
      }
      case "aftermathDao":
        tx.add(
          this.#vendor().migrate({
            ...options,
            migration,
          }),
        );
        break;
    }
    if (options.partner) {
      tx.add(
        this.call.payProtocolFeesWithPartner({
          ...options,
          partner: options.partner,
        }),
      );
    }
    return tx;
  }

  /** `pay_protocol_fees_with_partner` alone, for a migrated partnered sale. */
  payProtocolFeesWithPartner(
    options: PresaleInput & { partner: SharedObjectIdentity },
  ): Transaction {
    return single(this.call.payProtocolFeesWithPartner(options));
  }

  /**
   * `prove_owner` with the `PresaleCap`, then `vault::claim_owner_balances`,
   * sending both coins to `recipient`. The vault aborts when both owner
   * balances are zero: read the vault first.
   */
  claimOwnerBalances(
    options: PresaleInput & {
      presaleCap: TransactionObjectInput;
      vault: SharedObjectIdentity;
      recipient: string;
    },
  ): Transaction {
    const recipient = normalizeSuiAddress(options.recipient);
    const tx = new Transaction();
    const proof = tx.add(this.call.proveOwner(options));
    const coins = tx.add(
      this.vault.claimOwnerBalances({ ...this.#vaultInput(options), proof }),
    );
    tx.transferObjects(moveResults(coins, 2), recipient);
    return tx;
  }

  /** `prove_owner`, then `vault::schedule_fee_split` of a core `fee_split::new`. */
  scheduleFeeSplit(
    options: PresaleInput & {
      presaleCap: TransactionObjectInput;
      vault: SharedObjectIdentity;
      feeSplit: FeeSplit;
    },
  ): Transaction {
    const split = this.call.core.feeSplit(options.feeSplit);
    const tx = new Transaction();
    const proof = tx.add(this.call.proveOwner(options));
    const proposed = tx.add(split);
    tx.add(
      this.vault.scheduleFeeSplit({
        ...this.#vaultInput(options),
        proof,
        proposed,
      }),
    );
    return tx;
  }

  /** `prove_owner`, then `vault::cancel_fee_split`. */
  cancelFeeSplit(
    options: PresaleInput & {
      presaleCap: TransactionObjectInput;
      vault: SharedObjectIdentity;
    },
  ): Transaction {
    const tx = new Transaction();
    const proof = tx.add(this.call.proveOwner(options));
    tx.add(this.vault.cancelFeeSplit({ ...this.#vaultInput(options), proof }));
    return tx;
  }

  /** `set_protocol_fees` signed in as `FeeAdmin`, before the sale's start. */
  setProtocolFees(
    options: PresaleInput & { adminCapId: string; fees: ProtocolFees },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.setProtocolFees({ ...options, adminWitness }),
    );
  }

  setQuoteAllowed(
    options: AsAdmin<Parameters<PresaleCalls["setQuoteAllowed"]>[0]>,
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "ListingAdmin", (adminWitness) =>
      this.call.setQuoteAllowed({ ...options, adminWitness }),
    );
  }

  scheduleVenue(options: {
    adminCapId: string;
    venueType: string;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "VenueAdmin", (adminWitness) =>
      this.call.scheduleVenue({ ...options, adminWitness }),
    );
  }

  applyVenue(options: { venueType: string }): Transaction {
    return single(this.call.applyVenue(options));
  }

  cancelVenue(options: { adminCapId: string; venueType: string }): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelVenue({ ...options, adminWitness }),
    );
  }

  removeVenue(options: { adminCapId: string; venueType: string }): Transaction {
    return this.#asAdmin(options.adminCapId, "VenueAdmin", (adminWitness) =>
      this.call.removeVenue({ ...options, adminWitness }),
    );
  }

  scheduleVenueDelay(options: {
    adminCapId: string;
    delayMs: bigint;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "VenueAdmin", (adminWitness) =>
      this.call.scheduleVenueDelay({ ...options, adminWitness }),
    );
  }

  applyVenueDelay(): Transaction {
    return single(this.call.applyVenueDelay());
  }

  cancelVenueDelay(options: { adminCapId: string }): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelVenueDelay({ adminWitness }),
    );
  }

  addPartner(options: {
    adminCapId: string;
    partner: SharedObjectIdentity;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.addPartner({ ...options, adminWitness }),
    );
  }

  removePartner(options: {
    adminCapId: string;
    partner: SharedObjectIdentity;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.removePartner({ ...options, adminWitness }),
    );
  }

  scheduleFees(options: {
    adminCapId: string;
    fees: ProtocolFees;
    delayMs: bigint;
  }): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.scheduleFees({ ...options, adminWitness }),
    );
  }

  applyFees(): Transaction {
    return single(this.call.applyFees());
  }

  cancelFees(options: { adminCapId: string }): Transaction {
    return this.#asAdmin(options.adminCapId, "CancelAdmin", (adminWitness) =>
      this.call.cancelFees({ adminWitness }),
    );
  }

  /** `creation_policy::unpause` signed in as `UnpauseAdmin<BLAST_PRESALE_PACKAGE>`. */
  unpause(options: { adminCapId: string; bits: number }): Transaction {
    const tx = new Transaction();
    const unpauseAdmin = tx.add(
      this.#signInPackage(options.adminCapId, "UnpauseAdmin"),
    );
    tx.add(this.call.unpause({ unpauseAdmin, bits: options.bits }));
    return tx;
  }

  /**
   * Applies presale policy at once on a fresh deployment whose delays are
   * still zero, in one PTB: the fees (schedule and apply), each Quote, each
   * venue (schedule and apply) and each partner. Name only what changes; an
   * unchanged value aborts. Then call `armNotices`.
   */
  configureNow(
    options: { adminCapId: string } & PresalePolicySettings,
  ): Transaction {
    const tx = new Transaction();
    const as = this.#witnesses(tx, options.adminCapId);
    const { call } = this;
    if (options.fees) {
      tx.add(
        call.scheduleFees({
          fees: options.fees,
          delayMs: 0n,
          adminWitness: as("FeeAdmin"),
        }),
      );
      tx.add(call.applyFees());
    }
    for (const quote of options.quotes ?? []) {
      tx.add(
        call.setQuoteAllowed({ ...quote, adminWitness: as("ListingAdmin") }),
      );
    }
    for (const venueType of options.venueTypes ?? []) {
      tx.add(call.scheduleVenue({ venueType, adminWitness: as("VenueAdmin") }));
      tx.add(call.applyVenue({ venueType }));
    }
    for (const partner of options.partners ?? []) {
      tx.add(call.addPartner({ partner, adminWitness: as("FeeAdmin") }));
    }
    return tx;
  }

  /**
   * Raises each named delay from zero in one PTB: a schedule and its apply.
   * Run after `configureNow`; once armed, every later change waits its delay.
   */
  armNotices(options: { adminCapId: string } & PresaleNotices): Transaction {
    const tx = new Transaction();
    const as = this.#witnesses(tx, options.adminCapId);
    const { call } = this;
    if (options.fees) {
      tx.add(
        call.scheduleFees({ ...options.fees, adminWitness: as("FeeAdmin") }),
      );
      tx.add(call.applyFees());
    }
    if (options.venueDelayMs !== undefined) {
      tx.add(
        call.scheduleVenueDelay({
          delayMs: options.venueDelayMs,
          adminWitness: as("VenueAdmin"),
        }),
      );
      tx.add(call.applyVenueDelay());
    }
    return tx;
  }

  #prepare(
    tx: Transaction,
    options: PresaleTypes &
      PresaleVenueCreation & {
        sealedTreasuryCap: TransactionObjectInput;
        currency: SharedObjectIdentity;
      },
  ): (tx: Transaction) => TransactionResult {
    const memeTypes = {
      memeType: options.saleTokenType,
      quoteType: options.quoteType,
    };
    switch (options.venue) {
      case "cetus":
        return this.migrators.prepareCetus({
          ...memeTypes,
          cetus: options.cetus,
          sealedTreasuryCap: options.sealedTreasuryCap,
          admission: tx.add(
            this.call.venueAdmission({
              venueType: venueWitnessType(this.migrators.deployment, "cetus"),
            }),
          ),
          tickSpacing: options.tickSpacing,
        });
      case "bluefin":
        return this.migrators.prepareBluefin({
          ...memeTypes,
          sealedTreasuryCap: options.sealedTreasuryCap,
          currency: options.currency,
          tickSpacing: options.tickSpacing,
          feeRate: options.feeRate,
        });
      case "aftermathDao": {
        const lpCoin = assertAftermathLpCoin(options.lpCoin);
        return this.#vendor().prepare({
          ...options,
          lpType: lpCoin.lpType,
          createPoolCap: lpCoin.createPoolCapId,
        });
      }
    }
  }

  #vendor(): AftermathDaoPresaleCalls {
    if (!this.aftermathDaoPresale) {
      throw new TypeError("deployment.aftermathDaoPresale is required");
    }
    return this.aftermathDaoPresale;
  }

  #vaultInput(options: PresaleTypes & { vault: SharedObjectIdentity }) {
    return {
      memeType: options.saleTokenType,
      quoteType: options.quoteType,
      vault: options.vault,
    };
  }

  #signIn(adminCapId: string, role: CoreRole) {
    return this.admin.signIn({
      adminCap: adminCapId,
      role: coreRoleType(this.call.deployment.core, role),
    });
  }

  #signInPackage(adminCapId: string, role: PackageRole) {
    return this.admin.signIn({
      adminCap: adminCapId,
      role: packageRoleType(this.call.deployment.admin, this.call.otw, role),
    });
  }

  /** One `AdminWitness` per core role this PTB needs, signed in on first use. */
  #witnesses(tx: Transaction, adminCapId: string) {
    const witnesses = new Map<CoreRole, TransactionObjectArgument>();
    return (role: CoreRole): TransactionObjectArgument => {
      let witness = witnesses.get(role);
      if (!witness) {
        witness = tx.add(this.#signIn(adminCapId, role));
        witnesses.set(role, witness);
      }
      return witness;
    };
  }

  #asAdmin(
    adminCapId: string,
    role: CoreRole,
    call: (
      adminWitness: TransactionObjectArgument,
    ) => (tx: Transaction) => void,
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(this.#signIn(adminCapId, role));
    tx.add(call(adminWitness));
    return tx;
  }
}

/** A builder's options with the `AdminCap` ID that signs in in place of its witness. */
type AsAdmin<Options extends { adminWitness: TransactionObjectInput }> = Omit<
  Options,
  "adminWitness"
> & { adminCapId: string };

function single(call: (tx: Transaction) => void): Transaction {
  const tx = new Transaction();
  tx.add(call);
  return tx;
}

function saleTypeArguments(types: PresaleTypes): string[] {
  return [
    normalizeStructTag(types.saleTokenType),
    normalizeStructTag(types.quoteType),
  ];
}

/**
 * The normalized struct type of a venue witness. The contract rejects a
 * primitive or vector, which any caller can construct, and neither parses as
 * a struct here, and a framework (`0x1`, `0x2`) type.
 */
function venueType(type: string): string {
  const tag = parseStructTag(type);
  if (!isValidSuiAddress(tag.address)) {
    throw new TypeError(`a venue must be a struct type: ${type}`);
  }
  const address = BigInt(normalizeSuiAddress(tag.address));
  if (address === 1n || address === 2n) {
    throw new TypeError(`a venue must not be a framework type: ${type}`);
  }
  return normalizeStructTag(tag);
}

/**
 * The four `bps::new` rates of `ProtocolFees`, in Move order, each within
 * `fee_policy::protocol_fees`' maximums (`EInvalidFees` otherwise).
 */
function rateCalls(core: CoreCalls, fees: ProtocolFees) {
  return [
    requireBasisPointsAtMost("raiseBps", fees.raiseBps, MAX_PROTOCOL_RAISE_BPS),
    requireBasisPointsAtMost("tokenBps", fees.tokenBps, MAX_PROTOCOL_TOKEN_BPS),
    requireBasisPointsAtMost("lpFeeMemeBps", fees.lpFeeMemeBps, MAX_LP_FEE_BPS),
    requireBasisPointsAtMost(
      "lpFeeQuoteBps",
      fees.lpFeeQuoteBps,
      MAX_LP_FEE_BPS,
    ),
  ].map((rate) => core.bps(rate));
}
