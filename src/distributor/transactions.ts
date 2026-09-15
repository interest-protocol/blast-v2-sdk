import type {
  Transaction,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";
import { requireU64 } from "../lib/integers.ts";
import type { RewardManifest, RewardProof } from "./allocations.ts";
import {
  rewardAddress,
  rewardDigest,
  validateRewardManifest,
} from "./allocations.ts";

export type DistributorPair = { memeType: string; quoteType: string };

/** Calls compose with existing launch creation, creator cap claims and venue collectors. */
export class DistributorCalls {
  readonly packageId: string;
  readonly packageVersion: TransactionObjectInput;
  constructor(deployment: {
    packageId: string;
    packageVersion: TransactionObjectInput;
  }) {
    this.packageId = rewardAddress(deployment.packageId);
    this.packageVersion = deployment.packageVersion;
  }

  /** Requires the distributor AdminCap created at publication. */
  setPaused(options: { adminCap: TransactionObjectInput; paused: boolean }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.packageId}::distributor::set_paused`,
        arguments: [
          tx.object(this.packageVersion),
          tx.object(options.adminCap),
          tx.pure.bool(options.paused),
        ],
      });
    };
  }

  /** Moves the shared version to the selected upgraded package's version. */
  migrate(options: { adminCap: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.packageId}::distributor::migrate`,
        arguments: [
          tx.object(this.packageVersion),
          tx.object(options.adminCap),
        ],
      });
    };
  }

  /** Destroys the curve-fee cap and binds the launch's creator fees to the new distributor. */
  enroll(
    options: DistributorPair & {
      curveFeeCap: TransactionObjectInput;
      launch: TransactionObjectInput;
      /** Launchpad `PackageVersion`. */
      packageVersion: TransactionObjectInput;
    },
  ) {
    const types = pairTypes(options);
    return (tx: Transaction): TransactionResult => {
      const result = tx.moveCall({
        target: `${this.packageId}::distributor::new`,
        typeArguments: types,
        arguments: [
          tx.object(this.packageVersion),
          tx.object(options.curveFeeCap),
          tx.object(options.launch),
          tx.object(options.packageVersion),
        ],
      });
      return result;
    };
  }

  share(options: DistributorPair & { distributor: TransactionObjectInput }) {
    const types = pairTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.packageId}::distributor::share`,
        typeArguments: types,
        arguments: [tx.object(options.distributor)],
      });
    };
  }

  collectCurveFees(
    options: DistributorPair & {
      distributor: TransactionObjectInput;
      launch: TransactionObjectInput;
      packageVersion: TransactionObjectInput;
    },
  ) {
    const types = pairTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.packageId}::distributor::collect_curve_fees`,
        typeArguments: types,
        arguments: [
          tx.object(options.distributor),
          tx.object(this.packageVersion),
          tx.object(options.launch),
          tx.object(options.packageVersion),
        ],
      });
    };
  }

  collectLpFees(
    options: DistributorPair & {
      distributor: TransactionObjectInput;
      lpVault: TransactionObjectInput;
      /** Migrators `PackageVersion`. */
      migratorsVersion: TransactionObjectInput;
    },
  ) {
    const types = pairTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.packageId}::distributor::collect_lp_fees`,
        typeArguments: types,
        arguments: [
          tx.object(options.distributor),
          tx.object(this.packageVersion),
          tx.object(options.lpVault),
          tx.object(options.migratorsVersion),
        ],
      });
    };
  }

  /** Destroys the vault's live LP-fee cap and binds its creator LP fees to the distributor. */
  lockLpFees(
    options: DistributorPair & {
      distributor: TransactionObjectInput;
      lpVault: TransactionObjectInput;
      /** Migrators `PackageVersion`. */
      migratorsVersion: TransactionObjectInput;
      lpFeeCap: TransactionObjectInput;
    },
  ) {
    const types = pairTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.packageId}::distributor::lock_lp_fees`,
        typeArguments: types,
        arguments: [
          tx.object(options.distributor),
          tx.object(this.packageVersion),
          tx.object(options.lpVault),
          tx.object(options.migratorsVersion),
          tx.object(options.lpFeeCap),
        ],
      });
    };
  }

  publishRound(
    options: DistributorPair & {
      publisherCap: TransactionObjectInput;
      manifest: RewardManifest;
    },
  ) {
    const types = pairTypes(options);
    const manifest = validateRewardManifest(options.manifest);
    return (tx: Transaction) =>
      tx.moveCall({
        target: `${this.packageId}::distributor::publish_round`,
        typeArguments: types,
        arguments: [
          tx.object(manifest.distributorId),
          tx.object(options.publisherCap),
          tx.object(this.packageVersion),
          tx.pure.u64(manifest.number),
          tx.pure.u64(manifest.startCheckpoint),
          tx.pure.u64(manifest.endCheckpoint),
          tx.pure.vector("u8", rewardDigest(manifest.root)),
          tx.pure.vector("u8", rewardDigest(manifest.manifestDigest)),
          tx.pure.u64(manifest.allocations.length),
          tx.pure.u64(manifest.memeAmount),
          tx.pure.u64(manifest.quoteAmount),
        ],
      });
  }

  shareRound(options: DistributorPair & { round: TransactionObjectInput }) {
    const types = pairTypes(options);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.packageId}::distributor::share_round`,
        typeArguments: types,
        arguments: [tx.object(options.round)],
      });
    };
  }

  claim(
    options: DistributorPair & {
      round: TransactionObjectInput;
      allocation: RewardProof;
    },
  ) {
    const types = pairTypes(options);
    const { allocation } = options;
    requireU64("index", BigInt(allocation.index));
    requireU64("memeAmount", BigInt(allocation.memeAmount));
    requireU64("quoteAmount", BigInt(allocation.quoteAmount));
    const beneficiary = rewardAddress(allocation.beneficiary);
    if (allocation.proof.length > 16)
      throw new RangeError("proof exceeds 16 siblings");
    const proof = allocation.proof.map((value) =>
      Array.from(rewardDigest(value)),
    );
    return (tx: Transaction): void => {
      tx.moveCall({
        target: `${this.packageId}::distributor::claim`,
        typeArguments: types,
        arguments: [
          tx.object(options.round),
          tx.object(this.packageVersion),
          tx.pure.u64(allocation.index),
          tx.pure.address(beneficiary),
          tx.pure.u64(allocation.memeAmount),
          tx.pure.u64(allocation.quoteAmount),
          tx.pure("vector<vector<u8>>", proof),
        ],
      });
    };
  }
}

function pairTypes(pair: DistributorPair): [string, string] {
  const meme = normalizeStructTag(pair.memeType);
  const quote = normalizeStructTag(pair.quoteType);
  if (meme === quote) throw new Error("Meme and Quote must differ");
  return [meme, quote];
}
