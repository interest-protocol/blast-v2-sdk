import type {
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import { requirePositiveU64, requireU64 } from "../lib/integers.ts";
import type { SharedObjectReference, SuiPackageReference } from "../lib/sui.ts";
import {
  normalizeSharedObjectReference,
  normalizeSuiPackageReference,
} from "../lib/sui.ts";
import type { VestingKind } from "./modules.ts";
import { vestingModule } from "./modules.ts";
import type { LinearSchedule, VestingCheckpoint } from "./schedules.ts";
import {
  linearEndMs,
  validateCheckpointSchedule,
  validateLinearSchedule,
} from "./schedules.ts";

export type { SharedObjectReference } from "../lib/sui.ts";

export type VestingDeployment = {
  packageId: string;
  originalPackageId?: string;
};

export type VestingPosition = SharedObjectReference<true> & {
  kind: VestingKind;
  coinType: string;
};

type NormalizedDeployment = Required<VestingDeployment>;

export type LinearCreateOptions = {
  coinType: string;
  totalAmount: bigint;
  beneficiary: string;
  schedule: LinearSchedule;
  currentTimestampMs?: bigint;
  minimumLeadTimeMs?: bigint;
};

export type CheckpointCreateOptions = {
  coinType: string;
  totalAmount: bigint;
  beneficiary: string;
  checkpoints: readonly VestingCheckpoint[];
  currentTimestampMs?: bigint;
  minimumLeadTimeMs?: bigint;
};

export class VestingCalls {
  readonly deployment: NormalizedDeployment;

  constructor(deployment: VestingDeployment) {
    this.deployment = normalizeDeployment(deployment);
  }

  newLinearIrrevocable(options: {
    coinType: string;
    funds: TransactionObjectInput;
    beneficiary: string;
    schedule: LinearSchedule;
  }) {
    const coinType = normalizeStructTag(options.coinType);
    validateLinearArguments(options.schedule);
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::${vestingModule("linear")}::new_irrevocable`,
        typeArguments: [coinType],
        arguments: [
          tx.object(options.funds),
          tx.pure.address(
            normalizeNonzeroAddress("beneficiary", options.beneficiary),
          ),
          tx.pure.u64(options.schedule.startMs),
          tx.pure.u64(options.schedule.cliffMs),
          tx.pure.u64(options.schedule.periodMs),
          tx.pure.u64(options.schedule.periods),
          tx.object.clock(),
        ],
      });
  }

  newLinearCancelable(options: {
    coinType: string;
    funds: TransactionObjectInput;
    beneficiary: string;
    refundRecipient: string;
    schedule: LinearSchedule;
  }) {
    const coinType = normalizeStructTag(options.coinType);
    validateLinearArguments(options.schedule);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::${vestingModule("linear")}::new_cancelable`,
        typeArguments: [coinType],
        arguments: [
          tx.object(options.funds),
          tx.pure.address(
            normalizeNonzeroAddress("beneficiary", options.beneficiary),
          ),
          tx.pure.address(
            normalizeNonzeroAddress("refundRecipient", options.refundRecipient),
          ),
          tx.pure.u64(options.schedule.startMs),
          tx.pure.u64(options.schedule.cliffMs),
          tx.pure.u64(options.schedule.periodMs),
          tx.pure.u64(options.schedule.periods),
          tx.object.clock(),
        ],
      });
  }

  newCheckpointSchedule() {
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::${vestingModule("checkpoints")}::new_schedule`,
      });
  }

  addCheckpoint(options: {
    schedule: TransactionObjectInput;
    checkpoint: VestingCheckpoint;
  }) {
    requireU64("checkpoint.timestampMs", options.checkpoint.timestampMs);
    requirePositiveU64(
      "checkpoint.cumulativeAmount",
      options.checkpoint.cumulativeAmount,
    );
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::${vestingModule("checkpoints")}::add`,
        arguments: [
          tx.object(options.schedule),
          tx.pure.u64(options.checkpoint.timestampMs),
          tx.pure.u64(options.checkpoint.cumulativeAmount),
        ],
      });
    };
  }

  newCheckpointIrrevocable(options: {
    coinType: string;
    funds: TransactionObjectInput;
    beneficiary: string;
    schedule: TransactionObjectInput;
  }) {
    const coinType = normalizeStructTag(options.coinType);
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: `${this.deployment.packageId}::${vestingModule("checkpoints")}::new_irrevocable`,
        typeArguments: [coinType],
        arguments: [
          tx.object(options.funds),
          tx.pure.address(
            normalizeNonzeroAddress("beneficiary", options.beneficiary),
          ),
          tx.object(options.schedule),
          tx.object.clock(),
        ],
      });
  }

  newCheckpointCancelable(options: {
    coinType: string;
    funds: TransactionObjectInput;
    beneficiary: string;
    refundRecipient: string;
    schedule: TransactionObjectInput;
  }) {
    const coinType = normalizeStructTag(options.coinType);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: `${this.deployment.packageId}::${vestingModule("checkpoints")}::new_cancelable`,
        typeArguments: [coinType],
        arguments: [
          tx.object(options.funds),
          tx.pure.address(
            normalizeNonzeroAddress("beneficiary", options.beneficiary),
          ),
          tx.pure.address(
            normalizeNonzeroAddress("refundRecipient", options.refundRecipient),
          ),
          tx.object(options.schedule),
          tx.object.clock(),
        ],
      });
  }

  share(options: {
    kind: VestingKind;
    coinType: string;
    vesting: TransactionObjectInput;
  }) {
    const kind = normalizeKind(options.kind);
    const coinType = normalizeStructTag(options.coinType);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::${vestingModule(kind)}::share`,
        typeArguments: [coinType],
        arguments: [tx.object(options.vesting)],
      });
    };
  }

  claim(options: VestingPosition) {
    const position = normalizePosition(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::${vestingModule(position.kind)}::claim`,
        typeArguments: [position.coinType],
        arguments: [sharedObject(tx, "vesting", position), tx.object.clock()],
      });
    };
  }

  cancel(options: VestingPosition & { cancelCap: TransactionObjectInput }) {
    const position = normalizePosition(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::${vestingModule(position.kind)}::cancel`,
        typeArguments: [position.coinType],
        arguments: [
          sharedObject(tx, "vesting", position),
          tx.object(options.cancelCap),
          tx.object.clock(),
        ],
      });
    };
  }

  closeIrrevocable(options: VestingPosition) {
    const position = normalizePosition(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.deployment.packageId}::${vestingModule(position.kind)}::close_irrevocable`,
        typeArguments: [position.coinType],
        arguments: [sharedObject(tx, "vesting", position)],
      });
    };
  }
}

