# Blast SDK monorepo

Canonical contract source and generated Move references live in
[interest-protocol/blast-v2-contracts](https://github.com/interest-protocol/blast-v2-contracts).
The canonical MVR mainnet bindings use source metadata commit
[`52effbc`](https://github.com/interest-protocol/blast-v2-contracts/tree/52effbcee5f12b727484ba0bb14f96aa5e2b4786/sui).
The production Move implementation and frozen ABI remain at reviewed commit
[`9255e78`](https://github.com/interest-protocol/blast-v2-contracts/tree/9255e78751b70b22d8f33cc6577df126a3434424/sui).

This npm workspace contains independently publishable SDK packages. The root is
private; `packages/blast-sdk` preserves the original `@interest-protocol/blast-sdk`
package, including its root export and every existing subpath. Existing users
can keep their imports. New users can install only the SDK they need:

```sh
npm install @interest-protocol/blast-presale-sdk@0.1.0 @interest-protocol/blast-deployments-sdk@0.1.0 @mysten/sui@2.26.2 @mysten/move-bytecode-template@0.4.1
```

```ts
import { PresaleClient } from "@interest-protocol/blast-presale-sdk";
// The existing import still works:
import { PresaleClient as LegacyPresaleClient } from "@interest-protocol/blast-sdk/presale";
```

| Directory | npm package | Purpose |
| --- | --- | --- |
| `packages/core` | `@interest-protocol/blast-core` | Shared primitives, integer math, transaction utilities, and reward accounting |
| `packages/admin` | `@interest-protocol/blast-admin-sdk` | ACL reads and administrator transactions |
| `packages/blast-sui` | `@interest-protocol/blast-sui-sdk` | blastSUI reads, previews, and transactions |
| `packages/boosts` | `@interest-protocol/blast-boosts-sdk` | Boosts products and transactions |
| `packages/coin` | `@interest-protocol/blast-coin-sdk` | Standalone Sui coin creation |
| `packages/cctp` | `@interest-protocol/blast-cctp-sdk` | EVM USDC deposit parameters and ABIs |
| `packages/launchpad` | `@interest-protocol/blast-launchpad-sdk` | Launch creation, trading, economics, and events |
| `packages/presale` | `@interest-protocol/blast-presale-sdk` | Presale creation, commitments, migration, and claims |
| `packages/migrators` | `@interest-protocol/blast-migrators-sdk` | Venue pool creation, launch migrations, and vaults |
| `packages/partners` | `@interest-protocol/blast-partners-sdk` | On-chain partner administration and payment previews |
| `packages/deployments` | `@interest-protocol/blast-deployments-sdk` | Deployment identity, protocol access, and venue readers |
| `packages/holder-rewards` | `@interest-protocol/blast-holder-rewards-sdk` | Reward accounting and operator workflows |
| `packages/partner-client` | `@interest-protocol/blast-partner-client` | Authenticated REST read client; no runtime dependencies |
| `packages/blast-sdk` | `@interest-protocol/blast-sdk` | Compatible root and subpath exports for existing consumers |

The REST partner client is separate from the on-chain partners SDK. Venue
readers live in the deployments SDK (`/bluefin-venue` and `/cetus-venue`);
the existing `blast-sdk/migrators` entry point continues to export them.
Packages import each other through declared package exports. Shared reward
primitives and migration math live in core to keep the dependency graph acyclic.

## Workspace development and releases

Run installation and checks from the repository root. The root lockfile is the
single dependency lock for every workspace:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run check:package
```

`build` runs workspaces sequentially in dependency order. Build the workspace
once before running a focused check, for example
`npm test --workspace @interest-protocol/blast-partner-client` or
`node --test --test-concurrency=1 test/presale-math.test.ts`. Tests and operational
tools use the built package exports. Formatting, linting, typechecking, and
package checks include the REST client as well as the on-chain SDKs.

`check:package` validates every package with publint and Are the Types Wrong,
then installs their tarballs into a temporary consumer outside the workspace.
It checks every original SDK entry point against the pre-migration export
snapshot (ESM and Node `require()`), verifies re-export identity, and compiles all
1,519 original public symbol imports along with a
TypeScript consumer. It also checks declared dependencies and build order.

Each public workspace owns its version, dependencies, export map, and publish
configuration. Internal dependency versions are ordinary npm versions so packed
packages work without workspace resolution. Before a release, assign real
versions to the packages being released and update affected internal dependency
ranges, regenerate the root lockfile, then run `npm run check` with the pinned
contracts checkout and Sui CLI. Publish dependencies before their dependants
in the order listed in the root `workspaces` array, using
`npm publish --workspace <package-name>`. A change to a product used by the
compatibility package also requires updating that package's dependency range.
The root itself cannot be published. The first on-chain SDK release is `0.1.0`;
its `SDK_RELEASE` stamp records the validated source commit. The REST client's
MIT license applies only to that package; see its release documentation.

## Canonical mainnet bindings

These sources bind the 2026-10-28 canonical MVR publication, which supersedes
the earlier deployment shipped in npm `0.1.0`. The deployments and compatible
SDK packages ship as `0.1.3`; `0.1.2` registered the mainnet deployment
(`BLAST_DEPLOYMENTS.mainnet`, every Cetus and Bluefin tier), and `0.1.3` adds the
composable `LaunchpadCalls.finalizeCurrencyRegistration` (launchpad `0.1.1`, with
migrators, presale and holder-rewards `0.1.1` re-pinned to it). The other product
packages retain `0.1.0` because their ABI and implementation are unchanged:

- Presale: `0xb0279fbe54bfd1d920e985a4dba0916b2b73a5218514edeecb7b9dd30cf2863b`
- Launchpad (bonding curve): `0x079a1b44c551613cbc63cc0406f8ff8d717407378dd6f17d43d9e1b3fd63a573`

The [verified deployment record](https://github.com/interest-protocol/blast-v2-contracts/blob/390daf87bf42e4da40804d98c7fad64157967d80/deployments/sui/mainnet/2026-10-28-canonical-mvr-launch-stack.json)
contains the five new package IDs, eleven SDK shared objects, three upgrade
custody objects and their initial sharing versions. The immutable timelock
dependency retains its existing identity. The public documentation and npm
`0.1.0` describe the earlier publication; use `0.1.3` for these canonical bindings.

Use the call-ready constants from `@interest-protocol/blast-deployments-sdk`
(or the compatible `@interest-protocol/blast-sdk/deployments` export):

```ts
import {
  MAINNET_LAUNCHPAD_DEPLOYMENT,
  MAINNET_MIGRATORS_DEPLOYMENT,
  getPresaleDeployment,
} from "@interest-protocol/blast-deployments-sdk";
import { LaunchpadCalls } from "@interest-protocol/blast-launchpad-sdk";
import { PresaleCalls } from "@interest-protocol/blast-presale-sdk";

const launchpad = new LaunchpadCalls(MAINNET_LAUNCHPAD_DEPLOYMENT);
const presale = new PresaleCalls(getPresaleDeployment("mainnet"));
```

The deployment package also exports `MAINNET_ADMIN_DEPLOYMENT`,
`MAINNET_PARTNERS_DEPLOYMENT`, `MAINNET_PRESALE_DEPLOYMENT`,
`CANONICAL_MAINNET_PACKAGES`, and `CANONICAL_MAINNET_SHARED_OBJECTS`.
Bindings include the matching ACL, partners, timelock and migrators, and all
initial shared versions, including the activated version singletons.
`npm run check:mainnet` verifies deployed interfaces and object identities.

To resolve package addresses through MVR, use the installed Sui client's cached
resolver:

```ts
import { resolveMainnetDeployments } from "@interest-protocol/blast-deployments-sdk";
import { LaunchpadCalls } from "@interest-protocol/blast-launchpad-sdk";
import { PresaleCalls } from "@interest-protocol/blast-presale-sdk";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io:443",
});
const deployments = await resolveMainnetDeployments(client);
const launchpad = new LaunchpadCalls(deployments.launchpad);
const presale = new PresaleCalls(deployments.presale);
```

`CANONICAL_MAINNET_MVR_NAMES` records the five `@blastpackages/<package>/1`
names. Resolution verifies the reviewed package identities and rejects missing
or mismatched results; it does not silently fall back to static addresses.
Shared object IDs, initial sharing versions and original type identities stay
bound to the deployment record. An unversioned MVR name follows native package
upgrades, which can precede Blast's separate operational activation. A reviewed
SDK release must update both the pin and deployment evidence before adopting
an upgrade. See [Mysten's MVR client API](https://sdk.mystenlabs.com/sui/clients/querying#mvr).

Package publication and custody do not attest to product configuration or venue
readiness. `BLAST_DEPLOYMENTS` remains empty until product rollout verification
is complete; `evaluateProtocolAccess` therefore continues to reject production
signing. Standalone bindings construct calls with the canonical identities;
live policies determine whether an operation is admitted.

## Compatible Blast SDK


The SDK mirrors the frozen Sui ABIs of every Blast package without becoming a
second source of truth for protocol execution. See
[launchpad ABI coverage](docs/launchpad-abi-coverage.md) for the frozen
contracts commits.

```sh
npm install @interest-protocol/blast-sdk@0.1.0 @mysten/sui@2.26.2 @mysten/move-bytecode-template@0.4.1
```

The package is ESM with TypeScript declarations and has no Node, browser, or
storage dependencies of its own: it runs on Node 22+, browsers, edge workers,
and other runtimes with ES2023, `BigInt`, and `TextEncoder`. Node 22.12+ can
also `require()` it. Workflows that need durable state, such as the
holder-rewards operator, take a store you implement.

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
- typed BCS event decoding and deterministic launch-to-vault replay;
- the standalone `blast_presale` package: creation, commitments, settlement,
  Cetus and Bluefin migration, vaults for an owner's own position, Aftermath
  DAO-pool migration through the partner's vendor package, claims, LP-fee
  collection, and holder-reward rounds, with exact previews and event replay;
- operator transactions for every administrator action: the shared
  `blast_admin` ACL (admins, roles, the timelocked root transfer), the
  `LaunchConfig` and `RuntimeConfig` setters, creator-cap reassignment,
  LP-fee policy, buybacks, and the blastSUI redeem fee, each signed in with its
  typed role in the same transaction; and
- the `blast_partners` package: partner caps, registration, timelocked share
  and cap schedules, recipients, payment previews, and replay; and
- standalone coins from the coin template (`@interest-protocol/blast-sdk/coin`):
  a plain Sui coin with no Blast dependency.

The `@interest-protocol/blast-sdk/cctp` entry point adds viem-compatible
parameters and typed factory/forwarder ABIs for EVM USDC deposits to Sui.
See [CCTP deposits](docs/cctp.md) for reads, forwarding and events.

See [holder rewards](docs/holder-rewards.md) for holder accounting, Merkle
rounds funded from the vault's rewards share, and permissionless payouts.

## Client extension

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { blastLaunchpad } from "@interest-protocol/blast-sdk/launchpad";

const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io:443",
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
    partnersPackageId: "0x...", // published blast_partners
    timelockPackageId: "0x...", // published immutable blast_fun_timelock
    packageVersion: { objectId: "0x...", initialSharedVersion: "..." },
    launchConfig: { objectId: "0x...", initialSharedVersion: "..." },
    runtimeConfig: { objectId: "0x...", initialSharedVersion: "..." },
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

A deployment's shared singletons are identities (`objectId`,
`initialSharedVersion`); each call adds the mutability its Move signature
needs. Every per-call shared-object input is a fully qualified reference that
also carries `mutable`, and the SDK validates it against the Move argument.
`getLaunch` returns these fields, so its result can be passed directly as the
`launch` transaction input.

## Deployments

`@interest-protocol/blast-sdk/deployments` is the single deployment import for
every runtime (web, indexer, keeper). A manifest is the normalized runtime
identity: schema version, environment (`production` may sign; `non-production`
never can), network and chain identifier (Blast runs on Sui mainnet only, so
every manifest names mainnet and carries its genesis checkpoint digest as the
Core API reports it), explorer, every published package with its current and
original package IDs (`timelock`, `admin`, `partners` and `launchpad` always;
`migrators`, `presale`, `blastSui` and a venue's packages when recorded),
shared-object IDs and initial versions grouped by the package that owns them,
migration routes and their tiers, the contracts commit and ABI artifact
digests it was built from, release transaction digests, the SDK version and
commit, and post-deploy evidence. The `launch_ticket_template` and
`coin_template` packages have no entry: each launch publishes its own Meme
package from the launch ticket template's bytecode, linking the timelock,
admin, partners and launchpad packages, and each standalone coin publishes its
own package from the coin template's.

Each shared object therefore has one owner-qualified path: `admin.acl`;
`launchpad.packageVersion`, `launchConfig`, `runtimeConfig`;
`migrators.packageVersion`, `lpFeePolicy`, `venueConfig`;
`presale.packageVersion`, `venueConfig`, `creationPolicy`, `feePolicy`;
`blastSui.packageVersion`, `vault`; and each venue's own group (`cetus.config`,
`cetus.pools`, `cetus.burnManager`, `bluefin.config`). A group is recorded
exactly when the package that owns it is, and every key in a recorded group is
required. Builders add `mutable` from the Move function signature, because
mutability belongs to a transaction argument and not to the object itself.

`defineBlastDeployment` validates and freezes one manifest;
`deploymentFingerprint` hashes its identity-bearing fields;
`observeDeploymentRuntime` reports what a node sees, keyed by those same
paths. `adminDeployment`, `partnersDeployment`, `launchpadDeployment`,
`migratorsDeployment`, `presaleDeployment` and `blastSuiDeployment` derive each
product's call-ready deployment, and each refuses a package the manifest does
not record. The presale publishes on its own (contracts ADR 0099), so
`BLAST_PRESALE_DEPLOYMENTS` and `getPresaleDeployment` can register a standalone
release before a complete `BlastDeployment` exists. The versioned ABI currently
requires an explicit fresh deployment with PackageVersion from activation.

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

For an unreleased mainnet deployment, validate one manifest with
`defineBlastDeployment`, then pass it through the matching deployment helper. The
built-in registry remains empty until publish output supplies real IDs; the SDK
does not ship placeholder addresses.

It never throws for an identity problem. Any core reason disables signing (see
`DeploymentRejectionCode`): an invalid manifest (including any network but
mainnet, or a chain identifier that is not mainnet's genesis digest), an
environment mismatch, fixture identities in
production, an unreleased or foreign-lineage deployment, an ABI mismatch, an
unsupported route, a private or unversioned SDK (`sdk-unreleased`), an SDK
other than the one that validated the manifest (`sdk-mismatch`), post-deploy
evidence missing, a missing or malformed runtime observation
(`runtime-unverified`), or a runtime chain or shared-object mismatch.
`BLAST_DEPLOYMENTS` is empty, so production signing stays
disabled until a reviewed deployment is registered and runtime-verified. The
published SDK identity is recorded in `SDK_RELEASE`. Quick presets (`QUICK_PRESETS`,
empty) bind to one deployment fingerprint and an SDK version range, and
`resolveQuickPreset` returns values only while access is enabled for that exact
deployment.

### Venue sets and per-venue availability

Each enabled venue records its package lineage and every shared object that
creating, migrating, and trading a launch on it needs, as one set
(`VENUE_IDENTITY_SETS`):

| Venue | Packages (current revision and original) | Shared objects |
| --- | --- | --- |
| Cetus | `cetusClmm` (Cetus CLMM), `cetusLpBurn` (Cetus LP Burn) | `cetus.config` (`config::GlobalConfig`), `cetus.pools` (`factory::Pools`), `cetus.burnManager` (`lp_burn::BurnManager`) |
| Bluefin | `bluefinSpot` (Bluefin Spot) | `bluefin.config` (`config::GlobalConfig`) |

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

Presale publishes independently. Its versioned ABI requires a fresh package and
activation before a preset can be registered. Pass an explicit deployment with
`packageVersion` from activation effects. The existing unversioned mainnet
package remains available through the preceding SDK revision.

The opt-in [live presale verification](docs/presale-live-verification.md) checks
all builders against the versioned test deployment and distinguishes validated
simulation, Move inspection and construction-only coverage.

## Launch creation

A launch starts in its migration adapter (contracts ADR 0089) after three
transactions:

1. `tx.publishMeme` publishes the generated Meme package against its whole
   dependency closure. `readMemePublication` reads the Meme type, the
   `LaunchTicket` its initializer transferred to the publisher, and the
   `Currency<Meme>` sent to the Coin Registry.
2. `tx.finalizeCurrencyRegistration` shares that currency;
   `readCurrencyRegistration` returns its shared reference. Its
   `call.finalizeCurrencyRegistration` form registers several Memes in one PTB.
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
  openingRoundMs: 60_000n, // optional: zero or 60,000 to 300,000
  partner, // optional: a Blast partner LaunchConfig accepts, fixed for good
  // With an opening round the creator bids into the same pot.
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

`createBluefinLaunch` takes `tickSpacing` and `feeRate` instead of the Cetus
objects. The creator's plan names up to sixteen recipients and excludes Blast:
`launch::finalize` sets the plan's `protocolMemeBps` and `protocolQuoteBps`
from the `LaunchConfig` protocol allocation and requires each asset to sum to
10,000 basis points. At migration Blast's shares accrue as its one-time fee in
the launch's fee ledger (`ProtocolFeesAccrued`).

Anyone may claim Blast's Meme, Quote, and SUI (creation-fee) balances with
`claimProtocolFees`; no admin cap is needed, and the contract pays them to the
`RuntimeConfig` treasury, never to the sender. When the launch names a partner
(`LaunchState.partnerId`), pass that `partner`: the SDK then calls
`claim_protocol_fees_with_partner`, which pays the partner its share of each
balance in the same call. A `TreasuryAdmin` rotates the treasury with
`setTreasury`.

## Migrators

`@interest-protocol/blast-sdk/migrators` covers every route of the two shipped
adapters. Cetus orders a pool's coin types by type name, so its builders take
`memeSide: "a" | "b"` and pass the pool's coins in that order after Meme and
Quote, as `<Meme, Quote, CoinA, CoinB>`, to Cetus's single route per operation
(contracts ADR 0100); Bluefin always creates `Pool<Meme, Quote>`.

- Migration is permissionless. Cetus burns the full-range position through
  Cetus LP Burn and takes the mutable `BurnManager`; Bluefin takes its SUI
  pool-creation fee, which `tx.migrateBluefin` pays as an exact-balance SUI
  coin (see [SUI payments and sponsored gas](#sui-payments-and-sponsored-gas)).
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
  (`publishHolderRewardRound`). Each composes
  `blast_admin::blast_acl::sign_in<Role>` in the same transaction with the one
  typed `blast_fun_domain` role its Move function takes (contracts ADR 0097):
  `FeeAdmin` for LP-fee shares, `TreasuryAdmin` for the destination and every
  protocol claim, `BuybackAdmin` for buybacks, and `RewardsAdmin` for rounds.
  The `AdminCap` must hold that role.

The launchpad client reads launches, the `LaunchConfig` singleton
(`getLaunchConfig`: creation fee, trade fees, Blast's allocation), and a
bidder's undelivered opening-round bid (`getOpeningRoundBid`). The migrators
client reads `LpVault` objects, the `LpFeePolicy` singleton, a coin's live
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
(`packages/deployments/src/cetus-venue.ts`) never trusts a caller-supplied pool:

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

The Bluefin adapter (`packages/deployments/src/bluefin-venue.ts`) mirrors it one for one:
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

## Administration

`@interest-protocol/blast-sdk/admin` builds the shared `blast_admin::blast_acl`
calls. The root `SuperAdminCap` grants and revokes `AdminCap`s and their
roles (`grantAdmin`, `revokeAdmin`, `grantRole`, `revokeRole`) and nominates
its successor, who accepts after seven days (`beginSuperAdminTransfer`,
`cancelSuperAdminTransfer`, `acceptSuperAdminTransfer`,
`destroyRetiredSuperAdminCap`); an administrator can delete its own cap
(`destroyAdminCap`). A role is a Move type its consumer package declares, so
each product names its own with `roleType`:

```ts
import { AdminTransactions } from "@interest-protocol/blast-sdk/admin";

const admin = new AdminTransactions(adminDeployment(blast));
const launchpad = new LaunchpadTransactions(launchpadDeployment(blast));
const grant = admin.grantRole({
  superAdminCapId,
  adminCapId,
  role: launchpad.call.roleType("FeeAdmin"),
});
```

Every administrator transaction signs in with
`blast_acl::sign_in<Role>` and makes its call in the same PTB; the `AdminCap`
must hold that role:

| Package | Transactions | Role |
| --- | --- | --- |
| launchpad `LaunchConfig` | `setTradeFees`, `setCreationFee`, `addPartner`, `removePartner` | `FeeAdmin` |
| launchpad `LaunchConfig` | `setProtocolAllocation` | `TreasuryAdmin` |
| launchpad `LaunchConfig` | `setQuoteAllowed`, `setMemeDecimalsAllowed` | `ListingAdmin` |
| launchpad `LaunchConfig` | `setMigrationWitnessAllowed` | `AdapterAdmin` |
| launchpad `RuntimeConfig` | `setProtocolFeeShare` | `FeeAdmin` |
| launchpad `RuntimeConfig` | `setCreatorClaimSigner` | `ClaimSignerAdmin` |
| launchpad `RuntimeConfig` | `setTreasury` | `TreasuryAdmin` |
| launchpad `Launch` | `reassignCurveFeeCap`, `reassignMetadataCap` | `CreatorAdmin` |
| migrators | `setLpFeeDefaultShares`, `setLpFeeCoinShares`, `clearLpFeeCoinShares` | `FeeAdmin` |
| migrators | `setLpFeeProtocolDestination`, `claimProtocolFees` | `TreasuryAdmin` |
| migrators | `buybackAndBurnCetus`, `buybackAndBurnBluefin` | `BuybackAdmin` |
| migrators | `publishHolderRewardRound` | `RewardsAdmin` |
| presale | `setProtocolFees`, `setPresaleProtocolFees`, `setProtocolLpFees`, `addPartner`, `removePartner` | `blast_presale_domain::FeeAdmin` |
| presale | `setProtocolDestination` | `blast_presale_domain::TreasuryAdmin` |
| presale | `setQuoteAllowed` | `blast_presale_domain::ListingAdmin` |
| presale | `setMigrationWitnessAllowed` | `blast_presale_domain::AdapterAdmin` |
| presale | `publishHolderRewardRound`, `publishHolderRewardReserveRound`, `settleHolderRewardGasReserve`, `reconcileUnallocatedHolderMeme` | `blast_presale_domain::RewardsAdmin` |
| blast SUI | `setRedeemFee` | `blast_sui_domain::FeeAdmin` |
| partners | `register`, `scheduleShare`, `scheduleCap` | `blast_partners::PartnerAdmin` |

`decodeAclObject`/`getAcl` read the ACL, and `decodeAclEvent` with
`reduceAclEvent` replays its nine membership and root-transfer events. Package
upgrades (`package_admin` custody and the generic upgrade events) stay with the
CLI publish tooling.

## Partners

`@interest-protocol/blast-sdk/partners` covers `blast_partners`. Anyone mints a
`PartnerCap` (`newCap`); the `PartnerAdmin` registers a partner under a cap
with its share of Blast's fee and schedules later share and cap changes, which
take effect after `PARTNER_DELAY_MS` (seven days); the live cap's holder sets
the recipient at once (`setRecipient`). `decodePartnerObject`/`getPartner`
read the timelocked terms, `partnerPayment` mirrors `blast_partners::pay`
(rounded down; Blast keeps the remainder), and `reducePartnerEvent` replays
`PartnerUpdated` terms and `PartnerPaid` totals per coin type. `LaunchConfig`
accepts a partner for new launches through `addPartner` and `removePartner`.

## Generated Meme package

`publishMeme` uses the reviewed, compiled Move launch ticket template
(`launch_ticket_template`, formerly `meme_template`; contracts ADR 0108). It patches the type
identifiers, decimals, metadata, creator recipient, launch policy, and deployed
Blast package dependency. The publish lists every package the launchpad links:
the `blast_fun_timelock`, `blast_admin`, and `blast_partners` packages from the
deployment, then the launchpad. Launch finalization rejects a symbol longer than 32
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

## Standalone coin

`@interest-protocol/blast-sdk/coin` publishes a plain Sui coin from the
compiled coin template (contracts ADR 0108). The coin has no Blast dependency,
Blast holds no authority over it, and it can never launch on Blast. Its
initializer creates the currency in the Coin Registry, mints the initial supply
to one recipient, and settles the `TreasuryCap` by the supply mode:
`mintable` sends it to a recipient, while `fixed` and `burnOnly` consume it
and need a nonzero initial supply. The `MetadataCap` goes to a recipient, or a
null recipient deletes it and freezes the metadata. The `Currency` goes to the
Coin Registry address; anyone may share it with
`coin_registry::finalize_registration` afterward.

```ts
import { publishCoin } from "@interest-protocol/blast-sdk/coin";

const transaction = publishCoin({
  symbol: "DOG",
  name: "Dog Coin",
  description: "A good dog",
  iconUrl: "https://example.com/dog.png",
  decimals: 9,
  initialSupply: 1_000_000_000n * 10n ** 9n,
  supplyRecipient: creator,
  supply: { kind: "fixed" },
  metadataCapRecipient: creator,
  upgradeCapRecipient: null, // makes the package immutable
});
```

Both templates are patched by constant type and default value. When two
patched constants end up equal, which the bytecode verifier rejects as
duplicates (one recipient for every capability, a name equal to the symbol,
two false flags), the builder merges them into one and leaves the freed slot
unused, so every publish verifies.

### A Bluefin vault without a presale

After executing `publishCoin` above, read the coin type and pending `Currency`
ID from its effects. The next transaction can finalize registration, create a
Bluefin `Pool<Meme, Quote>`, seed liquidity, and lock the position in a Blast
vault. Use Bluefin's runtime package and mutable config reference from your
deployment identities (or `resolveVenueObjects(access, "bluefin")`). Read the
current SUI creation fee with `getBluefinPoolCreationFee(client, deployment)`;
it may be zero, but the builder does not assume that.

```ts
import { Transaction } from "@mysten/sui/transactions";
import { finalizeCoinRegistration } from "@interest-protocol/blast-sdk/coin";
import {
  addBluefinPoolWithLiquidity,
  shareBluefinPool,
} from "@interest-protocol/blast-sdk/migrators";
import { definePresaleDeployment } from "@interest-protocol/blast-sdk/deployments";
import { PresaleCalls } from "@interest-protocol/blast-sdk/presale";

// memeType and currencyId come from the completed coin publication.
// quoteType, bluefinPackageId, bluefinConfig and creationFee come from
// the selected deployment and current chain state, not token-specific defaults.
const tx = new Transaction();
finalizeCoinRegistration(tx, { coinType: memeType, currency: currencyId });
const types = { memeType, quoteType };
const pool = addBluefinPoolWithLiquidity(tx, {
  ...types,
  bluefinPackageId,
  bluefinConfig, // { objectId, initialSharedVersion, mutable: true }
  memeMetadata: { symbol: "DOG", decimals: 9 },
  quoteMetadata: { symbol: "QUOTE", decimals: 9 },
  tickSpacing: 200,
  feeRate: 10_000n, // 1% in Bluefin's millionths
  sqrtPriceX64: 1n << 64n, // Quote atoms / Meme atom = 1
  creationFee, // MIST
  lowerTick: -443_600,
  upperTick: 443_600,
  memeCoin: tx.coin({ type: memeType, balance: 1_000n * 10n ** 9n }),
  quoteCoin: tx.coin({ type: quoteType, balance: 1_100n * 10n ** 9n }),
  fixedAmount: 1_000n * 10n ** 9n,
  fixedMeme: true,
});
// activatedPresaleManifest includes PackageVersion from fresh activation effects.
const presale = new PresaleCalls(definePresaleDeployment(activatedPresaleManifest));
tx.add(presale.newBluefinVault({
  ...types,
  pool: pool.pool,
  position: pool.position,
  feeRecipients: [{ recipient: creator, bps: 1_000n }],
  holderRewardsBps: 9_000n,
}));
shareBluefinPool(tx, { ...types, bluefinPackageId, pool: pool.pool });
tx.transferObjects([pool.memeResidual, pool.quoteResidual], creator);
// Simulate and execute tx with the wallet/client, as with other SDK builders.
```

The tick bounds above are the full range aligned inward for spacing 200 at
Bluefin's -443,636..443,636 limits; select bounds for the current config.
Prices use atomic units, so equal displayed prices need a decimals adjustment
when the two coins have different decimals. Input coin balances cap spending;
Bluefin calculates the non-fixed side and aborts if its balance is too small.
The returned residuals are `Coin` handles (even when zero), which must be
consumed or transferred. The returned pool stays owned until `shareBluefinPool`;
call it after the vault borrows the pool. Alternatively transfer the position
to its owner and create the vault in a later transaction using its shared pool
reference. Vault creation permanently locks the position's liquidity and
requires Blast's `CreationPolicy` to allow Quote and the Bluefin migrator.

### A Cetus vault without a presale

After `publishCoin` completes, Cetus can seed the coin's pool through
`addCetusPoolWithLiquidity`. Cetus revision 15 shares the pool internally and
returns only a position and residual coins. Execute pool creation first, then
read the new shared pool and position from its effects and create the vault in
the next transaction. The SDK reuses `finalizeCoinRegistration` from the
Bluefin example; neither route requires a presale.

```ts
import { Transaction } from "@mysten/sui/transactions";
import { finalizeCoinRegistration } from "@interest-protocol/blast-sdk/coin";
import { definePresaleDeployment } from "@interest-protocol/blast-sdk/deployments";
import { addCetusPoolWithLiquidity } from "@interest-protocol/blast-sdk/migrators";
import { PresaleTransactions } from "@interest-protocol/blast-sdk/presale";

// memeType and currencyId come from the completed publishCoin transaction.
// Get the Cetus runtime package, config, Pools and LP Burn manager identities
// from your deployment (or resolveVenueObjects(access, "cetus")).
const tx = new Transaction();
const types = { memeType, quoteType };
finalizeCoinRegistration(tx, { coinType: memeType, currency: currencyId });
const created = addCetusPoolWithLiquidity(tx, {
  ...types,
  cetusPackageId,
  cetusConfig, // read-only shared reference
  cetusPools, // mutable shared reference
  tickSpacing: 200,
  sqrtPriceX64: 1n << 64n, // coin B atoms / coin A atom = 1
  lowerTick: -443_600,
  upperTick: 443_600,
  // Supply the exact fixed-side amount and a capped amount on the other side.
  memeCoin: tx.coin({ type: memeType, balance: 1_000n * 10n ** 9n }),
  quoteCoin: tx.coin({ type: quoteType, balance: 1_100n * 10n ** 9n }),
  fixedMeme: true,
});
tx.transferObjects([
  created.position, created.memeResidual, created.quoteResidual,
], creator);
// Simulate and execute tx, then read positionId and poolRef from chain state.

const vaultTransaction = new PresaleTransactions(
  definePresaleDeployment(activatedPresaleManifest),
).newCetusVault({
  ...types,
  position: positionId,
  pool: poolRef, // { objectId, initialSharedVersion, mutable: false }
  burnManager, // mutable shared reference
  feeRecipients: [{ recipient: creator, bps: 1_000n }],
  holderRewardsBps: 9_000n,
});
// Simulate and execute vaultTransaction.
```

The helper orders the defining coin types, input coins, fixed side and residuals
with `cetusMemeSide`. `sqrtPriceX64` and signed tick bounds remain in Cetus's
coin A/B order: price is B atoms per A atom, adjusted for decimals, and it must
lie inside the tick range. The fixed side takes its input coin's entire balance;
the other input caps spending. Consume or transfer all three returned handles,
including zero residual coins. Cetus derives the fee tier from `tickSpacing`.
An unreserved pair needs no creation cap; for an already reserved pair/tier,
pass its matching `poolCreationCap` to select `create_pool_v3_with_creation_cap`.
Cetus rejects duplicate or disallowed pools. The new pool is shared by Cetus;
there is no separate SDK share call or fresh pool handle to pass to a vault.
The vault permanently locks the position through Cetus LP Burn, and Blast's
`CreationPolicy` must allow Quote and the Cetus migrator.

## Presale

`@interest-protocol/blast-sdk/presale` builds every product route of the
`blast_presale` versioned package for Bluefin, Cetus and native Aftermath. Native
Aftermath creation consumes the final `FinalizeTicket`, shares the pool reservation,
and migrates into a locked DAO-fee pool; see the [native lifecycle](docs/presale.md#native-aftermath-pools). It requires fresh
publication and activation; supply `packageVersion` from activation effects. Aftermath vendor builders require an explicitly configured matching
deployment. The contract requires confirmed unregulated sale currencies; the SDK
decodes rejection code 35 as `ESaleTokenNotUnregulated`. It
previews creation economics, commitments, and claims, and it decodes and replays the
package's objects and events. See [docs/presale.md](docs/presale.md).

## Gas budgets

Cetus seeds a new pool's tick skip list from the clock, so creating a pool can
write up to 18 more bytes of storage when it executes than when it was
simulated. `@mysten/sui` and the fullnode budget only the simulated net cost
plus 1,000 gas units, about 13 bytes, so a Cetus migration runs out of gas in
about one execution in four. A presale's Cetus migration did on mainnet.

The presale and migrators `migrateCetus` calls, `addCetusPoolWithLiquidity`, and
the transactions built from them carry the `grossGasBudget()` build plugin.
When built without a budget, it budgets the simulated computation plus all
storage, ignoring the
rebate, plus a fifth and 10,000 gas units. The charge is unchanged; only the
ceiling rises. A payer that cannot cover the gross budget keeps the default
one. Every other SDK transaction is deterministic and keeps the default budget.

A plugin does not survive JSON serialization: after `Transaction.from(json)` of
a Cetus migration, add it again with `tx.addBuildPlugin(grossGasBudget())`.

## SUI payments and sponsored gas

Builders that spend SUI (a creation fee, a vault deposit, or a SUI-quoted
buy or commitment) take it with `@mysten/sui`'s `tx.coin`. Its default
withdraws from the sender's address balance when that covers the amount and
otherwise splits the gas coin. That suits a sender who pays their own gas. In
a sponsored transaction the gas coin is the sponsor's, so pass
`useGasCoin: false` and the SUI comes from the sender's own coins and address
balance instead:

```ts
// Once for every builder of a client or transaction builder...
const presale = new PresaleClient(client, deployment, { useGasCoin: false });
const blastSui = new BlastSuiTransactions(deployment, { useGasCoin: false });

// ...or per call, which wins over the builder's setting.
const tx = presale.tx.commit({ ...commit, useGasCoin: false });
```

Every SUI-spending builder honors it: `BlastSuiTransactions` `mintFunSui`,
`requestBlastSui`, and `donateSui`; `LaunchpadTransactions` `buy` and
`joinOpeningRound`; `MigratorTransactions` `createCetusLaunch`,
`createBluefinLaunch`, and `migrateBluefin`; `PresaleTransactions` `commit` and
`migrateBluefin`; and `addLaunchCompletion`. Other coin types never touch the
gas coin. The `call` builders take coin arguments you construct, so a PTB you
compose sources its coins however you choose. A self-paying sender with
`useGasCoin: false` needs SUI beyond what gas selection takes.

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
npm ci
npm run typecheck
npm test
BLAST_CONTRACTS_DIR=../blast-v2-contracts npm run check:abi
```

`npm run check:abi` extracts the frozen contracts commit with `git archive` from
the contracts repository (`BLAST_CONTRACTS_DIR`, default `../blast-v2-contracts`) and
compares its `sui move summary` with `abi/` using the pinned Sui CLI; the
contracts working tree and branch do not matter. The default test suite runs the
same comparison when that repository contains the commit.

See [docs/launch-economics.md](docs/launch-economics.md) for the endpoint and
valuation formulas. See
[docs/launchpad-abi-coverage.md](docs/launchpad-abi-coverage.md) for the frozen
ABI baseline and the complete SDK coverage matrix.
