/**
 * E2E-020 and E2E-021: real swaps on migrated pools, then permissionless fee
 * collection. Checks Blast's share (rounded up, at the vault's current rates),
 * each fee recipient's largest-remainder share, and the holder share kept in
 * the vault; then changes the vault's Blast rates and collects again.
 * Bluefin uses the E2E-014 vault (TEST_SUI); Cetus the E2E-011 vault (tiny SUI).
 */
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";

import {
  cetusMemeSide,
  splitCollectedFee,
} from "../../../src/presale/index.ts";
import type { Executed } from "../chain.ts";
import {
  balance,
  balanceChange,
  equal,
  event,
  events,
  exec,
  expectAbort,
  single,
} from "../chain.ts";
import {
  ADMIN_CAP,
  BLUEFIN,
  CETUS,
  deployer,
  presale,
  SUI,
  wallets,
} from "../env.ts";
import type { SaleRecord, Shared } from "../sale.ts";
import { coins, imm, mut, sale, types, u64 } from "../sale.ts";

const MIN_SQRT_PRICE = 4_295_048_016n;
const MAX_SQRT_PRICE = 79_226_673_515_401_279_992_447_579_055n;

export async function e020(): Promise<void> {
  const w = wallets();
  const bluefin = sale("e014");
  const destination = deployer().toSuiAddress();

  await bluefinRoundTrip(bluefin, w.p6, coins(1_000));
  await collectAndCheck("Bluefin", bluefin, destination);
  const empty = await exec(
    "relayer collects again with nothing accrued",
    w.relayer,
    collectTx(bluefin),
  );
  equal(
    "an empty collection emits nothing",
    events(empty, "FeesCollected").length,
    0,
  );

  // E2E-021: change the vault's Blast rates mid-life.
  const setRates = (meme: bigint, quote: bigint) =>
    single((tx) =>
      tx.add(
        presale.call.setProtocolLpFees({
          ...types(bluefin),
          vault: mut(bluefin.vault as Shared),
          adminCap: ADMIN_CAP,
          lpFeeMemeBps: meme,
          lpFeeQuoteBps: quote,
        }),
      ),
    );
  const changed = await exec(
    "admin sets the vault's Blast rates",
    deployer(),
    setRates(2_500n, 500n),
  );
  equal(
    "ProtocolLpFeesChanged meme",
    u64(event(changed, "ProtocolLpFeesChanged").protocol_lp_fee_meme_bps),
    2_500n,
  );
  await expectAbort(
    "the same vault rates",
    deployer(),
    setRates(2_500n, 500n),
    { module: "presale_vault", code: 3 },
  );
  await bluefinRoundTrip(bluefin, w.p6, coins(500));
  await collectAndCheck("Bluefin after the rate change", bluefin, destination);

  const cetus = sale("e011");
  await cetusRoundTrip(cetus, w.p6, coins(0.005));
  await collectAndCheck("Cetus", cetus, destination);
}

function collectTx(record: SaleRecord): Transaction {
  const vault = mut(record.vault as Shared);
  const pool = mut(record.pool as Shared);
  return single((tx) =>
    tx.add(
      record.venue === "bluefin"
        ? presale.call.collectBluefinFees({
            ...types(record),
            vault,
            bluefinConfig: imm(BLUEFIN.config),
            pool,
          })
        : presale.call.collectCetusFees({
            ...types(record),
            vault,
            cetusConfig: imm(CETUS.config),
            burnManager: imm(CETUS.burnManager),
            pool,
          }),
    ),
  );
}

/** Collects as the relayer and checks every leg against the SDK's split. */
async function collectAndCheck(
  label: string,
  record: SaleRecord,
  destination: string,
): Promise<void> {
  const w = wallets();
  const vaultId = (record.vault as Shared).objectId;
  const before = await presale.getVault(vaultId);
  const collected = await exec(
    `relayer collects ${label} fees`,
    w.relayer,
    collectTx(record),
  );
  const fees = event(collected, "FeesCollected");
  const grossMeme = u64(fees.gross_meme);
  const grossQuote = u64(fees.gross_quote);
  equal(
    `${label}: fees accrued on both sides`,
    grossMeme > 0n && grossQuote > 0n,
    true,
  );
  const meme = splitCollectedFee(
    before.feeRecipients,
    before.holderRewardsBps,
    before.protocolFees.lpFeeMemeBps,
    grossMeme,
  );
  const quote = splitCollectedFee(
    before.feeRecipients,
    before.holderRewardsBps,
    before.protocolFees.lpFeeQuoteBps,
    grossQuote,
  );
  equal(
    `${label}: Blast meme rounded up`,
    u64(fees.protocol_meme),
    meme.protocol,
  );
  equal(
    `${label}: Blast quote rounded up`,
    u64(fees.protocol_quote),
    quote.protocol,
  );
  equal(
    `${label}: paid to the destination`,
    fees.protocol_destination,
    destination,
  );
  equal(
    `${label}: recipient meme shares`,
    (fees.fee_recipient_meme as unknown[]).map(String).join(","),
    meme.recipients.join(","),
  );
  equal(
    `${label}: recipient quote shares`,
    (fees.fee_recipient_quote as unknown[]).map(String).join(","),
    quote.recipients.join(","),
  );
  for (const [i, share] of before.feeRecipients.entries()) {
    if (share.recipient === destination) continue;
    equal(
      `${label}: recipient ${i} received its quote`,
      balanceChange(collected, share.recipient, record.quoteType),
      quote.recipients[i] as bigint,
    );
  }
  const after = await presale.getVault(vaultId);
  equal(
    `${label}: holder meme kept`,
    after.holderRewardsMeme - before.holderRewardsMeme,
    meme.holderRewards,
  );
  equal(
    `${label}: holder quote kept`,
    after.holderRewardsQuote - before.holderRewardsQuote,
    quote.holderRewards,
  );
}

