import type {
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  isValidTransactionDigest,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";
import type {
  LaunchpadDeployment,
  LaunchTypes,
} from "../launchpad/transactions.ts";
import { LaunchpadCalls } from "../launchpad/transactions.ts";
import { normalizePositiveU64, requireU64 } from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";
import { normalizeSharedObjectReference } from "../lib/sui.ts";
import type { MigratorVenue } from "./state.ts";

export type MigratorsDeployment = {
  packageId: string;
  originalPackageId?: string;
  launchpad: LaunchpadDeployment;
  venueConfig: SharedObjectReference<false>;
};

export type CetusMigrationPool =
  | { kind: "new"; pools: SharedObjectReference<true> }
  | { kind: "existing"; pool: SharedObjectReference<true> };

export type TurbosMigrationPool =
  | {
      kind: "new";
      poolConfig: SharedObjectReference<true>;
      fee: SharedObjectReference<false>;
    }
  | { kind: "existing"; pool: SharedObjectReference<true> };

export type FullSailMigrationPool = CetusMigrationPool;

/** A fully resolved object reference that Sui can encode as `Receiving<T>`. */
export type ReceivingCoinReference = Readonly<{
  objectId: string;
  version: number | string;
  digest: string;
}>;

/** Maximum Aftermath DAO fee coin objects accepted by one accrual call. */
export const AFTERMATH_MAX_DAO_FEE_COINS_PER_BATCH = 100;

type NormalizedDeployment = Required<Omit<MigratorsDeployment, "launchpad">> & {
  launchpad: LaunchpadDeployment;
};

export class MigratorCalls {
  readonly deployment: NormalizedDeployment;
  readonly #launchpad: LaunchpadCalls;

  constructor(deployment: MigratorsDeployment) {
    const packageId = normalizeSuiObjectId(deployment.packageId);
    this.#launchpad = new LaunchpadCalls(deployment.launchpad);
    this.deployment = {
      packageId,
      originalPackageId: normalizeSuiObjectId(
        deployment.originalPackageId ?? packageId,
      ),
      launchpad: this.#launchpad.deployment,
      venueConfig: normalizeSharedObjectReference(
        "venueConfig",
        deployment.venueConfig,
        false,
      ),
    };
  }

  migrationWitnessType(venue: MigratorVenue): string {
    return normalizeStructTag(
      `${this.deployment.originalPackageId}::${venue}::Witness`,
    );
  }

  signIn(options: { adminCap: TransactionObjectInput }) {
    return this.#launchpad.signIn(options);
  }

  claimCreatorFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      creatorCap: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::claim_creator_fees`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          tx.object(options.creatorCap),
        ],
      });
  }

  claimProtocolFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      adminWitness: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::vault::claim_protocol_fees`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          tx.object(options.adminWitness),
        ],
      });
  }

  setAftermathPolicy(options: {
    adminWitness: TransactionObjectInput;
    memeWeight: bigint;
    quoteWeight: bigint;
    daoFeeBps: number;
  }) {
    const policy = normalizeAftermathPolicy(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::aftermath::set_policy`,
        arguments: [
          sharedObject(
            tx,
            "venueConfig",
            { ...this.deployment.venueConfig, mutable: true },
            true,
          ),
          tx.object(options.adminWitness),
          tx.pure.u64(policy.memeWeight),
          tx.pure.u64(policy.quoteWeight),
          tx.pure.u16(policy.daoFeeBps),
        ],
      });
  }

  migrateAftermath(
    options: LaunchTypes & {
      lpType: string;
      memeSide: "first" | "second";
      launch: SharedObjectReference<true>;
      memeCurrency: SharedObjectReference<true>;
      poolRegistry: SharedObjectReference<true>;
      createPoolCap: TransactionObjectInput;
      daoFeeVersion: SharedObjectReference<false>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const lpType = normalizeStructTag(options.lpType);
    const memeSide = normalizeAftermathMemeSide(options.memeSide);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::aftermath::migrate_meme_${memeSide}`,
        typeArguments: [lpType, types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          sharedObject(
            tx,
            "packageVersion",
            this.deployment.launchpad.packageVersion,
            false,
          ),
          sharedObject(tx, "venueConfig", this.deployment.venueConfig, false),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "poolRegistry", options.poolRegistry, true),
          tx.object(options.createPoolCap),
          sharedObject(tx, "daoFeeVersion", options.daoFeeVersion, false),
        ],
      });
  }

  updateAftermathDaoFee(
    options: LaunchTypes & {
      lpType: string;
      vault: SharedObjectReference<true>;
      daoFeePool: SharedObjectReference<true>;
      daoFeeVersion: SharedObjectReference<false>;
      adminWitness: TransactionObjectInput;
      daoFeeBps: number;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const lpType = normalizeStructTag(options.lpType);
    const daoFeeBps = normalizeAftermathDaoFeeBps(options.daoFeeBps);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::aftermath::update_dao_fee`,
        typeArguments: [lpType, types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          sharedObject(tx, "daoFeePool", options.daoFeePool, true),
          sharedObject(tx, "daoFeeVersion", options.daoFeeVersion, false),
          tx.object(options.adminWitness),
          tx.pure.u16(daoFeeBps),
        ],
      });
  }

  accrueAftermathDaoFees(
    options: LaunchTypes & {
      lpType: string;
      vault: SharedObjectReference<true>;
      memeFeeCoins: readonly ReceivingCoinReference[];
      quoteFeeCoins: readonly ReceivingCoinReference[];
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const lpType = normalizeStructTag(options.lpType);
    const { memeFeeCoins, quoteFeeCoins } = normalizeAftermathFeeCoinBatches(
      options.memeFeeCoins,
      options.quoteFeeCoins,
    );
    return (tx: Transaction): TransactionResult => {
      const memeReceivings = tx.makeMoveVec({
        type: receivingCoinType(types.memeType),
        elements: memeFeeCoins.map((feeCoin) => tx.receivingRef(feeCoin)),
      });
      const quoteReceivings = tx.makeMoveVec({
        type: receivingCoinType(types.quoteType),
        elements: quoteFeeCoins.map((feeCoin) => tx.receivingRef(feeCoin)),
      });

      return tx.moveCall({
        target: `${this.deployment.packageId}::aftermath::accrue_dao_fees`,
        typeArguments: [lpType, types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          sharedObject(
            tx,
            "runtimeConfig",
            this.deployment.launchpad.runtimeConfig,
            false,
          ),
          memeReceivings,
          quoteReceivings,
        ],
      });
    };
  }

  migrateBluefin(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      memeCurrency: SharedObjectReference<true>;
      quoteCurrency: SharedObjectReference<false>;
      bluefinConfig: SharedObjectReference<true>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::bluefin::migrate`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          sharedObject(
            tx,
            "packageVersion",
            this.deployment.launchpad.packageVersion,
            false,
          ),
          sharedObject(tx, "venueConfig", this.deployment.venueConfig, false),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "quoteCurrency", options.quoteCurrency, false),
          sharedObject(tx, "bluefinConfig", options.bluefinConfig, true),
          tx.object.clock(),
        ],
      });
  }

  collectBluefinFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      bluefinConfig: SharedObjectReference<false>;
      pool: SharedObjectReference<true>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::bluefin::collect_fees`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          sharedObject(
            tx,
            "runtimeConfig",
            this.deployment.launchpad.runtimeConfig,
            false,
          ),
          sharedObject(tx, "bluefinConfig", options.bluefinConfig, false),
          sharedObject(tx, "pool", options.pool, true),
          tx.object.clock(),
        ],
      });
  }

  migrateMmt(
    options: LaunchTypes & {
      memeSide: "x" | "y";
      launch: SharedObjectReference<true>;
      memeCurrency: SharedObjectReference<true>;
      mmtGlobalConfig: SharedObjectReference<true>;
      mmtVersion: SharedObjectReference<false>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const memeSide = normalizeMemeSide(options.memeSide);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::mmt::migrate_meme_${memeSide}`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          sharedObject(
            tx,
            "packageVersion",
            this.deployment.launchpad.packageVersion,
            false,
          ),
          sharedObject(tx, "venueConfig", this.deployment.venueConfig, false),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "mmtGlobalConfig", options.mmtGlobalConfig, true),
          sharedObject(tx, "mmtVersion", options.mmtVersion, false),
          tx.object.clock(),
        ],
      });
  }

  collectMmtFees(
    options: LaunchTypes & {
      memeSide: "x" | "y";
      vault: SharedObjectReference<true>;
      pool: SharedObjectReference<true>;
      mmtVersion: SharedObjectReference<false>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const memeSide = normalizeMemeSide(options.memeSide);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::mmt::collect_fees_meme_${memeSide}`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          sharedObject(
            tx,
            "runtimeConfig",
            this.deployment.launchpad.runtimeConfig,
            false,
          ),
          sharedObject(tx, "pool", options.pool, true),
          sharedObject(tx, "mmtVersion", options.mmtVersion, false),
          tx.object.clock(),
        ],
      });
  }

  migrateCetus(
    options: LaunchTypes & {
      memeSide: "a" | "b";
      pool: CetusMigrationPool;
      launch: SharedObjectReference<true>;
      memeCurrency: SharedObjectReference<true>;
      cetusConfig: SharedObjectReference<false>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const memeSide = normalizeMemeSideAb(options.memeSide);
    const poolKind = normalizePoolKind(options.pool.kind);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::cetus::migrate_${poolKind}_meme_${memeSide}`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          sharedObject(
            tx,
            "packageVersion",
            this.deployment.launchpad.packageVersion,
            false,
          ),
          sharedObject(tx, "venueConfig", this.deployment.venueConfig, false),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "cetusConfig", options.cetusConfig, false),
          options.pool.kind === "new"
            ? sharedObject(tx, "pools", options.pool.pools, true)
            : sharedObject(tx, "pool", options.pool.pool, true),
          tx.object.clock(),
        ],
      });
  }

  collectCetusFees(
    options: LaunchTypes & {
      memeSide: "a" | "b";
      vault: SharedObjectReference<true>;
      cetusConfig: SharedObjectReference<false>;
      pool: SharedObjectReference<true>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const memeSide = normalizeMemeSideAb(options.memeSide);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::cetus::collect_fees_meme_${memeSide}`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          sharedObject(
            tx,
            "runtimeConfig",
            this.deployment.launchpad.runtimeConfig,
            false,
          ),
          sharedObject(tx, "cetusConfig", options.cetusConfig, false),
          sharedObject(tx, "pool", options.pool, true),
        ],
      });
  }

  migrateTurbos(
    options: LaunchTypes & {
      feeType: string;
      memeSide: "a" | "b";
      pool: TurbosMigrationPool;
      launch: SharedObjectReference<true>;
      memeCurrency: SharedObjectReference<true>;
      positions: SharedObjectReference<true>;
      deadline: bigint;
      versioned: SharedObjectReference<false>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const feeType = normalizeStructTag(options.feeType);
    const memeSide = normalizeMemeSideAb(options.memeSide);
    const poolKind = normalizePoolKind(options.pool.kind);
    requireU64("deadline", options.deadline);
    return (tx: Transaction): TransactionResult => {
      const baseArguments = [
        sharedObject(tx, "launch", options.launch, true),
        sharedObject(
          tx,
          "packageVersion",
          this.deployment.launchpad.packageVersion,
          false,
        ),
        sharedObject(tx, "venueConfig", this.deployment.venueConfig, false),
        sharedObject(tx, "memeCurrency", options.memeCurrency, true),
      ];
      const poolArguments =
        options.pool.kind === "new"
          ? [
              sharedObject(tx, "poolConfig", options.pool.poolConfig, true),
              sharedObject(tx, "fee", options.pool.fee, false),
            ]
          : [sharedObject(tx, "pool", options.pool.pool, true)];
      return tx.moveCall({
        target: `${this.deployment.packageId}::turbos::migrate_${poolKind}_meme_${memeSide}`,
        typeArguments: [types.memeType, types.quoteType, feeType],
        arguments: [
          ...baseArguments,
          ...poolArguments,
          sharedObject(tx, "positions", options.positions, true),
          tx.pure.u64(options.deadline),
          tx.object.clock(),
          sharedObject(tx, "versioned", options.versioned, false),
        ],
      });
    };
  }

  collectTurbosFees(
    options: LaunchTypes & {
      feeType: string;
      memeSide: "a" | "b";
      vault: SharedObjectReference<true>;
      pool: SharedObjectReference<true>;
      positions: SharedObjectReference<true>;
      deadline: bigint;
      versioned: SharedObjectReference<false>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const feeType = normalizeStructTag(options.feeType);
    const memeSide = normalizeMemeSideAb(options.memeSide);
    requireU64("deadline", options.deadline);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::turbos::collect_fees_meme_${memeSide}`,
        typeArguments: [types.memeType, types.quoteType, feeType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          sharedObject(
            tx,
            "runtimeConfig",
            this.deployment.launchpad.runtimeConfig,
            false,
          ),
          sharedObject(tx, "pool", options.pool, true),
          sharedObject(tx, "positions", options.positions, true),
          tx.pure.u64(options.deadline),
          tx.object.clock(),
          sharedObject(tx, "versioned", options.versioned, false),
        ],
      });
  }

  migrateFullSail(
    options: LaunchTypes & {
      memeSide: "a" | "b";
      pool: FullSailMigrationPool;
      launch: SharedObjectReference<true>;
      memeCurrency: SharedObjectReference<true>;
      fullSailConfig: SharedObjectReference<false>;
      rewarderGlobalVault: SharedObjectReference<true>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const memeSide = normalizeMemeSideAb(options.memeSide);
    const poolKind = normalizePoolKind(options.pool.kind);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::fullsail::migrate_${poolKind}_meme_${memeSide}`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          sharedObject(
            tx,
            "packageVersion",
            this.deployment.launchpad.packageVersion,
            false,
          ),
          sharedObject(tx, "venueConfig", this.deployment.venueConfig, false),
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          sharedObject(tx, "fullSailConfig", options.fullSailConfig, false),
          sharedObject(
            tx,
            "rewarderGlobalVault",
            options.rewarderGlobalVault,
            true,
          ),
          options.pool.kind === "new"
            ? sharedObject(tx, "pools", options.pool.pools, true)
            : sharedObject(tx, "pool", options.pool.pool, true),
          tx.object.clock(),
        ],
      });
  }

  collectFullSailFees(
    options: LaunchTypes & {
      memeSide: "a" | "b";
      vault: SharedObjectReference<true>;
      fullSailConfig: SharedObjectReference<false>;
      pool: SharedObjectReference<true>;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    const memeSide = normalizeMemeSideAb(options.memeSide);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::fullsail::collect_fees_meme_${memeSide}`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "vault", options.vault, true),
          sharedObject(
            tx,
            "runtimeConfig",
            this.deployment.launchpad.runtimeConfig,
            false,
          ),
          sharedObject(tx, "fullSailConfig", options.fullSailConfig, false),
          sharedObject(tx, "pool", options.pool, true),
        ],
      });
  }
}

