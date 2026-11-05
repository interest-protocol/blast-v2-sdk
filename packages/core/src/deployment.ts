import type {
  Transaction,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";
import { MAX_VESTING_DURATION_MS, requireBps } from "./bps.ts";
import type { Destination, FeeSplit } from "./fee-split.ts";
import { normalizeFeeSplit } from "./fee-split.ts";
import { requireU64 } from "./integers.ts";
import type { VestingTerms } from "./payout.ts";
import type { SharedObjectIdentity } from "./sui.ts";
import { normalizeSharedObjectIdentity } from "./sui.ts";

/**
 * The `blast_core` package and its shared `blast_treasury::Treasury`. Calls
 * target `packageId`; types and roles name `originalPackageId`.
 */
export type CoreDeployment = {
  packageId: string;
  originalPackageId: string;
  treasury: SharedObjectIdentity;
};

export function normalizeCoreDeployment(
  deployment: CoreDeployment,
): CoreDeployment {
  return {
    packageId: normalizeSuiObjectId(deployment.packageId),
    originalPackageId: normalizeSuiObjectId(deployment.originalPackageId),
    treasury: normalizeSharedObjectIdentity(
      "core.treasury",
      deployment.treasury,
    ),
  };
}

/** `<core original>::<module>::<name>`, normalized. */
export function coreType(
  core: Pick<CoreDeployment, "originalPackageId">,
  module: string,
  name: string,
): string {
  return normalizeStructTag(
    `${normalizeSuiObjectId(core.originalPackageId)}::${module}::${name}`,
  );
}

/**
 * `blast_core` value constructors and treasury calls. Each method returns a
 * PTB step; the constructors return the value as a transaction result that
 * the product or vault call consuming it takes by value.
 */
export class CoreCalls {
  readonly deployment: CoreDeployment;

  constructor(deployment: CoreDeployment) {
    this.deployment = normalizeCoreDeployment(deployment);
  }

  /** `bps::new`: aborts above 10,000. */
  bps(value: bigint) {
    const bps = requireBps(value);
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("bps", "new"),
        arguments: [tx.pure.u64(bps)],
      });
  }

  /**
   * `fee_split::new` over one `fee_split::route` per route, each built from
   * its `*_destination` constructor and `bps::new`, in the given order.
   */
  feeSplit(split: FeeSplit) {
    const { routes } = normalizeFeeSplit(split);
    return (tx: Transaction): TransactionResult => {
      const elements = routes.map(({ destination, bps }) =>
        tx.moveCall({
          target: this.#target("fee_split", "route"),
          arguments: [this.#destination(tx, destination), this.bps(bps)(tx)],
        }),
      );
      return tx.moveCall({
        target: this.#target("fee_split", "new"),
        arguments: [
          tx.makeMoveVec({
            type: coreType(this.deployment, "fee_split", "Route"),
            elements,
          }),
        ],
      });
    };
  }

  /**
   * `payout::vesting_terms`; rejects terms the contract aborts on: positive
   * steps whose total fits `MAX_VESTING_DURATION_MS` and a cliff within it.
   */
  vestingTerms(terms: VestingTerms) {
    const cliff = requireU64("cliffDelayMs", terms.cliffDelayMs);
    const period = requireU64("periodDurationMs", terms.periodDurationMs);
    const periods = requireU64("periods", terms.periods);
    if (
      period === 0n ||
      periods === 0n ||
      period > MAX_VESTING_DURATION_MS / periods ||
      cliff > period * periods
    ) {
      throw new RangeError(
        "vesting needs positive steps whose total and cliff fit the bound",
      );
    }
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("payout", "vesting_terms"),
        arguments: [
          tx.pure.u64(cliff),
          tx.pure.u64(period),
          tx.pure.u64(periods),
        ],
      });
  }

  /** `payout::recipient`: paid outright when `vestingTerms` is null. */
  recipient(options: {
    destination: string;
    vestingTerms: VestingTerms | null;
  }) {
    const terms = options.vestingTerms
      ? this.vestingTerms(options.vestingTerms)
      : null;
    const termsType = coreType(this.deployment, "payout", "VestingTerms");
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("payout", "recipient"),
        arguments: [
          tx.pure.address(options.destination),
          terms
            ? tx.moveCall({
                target: "0x1::option::some",
                typeArguments: [termsType],
                arguments: [terms(tx)],
              })
            : tx.moveCall({
                target: "0x1::option::none",
                typeArguments: [termsType],
              }),
        ],
      });
  }

  /**
   * `blast_treasury::schedule_destination`: a `TreasuryAdmin` witness
   * schedules `destination` and the next change's `delayMs`.
   */
  scheduleDestination(options: {
    adminWitness: TransactionObjectInput;
    destination: string;
    delayMs: bigint;
  }) {
    const delayMs = requireU64("delayMs", options.delayMs);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("blast_treasury", "schedule_destination"),
        arguments: [
          this.#treasury(tx, true),
          tx.object(options.adminWitness),
          tx.pure.address(options.destination),
          tx.pure.u64(delayMs),
          tx.object.clock(),
        ],
      });
    };
  }

  /** `blast_treasury::apply_destination`: anyone, once ready. */
  applyDestination() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("blast_treasury", "apply_destination"),
        arguments: [this.#treasury(tx, true), tx.object.clock()],
      });
    };
  }

  /** `blast_treasury::cancel_destination` with a `CancelAdmin` witness. */
  cancelDestination(options: { adminWitness: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("blast_treasury", "cancel_destination"),
        arguments: [this.#treasury(tx, true), tx.object(options.adminWitness)],
      });
    };
  }

  #destination(tx: Transaction, destination: Destination) {
    switch (destination.kind) {
      case "Address":
        return tx.moveCall({
          target: this.#target("fee_split", "address_destination"),
          arguments: [tx.pure.address(destination.address)],
        });
      case "Owner":
        return tx.moveCall({
          target: this.#target("fee_split", "owner_destination"),
        });
      case "AutoLp":
        return tx.moveCall({
          target: this.#target("fee_split", "auto_lp_destination"),
        });
      case "HolderRewards":
        return tx.moveCall({
          target: this.#target("fee_split", "holder_rewards_destination"),
        });
      case "Burn":
        return tx.moveCall({
          target: this.#target("fee_split", "burn_destination"),
        });
    }
  }

  #target(module: string, functionName: string): string {
    return `${this.deployment.packageId}::${module}::${functionName}`;
  }

  #treasury(tx: Transaction, mutable: boolean) {
    return tx.sharedObjectRef({ ...this.deployment.treasury, mutable });
  }
}
