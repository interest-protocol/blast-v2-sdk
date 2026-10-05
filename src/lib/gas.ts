import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { TransactionPlugin } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  fromBase64,
  normalizeStructTag,
  normalizeSuiAddress,
} from "@mysten/sui/utils";

/**
 * The budget a cost probe runs with; simulation charges nothing. The same
 * value as `@mysten/sui`'s own resolver probe (`MAX_GAS` there).
 */
const PROBE_BUDGET = 50_000_000_000n;

/** Headroom over the gross cost, in MIST: a fifth of it, plus a floor of 10,000 gas units at the gas price. */
const MARGIN_DIVISOR = 5n;
const MARGIN_GAS_UNITS = 10_000n;

const SUI = normalizeStructTag("0x2::sui::SUI");

/**
 * A build plugin that budgets a transaction at its gross cost plus headroom
 * when the caller has not set a budget.
 *
 * `@mysten/sui` and the fullnode budget the simulated net cost (computation
 * plus storage less rebate) plus 1,000 gas units, about 13 bytes of storage.
 * Execution fails with `InsufficientGas` once `budget - computation < storage
 * - rebate`, so a transaction whose execution writes more storage than its
 * simulation runs out of gas. Cetus seeds a new pool's tick skip list from the
 * clock, so creating a pool writes up to 18 more bytes in about one execution
 * in four: a presale's Cetus migration ran out of gas that way on 2026-10-05.
 * The SDK attaches this plugin to its Cetus migration calls only; every other
 * transaction it builds is deterministic and keeps the default budget.
 *
 * The plugin probes once more and budgets the simulated computation plus all
 * storage, ignoring the rebate, plus a fifth and 10,000 gas units. The charge
 * is unchanged, since the rebate is still credited; only the ceiling rises. A
 * payer that cannot cover that ceiling, given how `@mysten/sui` then picks its
 * gas payment, keeps the default net budget. A transaction-kind build, a
 * budget already set, no client, or a failing probe also leave the default
 * resolver in charge, with its own errors. A plugin does not survive JSON
 * serialization: add it again after `Transaction.from(json)`.
 */
export function grossGasBudget(): TransactionPlugin {
  return async (transactionData, options, next) => {
    const client = options.client as ClientWithCoreApi | undefined;
    const payer = transactionData.gasData.owner ?? transactionData.sender;
    if (
      options.onlyTransactionKind ||
      transactionData.gasData.budget ||
      !client ||
      !payer
    ) {
      return next();
    }

    const probed = await probe(transactionData, client).catch(() => null);
    if (!probed) return next();

    const { computationCost, storageCost } = probed.gasUsed;
    const gross = BigInt(computationCost) + BigInt(storageCost);
    const price = BigInt(probed.transaction.getData().gasData.price ?? 0);
    const budget = gross + gross / MARGIN_DIVISOR + MARGIN_GAS_UNITS * price;
    const { balance } = await client.core.getBalance({
      owner: payer,
      coinType: SUI,
    });
    if (canPay(probed.transaction, payer, balance, budget)) {
      transactionData.gasData.budget = String(budget);
    }
    return next();
  };
}

/**
 * Resolves a copy of the transaction and simulates it with the probe budget,
 * paying from the payer's address balance without gas selection, so the node
 * prices it with a synthetic gas coin whatever the payer holds. Returns null
 * when the simulation fails; resolving a failing transaction throws.
 */
async function probe(
  transactionData: Parameters<TransactionPlugin>[0],
  client: ClientWithCoreApi,
) {
  const transaction = Transaction.from(
    JSON.stringify(transactionData.snapshot(), (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
  transaction.setGasBudget(PROBE_BUDGET);
  transaction.setGasPayment([]);
  const options = {
    transaction: await transaction.build({ client }),
    include: { effects: true },
    // Both clients honor it, but `@mysten/sui` 2.26 leaves it out of the option type.
    doGasSelection: false,
  } as const;
  const simulated = await client.core.simulateTransaction(
    options as Omit<typeof options, "doGasSelection">,
  );
  if (simulated.$kind !== "Transaction") return null;
  return { transaction, gasUsed: simulated.Transaction.effects.gasUsed };
}

/**
 * Whether the payer can fund `budget` the way `@mysten/sui` pays gas: from the
 * address balance alone when the transaction never touches `GasCoin`,
 * otherwise from its coins plus that balance. Either way the SUI the
 * transaction itself takes is set aside first; an amount it takes that is not
 * yet resolved counts as unaffordable.
 */
function canPay(
  transaction: Transaction,
  payer: string,
  balance: { coinBalance: string; addressBalance: string },
  budget: bigint,
): boolean {
  const data = transaction.getData();
  const addressBalance =
    BigInt(balance.addressBalance) - withdrawals(transaction, payer);
  // A command argument naming the gas coin, at any depth.
  const usesGasCoin = JSON.stringify(data.commands).includes(
    '"$kind":"GasCoin"',
  );
  if (!usesGasCoin)
    return addressBalance >= budget || BigInt(balance.coinBalance) >= budget;

  let splitFromGas = 0n;
  for (const command of data.commands) {
    if (
      command.$kind !== "SplitCoins" ||
      command.SplitCoins.coin.$kind !== "GasCoin"
    )
      continue;
    for (const amount of command.SplitCoins.amounts) {
      const input =
        amount.$kind === "Input" ? data.inputs[amount.Input] : undefined;
      if (input?.$kind !== "Pure") return false;
      splitFromGas += BigInt(bcs.u64().parse(fromBase64(input.Pure.bytes)));
    }
  }
  return BigInt(balance.coinBalance) + addressBalance - splitFromGas >= budget;
}

/** The SUI a transaction withdraws from the payer's address balance. */
function withdrawals(transaction: Transaction, payer: string): bigint {
  const data = transaction.getData();
  let total = 0n;
  for (const input of data.inputs) {
    if (input.$kind !== "FundsWithdrawal") continue;
    const { typeArg, withdrawFrom, reservation } = input.FundsWithdrawal;
    if (normalizeStructTag(typeArg.Balance) !== SUI) continue;
    const owner = withdrawFrom.Sender ? data.sender : payer;
    if (!owner || normalizeSuiAddress(owner) !== normalizeSuiAddress(payer))
      continue;
    if (reservation.$kind === "MaxAmountU64")
      total += BigInt(reservation.MaxAmountU64);
  }
  return total;
}
