# Blast SDK

The SDK mirrors the Sui launchpad and migrators ABIs of contracts commit
`442116a0a1b82c6b4a64dc55fa0de430322f4bb7` without becoming a second source of
truth for protocol execution. See
[launchpad ABI coverage](docs/launchpad-abi-coverage.md).

It provides:

- exact `bigint` buy, sell, allocation, LP-fee split, protocol-claim, and
  valuation previews, plus the display economics (curve price, live supply,
  market cap, progress) the blast-infra indexer shares through pinned vectors;
- BCS decoding for live `Launch<Meme, Quote>`, `LpVault<Meme, Quote>`,
  `LpFeePolicy`, and holder-reward `Round` objects through the transport-
  neutral Sui Core API;
- executable transactions that publish a Meme, register its currency, start a
  launch through its migration adapter, configure and share it, run its
  opening round, trade, and claim fees, with explicit returned-object routing
  and readers for the objects each step's effects create;
- complete migration, permissionless LP-fee collection with auto-LP, creator
  LP-fee claims, settled fee-split updates, LP-fee policy administration, and
  holder-reward rounds for Cetus and Bluefin; and
- typed BCS event decoding and deterministic launch-to-vault replay.

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
    partnersPackageId: "0x...", // published blast_partners
    timelockPackageId: "0x...", // published blast_fun_timelock
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
    acl: {
      // the singleton blast_admin::blast_acl::ACL
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

`@interest-protocol/blast-sdk/deployments` is the single deployment import for
every runtime. A manifest is the normalized runtime identity: schema version,
environment (`production` names mainnet; `non-production` never does), network
and chain identifier (the genesis checkpoint digest the Core API reports; mainnet
and testnet must carry their own, and no other network may carry either),
explorer, current and original package IDs (launchpad,
`blast_admin`, `blast_partners`, `blast_fun_timelock`, and optionally migrators
and Blast SUI), shared-object IDs and initial versions, migration routes and
their tiers, the contracts commit and ABI artifact digests it was built from,
release transaction digests, the SDK version and commit, and post-deploy
evidence. `defineBlastDeployment` validates and freezes one manifest;
`deploymentFingerprint` hashes its identity-bearing fields.

Every consumer calls `evaluateProtocolAccess` before building or signing a
protocol transaction:

```ts
import {
  defineBlastDeployment,
  evaluateProtocolAccess,
  launchpadDeployment,
  observeDeploymentRuntime,
} from "@interest-protocol/blast-sdk/deployments";
import { blastLaunchpad } from "@interest-protocol/blast-sdk/launchpad";

const deployment = defineBlastDeployment(manifest);
const runtime = await observeDeploymentRuntime(client, deployment);
const access = evaluateProtocolAccess({ manifest, mode: "production", runtime });
if (access.signing === "enabled") {
  client.$extend(blastLaunchpad(launchpadDeployment(access.deployment)));
}
```

It never throws for an identity problem. Any core reason disables signing (see
`DeploymentRejectionCode`): an invalid manifest (including a chain identifier
that contradicts the network), an environment mismatch, fixture identities in
production, an unreleased or foreign-lineage deployment, an ABI mismatch, an
unsupported route, a private or unversioned SDK (`sdk-unreleased`), an SDK
other than the one that validated the manifest (`sdk-mismatch`), post-deploy
evidence missing, a missing or malformed runtime observation
(`runtime-unverified`), or a runtime chain or shared-object mismatch. `BLAST_DEPLOYMENTS` is empty and this SDK
build is private and unversioned (`SDK_RELEASE`), so production signing stays
disabled until a real release registers both. Quick presets (`QUICK_PRESETS`,
empty) bind to one deployment fingerprint and an SDK version range, and
`resolveQuickPreset` returns values only while access is enabled for that exact
deployment.

### Venue sets and per-venue availability

Each enabled venue records its package lineage and every shared object that
creating, migrating, and trading a launch on it needs, as one set
(`VENUE_IDENTITY_SETS`):

| Venue | Packages (current revision and original) | Shared objects |
| --- | --- | --- |
| Cetus | `cetusClmm` (Cetus CLMM), `cetusLpBurn` (Cetus LP Burn) | `cetusConfig` (`config::GlobalConfig`), `cetusPools` (`factory::Pools`), `cetusBurnManager` (`lp_burn::BurnManager`) |
| Bluefin | `bluefinSpot` (Bluefin Spot) | `bluefinConfig` (`config::GlobalConfig`) |

A set is all or nothing: any partial set is `invalid-manifest`, which
disables every action. `evaluateProtocolAccess` returns `venues`, one entry
per venue, on enabled and disabled results alike. `signing: "enabled"` covers
the core actions (curve trades, opening rounds, publication, and creation's
core checks). **An action on a venue (creating, migrating, or trading a
launch on it) requires `signing: "enabled"` and `venues[venue].available`.**

- Core reasons stay global and mark both venues unavailable with them: every
  existing reason above, including a chain mismatch and any shared object's
  ID or initial-version mismatch, venue objects included.
- Venue reasons disable only that venue: no recorded set (`venue-unrecorded`),
  a set without a route (`venue-not-routed`), or a recorded venue object that
  the runtime did not observe (`runtime-unverified`) or observed with another
  type (`runtime-mismatch`) or lineage (`foreign-lineage`).

`resolveVenueObjects(access, venue)` returns that venue's builder inputs,
grouped by action at the mutability each call takes (`create`, `migrate`,
`fees`, `buyback`), and throws `VenueUnavailableError` with the venue's
reasons otherwise. `getBluefinPoolCreationFee(client, deployment)` reads the
exact SUI pool-creation fee, in MIST, that `bluefin::migrate` requires: the
recorded Bluefin `GlobalConfig`'s `"pool_creation_fee"` `Table<String, u64>`
entry for SUI. A missing config, field, or entry, an unexpected type, or a
config of another lineage is a `BluefinPoolCreationFeeError`; there is no
default.

## Launch creation

A launch starts in its migration adapter (contracts ADR 0089) after three
transactions:

1. `tx.publishMeme` publishes the generated Meme package against its whole
   dependency closure. `readMemePublication` reads the Meme type, the
   `LaunchTicket` its initializer transferred to the publisher, and the
   `Currency<Meme>` sent to the Coin Registry.
2. `tx.finalizeCurrencyRegistration` shares that currency;
   `readCurrencyRegistration` returns its shared reference.
3. `createCetusLaunch` or `createBluefinLaunch` runs the whole construction
   atomically: the adapter's `new` returns a `LaunchInitializer`;
   `set_virtual_quote`, `set_graduation_target`, `set_allocation_plan`,
   `set_lp_fee_split`, and the optional `set_opening_round` and `set_partner`
   record the creator's settings; `launch::finalize` takes the exact
   `LaunchConfig` creation fee in SUI; then the creator's optional purchase
   (without an opening round) or bid (with one) runs on the owned launch before
   `launch::share`. `readLaunchCreation` returns the shared launch.

```ts
const transaction = client.blastMigrators.tx.createBluefinLaunch({
  memeType,
  quoteType: "0x2::sui::SUI",
  ticket: ticketId,
  memeCurrency, // shared Currency<Meme>, mutable
  tickSpacing: 200,
  feeRate: 10_000n,
  virtualQuote: 3_000_000_000_000n,
  graduationTarget: 12_000_000_000_000n,
  creationFee: (await client.blastLaunchpad.getLaunchConfig()).creationFee,
  // Blast's allocation is stored from LaunchConfig at finalization.
  allocationPlan: {
    curveMemeBps: 7_000n,
    lpMemeBps: 2_000n,
    lpQuoteBps: 9_500n,
    recipients: [{ destination: teamWallet, memeBps: 250n, quoteBps: 250n }],
  },
  lpFeeSplit: {
    creatorBps: 5_000n,
    autoLpBps: 2_500n,
    rewardsBps: 2_500n,
    burnBps: 0n,
    recipients: [],
  },
  openingRoundMs: 60_000n,
  creatorBid: { quoteAmount: 1_000_000_000n },
});
```

During the opening round anyone joins the pot (`joinOpeningRound`); after it
ends anyone settles it with one curve purchase (`settleOpeningRound`) and
delivers each bidder's pro-rata Meme and refund (`deliverOpeningRound`), which
the contract transfers to the bidder. The SDK checks the allocation plan and
fee split exactly as the Move constructors do. `addProtocolAllocation` previews
the protocol shares `launch::finalize` stores; `deriveLaunchEconomics`,
`apportionMeme`, `apportionQuote`, and `apportionFeeSplit` mirror the
contract's exact apportionment: Blast's migration allocation rounds up and
accrues to the launch's protocol fees at migration, every other part goes by
largest remainder. `previewProtocolFeeClaim` mirrors the partner's share of a
protocol-fee claim.

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
  (`publishHolderRewardRound`). Each composes `blast_admin::blast_acl::sign_in`
  with the one typed role the action takes (`FeeAdmin`, `TreasuryAdmin`,
  `BuybackAdmin`, or `RewardsAdmin`) in the same transaction.

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

### Trading a migrated launch on Cetus or Bluefin

Cetus and Bluefin Spot are the two post-migration venues the SDK trades
through, each with one adapter of the same shape. A launch trades only on the
venue its migration recorded; the caller never picks another. The Cetus adapter
(`src/migrators/cetus-venue.ts`) never trusts a caller-supplied pool:

1. `getCetusPool` reads a Cetus `pool::Pool`; `resolveCetusVenueRoute` accepts
   it only as the pool the launch's `LpVault` recorded, of the deployment's
   Cetus lineage, for the launch's coins and recorded tier, which the
   deployment's `routes` must admit. The manifest records Cetus as one venue
   set (see Deployments); `evaluateProtocolAccess` checks each object's type
   against that lineage and reports `venues.cetus`.
2. `quoteCetusSwap` asks any `CetusQuoteTransport` for one exact-input quote,
   and `normalizeCetusQuote` states it in atoms: input, output,
   `minimumOut = floor(out * (10,000 - slippageBps) / 10,000)`, fee, exact
   prices before and after, impact, expiry, sender, and balances.
3. `buildCetusSwapTransaction` refuses disabled signing, an unavailable Cetus
   venue (`venue-unavailable`), another deployment,
   foreign lineage, an unadmitted tier, a substituted route, an expired or
   future-dated quote, or inconsistent amounts. It builds `pool::flash_swap`, repays exactly
   `amountIn`, and aborts below `minimumOut`.
4. `reconcileCetusSwap` turns the executed or simulated transaction's single
   `SwapEvent` in that pool into exact trade facts, and refuses anything else.

Every error is a `CetusVenueError` whose `code` names the failed check.

The Bluefin adapter (`src/migrators/bluefin-venue.ts`) mirrors it one for one:
`getBluefinPool` and `decodeBluefinPoolObject` (the whole `pool::Pool` layout,
trailing bytes refused), `decodeBluefinSwapEvent` (`events::AssetSwap`),
`resolveBluefinVenueRoute` (the vault's `Pool<Meme, Quote>` of the
deployment's `bluefinSpot` lineage at an admitted Bluefin tier),
`quoteBluefinSwap` with any `BluefinQuoteTransport` and
`normalizeBluefinQuote` (which also refuses a paused pool),
`buildBluefinSwapTransaction`, `reconcileBluefinSwap`, `bluefinVenuePrice`,
`bluefinVenueTrade`, and `BluefinVenueError` with the same codes. Bluefin
always holds the Meme as coin A, so a buy is `a2b = false`. The builder calls
`pool::swap` once with the exact input, `minimumOut` as its `amount_limit`
(Bluefin aborts below it), and the contracts' swap price limit; it destroys
the zero input remainder and sends the output to the sender.
`reconcileBluefinSwap` accepts exactly one `AssetSwap` in the route's pool and
refuses a `FlashSwap` there.

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

After publication completes, read the ticket and pending currency with
`readMemePublication`, share the currency with `finalizeCurrencyRegistration`,
then pass the ticket ID to `MigratorTransactions.createCetusLaunch` or
`createBluefinLaunch`. This separation is required because a Move initializer
transfers the ticket; it cannot return the ticket to another command in the
publish transaction.

`tx` methods return complete transactions that route all returned coins or
capabilities. `call` methods return transaction thunks for programmable
composition; `LaunchpadCalls.completeLaunch` applies the settings, finalize
with the creation fee, the creator's optional purchase or opening-round bid
before sharing, and share to any adapter's initializer.

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

## Display economics

`curvePrice`, `formatPrice`, `formatPriceRational`, `liveSupply`,
`applyLiveSupplyChange`, `marketCap`, and `launchProgressBps` are the exact
`bigint` formulas the blast-infra indexer serves under `/v1`. `npm test` runs
every `curve_price`, `venue_price` (through `cetusVenuePrice`, and through
`bluefinVenuePrice` for each Meme-is-coin-A case), `venue_trade` (through
`cetusVenueTrade`, and `bluefinVenueTrade` likewise), `live_supply`,
`market_cap`, and
`progress` case of
`test/vectors/market-data.json`, the file blast-infra pins by SHA-256
`1fd14d23e58b6f5901b55adbf1327b39a185ad3d77a4f415f3a56df87ce5c2d4`, and refuses
a copy that differs from that pin. Update the vectors only by vendoring the file
and its pin together in both repositories.

## Checks

Use Node 22.18 or newer:

```bash
npm install
npm run typecheck
npm test
BLAST_CONTRACTS_DIR=../contracts npm run check:abi
```

`npm run check:abi` extracts the frozen contracts commit with `git archive` from
the contracts repository (`BLAST_CONTRACTS_DIR`, default `../contracts`) and
compares its `sui move summary` with `abi/` using the pinned Sui CLI; the
contracts working tree and branch do not matter. The default test suite runs the
same comparison when that repository contains the commit.

See [docs/launch-economics.md](docs/launch-economics.md) for the endpoint and
valuation formulas. See
[docs/launchpad-abi-coverage.md](docs/launchpad-abi-coverage.md) for the frozen
ABI baseline and the complete SDK coverage matrix.
