import { Transaction } from "@mysten/sui/transactions";
import type {
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import {
  MOVE_STDLIB_ADDRESS,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  SUI_FRAMEWORK_ADDRESS,
} from "@mysten/sui/utils";

import {
  requirePositiveU64,
  requireU64,
} from "../lib/integers.ts";
import { normalizeSharedObjectReference } from "../lib/sui.ts";
import type { SharedObjectReference } from "../lib/sui.ts";
import { buildMemePackageBytecode } from "./template.ts";
import type { MemeTemplateOptions } from "./template.ts";

export type { SharedObjectReference } from "../lib/sui.ts";

export type LaunchpadDeployment = {
  packageId: string;
  originalPackageId?: string;
  packageVersion: SharedObjectReference<false>;
  launchConfig: SharedObjectReference<false>;
  runtimeConfig: SharedObjectReference<false>;
  protocolAuthority: SharedObjectReference<false>;
};

export type LaunchTypes = {
  memeType: string;
  quoteType: string;
};

export type MigrationTypes = LaunchTypes & {
  migrationWitnessType: string;
};

type NormalizedDeployment = Required<LaunchpadDeployment>;

export class LaunchpadCalls {
  readonly deployment: NormalizedDeployment;

  constructor(deployment: LaunchpadDeployment) {
    this.deployment = normalizeDeployment(deployment);
  }

  createLaunch(options: MigrationTypes & { ticket: TransactionObjectInput }) {
    const types = normalizeMigrationTypes(options);
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::new`,
        typeArguments: [
          types.memeType,
          types.quoteType,
          types.migrationWitnessType,
        ],
        arguments: [
          tx.object(options.ticket),
          sharedObject(tx, "packageVersion", this.deployment.packageVersion, false),
          sharedObject(tx, "launchConfig", this.deployment.launchConfig, false),
        ],
      });
  }

  shareLaunch(options: LaunchTypes & { launch: TransactionObjectInput }) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::share`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [tx.object(options.launch)],
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
    const types = normalizeLaunchTypes(options);
    requireU64("minMemeOut", options.minMemeOut);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::buy`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          sharedObject(tx, "packageVersion", this.deployment.packageVersion, false),
          sharedObject(tx, "runtimeConfig", this.deployment.runtimeConfig, false),
          tx.object(options.quoteCoin),
          tx.pure.u64(options.minMemeOut),
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
          sharedObject(tx, "packageVersion", this.deployment.packageVersion, false),
          sharedObject(tx, "runtimeConfig", this.deployment.runtimeConfig, false),
          tx.object(options.memeCoin),
          tx.pure.u64(options.minQuoteOut),
        ],
      });
  }

  claimCreatorCap(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      xAttestation?: Uint8Array | null;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::claim_creator_cap`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          sharedObject(tx, "packageVersion", this.deployment.packageVersion, false),
          sharedObject(tx, "runtimeConfig", this.deployment.runtimeConfig, false),
          tx.pure.option(
            "vector<u8>",
            options.xAttestation
              ? Array.from(options.xAttestation)
              : null,
          ),
          tx.object.clock(),
        ],
      });
  }

  claimCreatorFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      creatorCap: TransactionObjectInput;
    },
  ) {
    const types = normalizeLaunchTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::claim_creator_fees`,
        typeArguments: [types.memeType, types.quoteType],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          sharedObject(tx, "packageVersion", this.deployment.packageVersion, false),
          tx.object(options.creatorCap),
        ],
      });
  }

  signIn(options: { adminCap: TransactionObjectInput }) {
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::acl::sign_in`,
        arguments: [
          sharedObject(
            tx,
            "protocolAuthority",
            this.deployment.protocolAuthority,
            false,
          ),
          sharedObject(tx, "packageVersion", this.deployment.packageVersion, false),
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
          sharedObject(tx, "packageVersion", this.deployment.packageVersion, false),
          tx.object(options.adminWitness),
        ],
      });
  }

  migrate(
    options: MigrationTypes & {
      launch: SharedObjectReference<true>;
      currency: SharedObjectReference<true>;
    },
  ) {
    const types = normalizeMigrationTypes(options);
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::migrate`,
        typeArguments: [
          types.memeType,
          types.quoteType,
          types.migrationWitnessType,
        ],
        arguments: [
          sharedObject(tx, "launch", options.launch, true),
          sharedObject(tx, "packageVersion", this.deployment.packageVersion, false),
          sharedObject(tx, "currency", options.currency, true),
        ],
      });
  }

  redeemMigration(
    options: MigrationTypes & {
      payload: TransactionObjectInput;
      migrationWitness: TransactionObjectInput;
    },
  ) {
    const types = normalizeMigrationTypes(options);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::launch::redeem_migration`,
        typeArguments: [
          types.memeType,
          types.quoteType,
          types.migrationWitnessType,
        ],
        arguments: [
          tx.object(options.payload),
          tx.object(options.migrationWitness),
        ],
      });
  }
}

