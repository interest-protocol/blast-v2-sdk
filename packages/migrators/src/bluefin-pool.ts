import { requireU64 } from "@interest-protocol/blast-core/integers";
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
import { normalizeSuiAddress, SUI_TYPE_ARG } from "@mysten/sui/utils";

/** Bluefin's pool metadata; amounts and prices always use atomic coin units. */
export type BluefinCoinMetadata = {
  symbol: string;
  decimals: number;
  iconUrl?: string;
};

export type BluefinPoolCreation = LaunchTypes & {
  /** Runtime package and config from the deployment's Bluefin venue identities. */
  bluefinPackageId: string;
  bluefinConfig: SharedObjectReference<true>;
  memeMetadata: BluefinCoinMetadata;
  quoteMetadata: BluefinCoinMetadata;
  /** Optional pool NFT icon. The name is `<Meme symbol>-<Quote symbol>`. */
  iconUrl?: string;
  tickSpacing: number;
  /** Bluefin fee units: 1,000,000 is 100%. */
  feeRate: bigint;
  /** Q64.64 square root of Quote atoms per Meme atom. */
  sqrtPriceX64: bigint;
  /** SUI atoms (MIST), read from the current config; never assumed zero. */
  creationFee: bigint;
  /** Signed ticks, aligned to tickSpacing; encoded as i32 two's-complement bits. */
  lowerTick: number;
  upperTick: number;
  /** Coins consumed; their balances bound each side's maximum contribution. */
  memeCoin: TransactionObjectInput;
  quoteCoin: TransactionObjectInput;
  /** Atomic amount on the fixed side. Bluefin calculates the other side. */
  fixedAmount: bigint;
  fixedMeme: boolean;
};

export type BluefinPoolCreationResult = {
  /** Fresh owned Pool<Meme, Quote>. Call shareBluefinPool after composing. */
  pool: TransactionObjectArgument;
  /** Position to pass to PresaleCalls.newBluefinVault, or transfer to its owner. */
  position: TransactionObjectArgument;
  /** Residual coins, including zero coins; callers must consume or transfer both. */
  memeResidual: TransactionObjectArgument;
  quoteResidual: TransactionObjectArgument;
};

/**
 * Creates Pool<Meme, Quote>, opens a position, and adds fixed-side liquidity.
 * Mirrors the pinned Bluefin Spot interface (91ce930). No presale is needed.
 * The fresh pool remains usable in this PTB, e.g. by newBluefinVault; the
 * caller must then share it, consume the position, and handle both residuals.
 * The input coins cap spending; Bluefin aborts if the other side is too small.
 */
export function addBluefinPoolWithLiquidity(
  tx: Transaction,
  options: BluefinPoolCreation,
): BluefinPoolCreationResult {
  const types = normalizeLaunchTypes(options);
  const typeArguments = [types.memeType, types.quoteType];
  const target = (name: string) =>
    `${normalizeSuiAddress(options.bluefinPackageId)}::pool::${name}`;
  const config = tx.sharedObjectRef(
    normalizeSharedObjectReference(
      "bluefinConfig",
      options.bluefinConfig,
      true,
    ),
  );
  const bytes = (value: string) =>
    tx.pure.vector("u8", new TextEncoder().encode(value));
  const balance = (coin: TransactionObjectInput, type: string) =>
    tx.moveCall({
      target: "0x2::coin::into_balance",
      typeArguments: [type],
      arguments: [tx.object(coin)],
    });
  const creationFee = requireU64("creationFee", options.creationFee);
  const fee =
    creationFee === 0n
      ? tx.moveCall({
          target: "0x2::balance::zero",
          typeArguments: [SUI_TYPE_ARG],
        })
      : balance(
          tx.coin({ type: SUI_TYPE_ARG, balance: creationFee }),
          SUI_TYPE_ARG,
        );
  const pool = tx.moveCall({
    target: target("create_pool_and_get_object"),
    typeArguments: [...typeArguments, SUI_TYPE_ARG],
    arguments: [
      tx.object.clock(),
      config,
      bytes(`${options.memeMetadata.symbol}-${options.quoteMetadata.symbol}`),
      bytes(options.iconUrl ?? ""),
      bytes(options.memeMetadata.symbol),
      tx.pure.u8(options.memeMetadata.decimals),
      bytes(options.memeMetadata.iconUrl ?? ""),
      bytes(options.quoteMetadata.symbol),
      tx.pure.u8(options.quoteMetadata.decimals),
      bytes(options.quoteMetadata.iconUrl ?? ""),
      tx.pure.u32(options.tickSpacing),
      tx.pure.u64(options.feeRate),
      tx.pure.u128(options.sqrtPriceX64),
      fee,
    ],
  });
  const position = tx.moveCall({
    target: target("open_position"),
    typeArguments,
    arguments: [
      config,
      pool,
      tx.pure.u32(tickBits(options.lowerTick)),
      tx.pure.u32(tickBits(options.upperTick)),
    ],
  });
  const [, , memeResidual, quoteResidual] = moveResults(
    tx.moveCall({
      target: target("add_liquidity_with_fixed_amount"),
      typeArguments,
      arguments: [
        tx.object.clock(),
        config,
        pool,
        position,
        balance(options.memeCoin, types.memeType),
        balance(options.quoteCoin, types.quoteType),
        tx.pure.u64(options.fixedAmount),
        tx.pure.bool(options.fixedMeme),
      ],
    }),
    4,
  );
  const coin = (residual: TransactionObjectArgument, type: string) =>
    tx.moveCall({
      target: "0x2::coin::from_balance",
      typeArguments: [type],
      arguments: [residual],
    });
  return {
    pool,
    position,
    memeResidual: coin(memeResidual, types.memeType),
    quoteResidual: coin(quoteResidual, types.quoteType),
  };
}

/** Shares a fresh Bluefin pool after all calls that borrow it in this PTB. */
export function shareBluefinPool(
  tx: Transaction,
  options: LaunchTypes & {
    bluefinPackageId: string;
    pool: TransactionObjectInput;
  },
): void {
  const { memeType, quoteType } = normalizeLaunchTypes(options);
  tx.moveCall({
    target: `${normalizeSuiAddress(options.bluefinPackageId)}::pool::share_pool_object`,
    typeArguments: [memeType, quoteType],
    arguments: [tx.object(options.pool)],
  });
}

function tickBits(tick: number): number {
  if (!Number.isInteger(tick) || tick < -(2 ** 31) || tick > 2 ** 31 - 1) {
    throw new RangeError("tick must be an i32");
  }
  return tick >>> 0;
}
