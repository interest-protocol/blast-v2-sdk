import { Transaction } from "@mysten/sui/transactions";
import type {
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

import type { LaunchpadDeployment, LaunchTypes } from "../launchpad/transactions.ts";
import { LaunchpadCalls } from "../launchpad/transactions.ts";
import { normalizeSharedObjectReference } from "../lib/sui.ts";
import type { SharedObjectReference } from "../lib/sui.ts";

export type MigratorsDeployment = {
  packageId: string;
  originalPackageId?: string;
  launchpad: LaunchpadDeployment;
  venueConfig: SharedObjectReference<false>;
};

type NormalizedDeployment = Required<Omit<MigratorsDeployment, "launchpad">> & {
  launchpad: LaunchpadDeployment;
};

export class MigratorCalls {
  readonly deployment: NormalizedDeployment;
  readonly #launchpad: LaunchpadCalls;

  constructor(deployment: MigratorsDeployment) {
    const packageId = normalizeSuiObjectId(deployment.packageId);
    this.deployment = {
      packageId,
      originalPackageId: normalizeSuiObjectId(
        deployment.originalPackageId ?? packageId,
      ),
      launchpad: deployment.launchpad,
      venueConfig: normalizeSharedObjectReference(
        "venueConfig",
        deployment.venueConfig,
        false,
      ),
    };
    this.#launchpad = new LaunchpadCalls(deployment.launchpad);
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