export class LaunchpadTransactions {
  readonly call: LaunchpadCalls;

  constructor(deployment: LaunchpadDeployment) {
    this.call = new LaunchpadCalls(deployment);
  }

  publishMeme(
    options: MemeTemplateOptions,
  ): Transaction {
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

  createLaunch(
    options: MigrationTypes & { ticketId: string },
  ): Transaction {
    const tx = new Transaction();
    const launch = tx.add(
      this.call.createLaunch({ ...options, ticket: options.ticketId }),
    );
    tx.add(this.call.shareLaunch({ ...options, launch }));
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
    const buyResult = tx.add(
      this.call.buy({
        ...options,
        quoteCoin,
      }),
    );
    const memeCoin = buyResult[0]!;
    const quoteRefund = buyResult[1]!;
    tx.transferObjects(
      [memeCoin, quoteRefund],
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
    const quoteCoin = tx.add(
      this.call.sell({
        ...options,
        memeCoin,
      }),
    );
    tx.transferObjects([quoteCoin], normalizeSuiAddress(options.recipient));
    return tx;
  }

  claimCreatorCap(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      recipient: string;
      xAttestation?: Uint8Array | null;
    },
  ): Transaction {
    const tx = new Transaction();
    const claimResult = tx.add(
      this.call.claimCreatorCap(options),
    );
    const creatorCap = claimResult[0]!;
    const metadataCap = claimResult[1]!;
    tx.transferObjects(
      [creatorCap, metadataCap],
      normalizeSuiAddress(options.recipient),
    );
    return tx;
  }

  claimCreatorFees(
    options: LaunchTypes & {
      launch: SharedObjectReference<true>;
      creatorCapId: string;
      recipient: string;
    },
  ): Transaction {
    const tx = new Transaction();
    const claimResult = tx.add(
      this.call.claimCreatorFees({
        ...options,
        creatorCap: options.creatorCapId,
      }),
    );
    const memeCoin = claimResult[0]!;
    const quoteCoin = claimResult[1]!;
    tx.transferObjects(
      [memeCoin, quoteCoin],
      normalizeSuiAddress(options.recipient),
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
      this.call.signIn({
        adminCap: options.adminCapId,
      }),
    );
    const claimResult = tx.add(
      this.call.claimProtocolFees({
        ...options,
        adminWitness,
      }),
    );
    const memeCoin = claimResult[0]!;
    const quoteCoin = claimResult[1]!;
    tx.transferObjects(
      [memeCoin, quoteCoin],
      normalizeSuiAddress(options.recipient),
    );
    return tx;
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

function normalizeLaunchTypes(types: LaunchTypes): LaunchTypes {
  return {
    memeType: normalizeStructTag(types.memeType),
    quoteType: normalizeStructTag(types.quoteType),
  };
}

function normalizeMigrationTypes(types: MigrationTypes): MigrationTypes {
  return {
    ...normalizeLaunchTypes(types),
    migrationWitnessType: normalizeStructTag(types.migrationWitnessType),
  };
}
