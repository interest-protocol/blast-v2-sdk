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
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import type { AdminDeployment } from "../admin/transactions.ts";
import { AdminCalls, normalizeAdminDeployment } from "../admin/transactions.ts";
import type {
  RewardManifest,
  RewardManifestSummary,
  RewardProof,
} from "../holder-rewards/allocations.ts";
import {
  PRESALE_REWARD_LEAF_DOMAIN,
  rewardAddress,
  rewardDigest,
  validateRewardManifest,
  validateRewardManifestSummary,
} from "../holder-rewards/allocations.ts";
import type { LaunchTypes } from "../launchpad/transactions.ts";
import { normalizeLaunchTypes } from "../launchpad/transactions.ts";
import type { CoinSourceOptions } from "../lib/coins.ts";
import { grossGasBudget } from "../lib/gas.ts";
import { requireU64 } from "../lib/integers.ts";
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
import type { CetusMemeSide } from "../migrators/transactions.ts";
import type { AftermathPresaleDeployment } from "./aftermath.ts";
import {
  AFTERMATH_PRESALE_MODULE,
  aftermathWitnessType,
  defineAftermathPresaleDeployment,
} from "./aftermath.ts";
import type { AllowlistProof } from "./allowlist.ts";
import {
  allowlistedEligibility,
  openEligibility,
  uncappedForAnyone,
  validateBps,
  vestingTerms,
} from "./math.ts";
import type {
  BpsShare,
  EligibilityPolicy,
  HardCap,
  ProtocolFees,
  UncappedPhase,
  VestingTerms,
} from "./state.ts";

/**
 * `getPresaleDeployment(network)` returns a registered release. For another
 * deployment, pass the IDs the publish and `package_admin::wrap` activation effects
 * return. Publication shares `VenueConfig`,
 * `CreationPolicy`, and `FeePolicy`. Blast administers the package through the
 * shared `blast_admin` ACL with the `blast_presale_domain` roles (contracts
 * ADR 0099), and it links `blast_partners` to pay a sale's partner.
 */
export type PresaleDeployment = {
  packageId: string;
  originalPackageId: string;
  /** Shared by activation: `blast_presale_package::PackageVersion`. */
  packageVersion: SharedObjectIdentity;
  /** `venue_config::VenueConfig`, holding each Meme's Cetus `PoolCreationCap`. */
  venueConfig: SharedObjectIdentity;
  /** `creation_policy::CreationPolicy`: the Quote types, migrators, and partners creation admits. */
  creationPolicy: SharedObjectIdentity;
  /** `fee_policy::FeePolicy`: creation, migration, and fee collection read it. */
  feePolicy: SharedObjectIdentity;
  /** `blast_admin` and its ACL, where every administrator call signs in. */
  admin: AdminDeployment;
  /**
   * The Aftermath DAO-pool vendor package and the Aftermath objects its
   * migration takes (`defineAftermathPresaleDeployment`); absent until it is
   * published. Every `aftermath` builder throws without it.
   */
  aftermath?: AftermathPresaleDeployment;
};

/**
 * The typed `blast_presale::blast_presale_domain` roles (contracts ADR 0099).
 * Each administrator action takes the `AdminWitness` of exactly one of them.
 */
export type PresaleAdminRole =
  | "UpgradeAdmin"
  | "TreasuryAdmin"
  | "FeeAdmin"
  | "ListingAdmin"
  | "AdapterAdmin"
  | "RewardsAdmin";

/**
 * Venues the SDK migrates to: this package's `cetus` and `bluefin`, and
 * `aftermath`, the vendor package `blast_aftermath_dao_presale`, whose witness
 * is `<vendor>::blast_aftermath_dao_presale::Witness` (contracts ADR 0104).
 */
export type PresaleVenue = "cetus" | "bluefin" | "aftermath";

/**
 * A migrator the `CreationPolicy` can allow: one of this package's venues, or
 * the `Witness` struct type of a migrator in another package, such as
 * `<vendor>::blast_aftermath_dao_presale::Witness` (contracts ADR 0104).
 */
export type PresaleMigrator =
  | { venue: PresaleVenue; witnessType?: never }
  | { witnessType: string; venue?: never };

/**
 * Per-sale terms the `PresaleInitializer` setters record, in setter order
 * (contracts ADR 0110).
 */
export type PresaleSettings = LaunchTypes & {
  tokenSupply: bigint;
  tokenAllocationBps: bigint;
  /**
   * Terms each claim locks a participant's tokens under, in an irrevocable
   * schedule that starts at the claim; null pays them out.
   */
  participantVesting: VestingTerms | null;
  liquidityTokenAllocationBps: bigint;
  recipientAllocations: readonly BpsShare[];
  /** Coin Registry supply state after minting: burn-only when true, else fixed. */
  burnable: boolean;
  raiseTarget: bigint;
  raiseAllocations: readonly BpsShare[];
  durationMs: bigint;
  liquidityWindowMs: bigint;
  eligibility: EligibilityPolicy;
  uncapped: UncappedPhase | null;
  /**
   * Holds the sale to its raise from `startsAfterMs` into the window; with
   * `closesWhenFilled` anyone may settle it once the raise is full. Null
   * overflows for the whole window.
   */
  hardCap: HardCap | null;
  feeRecipients: readonly BpsShare[];
  holderRewardsBps: bigint;
  /**
   * A Blast partner the `CreationPolicy` accepts; it becomes the sale's
   * partner for good, paid its cut of Blast's raise fee after migration.
   */
  partner?: SharedObjectReference<false>;
};

/** A sale's settings without its LP-fee split, which some migrators fix themselves. */
export type PresaleTermsSettings = Omit<
  PresaleSettings,
  "feeRecipients" | "holderRewardsBps"
>;

/** A sale's settings plus the coin objects its creation consumes and finalizes. */
export type PresaleTerms = PresaleSettings & {
  /** The zero-supply `TreasuryCap<Meme>`, consumed. */
  treasuryCap: TransactionObjectInput;
  /** Confirmed unregulated `Currency<Meme>`; regulated and legacy Unknown abort at finalize. */
  memeCurrency: SharedObjectReference<true>;
};

export type CetusPresaleObjects = {
  /** Cetus CLMM `config::GlobalConfig`. */
  cetusConfig: SharedObjectReference<false>;
  /** Cetus CLMM `factory::Pools`. */
  cetusPools: SharedObjectReference<true>;
};

/**
 * An Aftermath DAO-pool vendor sale's terms (contracts ADRs 0104 and 0110):
 * every setting but the LP-fee split, which the vendor's `finalize` fixes (its
 * treasury takes every LP fee), the coin objects creation consumes, and the
 * fresh LP coin's pool-creation capability. The sale has no pool tier: its
 * pool's weights and fees are the vendor's constants (ADR 0111).
 */
export type AftermathPresaleTerms = PresaleTermsSettings & {
  /** The zero-supply `TreasuryCap<SaleToken>`, consumed. */
  treasuryCap: TransactionObjectInput;
  /** The sale token's Coin Registry `Currency`, which `finalize` takes. */
  memeCurrency: SharedObjectReference<true>;
  /** The vendor package's `AdminCap`. */
  adminCap: TransactionObjectInput;
  /** The fresh LP coin `Lp`, published for this sale alone. */
  lpType: string;
  /** Aftermath's `CreatePoolCapV2` that `Lp`'s publication minted, consumed. */
  createPoolCap: TransactionObjectInput;
};

/** A sale's Aftermath binding, which `migrate` consumes. */
export type AftermathMigration = LaunchTypes & {
  presale: SharedObjectReference<true>;
  /** The sale's shared `PoolCreation<Lp>`, taken by value. */
  poolCreation: SharedObjectReference<true>;
  /** The fresh LP coin, from `findAftermathPoolCreation` or the event. */
  lpType: string;
};

/** What `createCetusPresale` and `createBluefinPresale` add to creation. */
export type PresaleCreation = {
  startMs: bigint;
  capRecipient: string;
};

/**
 * The sale's partner, when `PresaleState.partnerId` (or, after migration,
 * `PresaleVaultState.partnerId`) is set: the migration or collection
 * transaction then pays it and Blast the fees the sale or its vault held.
 */
export type PresalePayout = {
  partner?: SharedObjectReference<false> | null;
};

/** Maximum Merkle proof depth for 65,536 leaves. */
export const MAX_PRESALE_PROOF_DEPTH = 16;