export class VestingTransactions {
  readonly call: VestingCalls;

  constructor(deployment: VestingDeployment) {
    this.call = new VestingCalls(deployment);
  }

  createLinearIrrevocable(options: LinearCreateOptions): Transaction {
    validateLinearCreation(options);
    const tx = new Transaction();
    const coinType = normalizeStructTag(options.coinType);
    const funds = tx.coin({ type: coinType, balance: options.totalAmount });
    const vesting = tx.add(
      this.call.newLinearIrrevocable({ ...options, coinType, funds }),
    );
    tx.add(this.call.share({ kind: "linear", coinType, vesting }));
    return tx;
  }

  createLinearCancelable(
    options: LinearCreateOptions & {
      refundRecipient: string;
      cancelCapRecipient: string;
    },
  ): Transaction {
    validateLinearCreation(options);
    const tx = new Transaction();
    const coinType = normalizeStructTag(options.coinType);
    const funds = tx.coin({ type: coinType, balance: options.totalAmount });
    const result = tx.add(
      this.call.newLinearCancelable({ ...options, coinType, funds }),
    );
    const vesting = result[0]!;
    const cancelCap = result[1]!;
    tx.add(this.call.share({ kind: "linear", coinType, vesting }));
    tx.transferObjects(
      [cancelCap],
      normalizeNonzeroAddress("cancelCapRecipient", options.cancelCapRecipient),
    );
    return tx;
  }

  createCheckpointIrrevocable(options: CheckpointCreateOptions): Transaction {
    validateCheckpointCreation(options);
    const tx = new Transaction();
    const coinType = normalizeStructTag(options.coinType);
    const schedule = addCheckpointSchedule(tx, this.call, options.checkpoints);
    const funds = tx.coin({ type: coinType, balance: options.totalAmount });
    const vesting = tx.add(
      this.call.newCheckpointIrrevocable({
        ...options,
        coinType,
        funds,
        schedule,
      }),
    );
    tx.add(this.call.share({ kind: "checkpoints", coinType, vesting }));
    return tx;
  }

