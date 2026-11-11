# Sui ABI coverage

The SDK mirrors the frozen Sui ABI of every Blast package without becoming a
second source of truth for protocol execution. Contract objects and completed
events stay authoritative.

## One ABI track

`scripts/check-contract-abi.mjs` extracts the contracts repository
([interest-protocol/blast-v2-contracts](https://github.com/interest-protocol/blast-v2-contracts))
at the baseline commit with `git archive`, runs `sui move summary` on each
package with the pinned Sui CLI `1.77.2-51d177ad7d65`, classifies every public function, private entry and event, and compares the result byte for byte with `abi/`.
`npm run check:abi` reads `../blast-v2-contracts` (or `BLAST_CONTRACTS_DIR`); CI
checks out the commit pinned in `.github/workflows/check.yml`.

The launch stack is frozen at contracts
[`86ee8cf`](https://github.com/interest-protocol/blast-v2-contracts/tree/86ee8cf9df8e9b2ec920f9564e2fda8afbf82106/sui)
(ADR 0137 with its 2026-11-05 amendment, PRs #178-#220, and ADR 0138's sealed
treasury caps, PR #219):

| Artifact | Move packages | Events |
| --- | --- | --- |
| `abi/production-admin-v1.json` | `blast_admin` | 36 (15 `blast_admin_events` + 21 delayed-module lifecycle events) |
| `abi/production-partners-v1.json` | `blast_partners` | 5 |
| `abi/production-core-v1.json` | `blast_core` | 1 (`ProtocolFeesPaid`) |
| `abi/production-vault-v1.json` | `blast_vault` | 10 |
| `abi/production-migrators-v1.json` | `blast_migrators` (Cetus and Bluefin, for both products) | 2 |
| `abi/production-launchpad-v1.json` | `blast_fun`, `launch_ticket_template`, `coin_template` | 18 |
| `abi/production-presale-v1.json` | `blast_presale`, `presale_coin_template` | 11 (`PresaleCreated` + 10 `events`) |
| `abi/production-aftermath-dao-presale-v1.json` | `blast_aftermath_dao_presale` | 2 |

`abi/production-blast-sui-v1.json` covers `blast_sui` at contracts `50b8d59a`
(the validator-list vault with generic package administration);
`check:abi` compares it against that commit. The Boosts packages adopt the
generic package administration separately; `abi/production-boosts-v1.json`
stays frozen at contracts `01d7659`. `sui/vesting`
is a dependency only; its `Vesting` layout is pinned by the payout tests.

`FROZEN_ABI` in `packages/deployments/src/release.ts` records the baseline
commit and the sha256 of every artifact. A deployment manifest must name the
same values, or `evaluateProtocolAccess` disables signing (`abi-mismatch`);
`test/deployment-identity.test.ts` pins each digest to `abi/`, so every
refreeze updates it.

## Classifications

Every public function carries one `sdk` role in its artifact:

| Role | Meaning |
| --- | --- |
| `builder` | An SDK `*Calls` method builds it; `test/abi.ts#assertBuildersMatchAbi` checks type and value arity, pure-versus-object kind of every argument, and `&` versus `&mut` of every shared-object input. Each package's transaction tests exercise every classified builder (vault 25, migrators 12, presale 43, vendor 2). |
| `compositional` | A value built inside a PTB for another call (`bps::new`, `fee_split::*`, `payout::recipient`, `allocation::plan`, each product's `venue_admission` for `cetus::prepare`). |
| `read` | A reader the SDK mirrors from object BCS or constants. |
| `move-composition` | Callable only from Move: it takes a package or venue witness, or embeds a value in another object (`delayed*`, `package_version`, `partner_list`, `vault::new`, `migration::*`, `sealed_treasury_cap::*` apart from its readers). |
| `template-builder`, `template-internal` | Called by a generated package's initializer: `launch_ticket::new` and `creator_authority::new_*` by the Meme package, `sale_token::new` by the sale-token package. |
| `intentional-deployment-exclusion`, `intentional-upgrade-exclusion` | Publishing (`package_admin::wrap`) and upgrades (`authorize_upgrade`, `commit_upgrade_and_advance`, `make_immutable`) are Sui CLI publish tooling. |
| `intentional-operator-exclusion` | Boosts operator PTBs. |

An unknown function fails the check (`--classify-function` probes one). Every
launch-stack event is `decoder-reducer`: the SDK decodes and replays it.
`test/object-layout.test.ts` parses Move-printed bytes of `Launch`,
`LaunchConfig`, `RuntimeConfig`, `LaunchTicket`, `Presale`, `PoolCreation`,
`Vault`, `VaultRegistry`, `Round` and `VaultTerms` and checks each against the
frozen field order. `test/aborts.test.ts` matches each package's numeric abort
table to its `sources/lib/errors.move` when `BLAST_CONTRACTS_DIR` is set.

Move calls use the current package ID. Type names, event types, object
schemas, venue and package witnesses, and derived-object keys use the original
package ID. The deployment model stores both.

## Boosts

Boosts snapshots cover all three packages, the private `operations::observe`
simulation hook, and its active mint/redeem/rebalance tuple results. The consumer
SDK builds these active operations and issuer metadata updates; issuance,
partner-specific trades, risk administration and shutdown remain explicit
operator PTBs. Only Minted, Redeemed and Rebalanced have consumer event decoders.
`test/boosts-abi.test.ts`, `test/boosts-transactions.test.ts` and
`test/boosts-grpc.test.ts` compare decoded layouts and generated calls against
the snapshot. The vault's `Binding` holds only account object/number, registry
and clearing-house identities; oracle storage inputs come from the caller's
manifest and the contract validates them against current market parameters.
Obsolete feed-origin fields are absent from SDK bindings and manifests.
Metadata updates sign in through
`blast_admin::blast_acl::sign_in<blast_boosts_core::VaultIssuer>`.

## Blast SUI

### Product operations

| Contract surface | SDK implementation | Returned-object routing | Verification |
| --- | --- | --- | --- |
| `vault::mint_fun_sui` | `BlastSuiCalls.mintFunSui`; `BlastSuiTransactions.mintFunSui` | Takes a listed `poolId`; the composable call returns `funSUI` and the transaction transfers it to the explicit recipient. | `test/blast-sui-transactions.test.ts` |
| `vault::redeem_fun_sui` | `BlastSuiCalls.redeemFunSui`; `BlastSuiTransactions.redeemFunSui` | Returns SUI; the transaction transfers it to the explicit recipient. | `test/blast-sui-transactions.test.ts` |
| `vault::request_blast_sui` | `BlastSuiCalls.requestBlastSui`; `BlastSuiTransactions.requestBlastSui` | Takes a listed `poolId`; the receipt goes to `deposit_receipt::keep` in the same PTB and becomes sender-owned. | `test/blast-sui-transactions.test.ts` |
| `deposit_receipt::keep` | `BlastSuiCalls.keepDepositReceipt` | Compositional only: it consumes the key-only receipt returned by `request_blast_sui`. | `test/blast-sui-transactions.test.ts` |
| `vault::claim_blast_sui` | `BlastSuiCalls.claimBlastSui`; `BlastSuiTransactions.claimBlastSui` | Consumes the owned receipt and transfers `blastSUI` to the explicit recipient. | `test/blast-sui-transactions.test.ts` |
| `deposit_receipt::cancel` | `BlastSuiCalls.cancelDepositReceipt`; `BlastSuiTransactions.cancelDepositReceipt` | Consumes the owned receipt and transfers returned SUI to the explicit recipient. | `test/blast-sui-transactions.test.ts` |
| `vault::donate_sui` | `BlastSuiCalls.donateSui`; `BlastSuiTransactions.donateSui` | No returned object. | `test/blast-sui-transactions.test.ts` |
| `vault::top_up_fun_reserve` | `BlastSuiCalls.topUpFunReserve`; `BlastSuiTransactions.topUpFunReserve` | No returned object; takes no `SuiSystemState`. | `test/blast-sui-transactions.test.ts` |
| `vault::redeem_blast_sui` | `BlastSuiCalls.redeemBlastSui`; `BlastSuiTransactions.redeemBlastSui` | Returns SUI and transfers it to the explicit recipient. | `test/blast-sui-transactions.test.ts` |
| `vault::sync` | `BlastSuiCalls.syncVault`; `BlastSuiTransactions.syncVault` | No returned object. | `test/blast-sui-transactions.test.ts` |
| `vault::apply_redeem_fee` | `BlastSuiCalls.applyRedeemFee`; `BlastSuiTransactions.applyRedeemFee` | Permissionless once the scheduled fee is ready. | `test/blast-sui-transactions.test.ts` |
| `vault::apply_validator` | `BlastSuiCalls.applyValidator`; `BlastSuiTransactions.applyValidator` | Permissionless once the pool admission is ready; emits `VaultSynced` without a refresh. | `test/blast-sui-transactions.test.ts` |
| `vault::apply_validator_delay` | `BlastSuiCalls.applyValidatorDelay`; `BlastSuiTransactions.applyValidatorDelay` | Permissionless once the scheduled delay is ready. | `test/blast-sui-transactions.test.ts` |
| `vault::schedule_redeem_fee` | `BlastSuiCalls.scheduleRedeemFee`; `BlastSuiTransactions.scheduleRedeemFee` | Signs in as `FeeAdmin`; rejects fees above 100 bps before building. | `test/blast-sui-transactions.test.ts` |
| `vault::cancel_redeem_fee` | `BlastSuiCalls.cancelRedeemFee`; `BlastSuiTransactions.cancelRedeemFee` | Signs in as `CancelAdmin`. | `test/blast-sui-transactions.test.ts` |
| `vault::schedule_validator` | `BlastSuiCalls.scheduleValidator`; `BlastSuiTransactions.scheduleValidator` | Signs in as `ValidatorAdmin`; admission waits for the validator delay. | `test/blast-sui-transactions.test.ts` |
| `vault::cancel_validator` | `BlastSuiCalls.cancelValidator`; `BlastSuiTransactions.cancelValidator` | Signs in as `CancelAdmin`; drops a pending admission. | `test/blast-sui-transactions.test.ts` |
| `vault::remove_validator` | `BlastSuiCalls.removeValidator`; `BlastSuiTransactions.removeValidator` | Signs in as `ValidatorAdmin`; takes effect at once, unwinding a listed pool (`PoolUnwound`) or dropping a pending admission. | `test/blast-sui-transactions.test.ts` |
| `vault::schedule_validator_delay` | `BlastSuiCalls.scheduleValidatorDelay`; `BlastSuiTransactions.scheduleValidatorDelay` | Signs in as `ValidatorAdmin`. | `test/blast-sui-transactions.test.ts` |
| `vault::cancel_validator_delay` | `BlastSuiCalls.cancelValidatorDelay`; `BlastSuiTransactions.cancelValidatorDelay` | Signs in as `CancelAdmin`. | `test/blast-sui-transactions.test.ts` |
| `vault::unpause` | `BlastSuiCalls.unpause`; `BlastSuiTransactions.unpause` | Signs in as the package `UnpauseAdmin`; bits are fun mint 1, request 2, claim 4. | `test/blast-sui-transactions.test.ts` |

Every Blast SUI vault call targets the current package and takes the mutable
`Vault` and immutable `PackageVersion` first, then the framework
`SuiSystemState` or `Clock` its Move signature requires; `unpause` takes the
`Vault` immutably and `PackageVersion` mutably. Admin calls sign in through
`blast_admin` with a typed `blast_sui_domain` witness. Transaction tests inspect
the exact argument order, shared mutability and result routing for every call.

### Arithmetic

| Contract formula | SDK implementation | Verification |
| --- | --- | --- |
| Usable native rate (both components positive) | `isUsableRate` | `test/blast-sui-math.test.ts` |
| Blast shares out, round down | `blastSharesOutDown` | `test/blast-sui-math.test.ts` |
| Gross SUI out, round down | `blastGrossSuiOutDown` | `test/blast-sui-math.test.ts` |
| Redemption fee, round up | `blastRedeemFeeUp` | `test/blast-sui-math.test.ts` |
| Complete redemption quote | `blastRedemptionQuote` | `test/blast-sui-math.test.ts` |
| SUI at a usable native pool rate, round down | `suiAtRateDown` | `test/blast-sui-math.test.ts` |
| Pool tokens at a usable native pool rate, round down | `poolTokensAtRateDown` | `test/blast-sui-math.test.ts` |
| Fun conversion-loss bound at a usable rate, round up | `funConversionLossBoundUp` | `test/blast-sui-math.test.ts` |
| Pool tokens required for SUI, round up and cap by holdings after checked conversion | `poolTokensForSuiUp` | `test/blast-sui-math.test.ts` |

All atomic protocol inputs and outputs use `bigint`. The rate helpers throw on
an unusable rate, as the vault never applies one. Contract execution remains
authoritative, and these helpers do not duplicate mutable admission policy.

### Wrapped events

All rows validate the `blast_events::Event<T>` envelope, current emitter
package, original payload package, ordered fields/types, native event
position, and their named reducer path. Every custody snapshot lists each
listed pool with its exchange rate and fun/blast positions.

| Contract payload | Typed decoder and projection effect | Verification |
| --- | --- | --- |
| `VaultCreated` | `decodeBlastSuiEvent`; vault, validator, bootstrap pool, reserves, fee and custody discovery | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `FunSuiMinted` | `decodeBlastSuiEvent`; listed-pool check, final custody, mint total | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `FunSuiRedeemed` | `decodeBlastSuiEvent`; final custody, fun redemption total | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `BlastSuiDepositRequested` | `decodeBlastSuiEvent`; listed-pool check, receipt lifecycle, principal total | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `BlastSuiDepositClaimed` | `decodeBlastSuiEvent`; receipt claim, pool-token, contribution and shares totals | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `BlastSuiDepositCancelled` | `decodeBlastSuiEvent`; receipt cancellation, returned-SUI total | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `BlastSuiDonated` | `decodeBlastSuiEvent`; final custody, donation total | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `FunReserveToppedUp` | `decodeBlastSuiEvent`; final custody, top-up total | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `BlastSuiRedeemed` | `decodeBlastSuiEvent`; final custody, blast/gross/fee/net totals | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `FunYieldSwept` | `decodeBlastSuiEvent`; final custody, swept-yield total | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `VaultSynced` | `decodeBlastSuiEvent`; final custody, sync count | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `PoolUnwound` | `decodeBlastSuiEvent`; final custody after a removed pool unwinds | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |

`decodeBlastSuiDelayedEvent` decodes the vault's `blast_admin` delayed events:
the `RedeemFee` setting and the `Validators` set. The reducer tracks the
pending redeem fee from schedule, cancel and apply; validator membership comes
from the custody snapshot pools, so set events are recorded and ignored.

`createBlastSuiProjection` and `reduceBlastSuiInput` replace final custody
snapshots, accumulate independent audit totals, and deduplicate by transaction
digest plus event index. Duplicate replay returns the same projection instance.
Replay rejects a mint or request whose pool is not listed, duplicate receipt
requests, unknown or terminal transitions, vault or principal mismatches, and
redemption totals that do not satisfy `gross = fee + net` before it applies an
event.

### Native facts that events do not prove

| Required fact | Explicit SDK input | Why it is not event-derived | Verification |
| --- | --- | --- | --- |
| Native event ordering metadata | `SuiEventPosition` with `checkpoint: bigint`, transaction digest, and event index | Sui provides ordering and replay identity; Blast adds no application sequence. | `test/common-events.test.ts` and every event test |
| Current Blast SUI deposit-receipt owner | `BlastSuiNativeFact` kind `depositReceiptOwnership`, `source: "objectOwnership"` | A request event and `deposit_receipt::keep` do not prove current ownership. | `test/blast-sui-reducer.test.ts` |
| Deleted Blast SUI deposit receipt | `BlastSuiNativeFact` kind `depositReceiptDeleted`, `source: "transactionEffects"` | Claim and cancellation events do not prove native object deletion or its transaction provenance. | `test/blast-sui-reducer.test.ts` |
| Blast SUI returned coin IDs and recipients | `BlastSuiNativeFact` kind `returnedCoinRecipient`, `source: "transactionEffects"` | Product events do not identify returned coin objects or recipients. | `test/blast-sui-reducer.test.ts` |

Native facts are stored separately from decoded Blast events and are independently
deduplicated. Reducers do not infer ownership, returned-object routing,
publication effects, deletion, or sharing from an event that does not contain
that fact.

The canonical manifest is backed by the [November 6 deployment record](https://github.com/interest-protocol/blast-v2-contracts/blob/main/deployments/sui/mainnet/2026-11-06-canonical-launch-stack.json). Auto-LP compounding now requires an `AutoLpAdmin` cap and inclusive Q64.64 price bounds; its private entry consumes and re-shares the pool. Collection stays permissionless.
