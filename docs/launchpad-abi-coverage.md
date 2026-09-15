# Production Sui ABI coverage

## Baseline

The frozen production ABI uses contracts commit
`a5ed34ad49c6c001af2db5b9cbcb206075704412`. The three parity artifacts are:

- `abi/production-launchpad-v1.json` for `launchpad`, `meme_template`, and the
  six production migrators;
- `abi/production-vesting-v1.json` for `vesting`; and
- `abi/production-blast-sui-v1.json` for `blast_sui`.

All three artifacts record Sui CLI `1.77.2-51d177ad7d65`. The checker verifies
the installed `sui --version` against those artifact values before it runs a
Move summary. The contracts working tree differed from the ABI commit when the
artifacts were frozen. The only
differences were `sui/meme_template/Move.lock` and
`docs/research/sui-deepbook-indexer-architecture-2026.md`. They do not change a
production function, object layout, or event schema. Contracts commit
`02cd182463629bc6977a097a2ab235ed765c9f01` adds ABI documentation only and does
not change the frozen production code.

Move calls use the current package ID. Type names, event types, object schemas,
migration witnesses, venue markers, and venue-tier dynamic-field keys use the
original package ID. The deployment model stores both IDs.

## Function coverage

### Launchpad, Meme template, and migrators

| Frozen contract surface | SDK implementation | Verification | Status or reason |
| --- | --- | --- | --- |
| `launch::new`, `launch::share` | `LaunchpadCalls.createLaunch`, `shareLaunch`; `LaunchpadTransactions.createLaunch` | `test/transactions.test.ts` | Complete atomic create-and-share transaction. |
| `launch::buy` | `LaunchpadCalls.buy`; `LaunchpadTransactions.buy`; `previewBuy` | `test/transactions.test.ts`, `test/curve.test.ts` | Complete builder and arithmetic preview. |
| `launch::sell` | `LaunchpadCalls.sell`; `LaunchpadTransactions.sell`; `previewSell` | `test/transactions.test.ts`, `test/curve.test.ts` | Complete builder and arithmetic preview. |
| `launch::claim_creator_caps` | `encodeCreatorClaimMessage`, `encodeCreatorClaimAttestation`; `LaunchpadCalls.claimCreatorCaps`; `LaunchpadTransactions.claimCreatorCaps` | `test/creator-claim.test.ts`, `test/transactions.test.ts` | Matches the Move BCS signature fixture and routes `CurveFeeCap` and `BlastMetadataCap`; current ownership is a native object fact. |
| `launch::claim_creator_fees` | `LaunchpadCalls.claimCreatorFees`; `LaunchpadTransactions.claimCreatorFees` | `test/transactions.test.ts` | Passes the live `CurveFeeCap` and routes both returned coins. |
| `launch::set_name`, `set_description`, `set_icon_url` | `LaunchpadCalls` and `LaunchpadTransactions` `setName`, `setDescription`, `setIconUrl` | `test/transactions.test.ts` | Pass the live `BlastMetadataCap` and the mutable `Currency<Meme>`. |
| `launch::reassign_curve_fee_cap`, `reassign_metadata_cap`, `creator_authority::new_lp_fee_cap` | None | ABI classifier | Intentional creator-administration exclusions; replay uses `CurveFeeCapReassigned` and `MetadataCapReassigned`. |
| `launch::lock_creator_fees`, `claim_custodied_creator_fees`, `assert_curve_fee_cap`; `vault::lock_creator_fees`, `claim_custodied_creator_fees`, `assert_lp_fee_cap`; `creator_authority::destroy_*`; `launchpad_domain::*_role` | Distributor calls compose the custodian paths | `test/distributor-chain.test.ts` | Move-composition: custodian paths require a `&UID` that only the custodian module can borrow. |
| `launch::claim_protocol_fees` | `LaunchpadCalls.claimProtocolFees`; `LaunchpadTransactions.claimProtocolFees` | `test/transactions.test.ts` | Composes sign-in and routes both returned coins. |
| `acl::sign_in` | `LaunchpadCalls.signIn`; `MigratorCalls.signIn` | `test/transactions.test.ts`, `test/migrators-transactions.test.ts` | Intentionally compositional because its witness must be consumed in the same PTB. |
| `launch::migrate`, `launch::redeem_migration` | `LaunchpadCalls.migrate`, `redeemMigration` | `test/transactions.test.ts`, `test/migrators-transactions.test.ts` | Intentionally compositional because an adapter consumes the typed payload and balances in the same PTB. |
| `launch_ticket::new` | Compiled Meme template and `LaunchpadTransactions.publishMeme` | `test/template.test.ts`, `test/transactions.test.ts` | The template initializer constructs the ticket; publication effects identify the transferred ticket. |
| `creator_authority::new_address`, `creator_authority::new_account` | Compiled Meme template | `test/template.test.ts` | Template-internal constructors, not standalone product calls. |
| `fees::new`, `accrue`, `has_protocol_fees`, `claim_creator_fees`, `claim_protocol_fees` | Launch/vault builders, object decoders, and reducers | state, transaction, and replay tests | Move-composition surface over `Balance` values and witnesses, not standalone client operations. |
| `runtime_config::protocol_fee_share_bps` | Launchpad and migrator projections | launchpad and migrator event tests | Move-composition getter; clients reconstruct the value from canonical object state or events. |
| Bluefin `migrate`, `collect_fees` | `migrateBluefin`, `collectBluefinFees` | `test/migrators-transactions.test.ts` | Both production routes complete. |
| MMT `migrate_meme_x`, `migrate_meme_y`, `collect_fees_meme_x`, `collect_fees_meme_y` | `migrateMmt`, `collectMmtFees` with `memeSide` | `test/migrators-transactions.test.ts` | All four routes complete. |
| Cetus four `migrate_{new,existing}_meme_{a,b}` calls and two collection calls | `migrateCetus`, `collectCetusFees` with pool route and `memeSide` | `test/migrators-transactions.test.ts` | All six routes complete. |
| Turbos four `migrate_{new,existing}_meme_{a,b}` calls and two collection calls | `migrateTurbos`, `collectTurbosFees` with pool route, `memeSide`, `feeType`, and deadline | `test/migrators-transactions.test.ts` | All six routes and the adapter-specific third type argument complete. |
| Aftermath `migrate_meme_{first,second}`, `set_policy`, `update_dao_fee`, and `accrue_dao_fees` | `migrateAftermath`, `setAftermathPolicy`, `updateAftermathDaoFee`, `accrueAftermathDaoFees` | `test/migrators-transactions.test.ts` | Both canonical orientations consume a fresh LP cap and DAO version; admin builders validate future and existing DAO rates; one accrual builder accepts separate Meme and Quote vectors bounded at 100 total receiving objects and preserves locked LP principal. |
| `vault::issue_lp_fee_cap`, `vault::claim_creator_fees`, `vault::claim_protocol_fees` | `MigratorCalls` and `MigratorTransactions` `issueLpFeeCap` and claim methods | `test/migrators-transactions.test.ts` | Issuance composes admin sign-in; the creator claim passes the live `LpFeeCap`; both claims route both returned coins. Every protected migrators call passes the migrators `PackageVersion` in its Move position. |