  createCheckpointCancelable(
    options: CheckpointCreateOptions & {
      refundRecipient: string;
      cancelCapRecipient: string;
    },
  ): Transaction {
    validateCheckpointCreation(options);
    const tx = new Transaction();
    const coinType = normalizeStructTag(options.coinType);
    const schedule = addCheckpointSchedule(tx, this.call, options.checkpoints);
    const funds = tx.coin({ type: coinType, balance: options.totalAmount });
    const result = tx.add(
      this.call.newCheckpointCancelable({
        ...options,
        coinType,
        funds,
        schedule,
      }),
    );
    const vesting = result[0]!;
    const cancelCap = result[1]!;
    tx.add(this.call.share({ kind: "checkpoints", coinType, vesting }));
    tx.transferObjects(
      [cancelCap],
      normalizeNonzeroAddress("cancelCapRecipient", options.cancelCapRecipient),
    );
    return tx;
  }

  claim(options: VestingPosition): Transaction {
    const tx = new Transaction();
    tx.add(this.call.claim(options));
    return tx;
  }

  cancel(options: VestingPosition & { cancelCapId: string }): Transaction {
    const tx = new Transaction();
    tx.add(this.call.cancel({ ...options, cancelCap: options.cancelCapId }));
    return tx;
  }

  closeIrrevocable(options: VestingPosition): Transaction {
    const tx = new Transaction();
    tx.add(this.call.closeIrrevocable(options));
    return tx;
  }
}

function addCheckpointSchedule(
  tx: Transaction,
  calls: VestingCalls,
  checkpoints: readonly VestingCheckpoint[],
): TransactionObjectArgument {
  const schedule = tx.add(calls.newCheckpointSchedule());
  checkpoints.forEach((checkpoint) => {
    tx.add(calls.addCheckpoint({ schedule, checkpoint }));
  });
  return schedule;
}

function validateLinearCreation(options: LinearCreateOptions): void {
  requirePositiveU64("totalAmount", options.totalAmount);
  if (
    options.currentTimestampMs === undefined &&
    options.minimumLeadTimeMs === undefined
  ) {
    validateLinearSchedule(options.schedule);
  } else {
    validateLinearSchedule(
      options.schedule,
      options.currentTimestampMs ?? BigInt(Date.now()),
      options.minimumLeadTimeMs,
    );
  }
}

function validateCheckpointCreation(options: CheckpointCreateOptions): void {
  if (
    options.currentTimestampMs === undefined &&
    options.minimumLeadTimeMs === undefined
  ) {
    validateCheckpointSchedule(options.checkpoints, options.totalAmount);
  } else {
    validateCheckpointSchedule(
      options.checkpoints,
      options.totalAmount,
      options.currentTimestampMs ?? BigInt(Date.now()),
      options.minimumLeadTimeMs,
    );
  }
}

function validateLinearArguments(schedule: LinearSchedule): void {
  linearEndMs(schedule);
}

function normalizeDeployment(
  deployment: VestingDeployment,
): NormalizedDeployment {
  const reference: SuiPackageReference = normalizeSuiPackageReference(
    "vesting",
    {
      packageId: deployment.packageId,
      originalPackageId: deployment.originalPackageId ?? deployment.packageId,
    },
  );
  return reference;
}

function normalizePosition(position: VestingPosition): VestingPosition {
  return {
    kind: normalizeKind(position.kind),
    coinType: normalizeStructTag(position.coinType),
    ...normalizeSharedObjectReference("vesting", position, true),
  };
}

function normalizeKind(kind: VestingKind): VestingKind {
  if (kind !== "linear" && kind !== "checkpoints") {
    throw new TypeError("kind must be linear or checkpoints");
  }
  return kind;
}

function sharedObject(
  tx: Transaction,
  name: string,
  reference: SharedObjectReference<true>,
): TransactionObjectArgument {
  return tx.sharedObjectRef(
    normalizeSharedObjectReference(name, reference, true),
  );
}

function normalizeNonzeroAddress(name: string, value: string): string {
  const address = normalizeSuiAddress(value);
  if (BigInt(address) === 0n) {
    throw new RangeError(`${name} must not be the zero address`);
  }
  return address;
}
