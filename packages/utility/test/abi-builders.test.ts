import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiObjectId } from "@mysten/sui/utils";

import { mainnet } from "../src/deployments.ts";
import { OtcCalls } from "../src/otc/transactions.ts";
import { VestingCalls } from "../src/vesting/transactions.ts";
import { frozenAbi, moveCalls, ptbParameterCount, shared } from "./support.ts";

const SUI = "0x2::sui::SUI";
const USDC = "0xa::usdc::USDC";

test("mainnet package IDs match the frozen ABI records", async () => {
  assert.equal(
    mainnet.otc.packageId,
    (await frozenAbi("otc-v1.json")).mainnet.packageId,
  );
  assert.equal(
    mainnet.vesting.packageId,
    (await frozenAbi("vesting-v1.json")).mainnet.packageId,
  );
});

test("every OTC builder passes exactly the frozen ABI's PTB parameters", async () => {
  const calls = new OtcCalls(mainnet.otc);
  const offer = {
    ...shared("0xc", 7, true),
    offeredType: SUI,
    wantedType: USDC,
  };
  const built = callsByFunction([
    calls.newOffer({
      offeredType: SUI,
      wantedType: USDC,
      offered: "0x1",
      wantedAmount: 5n,
      taker: "0xb",
      partialFills: true,
    }),
    calls.share({ offeredType: SUI, wantedType: USDC, offer: "0x2" }),
    calls.take({ ...offer, amount: 1n, payment: "0x3" }),
    calls.cancel(offer),
  ]);

  assertMatchesAbi(
    await frozenAbi("otc-v1.json"),
    built,
    mainnet.otc.packageId,
  );
});

test("every vesting builder passes exactly the frozen ABI's PTB parameters", async () => {
  const calls = new VestingCalls(mainnet.vesting);
  const schedule = { startMs: 100n, cliffMs: 0n, periodMs: 10n, periods: 2n };
  const built: [string, ReturnType<typeof moveCalls>[number]][] = [];
  for (const kind of ["linear", "checkpoints"] as const) {
    const position = { kind, coinType: SUI, ...shared("0xc", 7, true) };
    built.push(
      ...callsByFunction([
        calls.share({ kind, coinType: SUI, vesting: "0x2" }),
        calls.claim(position),
        calls.cancel({ ...position, cancelCap: "0x3" }),
        calls.closeIrrevocable(position),
      ]),
    );
  }
  built.push(
    ...callsByFunction([
      calls.newLinearIrrevocable({
        coinType: SUI,
        funds: "0x1",
        beneficiary: "0xb",
        schedule,
      }),
      calls.newLinearCancelable({
        coinType: SUI,
        funds: "0x1",
        beneficiary: "0xb",
        refundRecipient: "0xd",
        schedule,
      }),
      calls.newCheckpointSchedule(),
      calls.addCheckpoint({
        schedule: "0x4",
        checkpoint: { timestampMs: 1n, cumulativeAmount: 1n },
      }),
      calls.newCheckpointIrrevocable({
        coinType: SUI,
        funds: "0x1",
        beneficiary: "0xb",
        schedule: "0x4",
      }),
      calls.newCheckpointCancelable({
        coinType: SUI,
        funds: "0x1",
        beneficiary: "0xb",
        refundRecipient: "0xd",
        schedule: "0x4",
      }),
    ]),
  );

  assertMatchesAbi(
    await frozenAbi("vesting-v1.json"),
    built,
    mainnet.vesting.packageId,
  );
});

type BuiltCall = ReturnType<typeof moveCalls>[number];

function callsByFunction(
  thunks: readonly ((tx: Transaction) => unknown)[],
): [string, BuiltCall][] {
  return thunks.map((thunk) => {
    const tx = new Transaction();
    tx.add(thunk as (tx: Transaction) => void);
    const call = moveCalls(tx)[0]!;
    return [`${call.module}::${call.function}`, call];
  });
}

function assertMatchesAbi(
  abi: Awaited<ReturnType<typeof frozenAbi>>,
  built: readonly [string, BuiltCall][],
  packageId: string,
): void {
  const expected = Object.entries(abi.package.modules).flatMap(
    ([module, { functions }]) =>
      functions.map((fn) => [`${module}::${fn.name}`, fn] as const),
  );
  assert.deepEqual(
    built.map(([name]) => name).sort(),
    expected.map(([name]) => name).sort(),
    "the SDK must build every public function exactly once",
  );
  for (const [name, fn] of expected) {
    const call = built.find(([builtName]) => builtName === name)![1];
    assert.equal(
      call.arguments.length,
      ptbParameterCount(fn.parameters),
      `${name} argument count`,
    );
    assert.equal(
      normalizeSuiObjectId(call.package),
      normalizeSuiObjectId(packageId),
    );
  }
}
