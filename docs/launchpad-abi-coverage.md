# Production launchpad ABI coverage

## Baseline

The frozen production ABI uses contracts commit
`a5ed34ad49c6c001af2db5b9cbcb206075704412`. The ABI artifact is
`abi/production-launchpad-v1.json`. The artifact records Sui CLI
`1.77.2-51d177ad7d65`.

The contracts working tree differed from the ABI commit when the ABI was
frozen. The differences were `sui/meme_template/Move.lock` and
`docs/research/sui-deepbook-indexer-architecture-2026.md`. These differences do
not change a production function, object layout, or event schema. Contracts
commit `02cd182463629bc6977a097a2ab235ed765c9f01` adds ADR 0059 and the glossary
record for this freeze. It does not change the frozen ABI.

Move calls use the current package ID. Type names, event types, object schemas,
migration witnesses, venue markers, and venue-tier dynamic-field keys use the
original package ID. The deployment registry stores both IDs.

## Function coverage

| Frozen contract surface | SDK implementation | Verification | Status or reason |
| --- | --- | --- | --- |
| `launch::new`, `launch::share` | `LaunchpadCalls.createLaunch`, `shareLaunch`; `LaunchpadTransactions.createLaunch` | `test/transactions.test.ts` | Complete atomic create and share transaction. |
| `launch::buy` | `LaunchpadCalls.buy`; `LaunchpadTransactions.buy`; `previewBuy` | `test/transactions.test.ts`, `test/curve.test.ts` | Complete builder and arithmetic preview. |
| `launch::sell` | `LaunchpadCalls.sell`; `LaunchpadTransactions.sell`; `previewSell` | `test/transactions.test.ts`, `test/curve.test.ts` | Complete builder and arithmetic preview. |
| `launch::claim_creator_cap` | `LaunchpadCalls.claimCreatorCap`; `LaunchpadTransactions.claimCreatorCap` | `test/transactions.test.ts` | Routes `CreatorCap` and `MetadataCap`. Current ownership is a native object fact. |
| `launch::claim_creator_fees` | `LaunchpadCalls.claimCreatorFees`; `LaunchpadTransactions.claimCreatorFees` | `test/transactions.test.ts` | Routes both returned coins. |
| `launch::claim_protocol_fees` | `LaunchpadCalls.claimProtocolFees`; `LaunchpadTransactions.claimProtocolFees` | `test/transactions.test.ts` | Composes sign-in and routes both returned coins. |
| `acl::sign_in` | `LaunchpadCalls.signIn`; `MigratorCalls.signIn` | launchpad and migrator transaction tests | Intentionally compositional because the witness must be consumed in one PTB. |
| `launch::migrate`, `launch::redeem_migration` | `LaunchpadCalls.migrate`, `redeemMigration` | `test/transactions.test.ts` | Intentionally compositional. Production adapter builders consume the payload and balances in one PTB. |
| `launch_ticket::new` | Compiled Meme template and `LaunchpadTransactions.publishMeme` | `test/template.test.ts`, `test/transactions.test.ts` | Template initializer owns construction. Publication effects identify the returned ticket. |
| `creator_authority::new_address`, `new_x` | Compiled Meme template | `test/template.test.ts` | Template-internal constructors. There is no standalone client call. |
| `migration_math::sqrt_price_x64`, `assert_price_within_bps`, `minimum_utilized_amount`, `assert_residual_within_bps` | `sqrtPriceX64`, `assertPriceWithinBps`, `minimumUtilizedAmount`, `assertResidualWithinBps` | `test/migration-math.test.ts` | Exact SDK arithmetic mirror. Contract execution remains authoritative. |
| `fees::new`, `accrue_from_runtime`, `totals`, `claim_creator_fees`, `claim_protocol_fees` | Launch and vault builders, object decoders, and event reducers | state, transaction, and replay tests | Move-composition surface over `Balance` and witnesses. It is not a standalone client operation. |
| `runtime_config::protocol_fee_share_bps`, `protocol_treasury` | Launch and migrator event projections | launchpad and migrator event tests | Move-composition getters. Client reconstruction uses object state or events. |
| All `acl` administration except `sign_in` | None | ABI parity check | Intentional routine-administration exclusion. |
| All `launch_config` administration | None | ABI parity check | Intentional routine-administration exclusion. |
| All `package_admin` functions | None | ABI parity check | Intentional package-upgrade exclusion. |
| `runtime_config` setters and signer revocation | None | ABI parity check | Intentional routine-administration exclusion. |
| Bluefin `migrate`, `collect_fees` | `migrateBluefin`, `collectBluefinFees` | `test/migrators-transactions.test.ts` | Both production routes complete. |
| MMT `migrate_meme_x`, `migrate_meme_y`, `collect_fees_meme_x`, `collect_fees_meme_y` | `migrateMmt`, `collectMmtFees` with `memeSide` | `test/migrators-transactions.test.ts` | All four routes complete. |
| Cetus four `migrate_{new,existing}_meme_{a,b}` functions and two collection functions | `migrateCetus`, `collectCetusFees` with a discriminated pool route and `memeSide` | `test/migrators-transactions.test.ts` | All six routes complete. |
| Turbos four `migrate_{new,existing}_meme_{a,b}` functions and two collection functions | `migrateTurbos`, `collectTurbosFees` with pool route, `memeSide`, `feeType`, and deadline | `test/migrators-transactions.test.ts` | All six routes and the third type argument complete. |
| Full Sail four `migrate_{new,existing}_meme_{a,b}` functions and two collection functions | `migrateFullSail`, `collectFullSailFees` with a discriminated pool route and `memeSide` | `test/migrators-transactions.test.ts` | All six routes complete. Migration includes rewarder custody. Collection does not add unused inputs. |
| `vault::claim_creator_fees`, `claim_protocol_fees` | `MigratorCalls` and `MigratorTransactions` claim methods | `test/migrators-transactions.test.ts` | Both claims route both returned coins. |
| Bluefin, Cetus, MMT, Turbos, and Full Sail `set_tier` | None | ABI parity check | Intentional routine-administration exclusion. Frontend reads are supported. |