The SDK still provides `sqrtPriceX64`, `assertPriceWithinBps`,
`minimumUtilizedAmount`, and `assertResidualWithinBps` as exact preview mirrors.
`test/migration-math.test.ts` verifies them against shared vectors. The owning
Move operations are package-only in `blast_fun_migrators`, so they are not part
of the frozen public ABI; contract execution remains authoritative.

### Vesting

| Frozen contract surface | SDK implementation | Verification | Status or reason |
| --- | --- | --- | --- |
| `linear::new_irrevocable`, `linear::share` | `VestingCalls.newLinearIrrevocable`, `share`; `VestingTransactions.createLinearIrrevocable` | `test/vesting-transactions.test.ts` | Funds, constructs, and shares one linear position atomically. |
| `linear::new_cancelable`, `linear::share` | `VestingCalls.newLinearCancelable`, `share`; `VestingTransactions.createLinearCancelable` | `test/vesting-transactions.test.ts` | Shares the position and transfers the returned cancellation cap to the explicit recipient. |
| `linear::claim` | `VestingCalls.claim`; `VestingTransactions.claim` | `test/vesting-transactions.test.ts` | Complete permissionless product builder using an immutable native `Clock`. |
| `linear::cancel` | `VestingCalls.cancel`; `VestingTransactions.cancel` | `test/vesting-transactions.test.ts` | Complete cancellation-cap builder. |
| `linear::close_irrevocable` | `VestingCalls.closeIrrevocable`; `VestingTransactions.closeIrrevocable` | `test/vesting-transactions.test.ts` | Complete terminal irrevocable-close builder. |
| `checkpoints::new_schedule`, `checkpoints::add` | `VestingCalls.newCheckpointSchedule`, `addCheckpoint` | `test/vesting-transactions.test.ts`, `test/vesting-schedules.test.ts` | Intentionally composed inside checkpoint creation so the checkpoint schedule value cannot escape incomplete. |
| `checkpoints::new_irrevocable`, `checkpoints::share` | `VestingCalls.newCheckpointIrrevocable`, `share`; `VestingTransactions.createCheckpointIrrevocable` | `test/vesting-transactions.test.ts` | Builds the complete bounded schedule, funds, constructs, and shares one position atomically. |
| `checkpoints::new_cancelable`, `checkpoints::share` | `VestingCalls.newCheckpointCancelable`, `share`; `VestingTransactions.createCheckpointCancelable` | `test/vesting-transactions.test.ts` | Shares the position and transfers the returned cancellation cap to the explicit recipient. |
| `checkpoints::claim`, `checkpoints::cancel`, `checkpoints::close_irrevocable` | `VestingCalls` and `VestingTransactions` lifecycle methods | `test/vesting-transactions.test.ts` | Complete product builders using decoded shared-object metadata. |

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
| `Launch<Meme, Quote>` shared mutable object | `launchBcs`, `decodeLaunchObject`, `getLaunch` | `test/state.test.ts` |
| `LaunchTicket<Meme>` owned object | Meme publication and launch creation builders | `test/template.test.ts`, `test/transactions.test.ts`; ticket identity comes from publication effects |
| `MigrationPayload<Meme, Quote, Witness>` returned linear value | `LaunchpadCalls.migrate`, `redeemMigration`; every adapter transaction | `test/transactions.test.ts`, `test/migrators-transactions.test.ts` |
| `CurveFeeCap<Meme>`, `BlastMetadataCap<Meme>`, `LpFeeCap<Meme>` owned objects | creator-cap, fee-claim, metadata, and LP-fee builders; live IDs decoded as `curveFeeAuthority`, `blastMetadataCapId`, `lpFeeAuthority` | `test/transactions.test.ts`, `test/state.test.ts`, `test/migrators-state.test.ts`; current owner is a native ownership fact |
| `LpVault<Meme, Quote>` shared mutable object | `lpVaultBcs`, `decodeLpVaultObject`, `getLpVault` | `test/migrators-state.test.ts`, `test/migrators-client.test.ts` |
| `VenueConfig`, `TierKey<Venue>`, and `aftermath::PolicyKey` | `migratorsDeployment`, `getVenueTier`, `getAftermathPolicy` | `test/deployments.test.ts`, `test/migrators-state.test.ts`, `test/migrators-client.test.ts` |
| Launchpad and migrator package/shared-object identities, including the migrators `PackageVersion` (`migratorsPackageVersion`) | `launchpadDeployment`, `migratorsDeployment` | `test/deployments.test.ts` |
| Venue `Witness`, `Venue`, and Turbos `FeeType` | original-package witness/type helpers and route-specific type arguments | `test/migrators-transactions.test.ts` |
| `linear::Vesting<Coin>` and `checkpoints::Vesting<Coin>` shared mutable objects | `linearVestingBcs`, `checkpointVestingBcs`, `decodeVestingObject`, `getVesting` | `test/vesting-state.test.ts`, `test/vesting-client.test.ts` |
| Checkpoint schedule contents and native `Clock` | `getCheckpointPage`, `getAllCheckpoints`, `getCurrentTimestampMs` | `test/vesting-state.test.ts`, `test/vesting-client.test.ts` |
| Vesting package identity | `vestingDeployment`; current package targets and original object/event identity | `test/deployments.test.ts`, vesting transaction/state/event tests |
| Blast SUI `vault::Vault` shared mutable object | `blastSuiVaultBcs`, `decodeBlastSuiVaultObject`, `getBlastSuiVault`, `BlastSuiClient.getVault` | `test/blast-sui-state.test.ts` pins independent literal BCS bytes to the contracts baseline and Sui revision; `test/blast-sui-client.test.ts` reuses that golden. |
| `deposit_receipt::BlastSuiDepositReceipt` address-owned object | `blastSuiDepositReceiptBcs`, `decodeBlastSuiDepositReceiptObject`, `getBlastSuiDepositReceipt`, `BlastSuiClient.getDepositReceipt` | `test/blast-sui-state.test.ts` pins independent literal BCS bytes to the contracts baseline and Sui revision; `test/blast-sui-client.test.ts` reuses that golden. |
| `fun_sui::FUN_SUI` original-package type | `funSuiType` and transaction coin selection | `test/blast-sui-math.test.ts`, `test/blast-sui-transactions.test.ts` |
| `blast_sui::BLAST_SUI` original-package type | `blastSuiType` and transaction coin selection | `test/blast-sui-math.test.ts`, `test/blast-sui-transactions.test.ts` |
| Deposit-receipt original-package type | `blastSuiDepositReceiptType` and state/event validation | `test/blast-sui-math.test.ts`, `test/blast-sui-state.test.ts` |
| Blast SUI package, `PackageVersion`, `ProtocolAuthority`, `PackageAdmin`, and `Vault` identity slots | optional `BlastPackages.blastSui` and distinctly named optional shared identities; `blastSuiDeployment` returns the call-ready immutable version and mutable vault | `test/deployments.test.ts`, `test/blast-sui-math.test.ts` |
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
| 25 wrapped launchpad payloads: `Bought`, `CreatorCapsClaimed`, `CreatorClaimSignerRevoked`, `CreatorClaimSignerSet`, `CreatorFeesClaimed`, `CreatorFeesLocked`, `CurveFeeCapReassigned`, `GraduationDefaultsChanged`, `LaunchCreated`, `LaunchTicketCreated`, `LaunchTradeFeesChanged`, `LpProtocolFeeShareChanged`, `MemeMetadataUpdated`, `MetadataCapReassigned`, `Migrated`, `MigrationWitnessAllowed`, `MigrationWitnessDisallowed`, `ProjectLpProtocolFeeShareCleared`, `ProjectLpProtocolFeeShareSet`, `ProtocolFeesClaimed`, `ProtocolFeeShareChanged`, `QuoteAllowed`, `QuoteDisallowed`, `QuoteParametersChanged`, `Sold` | `launchpadEventSpecs`, `launchpadEventBcs`, `decodeLaunchpadEvent`, `reduceLaunchpadEvent` | `test/launchpad-events.test.ts` checks names, ordered fields/types, decoding, and every reducer path. |
| Eleven direct migrator payloads: `AftermathDaoFeeUpdated`, `AftermathMigrationCompleted`, `AftermathPolicyUpdated`, `CreatorFeesClaimed`, `LpFeeCapIssued`, `LpFeesCollected`, `LpFeesLocked`, `MigrationCompleted`, `ProtocolFeesClaimed`, `VaultCreated`, `VenueTierUpdated` | `migratorEventSpecs`, `migratorEventBcs`, `decodeMigratorEvent`, `reduceMigratorEvent` | `test/migrator-events.test.ts` checks names, ordered fields/types, decoding, and every reducer path. |
| Ordered launch-to-vault replay | `reduceLaunchpadProductInput` | launchpad and migrator replay tests reconstruct launch lifecycle, reserves, launch fees, migration, vault/pool/position identity, principal, and LP-fee totals. Actor identities omitted from payloads are reconstructed from native event senders. |

