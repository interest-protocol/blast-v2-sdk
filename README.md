# Blast SDK monorepo

TypeScript SDKs for the Blast contracts on Sui mainnet. Contract source and
generated Move references live in
[interest-protocol/blast-v2-contracts](https://github.com/interest-protocol/blast-v2-contracts);
this SDK is frozen to contracts
[`86ee8cf`](https://github.com/interest-protocol/blast-v2-contracts/tree/86ee8cf9df8e9b2ec920f9564e2fda8afbf82106/sui),
the one-way launch stack of ADR 0137 with the sealed treasury caps of ADR 0138
(see [docs/abi.md](docs/abi.md)).

Contract state and completed events are authoritative. The SDK builds
transactions, decodes objects and events, and mirrors contract formulas with
exact `bigint` arithmetic for previews; a preview never instructs a contract.

The packages are ESM with TypeScript declarations and no Node, browser or
storage dependencies of their own: they run on Node 22+, browsers, edge
workers and other ES2023 runtimes. Node 22.12+ can also `require()` them.

The coordinated SDK release is `0.2.0`:

```sh
npm install @interest-protocol/blast-sdk@0.2.0 @mysten/sui@^2.26.2 @mysten/move-bytecode-template@^0.4.1
```

## Packages

Move dependency edges point inward only, and the workspace mirrors them. The
root `workspaces` array is the build and publish order, which
`scripts/check-workspace-packages.mjs` enforces:

| Directory | npm package | Move package | Purpose |
| --- | --- | --- | --- |
| `packages/core` | `@interest-protocol/blast-core` | `blast_core` | Bps, apportionment, `FeeSplit`, `Recipient`/vesting, the protocol-fee `Ledger`, the shared `Treasury`, Merkle hashing, migration hand-off types, core roles, BCS and integer helpers, holder-reward accounting |
| `packages/admin` | `@interest-protocol/blast-admin-sdk` | `blast_admin` | The ACL, the delayed primitives, and generic `PackageVersion<OTW>` / `PackageAdmin<OTW>` administration |
| `packages/partners` | `@interest-protocol/blast-partners-sdk` | `blast_partners` | Partners, `PartnerList`, payment previews |
| `packages/vault` | `@interest-protocol/blast-vault-sdk` | `blast_vault` | The one LP vault: owner balances, fee split, Blast's share, holder-reward rounds, the venue and package witness registry |
| `packages/migrators` | `@interest-protocol/blast-migrators-sdk` | `blast_migrators` | Cetus and Bluefin venues for launches and presales: `prepare`, `migrate`, fee collection, buybacks |
| `packages/launchpad` | `@interest-protocol/blast-launchpad-sdk` | `blast_fun`, `launch_ticket_template` | Generated Meme packages, launch creation, the curve, opening rounds, migration, economics and events |
| `packages/presale` | `@interest-protocol/blast-presale-sdk` | `blast_presale`, `presale_coin_template`, `blast_aftermath_dao_presale` | Generated sale-token packages, presale creation, commitments, settlement, migration, claims, and the Aftermath DAO-pool vendor venue |
| `packages/coin` | `@interest-protocol/blast-coin-sdk` | `coin_template` | Standalone Sui coins with no Blast dependency; they can neither launch nor be sold on Blast |
| `packages/blast-sui` | `@interest-protocol/blast-sui-sdk` | `blast_sui` | blastSUI reads, previews and transactions |
| `packages/boosts` | `@interest-protocol/blast-boosts-sdk` | Boosts | Boosts products and transactions |
| `packages/cctp` | `@interest-protocol/blast-cctp-sdk` | — | EVM USDC deposit parameters and ABIs ([docs/cctp.md](docs/cctp.md)) |
| `packages/holder-rewards` | `@interest-protocol/blast-holder-rewards-sdk` | — | Holder-reward operator workflows over the vault ([docs/holder-rewards.md](docs/holder-rewards.md)) |
| `packages/deployments` | `@interest-protocol/blast-deployments-sdk` | — | Deployment manifests, identity checks, protocol access, venue readers, the admission runbook |
| `packages/blast-sdk` | `@interest-protocol/blast-sdk` | — | Re-exports every package above (subpaths `./admin`, `./vault`, `./launchpad`, ...) |
| `packages/partner-client` | `@interest-protocol/blast-partner-client` | — | Authenticated REST read client; no runtime dependencies |

The products (`launchpad`, `presale`) depend on `migrators`, never the
reverse: the PTB is where a product and a venue meet, so the one-PTB
compositions live in the product packages and one venue package serves both.

Each Move package's builders come in two layers: `*Calls` methods return
transaction thunks in Move argument order for your own PTB (`&mut TxContext`
is implicit, the `Clock` is `0x6`), and `*Transactions` methods return
complete transactions that route every returned coin and capability. A
deployment's shared singletons are identities (`objectId`,
`initialSharedVersion`); each call adds the mutability its Move signature
needs.

## 0.2.0 is a one-way break

0.2.0 targets a canonical November 6 launch stack and replaces the 0.1.x
surface outright; there is no compatibility layer. The last SDK commit that
carried the 2026-10-28 mainnet bindings is `main` `f78b2e7`; pin it to talk
to that stack.

Removed with no replacement in kind:

- `CANONICAL_MAINNET_*`, `MAINNET_*_DEPLOYMENT`, `definePresaleDeployment`,
  `BLAST_PRESALE_DEPLOYMENTS`, `getPresaleDeployment`, MVR resolution,
  `npm run check:mainnet` and the PR150 ABI track (`check:abi:pr150`);
- the presale's own Cetus, Bluefin, native Aftermath, vault, venue-config and
  holder-reward builders, readers and events; the launchpad's treasury,
  migration-witness and package-admin builders, `completeLaunch` and
  `addLaunchCompletion`; per-product `pause`/`scheduleUpgrade`/... methods;
- `MigratorTransactions.createCetusLaunch`/`createBluefinLaunch`, the
  migrators `LpVault`, `LpFeePolicy` and `blast_holder_rewards` surface;
- v1 holder-reward leaf domains (`MIGRATOR_REWARD_LEAF_DOMAIN`,
  `PRESALE_REWARD_LEAF_DOMAIN`) and `core/rewards/{state,keeper}`;
- the `blast-sdk` legacy export snapshot and duplicate re-exports.

Their replacements: `LaunchpadTransactions.createLaunch` and `.migrate`,
`PresaleTransactions.createPresale` and `.migrate` (venue steps through
`MigratorCalls`), `VaultCalls`/`VaultTransactions`, generic `AdminCalls`, the
core `FeeSplit` and `Recipient`, and holder rewards v2 on the vault.

## Deployments

`@interest-protocol/blast-deployments-sdk` is the one deployment import for
every runtime. A manifest (`BLAST_DEPLOYMENT_SCHEMA_VERSION = 2`) records the
eight required packages (`admin`, `partners`, `core`, `vesting`, `vault`,
`launchpad`, `presale`, `migrators`) with current and original IDs, each
upgradeable package's `PackageVersion<OTW>` and `PackageAdmin<OTW>`, the
shared singletons grouped by owner (`core.treasury`, `vault.registry`,
`launchpad.launchConfig`, `presale.creationPolicy`, `migrators.venueConfig`,
...), the optional venue sets (Cetus, Bluefin, and the presale vendor
`aftermathDao`), migration routes, and the contracts commit and ABI digests it
was built from.

`getBlastDeployment("mainnet")` returns the canonical November 6 manifest.
Its shared-object versions come from live owners. Vault and both products
remain paused; routes and route-release evidence remain empty until live venue
validation. Publication does not enable production signing: the manifest still
requires route evidence and runtime verification. Pass an explicit manifest to
`defineBlastDeployment`; `launchpadDeployment`, `presaleDeployment`,
`vaultDeployment`, `migratorsDeployment` and `coreDeployment` derive each
package's call-ready identities from it.

`observeDeploymentRuntime` reads every pinned object and each pausable
package's `PackageVersion.paused` mask; `evaluateProtocolAccess` enables
signing only for a production manifest whose identities, ABI digests and SDK
release match, and reports which package version or pause bit disables it.

### Admission runbook

A fresh publish starts with the vault and both products fully paused.
`admissionRunbook(deployment, adminCapId, options)` returns the contracts'
paused admission as ordered PTBs the administrator signs:

1. the vault registry admits, at notice zero, both products' package
   witnesses and both migrators venues (the vendor creates no vault and is
   never listed);
2. each product's `configureNow` admits its venues (the presale also the
   vendor's `Venue` when the manifest records it) and applies the named
   settings: fees, Quotes, decimals, partners, claim signers;
3. the vault's witness notice and each product's notices are raised
   (`armNotices`);
4. the vault, then each product, unpauses with its package's
   `UnpauseAdmin<OTW>`.

A step already done on chain aborts when dry-run, which is the intended check.

## Launches

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { blastLaunchpad } from "@interest-protocol/blast-sdk/launchpad";
import { launchpadDeployment } from "@interest-protocol/blast-sdk/deployments";

const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io:443",
}).$extend(blastLaunchpad(launchpadDeployment(deployment)));

