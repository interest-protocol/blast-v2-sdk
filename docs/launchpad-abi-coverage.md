# Production Sui ABI coverage

## Baseline

The frozen production ABI uses contracts commit
`a5ed34ad49c6c001af2db5b9cbcb206075704412`. The two parity artifacts are:

- `abi/production-launchpad-v1.json` for `launchpad`, `meme_template`, and the
  migrators package (Cetus and Bluefin adapters, LP vault, LP-fee policy, and
  holder rewards); and
- `abi/production-blast-sui-v1.json` for `blast_sui`.

Both artifacts record Sui CLI `1.77.2-51d177ad7d65`. The checker verifies
the installed `sui --version` against those artifact values before it runs a
Move summary. The contracts working tree differed from the ABI commit when the
artifacts were frozen. The only
differences were `sui/meme_template/Move.lock` and
`docs/research/sui-deepbook-indexer-architecture-2026.md`. They do not change a
production function, object layout, or event schema. Contracts commit
`02cd182463629bc6977a097a2ab235ed765c9f01` adds ABI documentation only and does
not change the frozen production code.

Administrator functions take `&AdminWitness<Role>` for one `blast_fun_domain`
role type, which `blast_admin::blast_acl::sign_in<Role>` returns against the one
shared `ACL` (contracts ADR 0097); the migrators package uses the launchpad's
roles. `LaunchpadCalls.signIn(role, { adminCap })` builds that call for every
launchpad and migrators admin builder.

Move calls use the current package ID. Type names, event types, object schemas,
migration witnesses, venue markers, and venue-tier dynamic-field keys use the
original package ID. The deployment model stores both IDs.

## Function coverage

### Launchpad, Meme template, and migrators