/**
 * Cetus orders a pool's coins by `type_name::with_defining_ids` text (64 hex
 * digits, no `0x`); Meme is coin A exactly when its name sorts after Quote's.
 * Pass original (defining) type addresses.
 */
export function cetusMemeSide(
  memeType: string,
  quoteType: string,
): CetusMemeSide {
  return cetusTypeName(memeType) > cetusTypeName(quoteType) ? "a" : "b";
}

/**
 * The normalized struct type of an external migrator's witness. The contract
 * rejects a primitive or vector witness, which any caller can construct, and
 * neither parses as a struct here.
 */
function externalWitnessType(witnessType: string): string {
  const tag = parseStructTag(witnessType);
  if (!isValidSuiAddress(tag.address)) {
    throw new TypeError(
      `migration witness must be a struct type: ${witnessType}`,
    );
  }
  // Anyone can construct the framework's droppable structs, such as
  // `TypeName`, `Option<T>`, or `ID`, so the contract rejects them too.
  if (FRAMEWORK_ADDRESSES.has(normalizeSuiAddress(tag.address))) {
    throw new TypeError(
      `migration witness must not be a framework type: ${witnessType}`,
    );
  }
  return normalizeStructTag(tag);
}

const FRAMEWORK_ADDRESSES = new Set(
  ["0x1", "0x2"].map((address) => normalizeSuiAddress(address)),
);

function cetusTypeName(type: string): string {
  return normalizeStructTag(parseStructTag(type)).replace(
    /0x([0-9a-f]{64})/g,
    "$1",
  );
}

export class PresaleCalls {
  readonly deployment: PresaleDeployment;
  readonly admin: AdminCalls;

  constructor(deployment: PresaleDeployment) {
    this.deployment = {
      ...normalizeSuiPackageReference("presale", deployment),
      packageVersion: normalizeSharedObjectIdentity(
        "packageVersion",
        deployment.packageVersion,
      ),
      venueConfig: normalizeSharedObjectIdentity(
        "venueConfig",
        deployment.venueConfig,
      ),
      creationPolicy: normalizeSharedObjectIdentity(
        "creationPolicy",
        deployment.creationPolicy,
      ),
      feePolicy: normalizeSharedObjectIdentity(
        "feePolicy",
        deployment.feePolicy,
      ),
      admin: normalizeAdminDeployment(deployment.admin),
      ...(deployment.aftermath === undefined
        ? {}
        : {
            aftermath: defineAftermathPresaleDeployment(deployment.aftermath),
          }),
    };
    this.admin = new AdminCalls(this.deployment.admin);
  }

  /** The Move type of one `blast_presale_domain` role, for `AdminCalls.grantRole`. */
  roleType(role: PresaleAdminRole): string {
    return this.#type(`blast_presale_domain::${role}`);
  }

  /** This PTB's `AdminWitness<Role>`; the `AdminCap` must hold `role`. */
  signIn(options: {
    adminCap: TransactionObjectInput;
    role: PresaleAdminRole;
  }) {
    return this.admin.signIn({
      adminCap: options.adminCap,
      role: this.roleType(options.role),
    });
  }

