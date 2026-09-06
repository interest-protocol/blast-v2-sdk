import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { autoLpEventSpecs } from "../src/auto-lp/events.ts";
import { AutoLpCalls } from "../src/auto-lp/transactions.ts";
import { dexEventSpecs } from "../src/dex/events.ts";
import { DexCalls } from "../src/dex/transactions.ts";

type MoveType =
  | string
  | {
      Reference?: [boolean, MoveType];
      Datatype?: { module: { name: string }; name: string };
    };
type Module = {
  functions: {
    name: string;
    parameters: MoveType[];
    typeParameters: unknown[];
  }[];
  events: { name: string; fields: { name: string; type: MoveType }[] }[];
};
const abi = JSON.parse(
  readFileSync(
    new URL("../abi/production-native-dex-v1.json", import.meta.url),
    "utf8",
  ),
) as { packages: Record<string, { modules: Record<string, Module> }> };
const dex = new DexCalls({
  packageId: "0xd",
  factory: { objectId: "0xf", initialSharedVersion: "1" },
});
const auto = new AutoLpCalls({
  packageId: "0xa",
  control: { objectId: "0xc", initialSharedVersion: "2" },
  dex: dex.deployment,
});
const pair = { memeType: "0x3::m::M", quoteType: "0x2::sui::SUI" };
const pool = { ...pair, pool: "0x20" };
const position = { ...pool, position: "0x21" };
const swap = {
  ...pool,
  input: "0x22",
  minimumOutput: 17n,
  maximumFeeBps: 203n,
  deadlineMs: 1234n,
};
const vault = { ...pool, vault: "0x30" };
const adminWitness = { $kind: "Result", Result: 0 } as const;
const calls = [
  dex.assertCurrent(),
  dex.activate({ adminWitness }),
  dex.create({
    ...pair,
    creatorCap: "0x24",
    launch: "0x25",
    currency: "0x26",
    meme: "0x27",
    quote: "0x28",
    burnBps: 15n,
  }),
  dex.share(pool),
  dex.newPosition(pool),
  dex.setMaxFee({ ...pool, adminWitness, maximumBps: 300n }),
  dex.depositAmounts({ ...pool, memeMaximum: 123n, quoteMaximum: 456n }),
  dex.addLiquidity({
    ...position,
    meme: "0x27",
    quote: "0x28",
    minimumShares: 1n << 80n,
    deadlineMs: 1234n,
  }),
  dex.removeLiquidity({
    ...position,
    shares: 1n << 80n,
    minimumMeme: 12n,
    minimumQuote: 34n,
    deadlineMs: 1234n,
  }),
  dex.claimFees(position),
  dex.destroyEmpty(position),
  dex.buy(swap),
  dex.sell(swap),
  dex.buyAndBurn({ ...swap, currency: "0x26" }),
  dex.sellAndBurn({ ...swap, currency: "0x26" }),
  dex.migrate({
    ...pair,
    launch: "0x25",
    packageVersion: "0x29",
    currency: "0x26",
  }),
  dex.collectNativeFees({ ...vault, runtimeConfig: "0x31" }),
  dex.claimNativeCreatorFees({ ...vault, creatorCap: "0x24" }),
  dex.claimNativeProtocolFees({ ...vault, adminWitness }),
  auto.enroll({ ...pool, creatorCap: "0x24", executor: "0x99" }),
  auto.share(vault),
  auto.collectCurve({ ...vault, launch: "0x25", packageVersion: "0x29" }),
  auto.collectExternalLp({ ...vault, source: "0x32" }),
  auto.collectNativeLp({ ...vault, source: "0x32" }),
  auto.collectOwnLp(vault),
  auto.contribute({ ...vault, meme: "0x27", quote: "0x28" }),
  auto.compound({
    ...vault,
    maximumMeme: 123n,
    maximumQuote: 456n,
    minimumShares: 1n << 80n,
    deadlineMs: 1234n,
  }),
  auto.activate({ adminWitness }),
];

test("all 28 public native package builders match frozen Move arity, generics, and pure widths", () => {
  const seen = new Set<string>();
  for (const call of calls) {
    const tx = new Transaction();
    tx.add(call);
    const data = tx.getData();
    const command = data.commands[0]?.MoveCall;
    assert.ok(command);
    const packageName =
      command.package === dex.deployment.packageId ? "dex" : "autoLp";
    const method = abi.packages[packageName]?.modules[
      command.module
    ]?.functions.find((f) => f.name === command.function);
    assert.ok(method);
    seen.add(`${packageName}::${command.module}::${command.function}`);
    const parameters = method.parameters.filter(
      (t) =>
        !(
          typeof t !== "string" &&
          t.Reference &&
          typeof t.Reference[1] !== "string" &&
          t.Reference[1].Datatype?.module.name === "tx_context"
        ),
    );
    assert.equal(command.arguments.length, parameters.length, command.function);
    assert.equal(
      command.typeArguments.length,
      method.typeParameters.length,
      command.function,
    );
    parameters.forEach((parameter, index) => {
      if (typeof parameter !== "string") return;
      const arg = command.arguments[index];
      assert.equal(arg?.$kind, "Input");
      assert.ok(arg && "Input" in arg);
      const input = data.inputs[arg.Input];
      assert.ok(input?.Pure);
      assert.equal(
        fromBase64(input.Pure.bytes).length,
        parameter === "u128" ? 16 : parameter === "address" ? 32 : 8,
        `${command.function} argument ${index}`,
      );
    });
  }
  const expected = Object.entries(abi.packages).flatMap(([p, v]) =>
    Object.entries(v.modules).flatMap(([m, v]) =>
      v.functions.map((f) => `${p}::${m}::${f.name}`),
    ),
  );
  assert.deepEqual([...seen].sort(), expected.sort());
});

test("all 17 native event codecs match frozen field order and numeric widths", () => {
  for (const [packageName, specs] of [
    ["dex", dexEventSpecs],
    ["autoLp", autoLpEventSpecs],
  ] as const) {
    for (const [moduleName, events] of Object.entries(specs)) {
      const frozen = abi.packages[packageName]?.modules[moduleName]?.events;
      assert.ok(frozen);
      assert.deepEqual(
        Object.keys(events).sort(),
        frozen.map((e) => e.name).sort(),
      );
      for (const event of frozen) {
        const actual = Object.entries(
          events[event.name as keyof typeof events],
        );
        assert.deepEqual(
          actual,
          event.fields.map((f) => [
            f.name,
            typeof f.type === "string" ? f.type : "id",
          ]),
        );
      }
    }
  }
});