async function bluefinRoundTrip(
  record: SaleRecord,
  trader: Ed25519Keypair,
  quoteIn: bigint,
): Promise<void> {
  /** `gateway::swap_assets` in `tx`, paying `amount` of the input side by exact input. */
  const swap = (
    tx: Transaction,
    aToB: boolean,
    coinA: TransactionArgument,
    coinB: TransactionArgument,
    amount: bigint,
  ) =>
    tx.moveCall({
      target: `${BLUEFIN.packageId}::gateway::swap_assets`,
      typeArguments: [record.memeType, record.quoteType],
      arguments: [
        tx.object.clock(),
        tx.sharedObjectRef({ ...BLUEFIN.config, mutable: false }),
        tx.sharedObjectRef(mut(record.pool as Shared)),
        coinA,
        coinB,
        tx.pure.bool(aToB),
        tx.pure.bool(true),
        tx.pure.u64(amount),
        tx.pure.u64(0),
        tx.pure.u128(aToB ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n),
      ],
    });
  const buy = new Transaction();
  const [zeroMeme] = buy.moveCall({
    target: "0x2::coin::zero",
    typeArguments: [record.memeType],
  });
  swap(
    buy,
    false,
    zeroMeme as TransactionArgument,
    buy.coin({ type: record.quoteType, balance: quoteIn }),
    quoteIn,
  );
  const bought = await exec(`trader buys with ${quoteIn} quote`, trader, buy);
  const memeOut = balanceChange(bought, trader.toSuiAddress(), record.memeType);
  equal("buy returned tokens", memeOut > 0n, true);

  const held = await balance(trader.toSuiAddress(), record.memeType);
  const sell = new Transaction();
  const [zeroQuote] = sell.moveCall({
    target: "0x2::coin::zero",
    typeArguments: [record.quoteType],
  });
  swap(
    sell,
    true,
    sell.coin({ type: record.memeType, balance: held }),
    zeroQuote as TransactionArgument,
    held,
  );
  await exec("trader sells every token back", trader, sell);
}

async function cetusRoundTrip(
  record: SaleRecord,
  trader: Ed25519Keypair,
  suiIn: bigint,
): Promise<void> {
  const memeIsA = cetusMemeSide(record.memeType, SUI) === "a";
  const [coinA, coinB] = memeIsA
    ? [record.memeType, SUI]
    : [SUI, record.memeType];
  const swap = async (
    payType: string,
    amount: bigint,
    label: string,
  ): Promise<Executed> => {
    const aToB = payType === coinA;
    const tx = new Transaction();
    const config = tx.sharedObjectRef({ ...CETUS.config, mutable: false });
    const pool = tx.sharedObjectRef(mut(record.pool as Shared));
    const [outA, outB, receipt] = tx.moveCall({
      target: `${CETUS.packageId}::pool::flash_swap`,
      typeArguments: [coinA, coinB],
      arguments: [
        config,
        pool,
        tx.pure.bool(aToB),
        tx.pure.bool(true),
        tx.pure.u64(amount),
        tx.pure.u128(aToB ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n),
        tx.object.clock(),
      ],
    });
    const payCoin =
      payType === SUI
        ? tx.splitCoins(tx.gas, [amount])[0]
        : tx.coin({ type: payType, balance: amount });
    const [payBalance] = tx.moveCall({
      target: "0x2::coin::into_balance",
      typeArguments: [payType],
      arguments: [payCoin as TransactionArgument],
    });
    const [zeroOther] = tx.moveCall({
      target: "0x2::balance::zero",
      typeArguments: [aToB ? coinB : coinA],
    });
    tx.moveCall({
      target: `${CETUS.packageId}::pool::repay_flash_swap`,
      typeArguments: [coinA, coinB],
      arguments: aToB
        ? [
            config,
            pool,
            payBalance as TransactionArgument,
            zeroOther as TransactionArgument,
            receipt as TransactionArgument,
          ]
        : [
            config,
            pool,
            zeroOther as TransactionArgument,
            payBalance as TransactionArgument,
            receipt as TransactionArgument,
          ],
    });
    for (const [type, out] of [
      [coinA, outA],
      [coinB, outB],
    ] as const) {
      const [coin] = tx.moveCall({
        target: "0x2::coin::from_balance",
        typeArguments: [type],
        arguments: [out as TransactionArgument],
      });
      tx.transferObjects([coin as TransactionArgument], trader.toSuiAddress());
    }
    return exec(label, trader, tx);
  };
  const bought = await swap(
    SUI,
    suiIn,
    `trader buys with ${suiIn} MIST of SUI on Cetus`,
  );
  const memeOut = balanceChange(bought, trader.toSuiAddress(), record.memeType);
  equal("Cetus buy returned tokens", memeOut > 0n, true);
  await swap(
    record.memeType,
    memeOut,
    "trader sells every token back on Cetus",
  );
}