  /**
   * The type a presale stores as its `migration_witness`. `aftermath` needs
   * `deployment.aftermath`.
   */
  migrationWitnessType(venue: PresaleVenue): string {
    if (venue === "aftermath") {
      return aftermathWitnessType(this.#aftermath().packageId);
    }
    return this.#type(`${venue}::Witness`);
  }

  /**
   * The venue a sale's `migration_witness` names, or null for any other
   * migrator; `aftermath` only when `deployment.aftermath` is set.
   */
  venueOf(migrationWitness: string): PresaleVenue | null {
    const witness = normalizeStructTag(migrationWitness);
    const venues: PresaleVenue[] = ["cetus", "bluefin"];
    if (this.deployment.aftermath) venues.push("aftermath");
    return (
      venues.find((venue) => this.migrationWitnessType(venue) === witness) ??
      null
    );
  }

  /** `blast_presale::open_eligibility` or `allowlisted_eligibility`. */
  eligibility(policy: EligibilityPolicy) {
    if (policy.kind === "open") {
      openEligibility(
        policy.walletCap,
        policy.maxParticipants,
        policy.minCommitment,
      );
      return (tx: Transaction): TransactionResult =>
        this.#presaleCall(tx, "open_eligibility", [
          tx.pure.u64(policy.walletCap),
          tx.pure.u64(policy.maxParticipants),
          tx.pure.u64(policy.minCommitment),
        ]);
    }
    allowlistedEligibility(policy.root, policy.leafCount);
    return (tx: Transaction): TransactionResult =>
      this.#presaleCall(tx, "allowlisted_eligibility", [
        tx.pure.vector("u8", fromHex(policy.root)),
        tx.pure.u64(policy.leafCount),
      ]);
  }

  /** `uncapped_for_eligible` or `uncapped_for_anyone`. */
  uncapped(phase: UncappedPhase) {
    requireU64("startsAfterMs", phase.startsAfterMs);
    const { access } = phase;
    if (access.kind === "anyone") {
      uncappedForAnyone(
        phase.startsAfterMs,
        access.maxParticipants,
        access.minCommitment,
      );
    }
    return (tx: Transaction): TransactionResult =>
      access.kind === "anyone"
        ? this.#presaleCall(tx, "uncapped_for_anyone", [
            tx.pure.u64(phase.startsAfterMs),
            tx.pure.u64(access.maxParticipants),
            tx.pure.u64(access.minCommitment),
          ])
        : this.#presaleCall(tx, "uncapped_for_eligible", [
            tx.pure.u64(phase.startsAfterMs),
          ]);
  }

  /** `vesting_terms`. */
  vesting(terms: VestingTerms) {
    const vesting = vestingTerms(terms.cliffMs, terms.periodMs, terms.periods);
    return (tx: Transaction): TransactionResult =>
      this.#vestingTerms(tx, vesting);
  }

  /** One `bps::Bps` through `bps::new`. */
  bps(value: bigint) {
    validateBps(value);
    return (tx: Transaction): TransactionResult =>
      this.#presaleCall(tx, "new", [tx.pure.u64(value)], undefined, "bps");
  }

  /**
   * `vector<RecipientShare>` from `recipient_share` calls, each rate through
   * `bps::new`; a share with `vesting` goes through `vesting_terms` and
   * `vested_recipient_share` instead. Only token and raise shares may vest.
   */
  recipientShares(shares: readonly BpsShare[]) {
    const normalized = shares.map((share) => {
      const bps = validateBps(share.bps);
      const { vesting } = share;
      return {
        recipient: normalizeSuiAddress(share.recipient),
        bps,
        vesting:
          vesting &&
          vestingTerms(vesting.cliffMs, vesting.periodMs, vesting.periods),
      };
    });
    return (tx: Transaction): TransactionResult =>
      tx.makeMoveVec({
        type: this.#type("blast_presale::RecipientShare"),
        elements: normalized.map(({ recipient, bps, vesting }) => {
          const address = tx.pure.address(recipient);
          const rate = tx.add(this.bps(bps));
          if (!vesting) {
            return this.#presaleCall(tx, "recipient_share", [address, rate]);
          }
          return this.#presaleCall(tx, "vested_recipient_share", [
            address,
            rate,
            this.#vestingTerms(tx, vesting),
          ]);
        }),
      });
  }

  /**
   * `blast_presale::fee_split`: the LP-fee split, each recipient's share then
   * the holder-reward share, totalling 10,000 BPS. Fee shares cannot vest.
   */
  feeSplit(feeRecipients: readonly BpsShare[], holderRewardsBps: bigint) {
    if (feeRecipients.some((recipient) => recipient.vesting)) {
      throw new RangeError("fee recipients cannot vest");
    }
    const shares = this.recipientShares(feeRecipients);
    const holderRewards = this.bps(holderRewardsBps);
    return (tx: Transaction): TransactionResult =>
      this.#presaleCall(tx, "fee_split", [
        tx.add(shares),
        tx.add(holderRewards),
      ]);
  }

  /**
   * `cetus::new`: reserves the pair's Cetus pool creation at `tickSpacing`
   * (Cetus derives the fee rate) and returns the sale's `PresaleInitializer`,
   * which the same PTB must `configurePresale` and `finalizePresale`.
   */
  startCetusPresale(
    options: LaunchTypes &
      CetusPresaleObjects & {
        treasuryCap: TransactionObjectInput;
        tickSpacing: number;
      },
  ) {
    const tickSpacing = requireU32("tickSpacing", options.tickSpacing);
    return (tx: Transaction): TransactionResult =>
      this.#presaleCall(
        tx,
        "new",
        [
          tx.object(options.treasuryCap),
          this.#version(tx),
          this.#creationPolicy(tx),
          this.#feePolicy(tx),
          deploymentObject(tx, this.deployment.venueConfig, true),
          sharedObject(tx, "cetusConfig", options.cetusConfig, false),
          sharedObject(tx, "cetusPools", options.cetusPools, true),
          tx.pure.u32(tickSpacing),
        ],
        options,
        "cetus",
      );
  }

  /**
   * `bluefin::new` at the creator's tier; returns the sale's
   * `PresaleInitializer`, which the same PTB must configure and finalize.
   */
  startBluefinPresale(
    options: LaunchTypes & {
      treasuryCap: TransactionObjectInput;
      memeCurrency: SharedObjectReference<true>;
      tickSpacing: number;
      feeRate: bigint;
    },
  ) {
    const tickSpacing = requireU32("tickSpacing", options.tickSpacing);
    const feeRate = requireU64("feeRate", options.feeRate);
    return (tx: Transaction): TransactionResult =>
      this.#presaleCall(
        tx,
        "new",
        [
          tx.object(options.treasuryCap),
          this.#version(tx),
          // The same PTB's `finalize` takes the currency mutably.
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          this.#creationPolicy(tx),
          this.#feePolicy(tx),
          // Records the tier for the migration (contracts ADR 0111).
          deploymentObject(tx, this.deployment.venueConfig, true),
          tx.pure.u32(tickSpacing),
          tx.pure.u64(feeRate),
        ],
        options,
        "bluefin",
      );
  }

  /**
   * Records every one of `options` on `initializer` through the
   * `PresaleInitializer` setters, optional ones only when given: supply, token
   * allocations, participant vesting, raise, windows, eligibility, uncapped
   * phase, hard cap, LP-fee split, then the partner, which the
   * `CreationPolicy` must accept now and which `finalize` fixes for good.
   */
  configurePresale(
    options: PresaleSettings & { initializer: TransactionArgument },
  ) {
    return this.#configure(options, {
      feeRecipients: options.feeRecipients,
      holderRewardsBps: options.holderRewardsBps,
    });
  }

  /**
   * Every `PresaleInitializer` setter `configurePresale` calls except
   * `set_fee_split`, for a migrator whose own `finalize` fixes the LP-fee
   * split, such as the Aftermath DAO-pool vendor (`AftermathDaoPresaleCalls`).
   */
  configurePresaleTerms(
    options: PresaleTermsSettings & { initializer: TransactionArgument },
  ) {
    return this.#configure(options, null);
  }

  #configure(
    options: PresaleTermsSettings & { initializer: TransactionArgument },
    feeSplit: Pick<
      PresaleSettings,
      "feeRecipients" | "holderRewardsBps"
    > | null,
  ) {
    const tokenSupply = requireU64("tokenSupply", options.tokenSupply);
    const raiseTarget = requireU64("raiseTarget", options.raiseTarget);
    const durationMs = requireU64("durationMs", options.durationMs);
    const liquidityWindowMs = requireU64(
      "liquidityWindowMs",
      options.liquidityWindowMs,
    );
    const { hardCap, participantVesting, uncapped, partner } = options;
    if (hardCap) requireU64("hardCap.startsAfterMs", hardCap.startsAfterMs);
    return (tx: Transaction): void => {
      const set = (name: string, args: TransactionArgument[]) =>
        this.#presaleCall(
          tx,
          name,
          [options.initializer, this.#version(tx), ...args],
          options,
        );

      set("set_supply", [
        tx.pure.u64(tokenSupply),
        tx.pure.bool(options.burnable),
      ]);
      set("set_token_allocations", [
        tx.add(this.bps(options.tokenAllocationBps)),
        tx.add(this.bps(options.liquidityTokenAllocationBps)),
        tx.add(this.recipientShares(options.recipientAllocations)),
      ]);
      if (participantVesting) {
        set("set_participant_vesting", [
          tx.add(this.vesting(participantVesting)),
        ]);
      }
      set("set_raise", [
        tx.pure.u64(raiseTarget),
        tx.add(this.recipientShares(options.raiseAllocations)),
      ]);
      set("set_windows", [
        tx.pure.u64(durationMs),
        tx.pure.u64(liquidityWindowMs),
      ]);
      set("set_eligibility", [tx.add(this.eligibility(options.eligibility))]);
      if (uncapped)
        set("set_uncapped_phase", [tx.add(this.uncapped(uncapped))]);
      if (hardCap) {
        set("set_hard_cap", [
          tx.pure.u64(hardCap.startsAfterMs),
          tx.pure.bool(hardCap.closesWhenFilled),
        ]);
      }
      if (feeSplit) {
        set("set_fee_split", [
          tx.add(
            this.feeSplit(feeSplit.feeRecipients, feeSplit.holderRewardsBps),
          ),
        ]);
      }
      if (partner) {
        set("set_partner", [
          this.#creationPolicy(tx),
          sharedObject(tx, "partner", partner, false),
          tx.object.clock(),
        ]);
      }
    };
  }

  /**
   * `blast_presale::finalize`: checks every setting together, mints and seals
   * the supply, and returns `(Presale, PresaleCap)`; the same PTB must `share`
   * the presale.
   */
  finalizePresale(
    options: LaunchTypes & {
      initializer: TransactionArgument;
      memeCurrency: SharedObjectReference<true>;
    },
  ) {
    return (tx: Transaction): TransactionResult =>
      this.#presaleCall(
        tx,
        "finalize",
        [
          options.initializer,
          this.#version(tx),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
        ],
        options,
      );
  }

  /**
   * `cetus::new`, every setter, and `finalize`: returns `(Presale,
   * PresaleCap)`; the same PTB must `share` the presale.
   */
  newCetusPresale(
    options: PresaleTerms & CetusPresaleObjects & { tickSpacing: number },
  ) {
    return this.#newPresale(this.startCetusPresale(options), options);
  }

  /** `bluefin::new`, every setter, and `finalize`; returns `(Presale, PresaleCap)`. */
  newBluefinPresale(
    options: PresaleTerms & { tickSpacing: number; feeRate: bigint },
  ) {
    return this.#newPresale(this.startBluefinPresale(options), options);
  }

  /**
   * `blast_aftermath_dao_presale::new<SaleToken, Quote>` with the vendor's
   * `AdminCap`: starts a sale migrating through the vendor and returns its
   * `PresaleInitializer`. The `CreationPolicy` must allow the vendor's witness
   * (`migrationWitnessType("aftermath")`) and Quote. Configure it with
   * `configurePresaleTerms`, then `finalizeAftermathPresale`: the vendor
   * aborts with `EWrongMigrator` if `blast_presale::finalize` is used instead.
   */
  startAftermathPresale(
    options: LaunchTypes & {
      adminCap: TransactionObjectInput;
      treasuryCap: TransactionObjectInput;
    },
  ) {
    const { packageId } = this.#aftermath();
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${packageId}::${AFTERMATH_PRESALE_MODULE}::new`,
        typeArguments: this.#saleTypes(options),
        arguments: [
          tx.object(options.adminCap),
          this.#version(tx),
          tx.object(options.treasuryCap),
          this.#creationPolicy(tx),
          this.#feePolicy(tx),
        ],
      });
  }

  /**
   * `blast_aftermath_dao_presale::finalize<Lp, SaleToken, Quote>` with the
   * vendor's `AdminCap`: names the vendor's treasury as the sale's only LP-fee
   * recipient, finalizes it, sends its `PresaleCap` to the treasury, shares
   * the `PoolCreation<Lp>` binding `createPoolCap` to it, and returns the
   * `Presale`, which the same PTB must `share`.
   */
  finalizeAftermathPresale(
    options: LaunchTypes & {
      adminCap: TransactionObjectInput;
      initializer: TransactionArgument;
      memeCurrency: SharedObjectReference<true>;
      lpType: string;
      createPoolCap: TransactionObjectInput;
    },
  ) {
    const { packageId } = this.#aftermath();
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${packageId}::${AFTERMATH_PRESALE_MODULE}::finalize`,
        typeArguments: this.#aftermathTypes(options),
        arguments: [
          tx.object(options.adminCap),
          this.#version(tx),
          options.initializer,
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          tx.object(options.createPoolCap),
        ],
      });
  }

  /**
   * The vendor's `new`, every setter but the LP-fee split (`set_partner` when
   * `partner` is given), and the vendor's `finalize`: returns the `Presale`,
   * which the same PTB must `share`. The `PresaleCap` goes to the vendor's
   * treasury.
   */
  newAftermathPresale(options: AftermathPresaleTerms) {
    return (tx: Transaction): TransactionResult => {
      const initializer = tx.add(this.startAftermathPresale(options));
      tx.add(this.configurePresaleTerms({ ...options, initializer }));
      return tx.add(this.finalizeAftermathPresale({ ...options, initializer }));
    };
  }

  /**
   * `blast_aftermath_dao_presale::migrate<Lp, SaleToken, Quote>`: consumes the
   * sale's `PoolCreation`, seeds a 50/50 Aftermath pool with all the sale's LP
   * tokens and Quote in Aftermath's coin order (`aftermathPoolCoinTypes`; the
   * contract orders them itself), wraps it in a DAO-fee pool paying the
   * vendor's treasury, and locks the LP. Anyone may call.
   */
  migrateAftermath(options: AftermathMigration) {
    const aftermath = this.#aftermath();
    const typeArguments = this.#aftermathTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${aftermath.packageId}::${AFTERMATH_PRESALE_MODULE}::migrate`,
        typeArguments,
        arguments: [
          this.#presale(tx, options),
          this.#version(tx),
          sharedObject(tx, "poolCreation", options.poolCreation, true),
          this.#feePolicy(tx),
          deploymentObject(tx, aftermath.poolRegistry, true),
          deploymentObject(tx, aftermath.daoFeeVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * `blast_presale::share`: shares the new presale and fixes its windows from
   * `startMs`, or from execution once that has passed (`0n` opens it at once).
   * Commitments open at the start; until then Blast's `FeeAdmin` may change the
   * sale's Blast rates (`setPresaleProtocolFees`).
   */
  share(
    options: LaunchTypes & { presale: TransactionArgument; startMs: bigint },
  ) {
    const startMs = requireU64("startMs", options.startMs);
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "share",
        [
          options.presale,
          this.#version(tx),
          tx.pure.u64(startMs),
          tx.object.clock(),
        ],
        options,
      );
    };
  }

  /** `commit_open`; returns the `Coin<Quote>` a hard cap did not accept. */
  commitOpen(
    options: LaunchTypes & {
      presale: SharedObjectReference<true>;
      quote: TransactionArgument;
    },
  ) {
    return (tx: Transaction): TransactionResult =>
      this.#presaleCall(
        tx,
        "commit_open",
        [
          this.#presale(tx, options),
          this.#version(tx),
          options.quote,
          tx.object.clock(),
        ],
        options,
      );
  }

  /** `commit_allowlisted` with the sender's leaf; returns the change coin. */
  commitAllowlisted(
    options: LaunchTypes & {
      presale: SharedObjectReference<true>;
      quote: TransactionArgument;
      allowlist: AllowlistProof;
    },
  ) {
    const { index, walletCap, proof } = options.allowlist;
    requireU64("index", index);
    requireU64("walletCap", walletCap);
    const siblings = digests(proof);
    return (tx: Transaction): TransactionResult =>
      this.#presaleCall(
        tx,
        "commit_allowlisted",
        [
          this.#presale(tx, options),
          this.#version(tx),
          options.quote,
          tx.pure.u64(index),
          tx.pure.u64(walletCap),
          tx.pure.vector("vector<u8>", siblings),
          tx.object.clock(),
        ],
        options,
      );
  }

  /** `commit_uncapped` once a phase open to anyone started; returns the change coin. */
  commitUncapped(
    options: LaunchTypes & {
      presale: SharedObjectReference<true>;
      quote: TransactionArgument;
    },
  ) {
    return (tx: Transaction): TransactionResult =>
      this.#presaleCall(
        tx,
        "commit_uncapped",
        [
          this.#presale(tx, options),
          this.#version(tx),
          options.quote,
          tx.object.clock(),
        ],
        options,
      );
  }

  /** `settle`: funds or cancels the sale after its window. Anyone may call. */
  settle(options: LaunchTypes & { presale: SharedObjectReference<true> }) {
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "settle",
        [this.#presale(tx, options), this.#version(tx), tx.object.clock()],
        options,
      );
    };
  }

  /** `cancel_unlaunched`: from the LP deadline, cancels an unmigrated funded sale. */
  cancelUnlaunched(
    options: LaunchTypes & { presale: SharedObjectReference<true> },
  ) {
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "cancel_unlaunched",
        [this.#presale(tx, options), this.#version(tx), tx.object.clock()],
        options,
      );
    };
  }

  /**
   * `claim`: pays `participant` its Quote refund and its tokens, or under
   * participant vesting locks the tokens in a new shared schedule that starts
   * at this claim. Anyone may relay.
   */
  claim(
    options: LaunchTypes & {
      presale: SharedObjectReference<true>;
      participant: string;
    },
  ) {
    const participant = normalizeSuiAddress(options.participant);
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "claim",
        [
          this.#presale(tx, options),
          this.#version(tx),
          tx.pure.address(participant),
          tx.object.clock(),
        ],
        options,
      );
    };
  }

  /** `destroy_cap`: deletes the `PresaleCap` of a cancelled sale. */
  destroyCap(
    options: LaunchTypes & {
      presale: SharedObjectReference;
      presaleCap: TransactionObjectInput;
    },
  ) {
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "destroy_cap",
        [
          sharedObject(
            tx,
            "presale",
            { ...options.presale, mutable: false },
            false,
          ),
          tx.object(options.presaleCap),
        ],
        options,
      );
    };
  }

  /**
   * `cetus::migrate<Meme, Quote, CoinA, CoinB>`: creates the reserved Cetus
   * pool, seeds full range, burns the position through LP Burn into a new
   * `Vault`. The coin order comes from `cetusMemeSide`. Anyone may call.
   */
  migrateCetus(
    options: LaunchTypes & {
      presale: SharedObjectReference<true>;
      cetusConfig: SharedObjectReference<false>;
      cetusPools: SharedObjectReference<true>;
      /** Cetus LP Burn `lp_burn::BurnManager`. */
      burnManager: SharedObjectReference<true>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      // Cetus seeds a new pool's tick skip list from the clock, so its storage
      // differs between simulation and execution by up to 18 bytes, more than
      // the default budget's headroom: budget this transaction at gross cost.
      tx.addBuildPlugin(grossGasBudget());
      tx.moveCall({
        target: `${this.deployment.packageId}::cetus::migrate`,
        typeArguments: cetusTypeArguments(types),
        arguments: [
          this.#presale(tx, options),
          this.#version(tx),
          this.#feePolicy(tx),
          deploymentObject(tx, this.deployment.venueConfig, false),
          sharedObject(tx, "cetusConfig", options.cetusConfig, false),
          sharedObject(tx, "cetusPools", options.cetusPools, true),
          sharedObject(tx, "burnManager", options.burnManager, true),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * `bluefin::migrate`: creates `Pool<Meme, Quote>`, seeds full range, and seals
   * the position in a new `Vault`. `creationFee` must be exactly
   * Bluefin's configured SUI pool-creation fee. Anyone may call.
   */
  migrateBluefin(
    options: LaunchTypes & {
      presale: SharedObjectReference<true>;
      memeCurrency: SharedObjectReference<false>;
      quoteCurrency: SharedObjectReference<false>;
      bluefinConfig: SharedObjectReference<true>;
      creationFee: TransactionArgument;
    },
  ) {
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "migrate",
        [
          this.#presale(tx, options),
          this.#version(tx),
          this.#feePolicy(tx),
          deploymentObject(tx, this.deployment.venueConfig, false),
          sharedObject(tx, "memeCurrency", options.memeCurrency, false),
          sharedObject(tx, "quoteCurrency", options.quoteCurrency, false),
          sharedObject(tx, "bluefinConfig", options.bluefinConfig, true),
          options.creationFee,
          tx.object.clock(),
        ],
        options,
        "bluefin",
      );
    };
  }

  /**
   * `blast_presale::pay_protocol_fees_with_partner`: once a partnered sale migrates, pays its
   * partner its cut in force of Blast's raise fee, rounded down, and
   * Blast the rest and its token share. Anyone may call it, once.
   */
  payProtocolFeesWithPartner(
    options: LaunchTypes & {
      presale: SharedObjectReference<true>;
      partner: SharedObjectReference<false>;
    },
  ) {
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "pay_protocol_fees_with_partner",
        [
          this.#presale(tx, options),
          this.#version(tx),
          this.#feePolicy(tx),
          sharedObject(tx, "partner", options.partner, false),
          tx.object.clock(),
        ],
        options,
      );
    };
  }

  /**
   * `presale_vault::pay_protocol_lp_fees_with_partner`: pays a partnered
   * vault's held Blast LP fees, the partner its cut in force of each asset,
   * rounded down, and Blast the rest. Anyone may call it; holding nothing
   * pays nothing.
   */
  payProtocolLpFeesWithPartner(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      partner: SharedObjectReference<false>;
    },
  ) {
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "pay_protocol_lp_fees_with_partner",
        [
          sharedObject(tx, "vault", options.vault, true),
          this.#version(tx),
          this.#feePolicy(tx),
          sharedObject(tx, "partner", options.partner, false),
          tx.object.clock(),
        ],
        options,
        "presale_vault",
      );
    };
  }

  /**
   * `cetus::collect_fees`: pays Blast, or holds its LP fees on a partnered
   * vault, then pays every fee recipient and keeps the holder share.
   */
  collectCetusFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      cetusConfig: SharedObjectReference<false>;
      burnManager: SharedObjectReference<false>;
      pool: SharedObjectReference<true>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::cetus::collect_fees`,
        typeArguments: cetusTypeArguments(types),
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          this.#version(tx),
          this.#feePolicy(tx),
          sharedObject(tx, "cetusConfig", options.cetusConfig, false),
          sharedObject(tx, "burnManager", options.burnManager, false),
          sharedObject(tx, "pool", options.pool, true),
        ],
      });
    };
  }

  /**
   * `bluefin::collect_fees`: pays Blast, or holds its LP fees on a partnered
   * vault, then pays every fee recipient and keeps the holder share.
   */
  collectBluefinFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      bluefinConfig: SharedObjectReference<false>;
      pool: SharedObjectReference<true>;
    },
  ) {
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "collect_fees",
        [
          sharedObject(tx, "vault", options.vault, true),
          this.#version(tx),
          this.#feePolicy(tx),
          sharedObject(tx, "bluefinConfig", options.bluefinConfig, false),
          sharedObject(tx, "pool", options.pool, true),
          tx.object.clock(),
        ],
        options,
        "bluefin",
      );
    };
  }

  /**
   * `cetus::new_vault`: burns the caller's own Cetus `position` in `pool`
   * through Cetus LP Burn and seals the proof in a new shared `Vault` that
   * splits its LP fees by the fee split, after Blast's current rates. The
   * coin order comes from `cetusMemeSide`. Blast must allow Quote and the
   * Cetus migrator, and accept `partnerId` when given (contracts ADR 0109).
   */
  newCetusVault(
    options: LaunchTypes & {
      position: TransactionObjectInput;
      feeRecipients: readonly BpsShare[];
      holderRewardsBps: bigint;
      partnerId?: string | null;
      pool: SharedObjectReference<false>;
      /** Cetus LP Burn `lp_burn::BurnManager`. */
      burnManager: SharedObjectReference<true>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const partnerId = optionalObjectId(options.partnerId);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::cetus::new_vault`,
        typeArguments: cetusTypeArguments(types),
        arguments: [
          tx.object(options.position),
          this.#version(tx),
          tx.add(
            this.feeSplit(options.feeRecipients, options.holderRewardsBps),
          ),
          tx.pure.option("address", partnerId),
          this.#creationPolicy(tx),
          this.#feePolicy(tx),
          sharedObject(tx, "pool", options.pool, false),
          sharedObject(tx, "burnManager", options.burnManager, true),
          tx.object.clock(),
        ],
      });
    };
  }

  /**
   * `bluefin::new_vault`: seals the caller's own Bluefin `position` in `pool`,
   * whose first coin must be Meme, in a new shared `Vault` splitting its LP
   * fees by the fee split, after Blast's current rates (contracts ADR 0109).
   * Accepts an existing shared pool or a fresh pool handle in this PTB.
   */
  newBluefinVault(
    options: LaunchTypes & {
      position: TransactionObjectInput;
      feeRecipients: readonly BpsShare[];
      holderRewardsBps: bigint;
      partnerId?: string | null;
      pool: SharedObjectReference<false> | TransactionObjectArgument;
    },
  ) {
    const partnerId = optionalObjectId(options.partnerId);
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "new_vault",
        [
          tx.object(options.position),
          this.#version(tx),
          tx.add(
            this.feeSplit(options.feeRecipients, options.holderRewardsBps),
          ),
          tx.pure.option("address", partnerId),
          this.#creationPolicy(tx),
          this.#feePolicy(tx),
          "objectId" in options.pool
            ? sharedObject(tx, "pool", options.pool, false)
            : tx.object(options.pool),
          tx.object.clock(),
        ],
        options,
        "bluefin",
      );
    };
  }

  /** `presale_vault::claim_migration_residuals`; returns `(Coin<Meme>, Coin<Quote>)`. */
  claimMigrationResiduals(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      presaleCap: TransactionObjectInput;
    },
  ) {
    return (tx: Transaction): TransactionResult =>
      this.#presaleCall(
        tx,
        "claim_migration_residuals",
        [
          sharedObject(tx, "vault", options.vault, true),
          this.#version(tx),
          tx.object(options.presaleCap),
        ],
        options,
        "presale_vault",
      );
  }

  /**
   * `fee_policy::set_fees`: the rates presales created afterward snapshot.
   * The contract bounds them (raise below 10,000, tokens at most 9,998, each
   * LP share at most 10,000) and rejects an unchanged set.
   */
  setProtocolFees(options: {
    adminWitness: TransactionObjectInput;
    fees: ProtocolFees;
  }) {
    const { raiseBps, tokenBps, lpFeeMemeBps, lpFeeQuoteBps } = options.fees;
    const rates = [raiseBps, tokenBps, lpFeeMemeBps, lpFeeQuoteBps].map(
      (rate) => this.bps(rate),
    );
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "set_fees",
        [
          this.#feePolicy(tx, true),
          this.#version(tx),
          tx.object(options.adminWitness),
          ...rates.map((rate) => tx.add(rate)),
        ],
        undefined,
        "fee_policy",
      );
    };
  }

  /**
   * `blast_presale::set_protocol_fees`: replaces one sale's Blast rates before
   * its window starts, either once shared or, in its creation PTB, before
   * `share` (with the `Presale` result as `presale`). Blast's token difference moves to or from the buyers'
   * sale allocation and its raise difference to or from the LP's Quote, each
   * rounded down. The contract applies `setProtocolFees`'s bounds and rejects
   * an unchanged set, a started sale, an LP left without Quote or an
   * unpoolable price, and buyers left without tokens.
   */
  setPresaleProtocolFees(
    options: LaunchTypes & {
      presale: SharedObjectReference<true> | TransactionArgument;
      adminWitness: TransactionObjectInput;
      fees: ProtocolFees;
    },
  ) {
    const { presale } = options;
    const { raiseBps, tokenBps, lpFeeMemeBps, lpFeeQuoteBps } = options.fees;
    const rates = [raiseBps, tokenBps, lpFeeMemeBps, lpFeeQuoteBps].map(
      (rate) => this.bps(rate),
    );
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "set_protocol_fees",
        [
          "objectId" in presale ? this.#presale(tx, { presale }) : presale,
          this.#version(tx),
          tx.object(options.adminWitness),
          ...rates.map((rate) => tx.add(rate)),
          tx.object.clock(),
        ],
        options,
      );
    };
  }

  /**
   * `presale_vault::set_protocol_lp_fees`: Blast's share of each asset in one
   * vault's later LP-fee collections. Fees still in the pool split at the new
   * rates when collected. The contract rejects an unchanged pair.
   */
  setProtocolLpFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
      lpFeeMemeBps: bigint;
      lpFeeQuoteBps: bigint;
    },
  ) {
    const rates = [options.lpFeeMemeBps, options.lpFeeQuoteBps].map((rate) =>
      this.bps(rate),
    );
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "set_protocol_lp_fees",
        [
          sharedObject(tx, "vault", options.vault, true),
          this.#version(tx),
          tx.object(options.adminWitness),
          ...rates.map((rate) => tx.add(rate)),
        ],
        options,
        "presale_vault",
      );
    };
  }

  /** `creation_policy::set_quote_allowed<Quote>`: whether presales created afterward may raise it. */
  setQuoteAllowed(options: {
    adminWitness: TransactionObjectInput;
    quoteType: string;
    allowed: boolean;
  }) {
    const quoteType = normalizeStructTag(options.quoteType);
    return (tx: Transaction): void => {
      this.#setAllowed(tx, "set_quote_allowed", quoteType, options);
    };
  }

  /**
   * `creation_policy::set_migration_witness_allowed`: whether the venue or
   * external migrator may create presales afterward.
   */
  setMigrationWitnessAllowed(
    options: PresaleMigrator & {
      adminWitness: TransactionObjectInput;
      allowed: boolean;
    },
  ) {
    const witness =
      options.venue === undefined
        ? externalWitnessType(options.witnessType)
        : this.migrationWitnessType(options.venue);
    return (tx: Transaction): void => {
      this.#setAllowed(tx, "set_migration_witness_allowed", witness, options);
    };
  }

  /** `creation_policy::add_partner`: new presales may name `partner` at once. */
  addPartner(options: {
    adminWitness: TransactionObjectInput;
    partner: SharedObjectReference<false>;
  }) {
    return (tx: Transaction): void => {
      this.#partnerCall(tx, "add_partner", options, []);
    };
  }

  /**
   * `creation_policy::remove_partner`: new presales stop naming `partner`
   * after `PARTNER_DELAY_MS`; sales that name it keep paying it.
   */
  removePartner(options: {
    adminWitness: TransactionObjectInput;
    partner: SharedObjectReference<false>;
  }) {
    return (tx: Transaction): void => {
      this.#partnerCall(tx, "remove_partner", options, [tx.object.clock()]);
    };
  }

  /** `fee_policy::set_destination`: redirects every later protocol payout. */
  setProtocolDestination(options: {
    adminWitness: TransactionObjectInput;
    destination: string;
  }) {
    const destination = normalizeSuiAddress(options.destination);
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "set_destination",
        [
          this.#feePolicy(tx, true),
          this.#version(tx),
          tx.object(options.adminWitness),
          tx.pure.address(destination),
        ],
        undefined,
        "fee_policy",
      );
    };
  }

  /**
   * `holder_rewards::publish_round` from a manifest built with
   * `PRESALE_REWARD_LEAF_DOMAIN`; reserves its budget from the vault's holder
   * share and shares the `Round`, claimable until `claimDeadlineMs`.
   */

  /** Funds holder leaves and gas custody only if the governed treasury still matches the prepared destination. */
  publishHolderRewardRound(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
      manifest: RewardManifest | RewardManifestSummary;
      gasReserveAmount: bigint;
      expectedTreasury: string;
      claimDeadlineMs: bigint;
    },
  ) {
    const manifest =
      "allocations" in options.manifest
        ? validateRewardManifest(options.manifest, PRESALE_REWARD_LEAF_DOMAIN)
        : validateRewardManifestSummary(
            options.manifest,
            PRESALE_REWARD_LEAF_DOMAIN,
          );
    const leafCount =
      "allocations" in manifest
        ? manifest.allocations.length
        : manifest.leafCount;
    if (
      rewardAddress(manifest.vaultId) !== rewardAddress(options.vault.objectId)
    )
      throw new TypeError("manifest belongs to another vault");
    const expectedTreasury = normalizeSuiAddress(options.expectedTreasury);
    if (!isValidSuiAddress(expectedTreasury))
      throw new TypeError("invalid expectedTreasury address");
    const gasReserveAmount = requireU64(
      "gasReserveAmount",
      options.gasReserveAmount,
    );
    const claimDeadlineMs = requireU64(
      "claimDeadlineMs",
      options.claimDeadlineMs,
    );
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "publish_round",
        [
          sharedObject(tx, "vault", options.vault, true),
          this.#version(tx),
          tx.object(options.adminWitness),
          this.#feePolicy(tx),
          tx.pure.address(expectedTreasury),
          tx.pure.u64(manifest.number),
          tx.pure.u64(manifest.startCheckpoint),
          tx.pure.u64(manifest.endCheckpoint),
          tx.pure.vector("u8", rewardDigest(manifest.root)),
          tx.pure.vector("u8", rewardDigest(manifest.manifestDigest)),
          tx.pure.u64(leafCount),
          tx.pure.u64(manifest.memeAmount),
          tx.pure.u64(manifest.quoteAmount),
          tx.pure.u64(gasReserveAmount),
          tx.pure.u64(claimDeadlineMs),
          tx.object.clock(),
        ],
        options,
        "holder_rewards",
      );
    };
  }

  /** `holder_rewards::claim`: relays one proof; the round pays its beneficiary. */
  claimHolderReward(
    options: LaunchTypes & {
      round: SharedObjectReference<true>;
      allocation: RewardProof;
    },
  ) {
    return this.#claimHolderReward(options, "claim");
  }

  /** Relays the same presale proof domain against the distinct reserve-bearing round. */

  #claimHolderReward(
    options: LaunchTypes & {
      round: SharedObjectReference<true>;
      allocation: RewardProof;
    },
    functionName: "claim",
  ) {
    const { allocation } = options;
    const index = requireU64("index", BigInt(allocation.index));
    const memeAmount = requireU64("memeAmount", BigInt(allocation.memeAmount));
    const quoteAmount = requireU64(
      "quoteAmount",
      BigInt(allocation.quoteAmount),
    );
    const beneficiary = rewardAddress(allocation.beneficiary);
    const proof = digests(allocation.proof);
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        functionName,
        [
          sharedObject(tx, "round", options.round, true),
          this.#version(tx),
          tx.pure.u64(index),
          tx.pure.address(beneficiary),
          tx.pure.u64(memeAmount),
          tx.pure.u64(quoteAmount),
          tx.pure.vector("vector<u8>", proof),
        ],
        options,
        "holder_rewards",
      );
    };
  }

  /**
   * `holder_rewards::close_round`: after the claim deadline, deletes the round
   * and returns its unclaimed balances to the vault. Anyone may call.
   */
  closeHolderRewardRound(
    options: LaunchTypes & {
      round: SharedObjectReference<true>;
      vault: SharedObjectReference<true>;
    },
  ) {
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "close_round",
        [
          sharedObject(tx, "round", options.round, true),
          this.#version(tx),
          sharedObject(tx, "vault", options.vault, true),
          tx.object.clock(),
        ],
        options,
        "holder_rewards",
      );
    };
  }

  /** One terminal reimbursement to the round's bound treasury; contract caps it by reserved Quote atoms. */
  settleHolderRewardGasReserve(
    options: LaunchTypes & {
      round: SharedObjectReference<true>;
      vault: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
      reimbursementAmount: bigint;
    },
  ) {
    const reimbursement = requireU64(
      "reimbursementAmount",
      options.reimbursementAmount,
    );
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "settle_gas_reserve",
        [
          sharedObject(tx, "round", options.round, true),
          this.#version(tx),
          tx.object(options.adminWitness),
          sharedObject(tx, "vault", options.vault, true),
          tx.pure.u64(reimbursement),
        ],
        options,
        "holder_rewards",
      );
    };
  }

  /** Permissionless actual close returns holder custody and any unsettled reserve to the bound vault. */

  #newPresale(
    start: (tx: Transaction) => TransactionResult,
    options: PresaleTerms,
  ) {
    return (tx: Transaction): TransactionResult => {
      const initializer = tx.add(start);
      tx.add(this.configurePresale({ ...options, initializer }));
      return tx.add(this.finalizePresale({ ...options, initializer }));
    };
  }

  #aftermath(): AftermathPresaleDeployment {
    const { aftermath } = this.deployment;
    if (!aftermath) {
      throw new TypeError("deployment.aftermath is required for Aftermath");
    }
    return aftermath;
  }

  /** `<SaleToken, Quote>`, the vendor's `new` type arguments. */
  #saleTypes(options: LaunchTypes): string[] {
    const { memeType, quoteType } = normalizeLaunchTypes(options);
    return [memeType, quoteType];
  }

  /** `<Lp, SaleToken, Quote>`, the vendor's `finalize` and `migrate` type arguments. */
  #aftermathTypes(options: LaunchTypes & { lpType: string }): string[] {
    return [normalizeStructTag(options.lpType), ...this.#saleTypes(options)];
  }

  #setAllowed(
    tx: Transaction,
    functionName: string,
    typeArgument: string,
    options: { adminWitness: TransactionObjectInput; allowed: boolean },
  ): void {
    tx.moveCall({
      target: `${this.deployment.packageId}::creation_policy::${functionName}`,
      typeArguments: [typeArgument],
      arguments: [
        this.#creationPolicy(tx, true),
        this.#version(tx),
        tx.object(options.adminWitness),
        tx.pure.bool(options.allowed),
      ],
    });
  }

  #partnerCall(
    tx: Transaction,
    functionName: "add_partner" | "remove_partner",
    options: {
      adminWitness: TransactionObjectInput;
      partner: SharedObjectReference<false>;
    },
    trailing: TransactionArgument[],
  ): void {
    tx.moveCall({
      target: `${this.deployment.packageId}::creation_policy::${functionName}`,
      arguments: [
        this.#creationPolicy(tx, true),
        this.#version(tx),
        tx.object(options.adminWitness),
        sharedObject(tx, "partner", options.partner, false),
        ...trailing,
      ],
    });
  }

  #vestingTerms(tx: Transaction, terms: VestingTerms): TransactionResult {
    return this.#presaleCall(tx, "vesting_terms", [
      tx.pure.u64(terms.cliffMs),
      tx.pure.u64(terms.periodMs),
      tx.pure.u64(terms.periods),
    ]);
  }

  /** Calls `module::functionName` of this package, typed `<Meme, Quote>` when given. */
  #presaleCall(
    tx: Transaction,
    functionName: string,
    args: TransactionArgument[],
    types?: LaunchTypes,
    module = "blast_presale",
  ): TransactionResult {
    const normalized = types && normalizeLaunchTypes(types);
    return tx.moveCall({
      target: `${this.deployment.packageId}::${module}::${functionName}`,
      typeArguments: normalized
        ? [normalized.memeType, normalized.quoteType]
        : [],
      arguments: args,
    });
  }

  #presale(
    tx: Transaction,
    options: { presale: SharedObjectReference<true> },
  ): TransactionObjectArgument {
    return sharedObject(tx, "presale", options.presale, true);
  }

  #version(tx: Transaction): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.packageVersion, false);
  }

  #feePolicy(tx: Transaction, mutable = false): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.feePolicy, mutable);
  }

  #creationPolicy(tx: Transaction, mutable = false): TransactionObjectArgument {
    return deploymentObject(tx, this.deployment.creationPolicy, mutable);
  }

  #type(name: string): string {
    return normalizeStructTag(`${this.deployment.originalPackageId}::${name}`);
  }
}