Vesting creation projections derive the funder from the native event sender;
claim, cancel, and close callers are likewise available as event senders and are
not duplicated in payload fields.

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

### Vesting direct events

| Frozen event | Typed decoder and projection effect | Verification |
| --- | --- | --- |
| `linear::VestingCreated` | `decodeVestingEvent`; complete linear schedule and active position | `test/vesting-events.test.ts`, `test/vesting-reducer.test.ts` |
| `linear::VestingClaimed` | `decodeVestingEvent`; released total and remaining balance | `test/vesting-events.test.ts`, `test/vesting-reducer.test.ts` |
| `linear::VestingCanceled` | `decodeVestingEvent`; beneficiary/refund conservation and canceled state | `test/vesting-events.test.ts`, `test/vesting-reducer.test.ts` |
| `linear::VestingClosed` | `decodeVestingEvent`; irrevocable terminal state | `test/vesting-events.test.ts`, `test/vesting-reducer.test.ts` |
| `checkpoints::VestingCreated` | `decodeVestingEvent`; checkpoint count and active position, without inventing schedule contents | `test/vesting-events.test.ts`, `test/vesting-reducer.test.ts` |
| `checkpoints::VestingClaimed` | `decodeVestingEvent`; released total and remaining balance | `test/vesting-events.test.ts`, `test/vesting-reducer.test.ts` |
| `checkpoints::VestingCanceled` | `decodeVestingEvent`; beneficiary/refund conservation and canceled state | `test/vesting-events.test.ts`, `test/vesting-reducer.test.ts` |
| `checkpoints::VestingClosed` | `decodeVestingEvent`; irrevocable terminal state | `test/vesting-events.test.ts`, `test/vesting-reducer.test.ts` |