export class MigratorTransactions {
  readonly call: MigratorCalls;

  constructor(deployment: MigratorsDeployment) {
    this.call = new MigratorCalls(deployment);
  }

  claimCreatorFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      creatorCapId: string;
      recipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const result = tx.add(
      this.call.claimCreatorFees({
        ...options,
        creatorCap: options.creatorCapId,
      }),
    );
    tx.transferObjects(
      [result[0]!, result[1]!],
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  claimProtocolFees(
    options: LaunchTypes & {
      vault: SharedObjectReference<true>;
      adminCapId: string;
      recipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn({ adminCap: options.adminCapId }),
    );
    const result = tx.add(
      this.call.claimProtocolFees({
        ...options,
        adminWitness,
      }),
    );
    tx.transferObjects(
      [result[0]!, result[1]!],
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  setAftermathPolicy(options: {
    adminCapId: string;
    memeWeight: bigint;
    quoteWeight: bigint;
    daoFeeBps: number;
  }): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn({ adminCap: options.adminCapId }),
    );
    tx.add(this.call.setAftermathPolicy({ ...options, adminWitness }));
    return tx;
  }

  migrateAftermath(
    options: Parameters<MigratorCalls["migrateAftermath"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.migrateAftermath(options));
    return tx;
  }

  updateAftermathDaoFee(
    options: Omit<
      Parameters<MigratorCalls["updateAftermathDaoFee"]>[0],
      "adminWitness"
    > & { adminCapId: string },
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(
      this.call.signIn({ adminCap: options.adminCapId }),
    );
    tx.add(this.call.updateAftermathDaoFee({ ...options, adminWitness }));
    return tx;
  }

  accrueAftermathDaoFees(
    options: Parameters<MigratorCalls["accrueAftermathDaoFees"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.accrueAftermathDaoFees(options));
    return tx;
  }

  migrateBluefin(
    options: Parameters<MigratorCalls["migrateBluefin"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.migrateBluefin(options));
    return tx;
  }

  collectBluefinFees(
    options: Parameters<MigratorCalls["collectBluefinFees"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.collectBluefinFees(options));
    return tx;
  }

  migrateMmt(options: Parameters<MigratorCalls["migrateMmt"]>[0]): Transaction {
    const tx = new Transaction();
    tx.add(this.call.migrateMmt(options));
    return tx;
  }

  collectMmtFees(
    options: Parameters<MigratorCalls["collectMmtFees"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.collectMmtFees(options));
    return tx;
  }

  migrateCetus(
    options: Parameters<MigratorCalls["migrateCetus"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.migrateCetus(options));
    return tx;
  }

  collectCetusFees(
    options: Parameters<MigratorCalls["collectCetusFees"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.collectCetusFees(options));
    return tx;
  }

  migrateTurbos(
    options: Parameters<MigratorCalls["migrateTurbos"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.migrateTurbos(options));
    return tx;
  }

  collectTurbosFees(
    options: Parameters<MigratorCalls["collectTurbosFees"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.collectTurbosFees(options));
    return tx;
  }

  migrateFullSail(
    options: Parameters<MigratorCalls["migrateFullSail"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.migrateFullSail(options));
    return tx;
  }

  collectFullSailFees(
    options: Parameters<MigratorCalls["collectFullSailFees"]>[0],
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.collectFullSailFees(options));
    return tx;
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

function normalizeLaunchTypes(types: LaunchTypes): LaunchTypes {
  return {
    memeType: normalizeStructTag(types.memeType),
    quoteType: normalizeStructTag(types.quoteType),
  };
}

function normalizeMemeSide(value: "x" | "y"): "x" | "y" {
  if (value !== "x" && value !== "y") {
    throw new RangeError("memeSide must be x or y");
  }
  return value;
}

function normalizeMemeSideAb(value: "a" | "b"): "a" | "b" {
  if (value !== "a" && value !== "b") {
    throw new RangeError("memeSide must be a or b");
  }
  return value;
}

function normalizeAftermathMemeSide(
  value: "first" | "second",
): "first" | "second" {
  if (value !== "first" && value !== "second") {
    throw new RangeError("memeSide must be first or second");
  }
  return value;
}

function normalizeAftermathPolicy(policy: {
  memeWeight: bigint;
  quoteWeight: bigint;
  daoFeeBps: number;
}) {
  const memeWeight = requireU64("memeWeight", policy.memeWeight);
  const quoteWeight = requireU64("quoteWeight", policy.quoteWeight);
  if (
    memeWeight < 10_000_000_000_000_000n ||
    quoteWeight < 10_000_000_000_000_000n ||
    memeWeight + quoteWeight !== 1_000_000_000_000_000_000n
  ) {
    throw new RangeError(
      "Aftermath weights must each be at least 1% and sum to 100%",
    );
  }
  const daoFeeBps = normalizeAftermathDaoFeeBps(policy.daoFeeBps);
  return { memeWeight, quoteWeight, daoFeeBps };
}

function normalizeAftermathDaoFeeBps(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError(
      "Aftermath DAO fee must be between 0 and 10,000 basis points",
    );
  }
  return value;
}

function receivingCoinType(coinType: string): string {
  return normalizeStructTag(
    `0x2::transfer::Receiving<0x2::coin::Coin<${coinType}>>`,
  );
}

function normalizeAftermathFeeCoinBatches(
  memeFeeCoins: readonly ReceivingCoinReference[],
  quoteFeeCoins: readonly ReceivingCoinReference[],
): {
  memeFeeCoins: ReceivingCoinReference[];
  quoteFeeCoins: ReceivingCoinReference[];
} {
  if (!Array.isArray(memeFeeCoins)) {
    throw new TypeError(
      "memeFeeCoins must be an array of receiving references",
    );
  }
  if (!Array.isArray(quoteFeeCoins)) {
    throw new TypeError(
      "quoteFeeCoins must be an array of receiving references",
    );
  }
  const totalFeeCoins = memeFeeCoins.length + quoteFeeCoins.length;
  if (
    totalFeeCoins === 0 ||
    totalFeeCoins > AFTERMATH_MAX_DAO_FEE_COINS_PER_BATCH
  ) {
    throw new RangeError(
      `memeFeeCoins and quoteFeeCoins must contain between 1 and ${AFTERMATH_MAX_DAO_FEE_COINS_PER_BATCH} total receiving references`,
    );
  }

  return {
    memeFeeCoins: normalizeReceivingCoinReferences(
      "memeFeeCoins",
      memeFeeCoins,
    ),
    quoteFeeCoins: normalizeReceivingCoinReferences(
      "quoteFeeCoins",
      quoteFeeCoins,
    ),
  };
}

function normalizeReceivingCoinReferences(
  name: string,
  feeCoins: readonly ReceivingCoinReference[],
): ReceivingCoinReference[] {
  return feeCoins.map((feeCoin, index) => {
    if (typeof feeCoin !== "object" || feeCoin === null) {
      throw new TypeError(`${name}[${index}] must be an object reference`);
    }
    if (!isValidTransactionDigest(feeCoin.digest)) {
      throw new TypeError(
        `${name}[${index}].digest must be a Sui object digest`,
      );
    }
    return {
      objectId: normalizeSuiObjectId(feeCoin.objectId),
      version: normalizePositiveU64(
        `${name}[${index}].version`,
        feeCoin.version,
      ),
      digest: feeCoin.digest,
    };
  });
}

function normalizePoolKind(value: "new" | "existing"): "new" | "existing" {
  if (value !== "new" && value !== "existing") {
    throw new RangeError("pool.kind must be new or existing");
  }
  return value;
}