export class PresaleTransactions {
  readonly call: PresaleCalls;
  readonly #useGasCoin: boolean;

  constructor(deployment: PresaleDeployment, options: CoinSourceOptions = {}) {
    this.call = new PresaleCalls(deployment);
    this.#useGasCoin = options.useGasCoin ?? true;
  }

  /**
   * `cetus::new`, every setter (with `set_partner` when `partner` is given),
   * `finalize`, `share` from `startMs`, and transfers the `PresaleCap` to
   * `capRecipient`.
   */
  createCetusPresale(
    options: Parameters<PresaleCalls["newCetusPresale"]>[0] & PresaleCreation,
  ): Transaction {
    const tx = new Transaction();
    const created = tx.add(this.call.newCetusPresale(options));
    return this.#shareAndKeepCap(tx, created, options);
  }

  /**
   * `bluefin::new`, every setter (with `set_partner` when `partner` is given),
   * `finalize`, `share` from `startMs`, and transfers the `PresaleCap` to
   * `capRecipient`.
   */
  createBluefinPresale(
    options: Parameters<PresaleCalls["newBluefinPresale"]>[0] & PresaleCreation,
  ): Transaction {
    const tx = new Transaction();
    const created = tx.add(this.call.newBluefinPresale(options));
    return this.#shareAndKeepCap(tx, created, options);
  }

