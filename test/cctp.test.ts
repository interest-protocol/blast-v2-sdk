import assert from "node:assert/strict";
import test from "node:test";
import type { CctpMode } from "@interest-protocol/blast-cctp-sdk";
import {
  CCTP_MODE_STANDARD,
  cctpDepositParameters,
  cctpForwarderAbi,
  cctpForwarderFactoryAbi,
} from "@interest-protocol/blast-cctp-sdk";
import type { Hex } from "viem";
import {
  createPublicClient,
  custom,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  zeroAddress,
  zeroHash,
} from "viem";

const factory = "0xf3A0C5997Db95DE3365d3EE2cd3bFe1E62D1150d";
const deposit = "0x5e15Be27Bad976eFDd316D6dBC2BBA4Db9406b23";
const recipient =
  "0xa11ce00000000000000000000000000000000000000000000000000000000a11";

test("CCTP parameters work with viem reads and forwarding simulations", async () => {
  const parameters = cctpDepositParameters({ factory, recipient });
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        assert.equal(method, "eth_call");
        const [call] = params as [{ to: string; data: Hex }];
        assert.equal(call.to.toLowerCase(), factory.toLowerCase());
        const decoded = decodeFunctionData({
          abi: cctpForwarderFactoryAbi,
          data: call.data,
        });
        assert.deepEqual(decoded.args, [recipient, 1, 0]);
        if (decoded.functionName === "addressOf") {
          return encodeFunctionResult({
            abi: cctpForwarderFactoryAbi,
            functionName: "addressOf",
            result: deposit,
          });
        }
        assert.equal(decoded.functionName, "forward");
        return encodeFunctionResult({
          abi: cctpForwarderFactoryAbi,
          functionName: "forward",
          result: [deposit, 1_000_000n, 10_000n],
        });
      },
    }),
  });
  assert.equal(
    await client.readContract({ ...parameters, functionName: "addressOf" }),
    deposit,
  );
  const simulation = await client.simulateContract({
    ...parameters,
    functionName: "forward",
    account: factory,
  });
  assert.deepEqual(simulation.result, [deposit, 1_000_000n, 10_000n]);
  assert.equal(simulation.request.functionName, "forward");
});

test("CCTP normalizes Sui addresses and preserves mode and uint32 rotation", () => {
  const parameters = cctpDepositParameters({
    factory,
    recipient: "0xa11",
    mode: CCTP_MODE_STANDARD,
    index: 0xffff_ffff,
  });
  assert.deepEqual(parameters.args, [
    `0x${"a11".padStart(64, "0")}`,
    0,
    0xffff_ffff,
  ]);
  for (const functionName of [
    "addressOf",
    "initCode",
    "deploy",
    "forward",
  ] as const) {
    const data = encodeFunctionData({ ...parameters, functionName });
    assert.deepEqual(
      decodeFunctionData({ abi: parameters.abi, data }).args,
      parameters.args,
    );
  }
});

test("CCTP rejects invalid recipients, factories, modes and indices", () => {
  for (const recipient of [
    "",
    "0x",
    "0x0",
    zeroHash,
    "0xgg",
    `0x${"1".repeat(65)}`,
  ]) {
    assert.throws(() => cctpDepositParameters({ factory, recipient }));
  }
  for (const factory of [zeroAddress, "0x123" as const]) {
    assert.throws(() => cctpDepositParameters({ factory, recipient }));
  }
  for (const mode of [-1, 2, 0.5, Number.NaN]) {
    assert.throws(() =>
      cctpDepositParameters({ factory, recipient, mode: mode as CctpMode }),
    );
  }
  for (const index of [
    -1,
    0x1_0000_0000,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(() => cctpDepositParameters({ factory, recipient, index }));
  }
});

test("CCTP ABIs decode canonical events and custom errors without losing atomic units", () => {
  const amount = 2n ** 60n;
  const topics = encodeEventTopics({
    abi: cctpForwarderAbi,
    eventName: "Forwarded",
    args: { recipient },
  });
  const event = decodeEventLog({
    abi: cctpForwarderAbi,
    eventName: "Forwarded",
    topics: [topics[0], recipient],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint32" }],
      [amount, 10_000n, 1_000],
    ),
  });
  assert.deepEqual(event.args, {
    recipient,
    amount,
    maxFee: 10_000n,
    minFinalityThreshold: 1_000,
  });
  const data = encodeErrorResult({
    abi: cctpForwarderAbi,
    errorName: "FeeAboveCeiling",
    args: [101n, 100n],
  });
  assert.deepEqual(decodeErrorResult({ abi: cctpForwarderAbi, data }).args, [
    101n,
    100n,
  ]);
});
