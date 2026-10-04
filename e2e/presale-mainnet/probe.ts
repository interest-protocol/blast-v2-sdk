/**
 * E2E-003: read-only feasibility probes. Every transaction here is simulated,
 * never executed.
 */
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";

import {
  assertMainnet,
  BLUEFIN,
  CETUS,
  COIN_REGISTRY,
  client,
  deployer,
  SUI,
  TEST_SUI,
  TESTKIT,
} from "./env.ts";

const sender = deployer().toSuiAddress();

async function simulate(tx: Transaction) {
  tx.setSender(sender);
  return client.core.simulateTransaction({
    transaction: tx,
    include: { commandResults: true, effects: true },
  });
}

async function bluefinCreationFee(): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${BLUEFIN.packageId}::config::get_pool_creation_fee_amount`,
    typeArguments: [SUI],
    arguments: [tx.sharedObjectRef({ ...BLUEFIN.config, mutable: false })],
  });
  const result = await simulate(tx);
  // Returns `(supported, amount)`.
  const [supported, amount] = result.commandResults?.[0]?.returnValues ?? [];
  if (result.$kind !== "Transaction" || !supported || !amount) {
    throw new Error(
      `fee read failed: ${JSON.stringify(result.FailedTransaction?.status)}`,
    );
  }
  if (!bcs.bool().parse(supported.bcs))
    throw new Error("Bluefin does not accept SUI fees");
  return BigInt(bcs.u64().parse(amount.bcs));
}

/** Whether Cetus lets a fresh sale token reserve a permission pair against SUI at `tickSpacing`. */
async function cetusPermissionPair(
  tickSpacing: number,
  quoteType = SUI,
): Promise<string> {
  const tx = new Transaction();
  const [treasuryCap] = tx.moveCall({
    target: `${TESTKIT}::sale_tokens::new_sale_p`,
    arguments: [tx.object(COIN_REGISTRY)],
  });
  const memeType = `${TESTKIT}::sale_tokens::SALE_P`;
  const config = tx.sharedObjectRef({ ...CETUS.config, mutable: false });
  const pools = tx.sharedObjectRef({ ...CETUS.pools, mutable: true });
  const [creationCap] = tx.moveCall({
    target: `${CETUS.packageId}::factory::mint_pool_creation_cap`,
    typeArguments: [memeType],
    arguments: [config, pools, treasuryCap as never],
  });
  tx.moveCall({
    target: `${CETUS.packageId}::factory::register_permission_pair`,
    typeArguments: [memeType, quoteType],
    arguments: [config, pools, tx.pure.u32(tickSpacing), creationCap as never],
  });
  tx.transferObjects([treasuryCap as never, creationCap as never], sender);
  const result = await simulate(tx);
  return result.$kind === "Transaction"
    ? "allowed"
    : (result.FailedTransaction.status.error?.message ?? "failed");
}

await assertMainnet();
const fee = await bluefinCreationFee();
console.log(
  `Bluefin pool-creation fee: ${fee} MIST (${Number(fee) / 1e9} SUI)`,
);
for (const tickSpacing of [2, 10, 20, 60, 200, 220]) {
  console.log(
    `Cetus SUI pair at tick spacing ${tickSpacing}: ${await cetusPermissionPair(tickSpacing)}`,
  );
}
console.log(
  `Cetus TEST_SUI pair at tick spacing 200: ${await cetusPermissionPair(200, TEST_SUI)}`,
);