  /**
   * With the vendor's `AdminCap`: the vendor's `new`, every setter but the
   * LP-fee split (with `set_partner` when `partner` is given), the vendor's
   * `finalize`, and `share` from `startMs`. The vendor sends the `PresaleCap`
   * to its treasury itself.
   */
  createAftermathPresale(
    options: AftermathPresaleTerms & Omit<PresaleCreation, "capRecipient">,
  ): Transaction {
    const tx = new Transaction();
    const presale = tx.add(this.call.newAftermathPresale(options));
    tx.add(this.call.share({ ...options, presale }));
    return tx;
  }

  /**
   * Commits `amount` Quote from the sender's coins through `route` and sends
   * the returned change (zero outside a hard-capped phase) to `recipient`,
   * normally the sender.
   */
  commit(
    options: LaunchTypes & {
      presale: SharedObjectReference<true>;
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
    const quote = tx.coin({
      type: normalizeStructTag(options.quoteType),
      balance: amount,
      useGasCoin: options.useGasCoin ?? this.#useGasCoin,
    });
    const change = tx.add(
      options.route === "allowlisted"
        ? this.call.commitAllowlisted({ ...options, quote })
        : options.route === "open"
          ? this.call.commitOpen({ ...options, quote })
          : this.call.commitUncapped({ ...options, quote }),
    );
    tx.transferObjects([change], recipient);
    return tx;
  }

  settle(options: Parameters<PresaleCalls["settle"]>[0]): Transaction {
    return single(this.call.settle(options));
  }

  cancelUnlaunched(
    options: Parameters<PresaleCalls["cancelUnlaunched"]>[0],
  ): Transaction {
    return single(this.call.cancelUnlaunched(options));
  }

  /** Relays one claim per participant in a single PTB. */
  claim(
    options: LaunchTypes & {
      presale: SharedObjectReference<true>;
      participants: readonly string[];
    },
  ): Transaction {
    const tx = new Transaction();
    for (const participant of options.participants) {
      tx.add(this.call.claim({ ...options, participant }));
    }
    return tx;
  }

  destroyCap(
    options: LaunchTypes & {
      presale: SharedObjectReference;
      presaleCapId: string;
    },
  ): Transaction {
    return single(
      this.call.destroyCap({ ...options, presaleCap: options.presaleCapId }),
    );
  }

  /** Then pays the sale's partner when `partner` is given; see `payProtocolFeesWithPartner`. */
  migrateCetus(
    options: Parameters<PresaleCalls["migrateCetus"]>[0] & PresalePayout,
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.migrateCetus(options));
    return this.#payProtocolFeesWithPartnerAfter(tx, options);
  }