| Contract surface | SDK implementation | Verification | Status or reason |
| --- | --- | --- | --- |
| `cetus::new`, `bluefin::new`; `launch::set_virtual_quote`, `set_graduation_target`, `set_allocation_plan`, `set_lp_fee_split`, `set_opening_round`, `set_partner`, `finalize`, `buy`, `join_opening_round`, `share` | `MigratorCalls.newCetusLaunch`, `newBluefinLaunch`; `LaunchpadCalls` setters, `finalizeLaunch`, `shareLaunch`, `completeLaunch`; `addLaunchCompletion`; `MigratorTransactions.createCetusLaunch`, `createBluefinLaunch` | `test/migrators-transactions.test.ts`, `test/transactions.test.ts` | Complete atomic start-configure-finalize-share transaction. `finalize` takes the exact `LaunchConfig` creation fee as a gas-paid `Coin<SUI>`. Before share, a launch without an opening round takes an optional routed purchase; one with an opening round takes the creator's bid instead, and the builder rejects the other combination. |
| `allocation::recipient`, `plan`, `route`, `fee_split`; `bps::new` | `LaunchpadCalls.allocationPlan`, `feeSplit`, `bps` | `test/transactions.test.ts`, `test/allocation.test.ts` | Compositional constructors; inputs are checked like the Move constructors first. |
| `allocation` getters and `apportion_fee_split` | `normalizeAllocationPlan`, `addProtocolAllocation`, `requireCompletePlan`, `normalizeFeeSplit`, `apportionMeme`, `apportionQuote`, `apportionFeeSplit`, `previewFeeCollection` | `test/allocation.test.ts` | Move-composition; mirrored off chain against the Move vectors. Blast's explicit `protocol_meme_bps` and `protocol_quote_bps` round up (ADR 0098). |
| `launch::buy` | `LaunchpadCalls.buy`; `LaunchpadTransactions.buy`; `previewBuy` | `test/transactions.test.ts`, `test/curve.test.ts` | Complete builder and arithmetic preview; `buy` takes no `Clock` (ADR 0093). |
| `launch::sell` | `LaunchpadCalls.sell`; `LaunchpadTransactions.sell`; `previewSell` | `test/transactions.test.ts`, `test/curve.test.ts` | Complete builder and arithmetic preview. |
| `launch::join_opening_round`, `settle_opening_round`, `deliver_opening_round` | `LaunchpadCalls` and `LaunchpadTransactions` `joinOpeningRound`, `settleOpeningRound`, `deliverOpeningRound` (many bidders per PTB); `previewOpeningRoundSettlement`, `previewOpeningRoundDelivery`; `getOpeningRoundBid` | `test/transactions.test.ts`, `test/curve.test.ts`, `test/state.test.ts` | Complete builders. Previews mirror the single pot purchase (a pot below one Meme atom is held whole) and the rounded-down pro-rata delivery whose last bidder takes the remainder. |
| `launch::claim_creator_caps` | `encodeCreatorClaimMessage`, `encodeCreatorClaimAttestation`; `LaunchpadCalls.claimCreatorCaps`; `LaunchpadTransactions.claimCreatorCaps` | `test/creator-claim.test.ts`, `test/transactions.test.ts` | Routes `CurveFeeCap` and `BlastMetadataCap`; current ownership is a native object fact. |
| `launch::claim_creator_fees` | `LaunchpadCalls.claimCreatorFees`; `LaunchpadTransactions.claimCreatorFees` | `test/transactions.test.ts` | Passes the live `CurveFeeCap` and routes both returned coins. |
| `launch::set_name`, `set_description`, `set_icon_url` | `LaunchpadCalls` and `LaunchpadTransactions` `setName`, `setDescription`, `setIconUrl` | `test/transactions.test.ts` | Pass the live `BlastMetadataCap` and the mutable `Currency<Meme>`. |
| `launch::claim_protocol_fees`, `claim_protocol_fees_with_partner` | `LaunchpadCalls.claimProtocolFees`, `claimProtocolFeesWithPartner`; `LaunchpadTransactions.claimProtocolFees` with an optional `partner` | `test/transactions.test.ts` | Composes `blast_admin::blast_acl::sign_in<TreasuryAdmin>` and routes the Meme, Quote, and SUI coins. The partner variant passes the immutable shared `Partner` and the `Clock`. |
| `launch::new`, `treasury_cap_mut`, `migrate` | Adapter entries | `test/migrators-transactions.test.ts` | Adapter composition: only the adapter module can construct its witness. |
| Launch getters, `launch::assert_curve_fee_cap`, `bps::*`, `creator_authority::destroy_*` | `decodeLaunchObject`, `getOpeningRoundBid`, reducers | `test/state.test.ts`, `test/migrators-state.test.ts` | Move-composition; the SDK reads BCS state instead. `blast_fun_domain` roles are types (ADR 0097) that `LaunchpadCalls.signIn(role, …)` names. |
| `launch_config::set_protocol_allocation`, `set_meme_decimals_allowed`, `set_quote_allowed`, `set_trade_fees`, `set_creation_fee`, `add_partner`, `remove_partner`, `set_migration_witness_allowed` | `LaunchpadCalls` and `LaunchpadTransactions` `setProtocolAllocation`, `setMemeDecimalsAllowed`, `setQuoteAllowed`, `setTradeFees`, `setCreationFee`, `addPartner`, `removePartner`, `setMigrationWitnessAllowed` | `test/transactions.test.ts` | Admin builders with the mutable `LaunchConfig`; each signs in with the one role its Move function names (`TreasuryAdmin`, `ListingAdmin`, `FeeAdmin`, or `AdapterAdmin`). |
| `launch::reassign_curve_fee_cap`, `reassign_metadata_cap`; `runtime_config::*`; `package_admin::*` | None | ABI classifier | Intentional administration exclusions; replay uses their events. |
| `launch_ticket::new` | Compiled Meme template and `LaunchpadTransactions.publishMeme` | `test/template.test.ts`, `test/transactions.test.ts` | The template initializer constructs the ticket at the selected decimals; publication effects identify the transferred ticket. |
| `creator_authority::new_address`, `new_account` | Compiled Meme template | `test/template.test.ts` | Template-internal constructors. |
| Cetus `migrate`, `collect_fees`, `settle_and_update_fee_split` (type arguments `<Meme, Quote, CoinA, CoinB>`, ADR 0100) | `migrateCetus`, `collectCetusFees`, `settleAndUpdateCetusFeeSplit` with `memeSide` | `test/migrators-transactions.test.ts` | Migration takes the mutable LP Burn `BurnManager`; collection and split updates take it immutably with the `Clock`, and the mutable Meme `Currency` to burn the burn share. |
| Bluefin `migrate`, `collect_fees`, `settle_and_update_fee_split` | `migrateBluefin`, `collectBluefinFees`, `settleAndUpdateBluefinFeeSplit` | `test/migrators-transactions.test.ts` | Migration pays the exact SUI pool-creation fee from gas; collection and split updates take the mutable Meme `Currency`. |
| Cetus `buyback_and_burn` (same four type arguments), Bluefin `buyback_and_burn` | `buybackAndBurnCetus` with `memeSide`, `buybackAndBurnBluefin` | `test/migrators-transactions.test.ts` | Admin builders composing `sign_in<BuybackAdmin>`; the caller sets `minMemeOut` from an off-chain price. |
| `vault::claim_creator_fees`, `vault::claim_protocol_fees` | `MigratorCalls` and `MigratorTransactions` claim methods | `test/migrators-transactions.test.ts` | The creator claim passes the read-only launch and its live `CurveFeeCap`; the residual claim composes `sign_in<TreasuryAdmin>`; both route the returned coins. |
| `lp_fee_policy::set_default_shares`, `set_coin_shares`, `clear_coin_shares`, `set_protocol_destination` | `setLpFeeDefaultShares`, `setLpFeeCoinShares`, `clearLpFeeCoinShares`, `setLpFeeProtocolDestination` | `test/migrators-transactions.test.ts` | Admin builders with the mutable `LpFeePolicy`: the share setters compose `sign_in<FeeAdmin>`, the destination setter `sign_in<TreasuryAdmin>`. |
| `blast_holder_rewards::publish_round`, `claim` | `publishHolderRewardRound`, `claimHolderReward`, `claimHolderRewards` | `test/migrators-transactions.test.ts`, `test/holder-rewards-operator.test.ts` | Publication composes `sign_in<RewardsAdmin>` and validates the manifest and its vault; relays carry positional proofs. |
| `vault` and `lp_fee_policy` state (no public getters) | `decodeLpVaultObject`, `getLpFeePolicy`, `getLpFeeShares` | `test/migrators-state.test.ts` | The SDK reads BCS state. |
| Migrators `package_admin::*` | None | ABI classifier | Intentional administration exclusions (`UpgradeAdmin`). |

