import assert from "node:assert/strict";
import test from "node:test";
import { finalizeCoinRegistration } from "@interest-protocol/blast-coin-sdk";
import {
  defineBlastDeployment,
  presaleDeployment,
} from "@interest-protocol/blast-deployments-sdk";
import { PresaleCalls } from "@interest-protocol/blast-presale-sdk";
import type { BluefinPoolCreation } from "@interest-protocol/blast-sdk/migrators";
import {
  addBluefinPoolWithLiquidity,
  shareBluefinPool,
} from "@interest-protocol/blast-sdk/migrators";
import { bcs } from "@mysten/sui/bcs";
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  fromBase64,
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_TYPE_ARG,
} from "@mysten/sui/utils";
import { NON_PRODUCTION_MANIFEST } from "./fixtures/non-production-deployment.ts";

const options: BluefinPoolCreation = {
  memeType: "0xa::meme::MEME",
  quoteType: "0xb::quote::QUOTE",
  bluefinPackageId: "0xcafe",
  bluefinConfig: { objectId: "0xcf", initialSharedVersion: "4", mutable: true },
  memeMetadata: { symbol: "MEME", decimals: 9 },
  quoteMetadata: {
    symbol: "QUOTE",
    decimals: 6,
    iconUrl: "https://example.com/quote.png",
  },
  tickSpacing: 200,
  feeRate: 10_000n,
  sqrtPriceX64: 1n << 64n,
  creationFee: 0n,
  lowerTick: -443_600,
  upperTick: 443_600,
  memeCoin: "0xa1",
  quoteCoin: "0xb1",
  fixedAmount: 1_000_000n,
  fixedMeme: true,
};

test("composes registry finalization, Bluefin pool/liquidity and a vault before sharing", () => {
  const tx = new Transaction();
  finalizeCoinRegistration(tx, {
    coinType: options.memeType,
    currency: "0xcc",
  });
  const result = addBluefinPoolWithLiquidity(tx, options);
  tx.add(
    new PresaleCalls(
      presaleDeployment(defineBlastDeployment(NON_PRODUCTION_MANIFEST)),
    ).newBluefinVault({
      ...options,
      pool: result.pool,
      position: result.position,
      feeRecipients: [{ recipient: "0x123", bps: 1_000n }],
      holderRewardsBps: 9_000n,
    }),
  );
  shareBluefinPool(tx, { ...options, pool: result.pool });
  tx.transferObjects([result.memeResidual, result.quoteResidual], "0x123");
  const data = tx.getData();
  const calls = data.commands.flatMap((command) =>
    command.MoveCall ? [command.MoveCall] : [],
  );
  const find = (fn: string) => {
    const call = calls.find((call) => call.function === fn);
    assert.ok(call, fn);
    return call;
  };
  const pure = (argument: TransactionArgument | undefined) => {
    assert.ok(argument && typeof argument === "object" && "Input" in argument);
    const input = data.inputs[argument.Input];
    assert.ok(input?.Pure);
    return fromBase64(input.Pure.bytes);
  };

  assert.deepEqual(
    calls.slice(0, 5).map((call) => call.function),
    [
      "finalize_registration",
      "zero",
      "create_pool_and_get_object",
      "open_position",
      "into_balance",
    ],
  );
  // Arity/order from BluefinSpot 91ce930 pool.move; TxContext is implicit.
  const create = find("create_pool_and_get_object");
  assert.equal(create.package, normalizeSuiAddress(options.bluefinPackageId));
  assert.deepEqual(create.typeArguments, [
    normalizeStructTag(options.memeType),
    normalizeStructTag(options.quoteType),
    SUI_TYPE_ARG,
  ]);
  assert.equal(create.arguments.length, 14);
  assert.equal(bcs.string().parse(pure(create.arguments[2])), "MEME-QUOTE");
  assert.equal(bcs.u8().parse(pure(create.arguments[5])), 9);
  assert.equal(bcs.u8().parse(pure(create.arguments[8])), 6);
  assert.equal(bcs.u32().parse(pure(create.arguments[10])), 200);
  assert.equal(BigInt(bcs.u64().parse(pure(create.arguments[11]))), 10_000n);
  assert.equal(BigInt(bcs.u128().parse(pure(create.arguments[12]))), 1n << 64n);
  const open = find("open_position");
  assert.equal(open.arguments.length, 4);
  assert.equal(bcs.u32().parse(pure(open.arguments[2])), 2 ** 32 - 443_600);
  assert.equal(bcs.u32().parse(pure(open.arguments[3])), 443_600);
  assert.deepEqual(open.arguments[1], { Result: 2, $kind: "Result" });
  const add = find("add_liquidity_with_fixed_amount");
  assert.equal(add.arguments.length, 8);
  assert.deepEqual(add.arguments.slice(2, 4), [
    open.arguments[1],
    { Result: 3, $kind: "Result" },
  ]);
  assert.equal(
    BigInt(bcs.u64().parse(pure(add.arguments[6]))),
    options.fixedAmount,
  );
  assert.equal(bcs.bool().parse(pure(add.arguments[7])), true);
  const vault = find("new_vault");
  assert.deepEqual(vault.arguments[0], add.arguments[3]);
  assert.deepEqual(vault.arguments[6], open.arguments[1]);
  const share = find("share_pool_object");
  assert.deepEqual(share.arguments, [open.arguments[1]]);
  assert.ok(calls.indexOf(vault) < calls.indexOf(share));
  assert.equal(find("zero").typeArguments[0], SUI_TYPE_ARG);
  assert.equal(
    data.inputs.filter(
      (input) =>
        input.Object?.SharedObject?.objectId === normalizeSuiAddress("0xcf"),
    ).length,
    1,
  );
  assert.equal(
    data.inputs.find(
      (input) =>
        input.Object?.SharedObject?.objectId === normalizeSuiAddress("0xcf"),
    )?.Object?.SharedObject?.mutable,
    true,
  );
});

test("pays an explicit nonzero creation fee and supports fixing Quote", () => {
  const tx = new Transaction();
  addBluefinPoolWithLiquidity(tx, {
    ...options,
    creationFee: 7n,
    fixedMeme: false,
  });
  const data = tx.getData();
  assert.equal(
    data.commands.filter((command) => command.MoveCall?.function === "zero")
      .length,
    0,
  );
  assert.equal(
    data.commands.filter(
      (command) => command.MoveCall?.function === "into_balance",
    ).length,
    3,
  );
  const intent = data.commands.find((command) => command.$Intent)?.$Intent;
  assert.ok(intent);
  assert.equal(intent.data.balance, 7n);
  assert.equal(intent.data.type, "gas");
  const add = data.commands.find(
    (command) =>
      command.MoveCall?.function === "add_liquidity_with_fixed_amount",
  )?.MoveCall;
  assert.ok(add);
  const flag = add.arguments[7];
  assert.ok(flag && "Input" in flag);
  const input = data.inputs[flag.Input];
  assert.ok(input?.Pure);
  assert.equal(bcs.bool().parse(fromBase64(input.Pure.bytes)), false);
});

test("rejects ticks that cannot be encoded without losing information", () => {
  for (const lowerTick of [-(2 ** 32), 2 ** 31, 0.5, Number.NaN]) {
    assert.throws(
      () =>
        addBluefinPoolWithLiquidity(new Transaction(), {
          ...options,
          lowerTick,
        }),
      /tick must be an i32/,
    );
  }
});
