# Blast SDK

The SDK mirrors the completed Sui launchpad and migrators ABIs
without becoming a second source of truth for protocol execution.

It provides:

- exact `bigint` buy, sell, allocation, LP-fee split, and valuation
  previews;
- BCS decoding for live `Launch<Meme, Quote>`, `LpVault<Meme, Quote>`,
  `LpFeePolicy`, and holder-reward `Round` objects through the transport-
  neutral Sui Core API;
- executable transactions that start a launch through its migration adapter
  (Cetus or Bluefin), configure and share it, trade, and claim fees;
- complete migration, permissionless LP-fee collection with auto-LP, creator
  LP-fee claims, settled fee-split updates, LP-fee policy administration, and
  holder-reward rounds for Cetus and Bluefin; and
- typed BCS event decoding and deterministic launch-to-vault replay; and
- the standalone `blast_presale` package: creation, commitments, settlement,
  Cetus and Bluefin migration, claims, LP-fee collection, and holder-reward
  rounds, with exact previews and event replay.

See [holder rewards](docs/holder-rewards.md) for holder accounting, Merkle
rounds funded from the vault's rewards share, and permissionless payouts.

## Client extension

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { blastLaunchpad } from "@interest-protocol/blast-sdk/launchpad";

const client = new SuiGrpcClient({
  network: "testnet",
  baseUrl: "https://fullnode.testnet.sui.io:443",
}).$extend(
  blastLaunchpad({
    packageId: "0x...",
    originalPackageId: "0x...",
    adminPackageId: "0x...", // published blast_admin
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

`@interest-protocol/blast-sdk/deployments` is the single TypeScript registry for
Blast package lineage and singleton shared-object identities. Package entries
keep both the current and original package IDs. Shared-object entries keep the
object ID and initial shared version. Builders add `mutable` from the Move
function signature because mutability belongs to a transaction argument, not to
the object itself. `packages.admin` names the published `blast_admin` package,
which owns `acl::sign_in` and is a transitive publish dependency of every
generated Meme package.

After a canonical network release is registered, initialize the client without
copying addresses into the application:

```ts
import { blastLaunchpad } from "@interest-protocol/blast-sdk/launchpad";
import {
  getBlastDeployment,
  launchpadDeployment,
} from "@interest-protocol/blast-sdk/deployments";

const blast = getBlastDeployment("testnet");
const launchpadExtension = blastLaunchpad(launchpadDeployment(blast));
```

For local or unreleased deployments, validate one manifest with
`defineBlastDeployment`, then pass it through the matching deployment helper. The
built-in registry remains empty until publish output supplies real IDs; the SDK
does not ship placeholder addresses.

## Launch creation

A launch starts in its migration adapter (contracts ADR 0089). Publish the
generated Meme package first (see below); its initializer transfers the
`LaunchTicket` to the publisher. A second transaction then runs the whole
construction atomically:

1. `cetus::new` or `bluefin::new` validates the creator's pool tier against its
   venue and calls `launch::new`, which returns a `LaunchInitializer` with no
   abilities. Cetus derives the fee rate from its own registry and reserves the
   pair's pool creation with the Meme type's `PoolCreationCap`; Bluefin checks
   its own tier bounds.
2. `set_graduation_target`, `set_allocation_plan`, `set_lp_fee_split`, and the
   optional `set_protection` record the creator's settings.
3. `launch::finalize` checks every invariant and fixes the supply mode.
4. An optional unprotected `buy` runs on the owned launch before public opening.
5. `launch::share` opens the launch; protection starts now.

```ts
import { blastMigrators } from "@interest-protocol/blast-sdk/migrators";

const transaction = client.blastMigrators.tx.createCetusLaunch({
  memeType,
  quoteType: "0x2::sui::SUI",
  ticket: ticketId,
  memeCurrency, // Coin Registry Currency<Meme>, mutable
  cetusConfig, // Cetus GlobalConfig, immutable
  cetusPools, // Cetus Pools, mutable
  tickSpacing: 200,
  graduationTarget: 3_000_000_000_000n,
  // Blast's allocation (here 500 bps of each asset) is added at finalization.
  allocationPlan: {
    curveMemeBps: 7_000n,
    lpMemeBps: 2_000n,
    lpQuoteBps: 9_000n,
    recipients: [{ destination: teamWallet, memeBps: 500n, quoteBps: 500n }],
  },
  lpFeeSplit: {
    creatorBps: 5_000n,
    autoLpBps: 2_500n,
    rewardsBps: 2_500n,
    burnBps: 0n,
    recipients: [],
  },
  protection: {
    windowMs: 60_000n,
    cumulativeSenderBps: 100n,
    perTransactionBps: 50n,
  },
  preShareBuy: { quoteAmount: 1_000_000_000n, minMemeOut: 1n, recipient },
});
```

`createBluefinLaunch` takes `tickSpacing` and `feeRate` instead of the Cetus
objects. The SDK checks the allocation plan and fee split exactly as the Move
constructors do and rejects shapes they abort on. The creator's plan excludes
Blast: `launch::finalize` inserts the `LaunchConfig` protocol allocation as the
first recipient and requires each asset to sum to 10,000 basis points;
`addProtocolAllocation` previews that step. `deriveLaunchEconomics`,
`apportionMeme`, `apportionQuote`, and `apportionFeeSplit` mirror the
contract's exact apportionment: Blast's migration allocation rounds up, every
other part goes by largest remainder.

## Migrators

`@interest-protocol/blast-sdk/migrators` covers every route of the two shipped
adapters. Cetus orders a pool's coin types by type name, so its builders take
`memeSide: "a" | "b"` and pass the pool's coins in that order after Meme and
Quote, as `<Meme, Quote, CoinA, CoinB>`, to Cetus's single route per operation
(contracts ADR 0100); Bluefin always creates `Pool<Meme, Quote>`.

- Migration is permissionless. Cetus burns the full-range position through
  Cetus LP Burn and takes the mutable `BurnManager`; Bluefin takes its SUI
  pool-creation fee, which `tx.migrateBluefin` pays from gas as an
  exact-balance coin.
- `collectCetusFees` (with the immutable `BurnManager`) and
  `collectBluefinFees` are permissionless. One call collects the position's
  fees, pays Blast's live share from `LpFeePolicy` to its protocol destination,
  and splits the rest into the creator's balance, auto-LP added straight back
  to the pool, the holder-rewards balance, and direct recipients.
  `previewFeeCollection` mirrors that split.
- The launch's live `CurveFeeCap` claims the creator's share
  (`claimCreatorFees`) and commits a new split after settling the current one
  (`settleAndUpdateCetusFeeSplit`, `settleAndUpdateBluefinFeeSplit`). Both take
  the shared `Launch` read-only.
- Administrators change Blast's share per coin or by default and its
  destination (`setLpFeeDefaultShares`, `setLpFeeCoinShares`,
  `clearLpFeeCoinShares`, `setLpFeeProtocolDestination`), claim migration
  residuals (`claimProtocolFees`), and publish holder-reward rounds
  (`publishHolderRewardRound`). Each composes `blast_admin::acl::sign_in` in
  the same transaction.

The client reads `LpVault` objects, the `LpFeePolicy` singleton, a coin's live
LP-fee shares (`getLpFeeShares`: its own pair, else the defaults), and
holder-reward rounds.

The event reducers require Sui checkpoint, transaction digest, and event index
metadata. Stable replay identity uses transaction digest plus event index;
checkpoint remains ordering metadata. Decoders authenticate events by their
type's original package: Sui records the transaction's called package on each
event, and migration emits launchpad events from a migrators entry.
Transaction effects provide package publication and returned-coin recipient
facts. Object ownership reads provide the current `CurveFeeCap` and
`BlastMetadataCap` owners; events record which capability IDs each launch
honors.

## Generated Meme package

`publishMeme` uses the reviewed, compiled Move template. It patches the type
identifiers, decimals, metadata, creator recipient, launch policy, and deployed
Blast package dependency. Launch finalization rejects a symbol longer than 32
bytes, and `LaunchConfig` admits the decimal precision (six and nine
initially), so the SDK rejects a longer symbol before publication. The recipient can be the publisher, another Sui address,
or a provider-independent Blast account. The transaction publishes the module
and immediately makes the package immutable. Its initializer calls
`blast_fun::launch_ticket::new`, so the publisher receives the resulting launch
ticket for the next launch transaction.

```ts
const transaction = client.blastLaunchpad.tx.publishMeme({
  decimals: 9,
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
The same live `CurveFeeCap` claims the creator's post-migration LP fees and
changes the LP-fee split in the migrators package; a creator administrator's
reassignment of the launch's `CurveFeeCap` moves both rights at once.

Browser builds initialize `@mysten/move-bytecode-template` automatically. If a
bundler cannot locate its WASM asset, call `initializeMemeTemplate` once with
the asset URL before building the transaction.

For lower-level composition, import `buildMemePackageBytecode` from
`@interest-protocol/blast-sdk/launchpad/template`. Pass the original Blast
package ID as its second argument; `publishMeme` handles this from the
deployment registry.

After publication completes, pass the created ticket ID to
`MigratorTransactions.createCetusLaunch` or `createBluefinLaunch`. This
separation is required because a Move initializer transfers the ticket; it
cannot return the ticket to another command in the publish transaction.

`tx` methods return complete transactions that route all returned coins or
capabilities. `call` methods return transaction thunks for programmable
composition; `LaunchpadCalls.completeLaunch` applies the settings, finalize,
optional purchase before sharing, and share to any adapter's initializer.

All protocol amounts use atomic units. Fee obligations round up to their
recipient. Curve outputs and valuations round down, so the integer remainder
stays with the reserve named by the contract formula. Contract objects and
completed events remain authoritative if transaction history changes after a
preview.

## Presale

`@interest-protocol/blast-sdk/presale` builds every product route of the
unpublished `blast_presale` package. It previews creation, commitments, and
claims exactly as the contract enforces them, and it decodes and replays the
package's objects and events. See [docs/presale.md](docs/presale.md).

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
