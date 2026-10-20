import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  fromBase64,
  normalizeStructTag,
  normalizeSuiAddress,
} from "@mysten/sui/utils";

import { finalizeCoinRegistration } from "../src/coin/index.ts";
import {
  defineBlastDeployment,
  presaleDeployment,
} from "../src/deployments/index.ts";
import type { CetusPoolCreation } from "../src/migrators/index.ts";
import { addCetusPoolWithLiquidity } from "../src/migrators/index.ts";
import { PresaleTransactions } from "../src/presale/index.ts";
import { NON_PRODUCTION_MANIFEST } from "./fixtures/non-production-deployment.ts";

const options: CetusPoolCreation = {
  memeType: "0xa::meme::MEME",
  quoteType: "0x2::sui::SUI",
  cetusPackageId: "0xcafe",
  cetusConfig: { objectId: "0xcf", initialSharedVersion: "4", mutable: false },
  cetusPools: { objectId: "0xc0", initialSharedVersion: "4", mutable: true },
  tickSpacing: 200,
  sqrtPriceX64: 1n << 64n,
  lowerTick: -443_600,
  upperTick: 443_600,
  memeCoin: "0xa1",
  quoteCoin: "0xb1",
  fixedMeme: true,
};

for (const memeIsA of [true, false]) {
  for (const fixedMeme of [true, false]) {
    test(`orders Cetus inputs and results: Meme is A=${memeIsA}, fixed Meme=${fixedMeme}`, () => {
      const tx = new Transaction();
      const memeType = memeIsA ? options.memeType : "0x1::meme::MEME";
      const result = addCetusPoolWithLiquidity(tx, {
        ...options,
        memeType,
        fixedMeme,
        url: "https://example.com/pool",
      });
      tx.transferObjects(
        [result.position, result.memeResidual, result.quoteResidual],
        "0x123",
      );
      const data = tx.getData();
      const call = data.commands[0]?.MoveCall;
      assert.ok(call);
      const pure = (arg: TransactionArgument | undefined) => {
        assert.ok(arg && typeof arg === "object" && "Input" in arg);
        const input = data.inputs[arg.Input];
        assert.ok(input?.Pure);
        return fromBase64(input.Pure.bytes);
      };
      const objectId = (arg: TransactionArgument | undefined) => {
        assert.ok(arg && typeof arg === "object" && "Input" in arg);
        return data.inputs[arg.Input]?.UnresolvedObject?.objectId;
      };
      const types = [memeType, options.quoteType].map(normalizeStructTag);
      assert.deepEqual(
        call.typeArguments,
        memeIsA ? types : types.toReversed(),
      );
      assert.equal(call.package, normalizeSuiAddress(options.cetusPackageId));
      assert.equal(call.module, "pool_creator");
      assert.equal(call.function, "create_pool_v3");
      // Pinned Cetus revision-15 ABI, with implicit TxContext omitted.
      assert.equal(call.arguments.length, 11);
      assert.equal(bcs.u32().parse(pure(call.arguments[2])), 200);
      assert.equal(
        BigInt(bcs.u128().parse(pure(call.arguments[3]))),
        1n << 64n,
      );
      assert.equal(
        bcs.string().parse(pure(call.arguments[4])),
        "https://example.com/pool",
      );
      assert.equal(bcs.u32().parse(pure(call.arguments[5])), 2 ** 32 - 443_600);
      assert.equal(bcs.u32().parse(pure(call.arguments[6])), 443_600);
      assert.equal(
        objectId(call.arguments[7]),
        normalizeSuiAddress(memeIsA ? "0xa1" : "0xb1"),
      );
      assert.equal(
        objectId(call.arguments[8]),
        normalizeSuiAddress(memeIsA ? "0xb1" : "0xa1"),
      );
      assert.equal(
        bcs.bool().parse(pure(call.arguments[9])),
        memeIsA === fixedMeme,
      );
      const transferred = data.commands[1]?.TransferObjects;
      assert.ok(transferred);
      assert.deepEqual(
        transferred.objects.map((arg) => {
          assert.ok("NestedResult" in arg);
          return arg.NestedResult;
        }),
        [
          [0, 0],
          [0, memeIsA ? 1 : 2],
          [0, memeIsA ? 2 : 1],
        ],
      );
      assert.equal(data.inputs[0]?.Object?.SharedObject?.mutable, false);
      assert.equal(data.inputs[1]?.Object?.SharedObject?.mutable, true);
    });
  }
}

test("uses the creation-cap v3 path for a reserved pair", () => {
  const tx = new Transaction();
  addCetusPoolWithLiquidity(tx, { ...options, poolCreationCap: "0x123" });
  const data = tx.getData();
  const call = data.commands[0]?.MoveCall;
  assert.ok(call);
  assert.equal(call.function, "create_pool_v3_with_creation_cap");
  assert.equal(call.arguments.length, 12);
  const cap = call.arguments[2];
  assert.ok(cap && "Input" in cap);
  assert.equal(
    data.inputs[cap.Input]?.UnresolvedObject?.objectId,
    normalizeSuiAddress("0x123"),
  );
});

test("composes Currency finalization and leaves vault creation to the next PTB", () => {
  const tx = new Transaction();
  finalizeCoinRegistration(tx, {
    coinType: options.memeType,
    currency: "0xcc",
  });
  const result = addCetusPoolWithLiquidity(tx, options);
  tx.transferObjects(
    [result.position, result.memeResidual, result.quoteResidual],
    "0x123",
  );
  assert.deepEqual(
    tx
      .getData()
      .commands.flatMap((command) => command.MoveCall?.function ?? []),
    ["finalize_registration", "create_pool_v3"],
  );
  assert.equal("pool" in result, false);
  const vault = new PresaleTransactions(
    presaleDeployment(defineBlastDeployment(NON_PRODUCTION_MANIFEST)),
  ).newCetusVault({
    memeType: options.memeType,
    quoteType: options.quoteType,
    position: "0x905",
    pool: { objectId: "0x90", initialSharedVersion: "7", mutable: false },
    burnManager: { objectId: "0x72", initialSharedVersion: "3", mutable: true },
    feeRecipients: [{ recipient: "0x123", bps: 1_000n }],
    holderRewardsBps: 9_000n,
  });
  const call = vault
    .getData()
    .commands.find(
      (command) => command.MoveCall?.function === "new_vault",
    )?.MoveCall;
  assert.ok(call);
  assert.equal(call.module, "cetus");
  assert.deepEqual(
    call.typeArguments,
    [
      options.memeType,
      options.quoteType,
      options.memeType,
      options.quoteType,
    ].map(normalizeStructTag),
  );
});

test("rejects signed ticks that cannot be encoded without losing information", () => {
  for (const tick of [-(2 ** 32), 2 ** 31, 0.5, Number.NaN]) {
    for (const side of ["lowerTick", "upperTick"]) {
      assert.throws(
        () =>
          addCetusPoolWithLiquidity(new Transaction(), {
            ...options,
            [side]: tick,
          }),
        /tick must be an i32/,
      );
    }
  }
});
