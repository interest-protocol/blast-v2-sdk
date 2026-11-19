# @interest-protocol/blast-util-sdk

TypeScript transaction builders, state reads, event decoders, and replay
reducers for the two immutable Blast util packages on Sui mainnet:

| Entry point | Package | Mainnet package ID |
| --- | --- | --- |
| `@interest-protocol/blast-util-sdk/otc` | [`blast_fun_otc`](https://github.com/interest-protocol/blast-v2-contracts/tree/main/sui/otc) | `0x40e0c95f73af329e7a6a8eafee9d152a1f3090736d35052842288232f7eb5968` |
| `@interest-protocol/blast-util-sdk/vesting` | [`blast_fun_vesting`](https://github.com/interest-protocol/blast-v2-contracts/tree/main/sui/vesting) | `0x85fdb7e3d28162b99e0df758069a3d23cff874c400b2160fc0d4618aefd3ec5c` |

Both IDs ship as `mainnet` in `@interest-protocol/blast-util-sdk/deployments`.
The packages can never be upgraded, so each ID is also its original ID and never
changes.

Install the compiled ESM package and its peer dependency:

```sh
npm install @interest-protocol/blast-util-sdk@^0.2.0 @mysten/sui@^3
```

The package includes JavaScript and TypeScript declarations for every entry point.
All amounts are atomic coin units as `bigint`; all times are Unix milliseconds.
`@mysten/sui` 3.x is a peer dependency. The TypeScript SDK moved here from
the [utility-sdk-v0.1.0 release](https://github.com/interest-protocol/blast-v2-contracts/tree/utility-sdk-v0.1.0/sdk)
and remains MIT-licensed.

## Clients

Both clients extend any Sui Core API client:

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { mainnet } from "@interest-protocol/blast-util-sdk/deployments";
import { blastOtc } from "@interest-protocol/blast-util-sdk/otc";
import { blastVesting } from "@interest-protocol/blast-util-sdk/vesting";

const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io:443",
})
  .$extend(blastOtc(mainnet.otc))
  .$extend(blastVesting(mainnet.vesting));
```

Each client has `tx` (complete transactions that route every returned object)
and `call` (thunks for composing your own programmable transaction).

## OTC

A maker escrows a `Coin<Offered>` in a shared `Offer<Offered, Wanted>` at a
fixed rate, optionally for one named taker and optionally allowing partial
fills. See the [OTC contract](https://github.com/interest-protocol/blast-v2-contracts/tree/main/sui/otc)
for the rules.

```ts
const USDC = "0x...::usdc::USDC"; // any coin type other than the offered one
const me = "0x..."; // the signer's address

// Maker: escrow 1,000 SUI units for 333 USDC units, partial fills allowed.
const create = client.blastOtc.tx.createOffer({
  offeredType: "0x2::sui::SUI",
  wantedType: USDC,
  offeredAmount: 1_000n,
  wantedAmount: 333n,
  partialFills: true,
});

// Taker: read the offer, then buy 400 units of it.
const offer = await client.blastOtc.getOffer("0x...");
const take = client.blastOtc.tx.take({
  offer,
  amount: 400n,
  recipient: me,
  sender: me,
});

// Maker: delete the offer and recover what is left.
const cancel = client.blastOtc.tx.cancel({ ...offer, recipient: me });
```

`take` pays exactly the quoted cost, `amount * wantedAmount / offeredAmount`
rounded up for the maker, as the contract does. The payment coin therefore ends
empty and is destroyed in the same transaction. `quoteTake` runs the contract's
checks in the contract's order, so a quote that succeeds would not abort
on-chain against the same offer state. `takeCost` and `maxTakeForPayment`
convert between amounts and payments.

`decodeOtcEvent` and `reduceOtcEvent` replay `OfferCreated`, `OfferTaken`, and
`OfferCanceled` into per-offer projections. Every fill is checked against the
rate, the named taker, and the all-or-nothing rule. The events carry no sender
field, so the projection takes the maker and taker from each event's
transaction sender.

## Vesting

`@interest-protocol/blast-util-sdk/vesting` supports the independent `linear`
and `checkpoints` modules. It validates creation inputs, builds atomic
create-and-share transactions, decodes live shared objects and their bounded
inline checkpoint vectors, and mirrors vesting math with `bigint`.

```ts
const currentTimestampMs = await client.blastVesting.getCurrentTimestampMs();
const transaction = client.blastVesting.tx.createCheckpointCancelable({
  coinType: "0x2::sui::SUI",
  totalAmount: 1_000n,
  beneficiary: "0xb0b",
  refundRecipient: "0xcafe",
  cancelCapRecipient: "0xca11",
  currentTimestampMs,
  checkpoints: [
    { timestampMs: currentTimestampMs + 60_000n, cumulativeAmount: 200n },
    { timestampMs: currentTimestampMs + 120_000n, cumulativeAmount: 456n },
    { timestampMs: currentTimestampMs + 300_000n, cumulativeAmount: 1_000n },
  ],
});
```

Checkpoint amounts are cumulative. At the second checkpoint, `456` total units
are vested, so that checkpoint adds `456 - 200 = 256` units. The final
cumulative amount must equal `totalAmount`.

Read and interact with a position without copying object metadata:

```ts
const position = await client.blastVesting.getVesting("0x...");
const preview = await client.blastVesting.preview(
  position.objectId,
  BigInt(Date.now()),
);
const claimTransaction = client.blastVesting.tx.claim(position);
```

The SDK requires 60 seconds between the checked current time and the first
vesting boundary. `getCurrentTimestampMs` reads the authoritative Sui `Clock`;
transaction builders fall back to `Date.now()` when no timestamp is supplied.
Set `minimumLeadTimeMs` explicitly only when the application has a different
submission policy. The contract checks the on-chain `Clock` again during
execution.

`decodeVestingEvent` and `reduceVestingInput` replay the four vesting events
into per-position projections. The events carry no sender field; the funder is
the `VestingCreated` transaction sender.

## ABI parity

`abi/otc-v1.json` and `abi/vesting-v1.json` freeze the public Move ABI of each
package, generated with `sui move summary` from the sources at the publish
commit `8600b8f`. The tests check the following:

- every public function has exactly one SDK builder, passing exactly the
  function's parameters other than `TxContext`, to the mainnet package;
- every event decoder has the frozen event's fields in the frozen order;
- the mainnet IDs in `deployments` match the frozen records.

```bash
BLAST_CONTRACTS_DIR=/path/to/blast-v2-contracts npm run check -w @interest-protocol/blast-util-sdk
```

The check regenerates the ABI from the pinned contracts commit with Sui CLI
`1.77.2-51d177ad7d65` and compares it to the frozen files. The contracts
checkout must contain that commit. When `BLAST_CONTRACTS_DIR` is unset, the
check looks for `blast-v2-contracts` next to the SDK repository.
