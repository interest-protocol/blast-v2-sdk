import { cetusMemeSide } from "@interest-protocol/blast-core/cetus";
import { grossGasBudget } from "@interest-protocol/blast-core/gas";
import { moveResults } from "@interest-protocol/blast-core/ptb";
import type { SharedObjectReference } from "@interest-protocol/blast-core/sui";
import { normalizeSharedObjectReference } from "@interest-protocol/blast-core/sui";
import type { LaunchTypes } from "@interest-protocol/blast-launchpad-sdk/transactions";
import { normalizeLaunchTypes } from "@interest-protocol/blast-launchpad-sdk/transactions";
import type {
  Transaction,
  TransactionObjectArgument,
  TransactionObjectInput,
} from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

export type CetusPoolCreation = LaunchTypes & {
  /** Runtime package and shared objects from the deployment's Cetus identities. */
  cetusPackageId: string;
  cetusConfig: SharedObjectReference<false>;
  cetusPools: SharedObjectReference<true>;
  tickSpacing: number;
  /** Q64.64 square root of coin B atoms per coin A atom, in Cetus coin order. */
  sqrtPriceX64: bigint;
  /** Pool/position metadata URL; empty by default. */
  url?: string;
  /** Signed ticks aligned to tickSpacing, encoded as i32 two's-complement bits. */
  lowerTick: number;
  upperTick: number;
  /**
   * Coins consumed. The fixed side uses this coin's entire balance; the other
   * coin caps the maximum contribution. Split exact input coins beforehand.
   */
  memeCoin: TransactionObjectInput;
  quoteCoin: TransactionObjectInput;
  fixedMeme: boolean;
  /** Required only for a pair/tier already reserved by this Cetus creation cap. */
  poolCreationCap?: TransactionObjectInput;
};

export type CetusPoolCreationResult = {
  /** Transfer to its owner; newCetusVault can consume it in the next PTB. */
  position: TransactionObjectArgument;
  /** Residual Coins, including zero coins; consume or transfer both. */
  memeResidual: TransactionObjectArgument;
  quoteResidual: TransactionObjectArgument;
};

/**
 * Creates and seeds a Cetus pool through the revision-15 pool_creator v3 API.
 * Coin types, input coins, fixed side and residuals follow cetusMemeSide.
 * Cetus shares the pool internally; its public API returns no pool handle.
 * Execute this PTB, read the shared pool/position IDs, then call newCetusVault
 * in a later PTB. No presale or TreasuryCap is needed for an unreserved pair.
 * ABI: CetusProtocol/cetus-contracts ddfbdeba, pool_creator.move and factory.move;
 * runtime package 0x260693ec785a6e6c9d81d58c7d2ff72f1288ae0fa6a9725abe05a6478b11f084.
 */
export function addCetusPoolWithLiquidity(
  tx: Transaction,
  options: CetusPoolCreation,
): CetusPoolCreationResult {
  const { memeType, quoteType } = normalizeLaunchTypes(options);
  const memeIsA = cetusMemeSide(memeType, quoteType) === "a";
  const typeArguments = memeIsA ? [memeType, quoteType] : [quoteType, memeType];
  const lowerTick = tickBits(options.lowerTick);
  const upperTick = tickBits(options.upperTick);
  const config = tx.sharedObjectRef(
    normalizeSharedObjectReference("cetusConfig", options.cetusConfig, false),
  );
  const pools = tx.sharedObjectRef(
    normalizeSharedObjectReference("cetusPools", options.cetusPools, true),
  );
  tx.addBuildPlugin(grossGasBudget());
  const [position, residualA, residualB] = moveResults(
    tx.moveCall({
      target: `${normalizeSuiAddress(options.cetusPackageId)}::pool_creator::${options.poolCreationCap === undefined ? "create_pool_v3" : "create_pool_v3_with_creation_cap"}`,
      typeArguments,
      arguments: [
        config,
        pools,
        ...(options.poolCreationCap === undefined
          ? []
          : [tx.object(options.poolCreationCap)]),
        tx.pure.u32(options.tickSpacing),
        tx.pure.u128(options.sqrtPriceX64),
        tx.pure.string(options.url ?? ""),
        tx.pure.u32(lowerTick),
        tx.pure.u32(upperTick),
        tx.object(memeIsA ? options.memeCoin : options.quoteCoin),
        tx.object(memeIsA ? options.quoteCoin : options.memeCoin),
        tx.pure.bool(memeIsA === options.fixedMeme),
        tx.object.clock(),
      ],
    }),
    3,
  );
  return {
    position,
    memeResidual: memeIsA ? residualA : residualB,
    quoteResidual: memeIsA ? residualB : residualA,
  };
}

function tickBits(tick: number): number {
  if (!Number.isInteger(tick) || tick < -(2 ** 31) || tick > 2 ** 31 - 1) {
    throw new RangeError("tick must be an i32");
  }
  return tick >>> 0;
}