## Object and type coverage

| Frozen object or type boundary | SDK implementation | Verification |
| --- | --- | --- |
| `Launch<Meme, Quote>` shared mutable object | `launchBcs`, `decodeLaunchObject`, `getLaunch` | `test/state.test.ts` |
| `LaunchTicket<Meme>` owned object | Meme publication and launch creation builders | template and transaction tests; ticket ID comes from publication effects |
| `MigrationPayload<Meme, Quote, Witness>` returned linear value | `LaunchpadCalls.migrate` and `redeemMigration`; complete adapter transactions | launchpad and every venue transaction test |
| `CreatorCap<Meme>` owned object | creator-cap and fee-claim builders | transaction tests; current owner stays in native facts |
| `LpVault<Meme, Quote>` shared mutable object | `lpVaultBcs`, `decodeLpVaultObject`, `getLpVault` | `test/migrators-state.test.ts` |
| `VenueConfig` and `TierKey<Venue>` | migrator deployment helper and `getVenueTier` | deployment and migrator state tests |
| Launchpad shared singletons | `launchpadDeployment` | `test/deployments.test.ts` |
| Migrator package and shared singleton | `migratorsDeployment` | `test/deployments.test.ts` |
| Venue `Witness`, `Venue`, and Turbos `FeeType` | original-package witness helper and route-specific type arguments | all venue transaction tests |
| Returned coins and capabilities | high-level transactions transfer every result | launchpad and migrator transaction tests |

## Event and replay coverage

| Frozen event surface | SDK implementation | Verification |
| --- | --- | --- |
| 30 wrapped launchpad payloads: `AdminDestroyed`, `AdminGranted`, `AdminRevoked`, `Bought`, `CreatorCapClaimed`, `CreatorFeesClaimed`, `GraduationDefaultsChanged`, `LaunchCreated`, `LaunchTicketCreated`, `LaunchTradeFeesChanged`, `Migrated`, `MigrationWitnessAllowed`, `MigrationWitnessDisallowed`, `PackageAdminCreated`, `PackageVersionAdvanced`, `ProtocolFeesClaimed`, `ProtocolFeeShareChanged`, `ProtocolTreasuryChanged`, `QuoteAllowed`, `QuoteDisallowed`, `QuoteParametersChanged`, `Sold`, `SuperAdminTransferCancelled`, `SuperAdminTransferred`, `SuperAdminTransferStarted`, `UpgradeAuthorized`, `UpgradeCommitted`, `UpgradePolicyRestricted`, `XClaimSignerRevoked`, `XClaimSignerSet` | `launchpadEventSpecs`, `launchpadEventBcs`, `decodeLaunchpadEvent`, `reduceLaunchpadEvent`, including capability, signer, and package-administration projections | `test/launchpad-events.test.ts` compares all names, fields, and types with the ABI artifact and runs every reducer path. |
| Six direct migrator payloads: `CreatorFeesClaimed`, `LpFeesCollected`, `MigrationCompleted`, `ProtocolFeesClaimed`, `VaultCreated`, `VenueTierUpdated` | `migratorEventSpecs`, `migratorEventBcs`, `decodeMigratorEvent`, `reduceMigratorEvent` | `test/migrator-events.test.ts` compares all names, fields, and types with the ABI artifact and runs every reducer path. |
| Native event position | checkpoint as `bigint`, transaction digest, and event index in every decoded event | launchpad and migrator identity tests |
| Ordered product replay | `reduceLaunchpadProductInput` | combined replay reconstructs lifecycle, zero post-migration reserves, launch fees, vault, pool, position, migration, principal, and LP fees |
| Duplicate replay | event identity maps keyed by transaction digest plus event index; checkpoint is retained as ordering metadata | duplicate and corrected-checkpoint tests require the same projection object |
| Package publication and created singleton objects | `PackagePublicationFact` with `source: "transactionEffects"` | native-fact test |
| Current `CreatorCap` owner | `CreatorCapOwnershipFact` with `source: "objectOwnership"` | native-fact test |
| Returned claim-coin recipients | `ReturnedCoinRecipientsFact` with `source: "transactionEffects"`, keyed per returned coin pair | same-transaction multi-claim native-fact test |

## Intentional exclusions

- `blast_sui` SDK support is outside this freeze.
- New vesting event indexing is outside this freeze.
- Routine administration and package-upgrade builders are outside this freeze.
- The indexer process, database, API, backend, and frontend wiring are outside
  this freeze.
- The SDK registry contains no placeholder deployment IDs.
- This slice does not change contract logic for SDK convenience.

## Gates before the indexer and API

1. Publish or upgrade the launchpad and migrator packages. Record real current
   and original package IDs and every shared-object identity from transaction
   effects.
2. Complete the mainnet dev-inspect matrix in
   `contracts/sui/migrators/DEPENDENCIES.md`. It covers all 15 migrations, all
   nine fee collections, and both vault claims against published venue code.
3. Add the approved deployment to `BLAST_DEPLOYMENTS`. Do not add a placeholder
   entry.
4. Start the indexer with the typed event inputs and native-fact inputs in this
   SDK. Persist event identity for idempotence.
5. Keep protocol arithmetic in this SDK. The API can expose SDK results but
   must not copy the formulas.