The SDK provides `sqrtPriceX64` and `autoLpFixedSide` as exact preview mirrors
of the package-only `migration_math` functions; `test/migration-math.test.ts`
verifies them against the contract vectors.

### Blast SUI product operations

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

Every Blast SUI call targets the current package, uses the mutable framework
`SuiSystemState`, mutable `Vault`, and immutable `PackageVersion` required by
its Move signature, and adds no type argument that the ABI does not define.
Transaction tests inspect the exact argument order and shared mutability for
all nine calls. They also pin the exact `Result` or `NestedResult`, normalized
recipient, and request-result-to-`keep` routing for every returned object.

## Object, type, read, and deployment coverage

| Frozen object or type boundary | SDK implementation | Verification |
| --- | --- | --- |
| `Launch<Meme, Quote>` shared mutable object, `Lifecycle` (with `OpeningRound`), `FeeLedger` (with `protocol_sui`), and `OpeningRoundBidKey` | `launchBcs`, `decodeLaunchObject`, `getLaunch`, `getOpeningRoundBid` | `test/state.test.ts`, `test/object-layout.test.ts` |
| `LaunchConfig` shared singleton | `launchConfigBcs`, `getLaunchConfig`, `LaunchpadClient.getLaunchConfig` (the exact creation fee) | `test/state.test.ts` |
| `blast_partners::Partner` shared object | Immutable `partner` reference for `setPartner`, `addPartner`, `removePartner`, and `claimProtocolFeesWithPartner`; a launch names it as `partnerId` | `test/transactions.test.ts`, `test/state.test.ts` |
| `LaunchTicket<Meme>` owned object and `LaunchInitializer<Meme, Quote>` linear value | Meme publication and adapter launch builders | `test/template.test.ts`, `test/migrators-transactions.test.ts`; ticket identity comes from publication effects |
| `AllocationPlan`, `ProtocolAllocation`, `FeeSplit`, `Bps` | `allocationPlanBcs`, `protocolAllocationBcs`, `feeSplitBcs`, `bpsBcs` and the constructor builders | `test/allocation.test.ts`, `test/transactions.test.ts`, `test/object-layout.test.ts` |
| `CurveFeeCap<Meme>`, `BlastMetadataCap<Meme>` owned objects | creator-cap, fee-claim, metadata, split-update builders; live IDs decoded as `curveFeeCapId`, `blastMetadataCapId` | `test/transactions.test.ts`, `test/state.test.ts`; current owner is a native ownership fact |
| `LpVault<Meme, Quote>` shared mutable object | `lpVaultBcs`, `decodeLpVaultObject`, `getLpVault` | `test/migrators-state.test.ts`, `test/migrators-client.test.ts` |
| `LpFeePolicy` shared singleton and its per-coin table | `lpFeePolicyBcs`, `getLpFeePolicy`, `getLpFeeShares` | `test/migrators-state.test.ts` |
| `blast_holder_rewards::Round<Meme, Quote>` shared object | `rewardRoundBcs`, `decodeRewardRound`, `getRewardRound` | `test/holder-rewards-chain.test.ts` |
| `VenueConfig` (Cetus `PoolCreationCap` custody) | `migratorsDeployment`; mutable in `cetus::new`, immutable at migration | `test/deployments.test.ts`, `test/migrators-transactions.test.ts` |
| Launchpad, `blast_admin`, `blast_partners`, `blast_fun_timelock`, and migrators package identities; the shared `blast_acl::ACL` and other shared-object identities | `launchpadDeployment`, `migratorsDeployment` | `test/deployments.test.ts`; generated Meme packages list the timelock, admin, partners, and launchpad packages as publish dependencies (`test/template.test.ts`) |
| Venue `Witness` | `MigratorCalls.migrationWitnessType` | original-package witness type |
| Blast SUI `vault::Vault` shared mutable object | `blastSuiVaultBcs`, `decodeBlastSuiVaultObject`, `getBlastSuiVault`, `BlastSuiClient.getVault` | `test/blast-sui-state.test.ts` pins independent literal BCS bytes to the contracts baseline and Sui revision; `test/blast-sui-client.test.ts` reuses that golden. |
| `deposit_receipt::BlastSuiDepositReceipt` address-owned object | `blastSuiDepositReceiptBcs`, `decodeBlastSuiDepositReceiptObject`, `getBlastSuiDepositReceipt`, `BlastSuiClient.getDepositReceipt` | `test/blast-sui-state.test.ts` pins independent literal BCS bytes to the contracts baseline and Sui revision; `test/blast-sui-client.test.ts` reuses that golden. |
| `fun_sui::FUN_SUI` original-package type | `funSuiType` and transaction coin selection | `test/blast-sui-math.test.ts`, `test/blast-sui-transactions.test.ts` |
| `blast_sui::BLAST_SUI` original-package type | `blastSuiType` and transaction coin selection | `test/blast-sui-math.test.ts`, `test/blast-sui-transactions.test.ts` |
| Deposit-receipt original-package type | `blastSuiDepositReceiptType` and state/event validation | `test/blast-sui-math.test.ts`, `test/blast-sui-state.test.ts` |
| Blast SUI package, `PackageVersion`, `PackageAdmin`, and `Vault` identity slots; administration signs in against the deployment's one shared `acl` | optional `BlastPackages.blastSui` and distinctly named optional shared identities; `blastSuiDeployment` returns the call-ready immutable version and mutable vault | `test/deployments.test.ts`, `test/blast-sui-math.test.ts` |
| Framework `SuiSystemState` | native system-object helper with initial shared version 1 and mutable input | `test/blast-sui-transactions.test.ts` |

