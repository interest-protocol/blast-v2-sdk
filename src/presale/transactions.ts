import type {
  TransactionArgument,
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import type { AdminDeployment } from "../admin/transactions.ts";
import { AdminCalls, normalizeAdminDeployment } from "../admin/transactions.ts";
import type {
  RewardManifest,
  RewardProof,
} from "../holder-rewards/allocations.ts";
import {
  PRESALE_REWARD_LEAF_DOMAIN,
  rewardAddress,
  rewardDigest,
  validateRewardManifest,
} from "../holder-rewards/allocations.ts";
import type { LaunchTypes } from "../launchpad/transactions.ts";
import { normalizeLaunchTypes } from "../launchpad/transactions.ts";
import { requireU64 } from "../lib/integers.ts";
import { moveResults } from "../lib/ptb.ts";
import type { SharedObjectReference } from "../lib/sui.ts";
import { normalizeSharedObjectReference } from "../lib/sui.ts";
import type { CetusMemeSide } from "../migrators/transactions.ts";
import type { AllowlistProof } from "./allowlist.ts";
import {
  allowlistedEligibility,
  openEligibility,
  uncappedForAnyone,
  validateFeeRecipient,
  validateRecipientAllocation,
} from "./math.ts";
import type { BpsShare, EligibilityPolicy, UncappedPhase } from "./state.ts";

/**
 * The presale package is not published yet, so no deployment is registered;
 * callers pass the IDs the publish and `package_admin::wrap` effects return.
 */
export type PresaleDeployment = {
  packageId: string;
  originalPackageId?: string;
  /** `venue_config::VenueConfig`, holding each Meme's Cetus `PoolCreationCap`. */
  venueConfig: SharedObjectReference<false>;
  admin: AdminDeployment;
};

type NormalizedDeployment = Required<PresaleDeployment>;

/** The typed `blast_presale_domain` roles. */
export type PresaleAdminRole = "UpgradeAdmin" | "RewardsAdmin";

/** Venues the presale adapters ship. */
export type PresaleVenue = "cetus" | "bluefin";

/** Per-sale terms shared by `cetus::new` and `bluefin::new`, in Move argument order. */
export type PresaleTerms = LaunchTypes & {
  /** The zero-supply `TreasuryCap<Meme>`, consumed. */
  treasuryCap: TransactionObjectInput;
  /** The Meme's Coin Registry `Currency<Meme>`. */
  memeCurrency: SharedObjectReference<true>;
  tokenSupply: bigint;
  tokenAllocationBps: bigint;
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
  feeRecipients: readonly BpsShare[];
  rewardsFeeBps: bigint;
};

export type CetusPresaleObjects = {
  /** Cetus CLMM `config::GlobalConfig`. */
  cetusConfig: SharedObjectReference<false>;
  /** Cetus CLMM `factory::Pools`. */
  cetusPools: SharedObjectReference<true>;
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

function cetusTypeName(type: string): string {
  return normalizeStructTag(parseStructTag(type)).replace(
    /0x([0-9a-f]{64})/g,
    "$1",
  );
}

export class PresaleCalls {
  readonly deployment: NormalizedDeployment;
  readonly admin: AdminCalls;

  constructor(deployment: PresaleDeployment) {
    const packageId = normalizeSuiObjectId(deployment.packageId);
    this.deployment = {
      packageId,
      originalPackageId: normalizeSuiObjectId(
        deployment.originalPackageId ?? packageId,
      ),
      venueConfig: normalizeSharedObjectReference(
        "venueConfig",
        deployment.venueConfig,
        false,
      ),
      admin: normalizeAdminDeployment(deployment.admin),
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

  /** The type a presale stores as its `migration_witness`. */
  migrationWitnessType(venue: PresaleVenue): string {
    return this.#type(`${venue}::Witness`);
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

  /** `Option<UncappedPhase>`: `none`, or `some` of `uncapped_for_eligible` / `uncapped_for_anyone`. */
  uncapped(phase: UncappedPhase | null) {
    const type = this.#type("blast_presale::UncappedPhase");
    if (phase) requireU64("startsAfterMs", phase.startsAfterMs);
    const { access } = phase ?? {};
    if (phase && access?.kind === "anyone") {
      uncappedForAnyone(
        phase.startsAfterMs,
        access.maxParticipants,
        access.minCommitment,
        phase.hardCap,
      );
    }
    return (tx: Transaction): TransactionResult => {
      if (!phase) {
        return tx.moveCall({
          target: "0x1::option::none",
          typeArguments: [type],
        });
      }
      const value =
        access?.kind === "anyone"
          ? this.#presaleCall(tx, "uncapped_for_anyone", [
              tx.pure.u64(phase.startsAfterMs),
              tx.pure.u64(access.maxParticipants),
              tx.pure.u64(access.minCommitment),
              tx.pure.bool(phase.hardCap),
            ])
          : this.#presaleCall(tx, "uncapped_for_eligible", [
              tx.pure.u64(phase.startsAfterMs),
              tx.pure.bool(phase.hardCap),
            ]);
      return tx.moveCall({
        target: "0x1::option::some",
        typeArguments: [type],
        arguments: [value],
      });
    };
  }

  /** `vector<RecipientAllocation>` from `recipient_allocation` calls. */
  recipientAllocations(allocations: readonly BpsShare[]) {
    return this.#shares(
      allocations,
      "recipient_allocation",
      "RecipientAllocation",
    );
  }

  /** `vector<FeeRecipient>` from `fee_recipient` calls. */
  feeRecipients(recipients: readonly BpsShare[]) {
    return this.#shares(recipients, "fee_recipient", "FeeRecipient");
  }

  /**
   * `cetus::new`: mints and seals the supply, reserves the pair's Cetus pool
   * creation at `tickSpacing` (Cetus derives the fee rate), and returns
   * `(Presale, PresaleCap)`; the same PTB must `share` the presale.
   */
  newCetusPresale(
    options: PresaleTerms & CetusPresaleObjects & { tickSpacing: number },
  ) {
    const tickSpacing = requireU32("tickSpacing", options.tickSpacing);
    return (tx: Transaction): TransactionResult =>
      this.#newPresale(tx, "cetus", options, [
        sharedObject(
          tx,
          "venueConfig",
          { ...this.deployment.venueConfig, mutable: true },
          true,
        ),
        sharedObject(tx, "cetusConfig", options.cetusConfig, false),
        sharedObject(tx, "cetusPools", options.cetusPools, true),
        tx.pure.u32(tickSpacing),
      ]);
  }

  /** `bluefin::new` at the creator's tier; returns `(Presale, PresaleCap)`. */
  newBluefinPresale(
    options: PresaleTerms & { tickSpacing: number; feeRate: bigint },
  ) {
    const tickSpacing = requireU32("tickSpacing", options.tickSpacing);
    const feeRate = requireU64("feeRate", options.feeRate);
    return (tx: Transaction): TransactionResult =>
      this.#newPresale(tx, "bluefin", options, [
        tx.pure.u32(tickSpacing),
        tx.pure.u64(feeRate),
      ]);
  }

  /** `blast_presale::share`: shares the new presale and starts its window now. */
  share(options: LaunchTypes & { presale: TransactionArgument }) {
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "share",
        [options.presale, tx.object.clock()],
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
        [this.#presale(tx, options), options.quote, tx.object.clock()],
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
        [this.#presale(tx, options), options.quote, tx.object.clock()],
        options,
      );
  }

  /** `settle`: funds or cancels the sale after its window. Anyone may call. */
  settle(options: LaunchTypes & { presale: SharedObjectReference<true> }) {
    return (tx: Transaction): void => {
      this.#presaleCall(
        tx,
        "settle",
        [this.#presale(tx, options), tx.object.clock()],
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
        [this.#presale(tx, options), tx.object.clock()],
        options,
      );
    };
  }

  /** `claim`: pays `participant` its tokens and Quote refund. Anyone may relay. */
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
        [this.#presale(tx, options), tx.pure.address(participant)],
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
   * `PresaleVault`. The coin order comes from `cetusMemeSide`. Anyone may call.
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
      tx.moveCall({
        target: `${this.deployment.packageId}::cetus::migrate`,
        typeArguments: cetusTypeArguments(types),
        arguments: [
          this.#presale(tx, options),
          sharedObject(tx, "venueConfig", this.deployment.venueConfig, false),
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
   * the position in a new `PresaleVault`. `creationFee` must be exactly
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

  /** `cetus::collect_fees`: pays every fee recipient, keeps the holder share. */
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
          sharedObject(tx, "cetusConfig", options.cetusConfig, false),
          sharedObject(tx, "burnManager", options.burnManager, false),
          sharedObject(tx, "pool", options.pool, true),
        ],
      });
    };
  }

  /** `bluefin::collect_fees`: pays every fee recipient, keeps the holder share. */
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
          sharedObject(tx, "bluefinConfig", options.bluefinConfig, false),
          sharedObject(tx, "pool", options.pool, true),
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
          tx.object(options.presaleCap),
        ],
        options,
        "presale_vault",
      );
  }

  /**
   * `holder_rewards::publish_round` from a manifest built with
   * `PRESALE_REWARD_LEAF_DOMAIN`; reserves its budget from the vault's holder
   * share and shares the `Round`, claimable until `claimDeadlineMs`.
   */
  publishHolderRewardRound(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      adminWitness: TransactionArgument;
      manifest: RewardManifest;
      claimDeadlineMs: bigint;
    },
  ) {
    const manifest = validateRewardManifest(
      options.manifest,
      PRESALE_REWARD_LEAF_DOMAIN,
    );
    if (
      rewardAddress(manifest.vaultId) !== rewardAddress(options.vault.objectId)
    ) {
      throw new TypeError("manifest belongs to another vault");
    }
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
          options.adminWitness,
          tx.pure.u64(manifest.number),
          tx.pure.u64(manifest.startCheckpoint),
          tx.pure.u64(manifest.endCheckpoint),
          tx.pure.vector("u8", rewardDigest(manifest.root)),
          tx.pure.vector("u8", rewardDigest(manifest.manifestDigest)),
          tx.pure.u64(manifest.allocations.length),
          tx.pure.u64(manifest.memeAmount),
          tx.pure.u64(manifest.quoteAmount),
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
        "claim",
        [
          sharedObject(tx, "round", options.round, true),
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
          sharedObject(tx, "vault", options.vault, true),
          tx.object.clock(),
        ],
        options,
        "holder_rewards",
      );
    };
  }

  #newPresale(
    tx: Transaction,
    venue: PresaleVenue,
    options: PresaleTerms,
    venueArguments: TransactionArgument[],
  ): TransactionResult {
    return this.#presaleCall(
      tx,
      "new",
      [
        tx.object(options.treasuryCap),
        sharedObject(tx, "memeCurrency", options.memeCurrency, true),
        tx.pure.u64(options.tokenSupply),
        tx.pure.u64(options.tokenAllocationBps),
        tx.pure.u64(options.liquidityTokenAllocationBps),
        tx.add(this.recipientAllocations(options.recipientAllocations)),
        tx.pure.bool(options.burnable),
        tx.pure.u64(options.raiseTarget),
        tx.add(this.recipientAllocations(options.raiseAllocations)),
        tx.pure.u64(options.durationMs),
        tx.pure.u64(options.liquidityWindowMs),
        tx.add(this.eligibility(options.eligibility)),
        tx.add(this.uncapped(options.uncapped)),
        tx.add(this.feeRecipients(options.feeRecipients)),
        tx.pure.u64(options.rewardsFeeBps),
        ...venueArguments,
      ],
      options,
      venue,
    );
  }

  #shares(
    shares: readonly BpsShare[],
    functionName: "recipient_allocation" | "fee_recipient",
    typeName: string,
  ) {
    const validate =
      functionName === "fee_recipient"
        ? validateFeeRecipient
        : validateRecipientAllocation;
    const normalized = shares.map((share) => {
      validate(share);
      return { ...share, recipient: normalizeSuiAddress(share.recipient) };
    });
    return (tx: Transaction): TransactionResult =>
      tx.makeMoveVec({
        type: this.#type(`blast_presale::${typeName}`),
        elements: normalized.map((share) =>
          this.#presaleCall(tx, functionName, [
            tx.pure.address(share.recipient),
            tx.pure.u64(share.bps),
          ]),
        ),
      });
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

  #type(name: string): string {
    return normalizeStructTag(`${this.deployment.originalPackageId}::${name}`);
  }
}