const publish = client.blastLaunchpad.tx.publishMeme({
  decimals: 9,
  symbol: "DOG",
  name: "Dog Coin",
  description: "A good dog",
  iconUrl: "https://example.com/dog.png",
  burnable: false,
  sellBurnBps: 0n,
  creatorRecipient: { kind: "address", address: creator },
});
```

`publishMeme` patches the compiled `launch_ticket_template` and publishes it
against every package `blast_fun` links (admin, partners, vesting, core, the
launchpad), then makes the package immutable. Its initializer mints the whole
supply into a `LaunchTicket` and sends the publisher the coin's `TreasuryCap`
sealed under the launchpad (`blast_core::sealed_treasury_cap::SealedTreasuryCap`,
contracts ADR 0138): no raw cap leaves the publication, so nobody mints before
`launch::new` opens the seal. `readMemePublication` reads the ticket, the
sealed cap and the pending `Currency` from the effects and
`finalizeCurrencyRegistration` shares the `Currency` (it takes the shared Coin Registry
`0xc` with its initial shared version, so it builds offline).

`createLaunch` then runs in one PTB: on Cetus the launchpad's
`venue_admission` of the venue, the venue's `prepare` (Cetus borrows the
sealed cap with that admission to reserve the pool; Bluefin takes it only as
proof of control; each records the pool tier and returns a sealed
`VenueTicket`), `launch::new` with the ticket and the sealed cap, the
settings (virtual Quote, graduation target, allocation plan, the vault's
core `FeeSplit`, opening round, partner), `finalize` with the SUI creation
fee, an optional pre-share buy or opening-round bid, and `share`.

A launch that reaches its graduation target migrates in two calls of one PTB:
`launch::migrate` returns a `Migration`, and the venue's `migrate` redeems it,
creates the pool and locks the position in a new `Vault`
(`LaunchpadTransactions.migrate`). Owner actions prove ownership with the
live `CurveFeeCap` (`launch::prove_owner`) and then call exactly one vault
action: `claimOwnerBalances`, `scheduleFeeSplit` or `cancelFeeSplit`.

Creator caps: `claimCreatorCaps` returns the `CurveFeeCap` and the
`CreatorMetadataCap` for a Blast-account recipient; use
`encodeCreatorClaimMessage` for the bytes the claim key signs and
`encodeCreatorClaimAttestation` for the attestation. `launchId` and
`launchVaultId` derive a launch's and its vault's object IDs from the
registries. Display economics (`curvePrice`, `liveSupply`, `marketCap`,
`launchProgressBps`) are pinned to `test/vectors/market-data.json`, the file
blast-infra pins by SHA-256; see [docs/launch-economics.md](docs/launch-economics.md).

## Presales

A sale token comes only from the generated `presale_coin_template` package:
`PresaleTransactions.publishPresaleCoin` patches its compiled module (symbol,
name, description, icon, decimals, the `MetadataCap` recipient or its
deletion) and publishes it against admin, partners, vesting, core and the
presale, then makes it immutable. Its initializer creates the currency through
`blast_presale::sale_token::new`, which seals the `TreasuryCap` under the
presale from birth and sends the publisher the `SealedTreasuryCap`;
`readPresaleCoinPublication` reads it and the pending `Currency` from the
effects and `finalizeCurrencyRegistration` shares the `Currency`. A coin
created elsewhere, including through `coin_template`, cannot start a sale.

`PresaleTransactions.createPresale` runs, on Cetus, the presale's
`venue_admission`, then the sale's venue `prepare` (Cetus, Bluefin, or the
vendor's `blast_aftermath_dao_presale::prepare`) on the sealed cap, `new`,
which opens the seal, every setter, `finalize`, an optional
`set_protocol_fees` signed in as `FeeAdmin`, and `share` at the chosen
`commitmentStartsAtMs`, then sends the `PresaleCap` to its recipient.
`migrate` optionally settles, calls `blast_presale::migrate` and hands the
`Migration` to the venue, and pays a partnered sale's held fees when asked.
The vendor's `prepare` needs the vendor `AdminCap` from the same sender that
holds the sealed cap, and cannot bind the LP coin to its `CreatePoolCapV2`:
verify the LP coin with `verifyAftermathLpCoin*` before listing. See
[docs/presale.md](docs/presale.md).

## Vault

`@interest-protocol/blast-sdk/vault` reads `Vault<Meme, Quote>`, `Round` and
the `VaultRegistry` (`blastVault` client extension, `getVault`, `vaultId`),
decodes the 10 vault events, and builds the vault's own calls: owner actions
with a product's `OwnerProof`, Blast's protocol share (`FeeAdmin`), holder
reward rounds (`RewardsAdmin`: schedule, publish, claim, settle gas, close),
the witness registry (`VenueAdmin`), and the package's `unpause` and
`make_immutable`. `previewFeesCollected` mirrors a fee collection's split.

## Migrators

One `blast_migrators` package serves launches and presales. `MigratorCalls`
builds `cetus::prepare`/`bluefin::prepare` (on the coin's sealed
`TreasuryCap`; Cetus also takes the product's `VenueAdmission`) and each
venue's `migrate` for the product compositions; `MigratorTransactions` builds
permissionless fee collection (`collectCetusFees`, `collectBluefinFees`),
auto-LP compounding (`compoundCetusAutoLp`, `compoundBluefinAutoLp`;
collection leaves the auto-LP share waiting in the vault, so a venue's refusal
of the add never blocks collecting), the settled fee-split switch
(`settleAndApply*FeeSplit`) and buybacks (`BuybackAdmin`). Every venue call
passes both the migrators and the vault `PackageVersion`.

- Migrators has no pause bits; the SDK defines none and `Paused<BLAST_MIGRATORS>`
  never occurs.
- A vault upgrade forces a migrators relink: after the vault's
  `commit_upgrade_and_advance`, every `collect_fees` and `migrate` aborts with
  `blast_admin` `EVersionMismatch` (code 9) until the migrators release that
  links the new vault version. The SDK cannot read the compiled version
  constant, so it can only surface the abort.

## Administration and partners

`AdminCalls` builds the shared ACL (admins, roles, the delayed root transfer)
and one generic package administration typed by the package's OTW:
`pause`, `scheduleUpgrade`, `scheduleMakeImmutable`, `cancelUpgradeAction`,
`scheduleUpgradeDelay`, `applyUpgradeDelay`. `packageRoleType(admin, otw,
role)` names `package_admin::{UpgradeAdmin, PauseAdmin, UnpauseAdmin,
CancelAdmin}<OTW>`; every product role is one of the nine
`blast_core::blast_domain` roles (`coreRoleType`). Each product's `unpause`
(`launch_config::unpause`, `creation_policy::unpause`,
`blast_vault_package::unpause`) takes `{ unpauseAdmin, bits }` on its `Calls`
and `{ adminCapId, bits }` on its `Transactions`. Publishing, upgrade
authorization and commits are Sui CLI publish tooling, not SDK surface.

Numeric abort codes map to names through each package's `*_ABORTS` table
(`coreAbortName`, `adminAbortName`, `vaultAbortName`, ...);
`test/aborts.test.ts` checks each table against its `errors.move`.

`@interest-protocol/blast-sdk/partners` builds partner registration, delayed
share and cap changes and recipients, decodes `Partner` and `PartnerList`, and
previews `blast_partners::pay`.

## Standalone coin

`@interest-protocol/blast-sdk/coin` publishes a plain Sui coin from the
compiled `coin_template`. The coin has no Blast dependency and can never launch
or be sold on Blast, since its creator holds the raw `TreasuryCap`. Its
initializer creates the currency in the Coin Registry, mints the initial
supply to one recipient, and settles the `TreasuryCap` by supply mode
(`mintable`, `fixed`, `burnOnly`).

## Gas budgets

Cetus seeds a new pool's tick skip list from the clock, so creating a pool can
write more storage when it executes than when it was simulated. Cetus
`migrate` carries the `grossGasBudget()` build plugin: without an explicit budget it budgets the simulated computation plus
all storage, ignoring the rebate, plus a fifth and 10,000 gas units. A plugin
does not survive JSON serialization; add it again after `Transaction.from`.

## SUI payments and sponsored gas

Builders that spend SUI (a creation fee, a Bluefin pool fee, a SUI-quoted buy
or commitment, blastSUI deposits) take it with `tx.coin`, which by default
uses the sender's address balance or splits the gas coin. In a sponsored
transaction pass `useGasCoin: false`, per builder or per call, so the SUI comes
from the sender's own coins.

## Integer helpers

`U64` and `U128` are branded `bigint` types returned by `requireU64`,
`requirePositiveU64` and `requireU128` after range checks. Every protocol
amount is atomic; fee obligations round up to their recipient, curve outputs
and valuations round down.

## Workspace development and releases

Run installation and checks from the root with Node 22.18+; the root lockfile
is the single dependency lock:

```sh
npm ci
npm run check   # check:abi, format, lint, typecheck, check:package, test, partner-client generated check
```

`npm run check:abi` extracts the frozen contracts commit from the contracts
repository (`BLAST_CONTRACTS_DIR`, default `../blast-v2-contracts`) and
compares its `sui move summary` with `abi/` using the pinned Sui CLI; refreeze
an approved change with `npm run check:abi:write` and update `FROZEN_ABI`.
Tests import built package exports, so build before a focused test, for
example `node --test --test-concurrency=1 test/vault-state.test.ts`.

`check:package` validates every package with publint and Are the Types Wrong,
installs the tarballs into a temporary consumer, and checks that each
`@interest-protocol/blast-sdk` entry point re-exports exactly its packages
(ESM and `require()`) with their types.

Each public workspace owns its version, dependencies and export map; internal
dependencies are ordinary npm versions. Publish in the order of the root
`workspaces` array with `npm publish --workspace <package-name>`.
`SDK_RELEASE` identifies the coordinated npm build and its reviewed implementation
commit. npm `gitHead` identifies the packaging commit. The partner REST client
remains at its already published `0.1.0`; its published files are unchanged.

The canonical manifest is backed by the [November 6 deployment record](https://github.com/interest-protocol/blast-v2-contracts/blob/main/deployments/sui/mainnet/2026-11-06-canonical-launch-stack.json). Auto-LP compounding now requires an `AutoLpAdmin` cap and inclusive Q64.64 price bounds; its private entry consumes and re-shares the pool. Collection stays permissionless.
