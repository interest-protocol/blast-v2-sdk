import type {
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";
import type {
  LaunchpadDeployment,
  LaunchTypes,
} from "../launchpad/transactions.ts";
import { LaunchpadCalls } from "../launchpad/transactions.ts";
import { requireU64 } from "../lib/integers.ts";
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
          sharedObject(
            tx,
            "runtimeConfig",
            this.deployment.launchpad.runtimeConfig,
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
          sharedObject(
            tx,
            "runtimeConfig",
            this.deployment.launchpad.runtimeConfig,
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
          sharedObject(
            tx,
            "runtimeConfig",
            this.deployment.launchpad.runtimeConfig,
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
        sharedObject(
          tx,
          "runtimeConfig",
          this.deployment.launchpad.runtimeConfig,
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
          sharedObject(
            tx,
            "runtimeConfig",
            this.deployment.launchpad.runtimeConfig,
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

function normalizePoolKind(value: "new" | "existing"): "new" | "existing" {
  if (value !== "new" && value !== "existing") {
    throw new RangeError("pool.kind must be new or existing");
  }
  return value;
}