`createVestingProjection` and `reduceVestingInput` enforce monotonic release,
conservation, active-only transitions, and idempotence by transaction digest
plus event index for both vesting kinds. Reducer tests execute a valid path for
each of the eight event kinds.

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
| Current vesting cancellation-cap owner | `VestingNativeFact` kind `cancelCapOwnership`, `source: "objectOwnership"` | Creation records the cap ID, not subsequent ownership. | `test/vesting-reducer.test.ts` |
| Deleted vesting cancellation cap | `VestingNativeFact` kind `cancelCapDeleted`, `source: "transactionEffects"` | A vesting terminal event does not prove native cap deletion or its transaction provenance. | `test/vesting-reducer.test.ts` |
| Checkpoint vesting schedule contents | `VestingNativeFact` kind `checkpointSchedule`, `source: "objectRead"` | `checkpoints::VestingCreated` contains only `checkpoint_count`. | `test/vesting-reducer.test.ts` |

Native facts are stored separately from decoded Blast events and are independently
deduplicated. Reducers do not infer ownership, returned-object routing,
publication effects, deletion, or sharing from an event that does not contain
that fact.

## Intentional exclusions

| Frozen surface or proposed layer | Status and reason |
| --- | --- |
| Launchpad `acl` administration except `sign_in`; all `launch_config` administration; `runtime_config` setters/revocation | Intentional routine-administration exclusion. Product transactions do not need these calls. Their event schemas remain frozen and decoded. |
| All launchpad `package_admin` functions | Intentional package-upgrade exclusion. Their event schemas remain frozen and decoded. |
| Bluefin, Cetus, MMT, and Turbos `set_tier` | Intentional routine-administration exclusion. Frontend tier reads are complete. |
| Blast SUI `package_admin::{new,share,add_capability,authorize_upgrade,commit_upgrade_and_advance,restrict_to_additive,make_immutable}` and `blast_sui_domain::package_admin_role` | Intentional package-bootstrap/upgrade exclusion. Administration uses `blast_admin::acl` with the `BLAST_SUI_DOMAIN` witness; the Blast SUI package no longer has its own `acl` module or ACL/upgrade events. `PackageCapabilityAdded` remains decoded. |
| Blast SUI `vault::set_redeem_fee` | Intentional routine-administration exclusion. The live fee is available in vault state and events. |
| Blast SUI `vault::create` and `deposit_receipt::create_display` | Intentional deployment-bootstrap exclusions. No deployment transaction is built or executed. |
| Vesting production functions | No excluded product function: all 14 public functions have composable or high-level builders. |
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
   package generation. Complete the migrator mainnet matrix for all 13 migration
   routes, all eight fee-accrual or collection routes, the Aftermath per-pool
   DAO-fee update, and both LP-vault claims.
4. Write normalized deployment records with chain ID, package lineage,
   transaction digests, shared-object initial versions, custodians, toolchain,
   source commit, and post-deploy verification. Only then add real entries to
   `BLAST_DEPLOYMENTS`.
5. Configure the later indexer to consume the typed event decoders plus explicit
   native ownership, transaction-effect, and object-read facts. Persist native
   event identity for idempotence.
6. Keep protocol arithmetic in this SDK. A later API may expose SDK results but
   must not copy the formulas.