  /**
   * Pays Bluefin's SUI pool-creation fee as an exact-balance coin,
   * then the sale's partner when `partner` is given; see `payProtocolFeesWithPartner`.
   */
  migrateBluefin(
    options: Omit<
      Parameters<PresaleCalls["migrateBluefin"]>[0],
      "creationFee"
    > & { creationFee: bigint } & PresalePayout &
      CoinSourceOptions,
  ): Transaction {
    requireU64("creationFee", options.creationFee);
    const tx = new Transaction();
    const creationFee = tx.coin({
      type: "0x2::sui::SUI",
      balance: options.creationFee,
      useGasCoin: options.useGasCoin ?? this.#useGasCoin,
    });
    tx.add(this.call.migrateBluefin({ ...options, creationFee }));
    return this.#payProtocolFeesWithPartnerAfter(tx, options);
  }

  /**
   * Migrates a funded Aftermath sale, then pays the sale's partner when
   * `partner` is given; see `payProtocolFeesWithPartner`.
   */
  migrateAftermath(options: AftermathMigration & PresalePayout): Transaction {
    const tx = new Transaction();
    tx.add(this.call.migrateAftermath(options));
    return this.#payProtocolFeesWithPartnerAfter(tx, options);
  }

  /**
   * `settle` and the Aftermath `migrate` in one PTB, then the partner payout
   * when `partner` is given: the relayer's settle-and-migrate shape. If the
   * sale settles as cancelled (underfunded), `migrate` aborts and the whole
   * PTB with it, so settle alone in that case.
   */
  settleAndMigrateAftermath(
    options: AftermathMigration & PresalePayout,
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.settle(options));
    tx.add(this.call.migrateAftermath(options));
    return this.#payProtocolFeesWithPartnerAfter(tx, options);
  }

  /**
   * Pays a migrated sale's partner and Blast the shares its migration held.
   * Use it for a sale another migrator, such as a vendor package's, migrated.
   */
  payProtocolFeesWithPartner(
    options: Parameters<PresaleCalls["payProtocolFeesWithPartner"]>[0],
  ): Transaction {
    return single(this.call.payProtocolFeesWithPartner(options));
  }

  /** Then pays the vault's partner when `partner` is given; see `payProtocolLpFeesWithPartner`. */
  collectCetusFees(
    options: Parameters<PresaleCalls["collectCetusFees"]>[0] & PresalePayout,
  ): Transaction {
    const tx = single(this.call.collectCetusFees(options));
    return this.#payProtocolLpFeesWithPartnerAfter(tx, options);
  }

  /** Then pays the vault's partner when `partner` is given; see `payProtocolLpFeesWithPartner`. */
  collectBluefinFees(
    options: Parameters<PresaleCalls["collectBluefinFees"]>[0] & PresalePayout,
  ): Transaction {
    const tx = single(this.call.collectBluefinFees(options));
    return this.#payProtocolLpFeesWithPartnerAfter(tx, options);
  }

  newCetusVault(
    options: Parameters<PresaleCalls["newCetusVault"]>[0],
  ): Transaction {
    return single(this.call.newCetusVault(options));
  }

  newBluefinVault(
    options: Parameters<PresaleCalls["newBluefinVault"]>[0],
  ): Transaction {
    return single(this.call.newBluefinVault(options));
  }

  /** Pays a partnered vault's partner and Blast the LP fees its collections held. */
  payProtocolLpFeesWithPartner(
    options: Parameters<PresaleCalls["payProtocolLpFeesWithPartner"]>[0],
  ): Transaction {
    return single(this.call.payProtocolLpFeesWithPartner(options));
  }

  claimMigrationResiduals(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      presaleCapId: string;
      recipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const result = tx.add(
      this.call.claimMigrationResiduals({
        ...options,
        presaleCap: options.presaleCapId,
      }),
    );
    tx.transferObjects(
      moveResults(result, 2),
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  /** Signs in as `RewardsAdmin` and publishes a holder-reward round. */
  publishHolderRewardRound(
    options: AsAdmin<Parameters<PresaleCalls["publishHolderRewardRound"]>[0]>,
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "RewardsAdmin", (adminWitness) =>
      this.call.publishHolderRewardRound({ ...options, adminWitness }),
    );
  }

  settleHolderRewardGasReserve(
    options: AsAdmin<
      Parameters<PresaleCalls["settleHolderRewardGasReserve"]>[0]
    >,
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "RewardsAdmin", (adminWitness) =>
      this.call.settleHolderRewardGasReserve({ ...options, adminWitness }),
    );
  }

  /** Signs in as `FeeAdmin` and sets the rates future presales snapshot. */
  setProtocolFees(
    options: AsAdmin<Parameters<PresaleCalls["setProtocolFees"]>[0]>,
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.setProtocolFees({ ...options, adminWitness }),
    );
  }

  /** Signs in as `FeeAdmin` and replaces one sale's Blast rates before its window starts. */
  setPresaleProtocolFees(
    options: Omit<
      Parameters<PresaleCalls["setPresaleProtocolFees"]>[0],
      "adminWitness" | "presale"
    > & { presale: SharedObjectReference<true>; adminCapId: string },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.setPresaleProtocolFees({ ...options, adminWitness }),
    );
  }

  /** Signs in as `FeeAdmin` and sets Blast's LP-fee rates on one migrated vault. */
  setProtocolLpFees(
    options: AsAdmin<Parameters<PresaleCalls["setProtocolLpFees"]>[0]>,
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.setProtocolLpFees({ ...options, adminWitness }),
    );
  }

  /** Signs in as `ListingAdmin` and lists or delists a Quote type for new presales. */
  setQuoteAllowed(
    options: AsAdmin<Parameters<PresaleCalls["setQuoteAllowed"]>[0]>,
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "ListingAdmin", (adminWitness) =>
      this.call.setQuoteAllowed({ ...options, adminWitness }),
    );
  }

  /** Signs in as `AdapterAdmin` and lists or delists a venue or external migrator. */
  setMigrationWitnessAllowed(
    options: PresaleMigrator & {
      adminCapId: string;
      allowed: boolean;
    },
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "AdapterAdmin", (adminWitness) =>
      this.call.setMigrationWitnessAllowed({ ...options, adminWitness }),
    );
  }

  /** Signs in as `FeeAdmin` and lets new presales name `partner` at once. */
  addPartner(
    options: AsAdmin<Parameters<PresaleCalls["addPartner"]>[0]>,
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.addPartner({ ...options, adminWitness }),
    );
  }

  /** Signs in as `FeeAdmin` and stops new presales naming `partner` after `PARTNER_DELAY_MS`. */
  removePartner(
    options: AsAdmin<Parameters<PresaleCalls["removePartner"]>[0]>,
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "FeeAdmin", (adminWitness) =>
      this.call.removePartner({ ...options, adminWitness }),
    );
  }

  /** Signs in as `TreasuryAdmin` and redirects every later protocol payout. */
  setProtocolDestination(
    options: AsAdmin<Parameters<PresaleCalls["setProtocolDestination"]>[0]>,
  ): Transaction {
    return this.#asAdmin(options.adminCapId, "TreasuryAdmin", (adminWitness) =>
      this.call.setProtocolDestination({ ...options, adminWitness }),
    );
  }

  /** Relays up to `allocations.length` proofs of one round in a single PTB. */
  claimHolderRewards(
    options: LaunchTypes & {
      round: SharedObjectReference<true>;
      allocations: readonly RewardProof[];
    },
  ): Transaction {
    const tx = new Transaction();
    for (const allocation of options.allocations) {
      tx.add(this.call.claimHolderReward({ ...options, allocation }));
    }
    return tx;
  }

  closeHolderRewardRound(
    options: Parameters<PresaleCalls["closeHolderRewardRound"]>[0],
  ): Transaction {
    return single(this.call.closeHolderRewardRound(options));
  }

  /** Signs in as `role` and runs one administrator call in the same PTB. */
  #asAdmin(
    adminCapId: string,
    role: PresaleAdminRole,
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

  #shareAndKeepCap(
    tx: Transaction,
    created: TransactionResult,
    options: LaunchTypes & PresaleCreation,
  ): Transaction {
    const [presale, presaleCap] = moveResults(created, 2);
    tx.add(this.call.share({ ...options, presale }));
    tx.transferObjects([presaleCap], normalizeSuiAddress(options.capRecipient));
    return tx;
  }

  #payProtocolFeesWithPartnerAfter(
    tx: Transaction,
    options: LaunchTypes & {
      presale: SharedObjectReference<true>;
    } & PresalePayout,
  ): Transaction {
    const { partner } = options;
    if (partner)
      tx.add(this.call.payProtocolFeesWithPartner({ ...options, partner }));
    return tx;
  }

  #payProtocolLpFeesWithPartnerAfter(
    tx: Transaction,
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
    } & PresalePayout,
  ): Transaction {
    const { partner } = options;
    if (partner)
      tx.add(this.call.payProtocolLpFeesWithPartner({ ...options, partner }));
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

/** A normalized object ID for an `Option<ID>` argument, or null for `none`. */
function optionalObjectId(objectId: string | null | undefined): string | null {
  return objectId ? normalizeSuiObjectId(objectId) : null;
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

/** `[Meme, Quote, CoinA, CoinB]`, the pool's coins in Cetus order. */
function cetusTypeArguments(types: LaunchTypes): string[] {
  const { memeType, quoteType } = types;
  return cetusMemeSide(memeType, quoteType) === "a"
    ? [memeType, quoteType, memeType, quoteType]
    : [memeType, quoteType, quoteType, memeType];
}

function digests(proof: readonly string[]): number[][] {
  if (proof.length > MAX_PRESALE_PROOF_DEPTH) {
    throw new RangeError(`proof exceeds ${MAX_PRESALE_PROOF_DEPTH} siblings`);
  }
  return proof.map((sibling) => Array.from(rewardDigest(sibling)));
}

function requireU32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be a u32`);
  }
  return value;
}