`BLAST_DEPLOYMENTS` remains empty. Deployment helpers validate caller-supplied
identities only and perform no publish, deploy, upgrade, or configuration call.

## Blast SUI arithmetic coverage

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

## Event and replay coverage

### Existing launchpad and migrator events

| Frozen event surface | SDK implementation | Verification |
| --- | --- | --- |
| 27 wrapped launchpad payloads: `Bought`, `CreationFeeChanged`, `CreatorCapsClaimed`, `CreatorClaimSignerSet`, `CreatorFeesClaimed`, `CurveFeeCapReassigned`, `LaunchCreated`, `LaunchShared`, `LaunchTicketCreated`, `LaunchTradeFeesChanged`, `MemeDecimalsSet`, `MemeMetadataUpdated`, `MetadataCapReassigned`, `Migrated`, `MigrationAllocationPaid`, `MigrationWitnessSet`, `OpeningRoundDelivered`, `OpeningRoundJoined`, `OpeningRoundSettled`, `PartnerAdded`, `PartnerRemoved`, `ProtocolAllocationSet`, `ProtocolFeesAccrued`, `ProtocolFeesClaimed`, `ProtocolFeeShareChanged`, `QuoteSet`, `Sold` | `launchpadEventSpecs`, `launchpadEventBcs`, `decodeLaunchpadEvent`, `reduceLaunchpadEvent` | `test/launchpad-events.test.ts` checks names, ordered fields/types, decoding, and every reducer path. |
| Thirteen direct migrator payloads in `blast_events`: `AutoLiquidityAdded`, `AutoLpPositionOpened`, `BuybackBurned`, `CetusPoolReserved`, `CreatorFeesClaimed`, `FeeSplitChanged`, `FeesCollected`, `LpFeeDestinationChanged`, `LpFeePolicyChanged`, `ProtocolFeesClaimed`, `RewardPaid`, `RoundPublished`, `VaultCreated` | `migratorEventSpecs`, `migratorEventBcs`, `decodeMigratorEvent`, `reduceMigratorEvent` | `test/migrator-events.test.ts` checks names, ordered fields/types, decoding, and every reducer path. |
| Ordered launch-to-vault replay | `reduceLaunchpadProductInput` | launchpad and migrator replay tests reconstruct launch lifecycle (including the opening round, its pot, and each undelivered bidder), reserves, launch trade, creation, and one-time migration fees, allocation payouts, migration, vault/pool/position identity, residuals and liquidity (the vault linked to its launch by Meme type on `VaultCreated`), split generations, creator/auto-LP/rewards balances, holder-reward rounds, and LP-fee policy. Actor identities omitted from payloads are reconstructed from native event senders. |

