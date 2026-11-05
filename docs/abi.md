# Sui ABI coverage

The SDK mirrors the frozen Sui ABI of every Blast package without becoming a
second source of truth for protocol execution. Contract objects and completed
events stay authoritative.

## One ABI track

`scripts/check-contract-abi.mjs` extracts the contracts repository
([interest-protocol/blast-v2-contracts](https://github.com/interest-protocol/blast-v2-contracts))
at the baseline commit with `git archive`, runs `sui move summary` on each
package with the pinned Sui CLI `1.77.2-51d177ad7d65`, classifies every public
function and event, and compares the result byte for byte with `abi/`.
`npm run check:abi` reads `../blast-v2-contracts` (or `BLAST_CONTRACTS_DIR`); CI
checks out the commit pinned in `.github/workflows/check.yml`.

The launch stack is frozen at contracts
[`88951fe`](https://github.com/interest-protocol/blast-v2-contracts/tree/88951fe9dbe2b621d45bb80124a325468c6e8298/sui)
(ADR 0137 with its 2026-11-05 amendment, PRs #178-#214):

| Artifact | Move packages | Events |
| --- | --- | --- |
| `abi/production-admin-v1.json` | `blast_admin` | 36 (15 `blast_admin_events` + 21 delayed-module lifecycle events) |
| `abi/production-partners-v1.json` | `blast_partners` | 5 |
| `abi/production-core-v1.json` | `blast_core` | 1 (`ProtocolFeesPaid`) |
| `abi/production-vault-v1.json` | `blast_vault` | 10 |
| `abi/production-migrators-v1.json` | `blast_migrators` (Cetus and Bluefin, for both products) | 2 |
| `abi/production-launchpad-v1.json` | `blast_fun`, `launch_ticket_template`, `coin_template` | 18 |
| `abi/production-presale-v1.json` | `blast_presale` | 11 (`PresaleCreated` + 10 `events`) |
| `abi/production-aftermath-dao-presale-v1.json` | `blast_aftermath_dao_presale` | 2 |

`blast_sui` and the three Boosts packages adopt the generic package
administration separately; `abi/production-blast-sui-v1.json` and
`abi/production-boosts-v1.json` stay frozen at contracts `01d7659`. `sui/vesting`
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
| `builder` | An SDK `*Calls` method builds it; `test/abi.ts#assertBuildersMatchAbi` checks type and value arity, and the shared mutability of every `PackageVersion` argument. |
| `compositional` | A value built inside a PTB for another call (`bps::new`, `fee_split::*`, `payout::recipient`, `allocation::plan`). |
| `read` | A reader the SDK mirrors from object BCS or constants. |
| `move-composition` | Callable only from Move: it takes a package or venue witness, or embeds a value in another object (`delayed*`, `package_version`, `partner_list`, `vault::new`, `migration::*`). |
| `template-builder`, `template-internal` | Called by the generated Meme package's initializer. |
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

| Frozen contract surface | SDK implementation | Returned-object routing | Verification |
| --- | --- | --- | --- |
| `vault::mint_fun_sui` | `BlastSuiCalls.mintFunSui`; `BlastSuiTransactions.mintFunSui` | The composable call returns the `funSUI` coin; the transaction transfers it to the explicit recipient. | `test/blast-sui-transactions.test.ts` |
| `vault::redeem_fun_sui` | `BlastSuiCalls.redeemFunSui`; `BlastSuiTransactions.redeemFunSui` | The composable call returns SUI; the transaction transfers it to the explicit recipient. | `test/blast-sui-transactions.test.ts` |
| `vault::request_blast_sui` | `BlastSuiCalls.requestBlastSui`; `BlastSuiTransactions.requestBlastSui` | The returned receipt is passed to `deposit_receipt::keep` in the same PTB and becomes sender-owned; no generic transfer is invented. | `test/blast-sui-transactions.test.ts` |
| `deposit_receipt::keep` | `BlastSuiCalls.keepDepositReceipt` | Intentionally compositional because it consumes the key-only receipt returned by `request_blast_sui` in the same PTB. | `test/blast-sui-transactions.test.ts` |
| `vault::claim_blast_sui` | `BlastSuiCalls.claimBlastSui`; `BlastSuiTransactions.claimBlastSui` | Consumes the owned receipt and transfers the returned `blastSUI` coin to the explicit recipient. | `test/blast-sui-transactions.test.ts` |
| `deposit_receipt::cancel` | `BlastSuiCalls.cancelDepositReceipt`; `BlastSuiTransactions.cancelDepositReceipt` | Consumes the owned receipt and transfers returned SUI to the explicit recipient. | `test/blast-sui-transactions.test.ts` |
| `vault::donate_sui` | `BlastSuiCalls.donateSui`; `BlastSuiTransactions.donateSui` | No returned object and no synthetic transfer. | `test/blast-sui-transactions.test.ts` |
| `vault::redeem_blast_sui` | `BlastSuiCalls.redeemBlastSui`; `BlastSuiTransactions.redeemBlastSui` | Returns SUI and transfers it to the explicit recipient. | `test/blast-sui-transactions.test.ts` |
| `vault::sync` | `BlastSuiCalls.syncVault`; `BlastSuiTransactions.syncVault` | No returned object and no synthetic transfer. | `test/blast-sui-transactions.test.ts` |
| `vault::set_redeem_fee` | `BlastSuiCalls.setRedeemFee`; `BlastSuiTransactions.setRedeemFee` | Signs in as the typed `blast_sui_domain::FeeAdmin` through the singleton ACL. | `test/blast-sui-transactions.test.ts` |

Every Blast SUI call targets the current package, uses the mutable framework
`SuiSystemState`, mutable `Vault`, and immutable `PackageVersion` required by
its Move signature, and adds no type argument that the ABI does not define.
Transaction tests inspect the exact argument order and shared mutability for
all nine calls. They also pin the exact `Result` or `NestedResult`, normalized
recipient, and request-result-to-`keep` routing for every returned object.

### Arithmetic

| Frozen formula | SDK implementation | Verification |
| --- | --- | --- |
| Blast shares out, round down | `blastSharesOutDown` | `test/blast-sui-math.test.ts` |
| Gross SUI out, round down | `blastGrossSuiOutDown` | `test/blast-sui-math.test.ts` |
| Redemption fee, round up | `blastRedeemFeeUp` with branded `BasisPoints` | `test/blast-sui-math.test.ts`, `test/integers.test.ts` |
| Complete redemption quote | `blastRedemptionQuote` | `test/blast-sui-math.test.ts` |
| SUI at native pool rate, round down | `suiAtRateDown` | `test/blast-sui-math.test.ts` |
| Pool tokens at native pool rate, round down | `poolTokensAtRateDown` | `test/blast-sui-math.test.ts` |
| Fun conversion-loss bound, round up | `funConversionLossBoundUp` | `test/blast-sui-math.test.ts` |
| Pool tokens required for SUI, round up and cap by holdings after checked conversion | `poolTokensForSuiUp` | `test/blast-sui-math.test.ts` |

All atomic protocol inputs and outputs use `bigint`. Contract execution remains
authoritative, and these helpers do not duplicate mutable admission policy.

### Wrapped events

All rows validate the generic `events_wrapper::Event<T>` envelope, current
emitter package, original payload package, ordered fields/types, native event
position, and their named reducer path.

| Frozen payload | Typed decoder and projection effect | Verification |
| --- | --- | --- |
| `PackageCapabilityAdded` | `decodeBlastSuiEvent`; exact typed dynamic child identity | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `VaultCreated` | `decodeBlastSuiEvent`; vault/validator/pool/bootstrap/fee/custody discovery | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `FunSuiMinted` | `decodeBlastSuiEvent`; final custody and cumulative mint input | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `FunSuiRedeemed` | `decodeBlastSuiEvent`; final custody and cumulative fun redemption | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `BlastSuiDepositRequested` | `decodeBlastSuiEvent`; receipt lifecycle and principal total | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `BlastSuiDepositClaimed` | `decodeBlastSuiEvent`; receipt claim, pool-token, contribution, and shares totals | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `BlastSuiDepositCancelled` | `decodeBlastSuiEvent`; receipt cancellation and returned-SUI total | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `BlastSuiDonated` | `decodeBlastSuiEvent`; final custody and donation total | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `BlastSuiRedeemed` | `decodeBlastSuiEvent`; final custody and blast/gross/fee/net totals | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `FunYieldSwept` | `decodeBlastSuiEvent`; final custody and swept-yield total | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `RedeemFeeChanged` | `decodeBlastSuiEvent`; branded live redeem fee | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `VaultSynced` | `decodeBlastSuiEvent`; final custody and sync count | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |
| `NativeStakeUnwound` | `decodeBlastSuiEvent`; final custody and unwind-only state | `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts` |

`createBlastSuiProjection` and `reduceBlastSuiInput` replay all 24 kinds,
replace final custody snapshots, accumulate independent audit totals, and
deduplicate by transaction digest plus event index. Duplicate replay returns the
same projection instance. Receipt replay rejects duplicate requests, unknown or
terminal transitions, vault or principal mismatches, and redemption totals that
do not satisfy `gross = fee + net` before it applies an event.

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
