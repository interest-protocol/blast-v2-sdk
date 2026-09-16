# Blast SDK

The SDK mirrors the completed Sui launchpad and vesting ABIs without becoming a
second source of truth for protocol execution.

It provides:

- exact `bigint` buy, sell, release, fee, and valuation previews;
- BCS decoding for live `Launch<Meme, Quote>` objects through the transport-
  neutral Sui Core API;
- executable transactions for launch creation, trades, creator claims, and fee
  claims;
- composable Move-call helpers for adapter-owned migration transactions;
- complete migration and LP-fee transactions for Bluefin, Cetus, MMT, Turbos,
  and Aftermath; and
- typed BCS event decoding and deterministic launch-to-vault replay.

See [optional holder rewards](docs/holder-distributor.md) for standalone creator-cap
custody, holder accounting, signed rounds, and permissionless airdrops.

## Client extension

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { blastLaunchpad } from "@blast-fun/sdk/launchpad";

const client = new SuiGrpcClient({
  network: "testnet",
  baseUrl: "https://fullnode.testnet.sui.io:443",
}).$extend(
  blastLaunchpad({
    packageId: "0x...",
    originalPackageId: "0x...",
    packageVersion: {
      objectId: "0x...",
      initialSharedVersion: "...",
      mutable: false,
    },
    launchConfig: {
      objectId: "0x...",
      initialSharedVersion: "...",
      mutable: false,
    },
    runtimeConfig: {
      objectId: "0x...",
      initialSharedVersion: "...",
      mutable: false,
    },
    protocolAuthority: {
      objectId: "0x...",
      initialSharedVersion: "...",
      mutable: false,
    },
  }),
);

const launch = await client.blastLaunchpad.getLaunch("0x...");
const preview = await client.blastLaunchpad.previewBuy(
  launch.objectId,
  1_000_000_000n,
);

const transaction = client.blastLaunchpad.tx.buy({
  memeType: launch.memeType,
  quoteType: launch.quoteType,
  launch,
  quoteAmount: 1_000_000_000n,
  minMemeOut: preview.memeOutNet,
  recipient: "0x...",
});
```

Every shared-object input is a fully qualified reference with `objectId`,
`initialSharedVersion`, and `mutable`. The SDK validates the expected
mutability for each Move argument. `getLaunch` returns these fields, so its
result can be passed directly as the `launch` transaction input.

## Deployments

`@blast-fun/sdk/deployments` is the single TypeScript registry for Blast
package lineage and singleton shared-object identities. Package entries keep
both the current and original package IDs. Shared-object entries keep the
object ID and initial shared version. Builders add `mutable` from the Move
function signature because mutability belongs to a transaction argument, not
to the object itself.

After a canonical network release is registered, initialize the client without
copying addresses into the application:

```ts
import { blastLaunchpad } from "@blast-fun/sdk/launchpad";
import { blastVesting } from "@blast-fun/sdk/vesting";
import {
  getBlastDeployment,
  launchpadDeployment,
  vestingDeployment,
} from "@blast-fun/sdk/deployments";

const blast = getBlastDeployment("testnet");
const launchpadExtension = blastLaunchpad(launchpadDeployment(blast));
const vestingExtension = blastVesting(vestingDeployment(blast));
```

For local or unreleased deployments, validate one manifest with
`defineBlastDeployment`, then pass it through the matching deployment helper. The
built-in registry remains empty until publish output supplies real IDs; the SDK
does not ship placeholder addresses.

## Migrators

`@blast-fun/sdk/migrators` supports every production migration and LP-fee route
for Bluefin, Cetus, MMT, Turbos, and Aftermath. Route options make
coin order and new-pool or existing-pool selection explicit. Turbos also
requires its `FeeType` and a `bigint` deadline; Aftermath requires a fresh LP
type, `CreatePoolCapV2`, and DAO `Version`. Aftermath builders also expose the
admin-only existing-pool DAO-rate update and permissionless Meme/Quote DAO-fee
receipt through the vault. The accrual builder accepts separate Meme and Quote
vectors with 1 through 100 total fully resolved receiving coin references.
Either vector can be empty.

The migrator client reads `LpVault` objects from BCS, CLMM venue tiers, and the
typed Aftermath weight-and-DAO-fee policy dynamic fields with original package type
identity. If a policy field does not exist, the client returns the documented
compiled default. It does not convert transport failures or corrupt fields into
defaults.

The event reducers require Sui checkpoint, transaction digest, and event index
metadata. Stable replay identity uses transaction digest plus event index;
checkpoint remains ordering metadata. Transaction effects provide package
publication and returned-coin recipient facts. Object ownership reads provide
the current `CurveFeeCap`, `BlastMetadataCap`, and `LpFeeCap` owners. Blast
events do not provide these native facts. Events do record which capability ID
each launch and LP vault currently honors (`curveFeeAuthority`,
`blastMetadataCapId`, `lpFeeAuthority`), including pending migration-born LP-fee
rights, administrator reassignments, and permanent custodian locks.

## Vesting

`@blast-fun/sdk/vesting` supports the independent `linear` and `checkpoints`
modules. It validates creation inputs, builds atomic create-and-share
transactions, decodes live shared objects and their bounded inline checkpoint
vectors, and mirrors vesting math with `bigint`.

```ts
import { blastVesting } from "@blast-fun/sdk/vesting";