Launchpad and migrator decoders authenticate an event by its type, which names
the original package. Sui records the transaction's called package and module on
each event rather than the emitting module, and adapters emit the launchpad's
`MigrationAllocationPaid`, `ProtocolFeesAccrued`, and `Migrated` from their own
migrators entries. An opening-round settlement's pot purchase emits `Bought`
before `OpeningRoundSettled` in the same transaction; the reducer keeps the
`MigrationReady` lifecycle that purchase may set.

### Blast SUI wrapped events

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
| Package publication and created singleton objects | launchpad `PackagePublicationFact`, `source: "transactionEffects"` | Publication/object creation is in transaction effects. | `test/launchpad-events.test.ts` |
| Current creator capability owner | launchpad `CreatorCapOwnershipFact`, `source: "objectOwnership"` | Events record issuance, not current ownership. | `test/launchpad-events.test.ts` |
| Returned launchpad/migrator claim-coin recipients | `ReturnedCoinRecipientsFact`, `source: "transactionEffects"` | Events record amounts, not created coin IDs or recipients. | launchpad/migrator replay tests |
| Current Blast SUI deposit-receipt owner | `BlastSuiNativeFact` kind `depositReceiptOwnership`, `source: "objectOwnership"` | A request event and `deposit_receipt::keep` do not prove current ownership. | `test/blast-sui-reducer.test.ts` |
| Deleted Blast SUI deposit receipt | `BlastSuiNativeFact` kind `depositReceiptDeleted`, `source: "transactionEffects"` | Claim and cancellation events do not prove native object deletion or its transaction provenance. | `test/blast-sui-reducer.test.ts` |
| Blast SUI returned coin IDs and recipients | `BlastSuiNativeFact` kind `returnedCoinRecipient`, `source: "transactionEffects"` | Product events do not identify returned coin objects or recipients. | `test/blast-sui-reducer.test.ts` |