export class PresaleTransactions {
  readonly call: PresaleCalls;

  constructor(deployment: PresaleDeployment) {
    this.call = new PresaleCalls(deployment);
  }

  /** `cetus::new`, then `share`, and transfers the `PresaleCap` to `capRecipient`. */
  createCetusPresale(
    options: Parameters<PresaleCalls["newCetusPresale"]>[0] & {
      capRecipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const created = tx.add(this.call.newCetusPresale(options));
    return this.#shareAndKeepCap(tx, created, options);
  }

  /** `bluefin::new`, then `share`, and transfers the `PresaleCap` to `capRecipient`. */
  createBluefinPresale(
    options: Parameters<PresaleCalls["newBluefinPresale"]>[0] & {
      capRecipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const created = tx.add(this.call.newBluefinPresale(options));
    return this.#shareAndKeepCap(tx, created, options);
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
    } & (
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

  migrateCetus(
    options: Parameters<PresaleCalls["migrateCetus"]>[0],
  ): Transaction {
    return single(this.call.migrateCetus(options));
  }

  /** Pays Bluefin's SUI pool-creation fee from gas as an exact-balance coin. */
  migrateBluefin(
    options: Omit<
      Parameters<PresaleCalls["migrateBluefin"]>[0],
      "creationFee"
    > & { creationFee: bigint },
  ): Transaction {
    requireU64("creationFee", options.creationFee);
    const tx = new Transaction();
    const creationFee = tx.coin({
      type: "0x2::sui::SUI",
      balance: options.creationFee,
    });
    tx.add(this.call.migrateBluefin({ ...options, creationFee }));
    return tx;
  }

  collectCetusFees(
    options: Parameters<PresaleCalls["collectCetusFees"]>[0],
  ): Transaction {
    return single(this.call.collectCetusFees(options));
  }

  collectBluefinFees(
    options: Parameters<PresaleCalls["collectBluefinFees"]>[0],
  ): Transaction {
    return single(this.call.collectBluefinFees(options));
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

  /** Signs in as `RewardsAdmin` and publishes the round in one PTB. */
  publishHolderRewardRound(
    options: Omit<
      Parameters<PresaleCalls["publishHolderRewardRound"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn({ adminCap: options.adminCapId, role: "RewardsAdmin" }),
    );
    tx.add(this.call.publishHolderRewardRound({ ...options, adminWitness }));
    return tx;
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

  #shareAndKeepCap(
    tx: Transaction,
    created: TransactionResult,
    options: LaunchTypes & { capRecipient: string },
  ): Transaction {
    const [presale, presaleCap] = moveResults(created, 2);
    tx.add(this.call.share({ ...options, presale }));
    tx.transferObjects([presaleCap], normalizeSuiAddress(options.capRecipient));
    return tx;
  }
}

function single(call: (tx: Transaction) => void): Transaction {
  const tx = new Transaction();
  tx.add(call);
  return tx;
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