const client = new SuiGrpcClient({
  network: "testnet",
  baseUrl: "https://fullnode.testnet.sui.io:443",
}).$extend(
  blastVesting({
    packageId: "0x...",
    originalPackageId: "0x...",
  }),
);

const currentTimestampMs =
  await client.blastVesting.getCurrentTimestampMs();
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

if (position.kind === "checkpoints") {
  const checkpoints = await client.blastVesting.getAllCheckpoints(position);
}
```

The SDK requires 60 seconds between the checked current time and the first
vesting boundary. `getCurrentTimestampMs` reads the authoritative Sui `Clock`;
transaction builders fall back to `Date.now()` when no timestamp is supplied.
Set `minimumLeadTimeMs` explicitly only when the application has a different
submission policy. The contract checks the on-chain `Clock` again during
execution.

## Generated Meme package

`publishMeme` uses the reviewed, compiled Move template. It patches the type
identifiers, metadata, creator recipient, launch policy, and deployed Blast
package dependency. The recipient can be the publisher, another Sui address,
or a provider-independent Blast account. The transaction publishes the module
and immediately makes the package immutable. Its initializer calls
`blast_fun::launch_ticket::new`, so the publisher receives the resulting launch
ticket for the next launch transaction.

```ts
const transaction = client.blastLaunchpad.tx.publishMeme({
  symbol: "DOG",
  name: "Dog Coin",
  description: "A good dog",
  iconUrl: "https://example.com/dog.png",
  burnable: false,
  sellBurnBps: 0n,
  creatorRecipient: { kind: "address", address: "0x..." },
});
```

For a Blast account recipient, pass its 32-byte account commitment instead:

```ts
creatorRecipient: { kind: "account", accountCommitment },
```

An account commitment may identify an unclaimed account created for a future
recipient. The backend binds provider logins to that account by immutable
provider subject ID; mutable handles such as `@name` are display metadata only.
Use `encodeCreatorClaimMessage` for the bytes signed by the creator-claim key,
then wrap its Ed25519 signature with `encodeCreatorClaimAttestation` before
passing it as `accountAttestation` to `claimCreatorCaps`. The claim returns a
`CurveFeeCap` for bonding-curve creator fees and a `BlastMetadataCap` for the
`setName`, `setDescription`, and `setIconUrl` launch metadata builders.
Post-migration creator LP fees use a separate `LpFeeCap` owned by the
migrators package. Each vault's migration leaves that right pending; the live
`CurveFeeCap` holder claims it once with `MigratorTransactions.claimLpFeeCap`,
then uses `claimCreatorFees`. A creator administrator can replace a claimed cap
with `issueLpFeeCap`, but never a pending one: a community takeover reassigns
the launch's `CurveFeeCap` through the launchpad, and its new holder then calls
`claimLpFeeCap`. Migrators also own the shared
`LpFeePolicy` object (`sharedObjects.lpFeePolicy`, required by
`migratorsDeployment`) and emit its LP-fee share events.

Browser builds initialize `@mysten/move-bytecode-template` automatically. If a
bundler cannot locate its WASM asset, call `initializeMemeTemplate` once with
the asset URL before building the transaction.

For lower-level composition, import `buildMemePackageBytecode` from
`@blast-fun/sdk/launchpad/template`. Pass the original Blast package ID as its
second argument; `publishMeme` handles this from the deployment registry.

After publication completes, pass the created ticket ID to `tx.createLaunch`.
This separation is required because a Move initializer transfers the ticket; it
cannot return the ticket to another command in the publish transaction.

`tx` methods return complete transactions that route all returned coins or
capabilities. `call` methods return transaction thunks for programmable
composition. Migration remains under `call` because an approved adapter must
consume the typed payload and returned balances in the same transaction.

All protocol amounts use atomic units. Fee obligations round up to their
recipient. Curve outputs and valuations round down, so the integer remainder
stays with the reserve named by the contract formula. Contract objects and
completed events remain authoritative if transaction history changes after a
preview.

## Integer helpers

The root package exports branded `U64` and `U128` bigint types. The
`requireU64`, `requirePositiveU64`, and `requireU128` validators return these
brands after runtime range checks. Shared helpers provide checked `u64`
addition, basis-point validation, and non-negative multiply-divide with an
explicit rounding direction. Arithmetic remains native `bigint`; computed
results must pass validation again before they regain a Move integer brand.

## Checks

Use Node 22.18 or newer:

```bash
npm install
npm run typecheck
npm test
npm run check:abi
```

The default test suite runs the live ABI comparison when the sibling
`contracts/` checkout is available. `npm run check:abi` is the explicit
cross-repository release gate.

See [docs/launch-economics.md](docs/launch-economics.md) for the endpoint and
valuation formulas. See
[docs/launchpad-abi-coverage.md](docs/launchpad-abi-coverage.md) for the frozen
ABI baseline and the complete SDK coverage matrix.
