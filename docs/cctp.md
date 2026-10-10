# CCTP deposits

`@interest-protocol/blast-sdk/cctp` integrates the EVM forwarder contracts in
[blast-cctp at b670f07](https://github.com/interest-protocol/blast-cctp/tree/b670f07ee290aace73b62b91694a9de0f7068f49).
It uses [viem](https://viem.sh/docs/contract/simulateContract) for ABI encoding,
reads, simulations, writes and event decoding. Supply your existing public
and wallet clients; the SDK owns no RPC endpoint, chain list, signer or state.

Argument checks use `tiny-invariant` and still throw in production, where
messages become generic. For runtimes without `process`, configure your bundler
to replace `process.env.NODE_ENV`, as required by `tiny-invariant`.

## Deposit address and forwarding

```ts
import { cctpDepositParameters } from "@interest-protocol/blast-sdk/cctp";

// publicClient and walletClient are viem clients for the same supported chain.
// factory is the verified deployed ForwarderFactory address on that chain.
const parameters = cctpDepositParameters({
  factory,
  recipient: suiAddress,
  // mode: CCTP_MODE_FAST (1) by default; CCTP_MODE_STANDARD is 0.
  // index: 0 by default; increment to rotate an address.
});

const depositAddress = await publicClient.readContract({
  ...parameters,
  functionName: "addressOf",
});

// Anyone can trigger a burn. Simulate with the account that will submit it.
const { result, request } = await publicClient.simulateContract({
  ...parameters,
  functionName: "forward",
  account: walletClient.account,
});
// result = [forwarder, amount, maxFee]; USDC amounts are bigint atomic units.
const hash = await walletClient.writeContract(request);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
```

`deploy` uses the same parameters and deploys without burning. `initCode` is
a read with the same parameters. Read `addressOf` from the deployed factory
instead of embedding creation bytecode: compiler and source changes alter
CREATE2 addresses. Reading an address does not deploy its forwarder.

## Forwarder reads, rescue and events

`cctpForwarderFactoryAbi` and `cctpForwarderAbi` expose all public contract
functions, events and custom errors. Pass them directly to viem's
`getContract`, `readContract`, `simulateContract`, `parseEventLogs` or
`decodeErrorResult`. The factory also propagates forwarder reverts; use
`cctpForwarderAbi` to decode their error data. Forwarder rescue calls require
the configured rescuer and always reject USDC.

```ts
import { parseEventLogs } from "viem";
import { cctpForwarderAbi } from "@interest-protocol/blast-sdk/cctp";

const burns = parseEventLogs({
  abi: cctpForwarderAbi,
  eventName: "Forwarded",
  logs: receipt.logs.filter(
    (log) => log.address.toLowerCase() === depositAddress.toLowerCase(),
  ),
});
```

`Forwarded` records the executed burn; simulation results are previews.
The amount is capped by Circle's per-message burn limit, so a large deposit
can need several calls. Fast requests finality 1000 and permits up to 100 bps
(1%) fees, rounded down in atomic units; the fractional remainder stays
outside the fee allowance. Standard requests finality 2000 and permits the
on-chain minimum (zero if the getter is unavailable). `maxFee` is an allowance,
not a fee quote or the actual charged fee. Both modes revert when the minimum
exceeds the ceiling, leaving USDC at the deposit address.

## Deployment boundary

At this contract revision, the contracts are not deployed or audited. There
are intentionally no registered factory addresses. Only show deposit
addresses on chains where you have verified the intended factory deployment
and compatible Circle CCTP V2 contracts. Test-rescuer pins are not production
addresses. The SDK validates argument shapes; it does not certify deployments.

This module covers the EVM deposit and burn. It does not operate a relayer,
poll Circle attestations, implement the Sui V2 mint or support Solana. A
successful EVM receipt is not confirmation that USDC has arrived on Sui.
