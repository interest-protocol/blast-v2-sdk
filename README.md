# Blast SDK

The SDK mirrors the completed Sui launchpad and migrators ABIs
without becoming a second source of truth for protocol execution.

```sh
npm install @interest-protocol/blast-sdk @mysten/sui @mysten/move-bytecode-template
```

The package is ESM with TypeScript declarations and has no Node, browser, or
storage dependencies of its own: it runs on Node 22+, browsers, edge workers,
and other runtimes with ES2023, `BigInt`, and `TextEncoder`. Node 22.12+ can
also `require()` it. Workflows that need durable state, such as the
holder-rewards operator, take a store you implement.

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
- typed BCS event decoding and deterministic launch-to-vault replay;
- the standalone `blast_presale` package: creation, commitments, settlement,
  Cetus and Bluefin migration, claims, LP-fee collection, and holder-reward
  rounds, with exact previews and event replay;
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
    packageId: "0x...", // current launchpad package
    originalPackageId: "0x...", // first publication; names every type
    admin: {
      packageId: "0x...", // published blast_admin
      acl: { objectId: "0x...", initialSharedVersion: "..." }, // its ACL
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

`@interest-protocol/blast-sdk/deployments` is the single TypeScript registry for
Blast package lineage and singleton shared-object identities. A
`BlastDeployment` names every published package, each with its current and
original package IDs: `timelock`, `admin`, `partners`, `launchpad`,
`migrators`, `presale`, and `blastSui`. The `launch_ticket_template` and
`coin_template` packages have no entry: each launch publishes its own Meme
package from the launch ticket template's bytecode, linking the timelock,
admin, partners, and launchpad packages, and each standalone coin publishes its
own package from the coin template's. `sharedObjects` groups each
package's singletons (`admin.acl`; `launchpad.packageVersion`, `launchConfig`,
`runtimeConfig`; `migrators.packageVersion`, `lpFeePolicy`, `venueConfig`;
`presale.venueConfig`, `feePolicy`; `blastSui.packageVersion`, `vault`) by object ID and
initial shared version. Builders add `mutable` from the Move function
signature because mutability belongs to a transaction argument, not to the
object itself. `adminDeployment`, `partnersDeployment`, `launchpadDeployment`,
`migratorsDeployment`, `presaleDeployment`, and `blastSuiDeployment` derive
each product's call-ready deployment.

After a canonical network release is registered, initialize the client without
copying addresses into the application:

```ts
import { blastLaunchpad } from "@interest-protocol/blast-sdk/launchpad";
import {
  getBlastDeployment,
  launchpadDeployment,
} from "@interest-protocol/blast-sdk/deployments";

const blast = getBlastDeployment("mainnet");
const launchpadExtension = blastLaunchpad(launchpadDeployment(blast));
```

For an unreleased mainnet deployment, validate one manifest with
`defineBlastDeployment`, then pass it through the matching deployment helper. The
built-in registry remains empty until publish output supplies real IDs; the SDK
does not ship placeholder addresses.

Presale can publish before the rest of Blast, so `BLAST_PRESALE_DEPLOYMENTS`
holds a standalone release, and `getPresaleDeployment(network)` prefers the
complete release's presale once `BLAST_DEPLOYMENTS` has one. It is empty until
a presale that signs in through the `blast_admin` ACL is published.

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
2. `set_virtual_quote` (the creator picks the reserve the curve starts from,
   contracts ADR 0092), `set_graduation_target`, `set_allocation_plan`,
   `set_lp_fee_split`, the optional `set_opening_round` (ADR 0093), and the
   optional `set_partner` (ADR 0098) record the creator's settings.
3. `launch::finalize` takes a `Coin<SUI>` of exactly the `LaunchConfig`
   creation fee, checks every invariant, and fixes the supply mode.
4. The optional purchase runs on the owned launch: a curve `buy` without an
   opening round, or the creator's `join_opening_round` bid with one.
5. `launch::share` opens trading, or the opening round.

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
  // Exact LaunchConfig creation fee in MIST, from getLaunchConfig().
  creationFee: (await client.blastLaunchpad.getLaunchConfig()).creationFee,
  virtualQuote: 1_000_000_000_000n,
  graduationTarget: 3_000_000_000_000n,
  // Blast's migration fee (here 500 bps of each asset) is added at finalization.
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
  openingRoundMs: 120_000n, // optional: zero or 60,000 to 300,000
  partner, // optional: a Blast partner LaunchConfig accepts, fixed for good
  // With an opening round this is the creator's bid in the same pot.
  preShareBuy: { quoteAmount: 1_000_000_000n, minMemeOut: 1n, recipient },
});
```

With an opening round nothing trades until `settleOpeningRound` buys once with
the whole pot after `openingRoundMs`; `joinOpeningRound` adds to the sender's
bid until then, and `deliverOpeningRound` sends each bidder its pro-rata share
(`previewOpeningRoundDelivery`). Anyone may settle and deliver; the reducer's
`openingRoundBidders` lists the bids a keeper still has to deliver.

`createBluefinLaunch` takes `tickSpacing` and `feeRate` instead of the Cetus
objects. The SDK checks the allocation plan and fee split exactly as the Move
constructors do and rejects shapes they abort on. The creator's plan names up
to sixteen recipients and excludes Blast: `launch::finalize` sets the plan's
`protocolMemeBps` and `protocolQuoteBps` from the `LaunchConfig` protocol
allocation and requires each asset to sum to 10,000 basis points;
`addProtocolAllocation` previews that step. At migration Blast's shares accrue
as its one-time fee in the launch's fee ledger (`ProtocolFeesAccrued`).
`deriveLaunchEconomics`, `apportionMeme`, `apportionQuote`, and
`apportionFeeSplit` mirror the contract's exact apportionment: Blast's
migration fee rounds up, every other part goes by largest remainder.

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

After publication completes, pass the created ticket ID to
`MigratorTransactions.createCetusLaunch` or `createBluefinLaunch`. This
separation is required because a Move initializer transfers the ticket; it
cannot return the ticket to another command in the publish transaction.

`tx` methods return complete transactions that route all returned coins or
capabilities. `call` methods return transaction thunks for programmable
composition; `LaunchpadCalls.completeLaunch` applies the settings, finalize,
optional purchase or opening-round bid before sharing, and share to any
adapter's initializer.

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

## Presale

`@interest-protocol/blast-sdk/presale` builds every product route of the
`blast_presale` package. It previews creation, commitments, and
claims exactly as the contract enforces them, and it decodes and replays the
package's objects and events. See [docs/presale.md](docs/presale.md).

## Gas budgets

Cetus seeds a new pool's tick skip list from the clock, so creating a pool can
write up to 18 more bytes of storage when it executes than when it was
simulated. `@mysten/sui` and the fullnode budget only the simulated net cost
plus 1,000 gas units, about 13 bytes, so a Cetus migration runs out of gas in
about one execution in four. A presale's Cetus migration did on mainnet.

The presale and migrators `migrateCetus` calls, and the transactions built from
them, therefore carry the `grossGasBudget()` build plugin. When built without a
budget, it budgets the simulated computation plus all storage, ignoring the
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