Native facts are stored separately from decoded Blast events and are independently
deduplicated. Reducers do not infer ownership, returned-object routing,
publication effects, deletion, or sharing from an event that does not contain
that fact.

## Intentional exclusions

| Frozen surface or proposed layer | Status and reason |
| --- | --- |
| `runtime_config` setters (an empty signer key revokes); launch cap reassignment | Intentional routine-administration exclusion. Product transactions do not need these calls. Their event schemas remain frozen and decoded. |
| All launchpad and migrators `package_admin` functions | Intentional package-upgrade exclusion. |
| Blast SUI `package_admin::{add_capability,authorize_upgrade,commit_upgrade_and_advance,make_immutable,restrict_to_additive}` | Intentional package-custody exclusion. Administration signs in to the shared `blast_admin::blast_acl::ACL` with Blast SUI's typed roles (ADR 0097). `PackageCapabilityAdded` remains decoded. |
| Blast SUI `vault::set_redeem_fee` | Intentional routine-administration exclusion. The live fee is available in vault state and events. |
| Blast SUI `vault::create` and `deposit_receipt::create_display` | Intentional deployment-bootstrap exclusions. No deployment transaction is built or executed. |
| Contract changes for SDK convenience | Excluded. This slice changes no Move logic. |
| Deployment/publish/upgrade/configuration actions and placeholder IDs | Excluded. The registry has no deployment record or placeholder identity. |
| Indexer process, database, API, backend, frontend wiring, and duplicated API formulas | Excluded. Protocol arithmetic remains in this SDK. |

## Remaining work before the indexer and API

No Blast V2 contract is deployed for this release, and the SDK has no canonical
network deployment entry. Before an indexer or API begins:

1. Publish the required packages and generated Meme package through an approved
   release process. Capture real current/original package IDs and shared-object
   identities from successful publication effects.
2. Verify returned, transferred, shared, and deleted object identities from
   transaction effects, including tickets, capabilities, receipts, vaults, and
   package-administration objects.
3. Run live transaction simulation or dev-inspect coverage against the published
   package generation. Complete the migrator mainnet matrix for both launch
   starts, all three migration routes, all three collection and all three
   split-update routes, both LP-vault claims, and holder-reward publication and
   claims.
4. Write normalized deployment records with chain ID, package lineage,
   transaction digests, shared-object initial versions, custodians, toolchain,
   source commit, and post-deploy verification. Only then add real entries to
   `BLAST_DEPLOYMENTS`.
5. Configure the later indexer to consume the typed event decoders plus explicit
   native ownership, transaction-effect, and object-read facts. Persist native
   event identity for idempotence.
6. Keep protocol arithmetic in this SDK. A later API may expose SDK results but
   must not copy the formulas.
