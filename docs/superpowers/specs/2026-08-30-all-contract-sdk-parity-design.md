# All-Contract SDK Parity Design

**Status:** Approved in chat on 2026-08-30; pending written-spec review.

**Contracts baseline:** `a5ed34ad49c6c001af2db5b9cbcb206075704412`

**SDK baseline:** `83730a8cdde24de5787121338f58ae4bdddab1b3`

## Goal

Complete frontend-ready SDK coverage for every production Sui contract in the
Blast V2 workspace without deploying a package or building an indexer, API,
backend, or web integration.

The SDK will retain the completed launchpad, Meme template, migrator, and
vesting transaction behavior. It will add the missing `blast_sui` product
surface, vesting event replay, all-contract ABI drift detection, a separately
branded basis-point type, TypeScript 7, and Biome quality gates.

## Repository State and Safety

The contracts code frozen by the existing launchpad artifact is commit
`a5ed34ad49c6c001af2db5b9cbcb206075704412`. Contracts commit
`02cd182463629bc6977a097a2ab235ed765c9f01` adds ABI documentation only and does
not change production Move code.

The contracts worktree contains pre-existing user work:

- modified `sui/meme_template/Move.lock`;
- untracked `docs/research/sui-deepbook-indexer-architecture-2026.md`.

These files are ABI-neutral and must remain untouched. No implementation step
may stage, overwrite, revert, or commit them. The SDK worktree was clean at the
start of this design.

## Scope

### Production packages

The all-contract boundary contains these Sui packages:

1. `launchpad`;
2. `meme_template`;
3. `migrators`, excluding vendored venue interface stubs;
4. `vesting`;
5. `blast_sui`.

The EVM directory contains no production contract and requires no SDK module.

### Included product behavior

Existing launchpad and migrator support remains unchanged. Existing vesting
transaction and state support remains unchanged except for compatible shared
helper adoption.

New work includes:

- every user-facing `blast_sui` operation;
- typed `blast_sui` vault and deposit-receipt reads;
- exact mirrors of production `blast_sui` integer formulas;
- all 20 `blast_sui` event payload decoders and deterministic reducers;
- all eight vesting event decoders and deterministic reducers;
- native Sui checkpoint, transaction-digest, and event-position metadata;
- explicit native facts for ownership and transaction effects that events do
  not prove;
- deployment value types and conversion helpers, without performing a deploy;
- ABI inventory and drift checks for vesting and `blast_sui`;
- TypeScript 7 and Biome enforcement; and
- a distinct `BasisPoints` type brand.

### Explicit exclusions

This work will not:

- publish, deploy, upgrade, or configure any Move package;
- add network deployment records, release records, or placeholder identifiers;
- build routine administration or package-upgrade transaction builders;
- change Move contract logic for SDK convenience;
- build an indexer process, database, API, backend, or frontend integration;
- add new vesting contract behavior; or
- duplicate SDK arithmetic in another layer.

Administration and upgrade events remain part of the decoding ABI even though
the corresponding transaction builders are excluded.

## Architecture

Use contract-shaped SDK modules. This follows the existing launchpad,
migrator, and vesting structure and avoids a generator framework or one large
cross-contract client.

Add a `src/blast-sui/` package containing focused files for calls,
frontend-ready transactions, client reads, BCS state, protocol math, event
decoding, and replay. Add event and replay files beside the existing vesting
files. Shared primitives move to `src/lib/` only when the repository already
has the same implementation in multiple modules.

The public root and package subpath exports remain source-compatible. New
`./blast-sui` exports are additive.

## Shared SDK Primitives

### Integer brands

`U64` and `U128` remain branded `bigint` types. Add a separate unique symbol:

```ts
declare const BASIS_POINTS_BRAND: unique symbol;
export type BasisPoints = U64 & {
  readonly [BASIS_POINTS_BRAND]: true;
};
```

`requireBasisPoints(name, value)` returns `BasisPoints`. Its accepted range is
zero through 10,000 inclusive. A `BasisPoints` value is assignable where a
validated `U64` is accepted, but an arbitrary `U64` is not assignable to a
`BasisPoints` parameter. Arithmetic returns an unbranded `bigint`; callers must
validate a result again before treating it as a rate.

Only atomic protocol values use `bigint`. Counts or indexes used solely by
JavaScript collections may remain safe integers where the existing API already
does so.

### Common BCS layouts

Add `src/lib/bcs.ts` for the repeated canonical Sui `ID`, `UID`, `Balance`, and
`TypeName` BCS layouts. Existing launchpad, migrator, and vesting state/event
decoders adopt these definitions when doing so is mechanical and compatible.
Contract-specific layouts remain in their contract module.

### Common event metadata

Add `src/lib/events.ts` for:

- `SuiEventPosition` containing `checkpoint: bigint`,
  `transactionDigest: string`, and `eventIndex: number`;
- validation and normalization of that position; and
- `suiEventId(position)`, returning
  `${transactionDigest}:${eventIndex}`.

Existing launchpad and migrator event APIs preserve their exported type and ID
helper names through aliases or small delegating functions. Reducers use the
shared identity helper, not an application-level sequence number.

## `blast_sui` SDK

### Deployment and type identity

Extend `BlastPackages` with optional `blastSui` current/original package
identity. Extend shared-object identities with distinctly named optional
`blastSuiPackageVersion`, `blastSuiProtocolAuthority`,
`blastSuiPackageAdmin`, and `blastSuiVault` entries. Launchpad identities retain
their current names and meaning.

Add `blastSuiDeployment(deployment)`. It validates that the package,
package-version object, and vault are present and returns call-ready references
with these mutability requirements:

- `PackageVersion`: shared immutable;
- `Vault`: shared mutable;
- framework `SuiSystemState`: shared mutable, supplied through the canonical
  framework object reference rather than a deployment placeholder.

The helper performs no chain mutation. `BLAST_DEPLOYMENTS` remains empty until
real deployment effects are available.

Coin and object type helpers use the original package ID for
`fun_sui::FUN_SUI`, `blast_sui::BLAST_SUI`, and
`deposit_receipt::BlastSuiDepositReceipt`. Move call targets use the current
package ID.

### Composable calls

`BlastSuiCalls` exposes one method for each user-facing production operation:

- `mintFunSui`;
- `redeemFunSui`;
- `requestBlastSui`;
- `keepDepositReceipt`;
- `claimBlastSui`;
- `cancelDepositReceipt`;
- `donateSui`;
- `redeemBlastSui`; and
- `syncVault`.

Methods accept `Transaction` inputs or transaction arguments in the same style
as existing SDK call classes. They preserve Move composability and return every
Move result that a later command may consume. They encode the exact type
arguments, object order, shared-object mutability, and original/current package
identity required by the frozen ABI.

`requestBlastSui` returns the receipt result without transferring it.
`mintFunSui`, `redeemFunSui`, `claimBlastSui`, `cancelDepositReceipt`, and
`redeemBlastSui` return their coin results without transferring them.

### Frontend-ready transactions

`BlastSuiTransactions` wraps the composable calls:

- returned fungible coins are transferred to the explicit recipient required
  by each high-level transaction method;
- `requestBlastSui` calls `deposit_receipt::keep` in the same PTB so the
  key-only receipt is stored under the transaction sender;
- claim and cancel accept an owned receipt object;
- methods returning no value do not add synthetic transfers; and
- no method invents a transfer path that the Move ABI forbids.

Tests inspect the programmable transaction commands to prove returned-object
routing for every operation.

### State and reads

`state.ts` defines typed BCS layouts for `Vault`, `Custody`, and
`BlastSuiDepositReceipt`, including their nested framework treasury, balance,
native stake, fungible stake, and option layouts at the pinned Sui dependency.

`decodeBlastSuiVaultObject` validates:

- the original package identity of the object type;
- the `vault::Vault` module and name;
- the object UID;
- shared ownership and required mutability; and
- every decoded atomic value as a valid `u64`.

It returns pool identity, both supplies, both custody ledgers, cached exchange
rate, redeem fee, and unwind-only status. Derived conservative asset totals are
computed by the SDK from liquid SUI, pending principal, and cached active SUI.

`decodeBlastSuiDepositReceiptObject` validates the receipt type, UID, owned
object shape, vault binding, staking pool, principal, and activation epoch.
Current receipt ownership remains a native object-ownership fact.

`getBlastSuiVault` and `getBlastSuiDepositReceipt` accept
`ClientWithCoreApi` and use the Sui Core API. They do not use legacy JSON-RPC.
The client extension exposes these reads and the call/transaction classes.

The SDK does not add a custom decoder for the complete live
`SuiSystemState`. Pure previews take the canonical rate and custody primitives
they need. Contract execution remains authoritative, and a caller may simulate
the transaction when it needs a live refreshed quote.

### Protocol arithmetic

`math.ts` mirrors these Move formulas exactly:

- blast shares out, rounded down;
- gross SUI out, rounded down;
- redemption fee, rounded up;
- full redemption quote;
- SUI at a pool rate, rounded down;
- pool tokens at a pool rate, rounded down;
- conversion loss bound, rounded up; and
- pool tokens required for SUI, rounded up and capped by holdings.

Each function documents atomic units, valid input bounds, intermediate width,
rounding direction, and the recipient of the remainder. The implementation uses
the shared checked integer and multiply/divide helpers. It does not use floating
point.

## Event Decoding

### `blast_sui`

Decode the generic production envelope
`events_wrapper::Event<events::Payload>`. Both the current package that emitted
the event and the original package that defines type identity are validated.

The decoder supports all 20 payloads:

- `SuperAdminTransferStarted`;
- `SuperAdminTransferCancelled`;
- `SuperAdminTransferred`;
- `PackageVersionAdvanced`;
- `PackageAdminCreated`;
- `UpgradeAuthorized`;
- `UpgradeCommitted`;
- `UpgradePolicyRestricted`;
- `VaultCreated`;
- `FunSuiMinted`;
- `FunSuiRedeemed`;
- `BlastSuiDepositRequested`;
- `BlastSuiDepositClaimed`;
- `BlastSuiDepositCancelled`;
- `BlastSuiDonated`;
- `BlastSuiRedeemed`;
- `FunYieldSwept`;
- `RedeemFeeChanged`;
- `VaultSynced`; and
- `NativeStakeUnwound`.

Nested `PoolCustody`, `ExchangeRate`, and `VaultCustody` payloads are typed and
decoded once. Unsupported package, envelope, payload, malformed BCS, invalid
position, or out-of-range integer input fails with a deterministic type or
range error.

### Vesting

Decode the four direct event types from both `linear` and `checkpoints`:

- `VestingCreated`;
- `VestingClaimed`;
- `VestingCanceled`; and
- `VestingClosed`.

The module name is part of the event discriminator because the payload names
overlap. The decoder validates the original vesting package, normalizes the coin
`TypeName`, and attaches the shared native position.

## Deterministic Replay

Reducers are pure mutations of an explicitly supplied projection and return the
same projection instance. They deduplicate by native event ID. Replaying the
same ordered input twice does not change totals, statuses, or histories.

### `blast_sui` projection

The projection records:

- vault discovery, validator, pool, locked bootstrap, and live redeem fee;
- final fun and blast custody snapshots and supplies;
- cumulative fun mint/redemption, blast deposits/claims/cancellations,
  donations, blast redemption gross/fees/net, and swept yield;
- receipt lifecycle keyed by receipt ID;
- sync and native-unwind facts;
- super-admin transfer state; and
- package version and upgrade-administration event history.

Final custody snapshots replace derived ledger state after every event that
contains one. Delta totals are independently accumulated for audit and display.
The reducer does not infer a receipt owner from `BlastSuiDepositRequested` or
from `deposit_receipt::keep`.

### Vesting projection

The projection records one position per vesting ID with its kind, coin type,
beneficiary, refund recipient, cancellation-cap ID, allocation, released total,
remaining event-known balance, and lifecycle status.

Linear creation events contain the complete schedule and are replay-complete.
Checkpoint creation events contain only `checkpoint_count`; the projection
marks their schedule as requiring an object read. Cancellation-cap ownership,
the current owner of any receipt, and returned-object recipients are never
guessed.

### Native facts

Where frontend state needs information absent from Blast events, reducers accept
separate discriminated native facts with an explicit source:

- `source: "objectOwnership"` for current owned-object identity and owner;
- `source: "transactionEffects"` for returned-object recipients, deletion,
  sharing, or publication; and
- `source: "objectRead"` for checkpoint schedule contents or canonical object
  snapshots.

Native facts carry a checkpoint and transaction position where available. They
cannot masquerade as decoded Blast events.

## ABI Parity

Keep `abi/production-launchpad-v1.json` stable. Add focused production artifacts
for vesting and `blast_sui` so later review can distinguish independent package
commitments. The checker extracts production public functions, structs used by
clients, event payloads, the generic event envelope, type parameters, reference
mutability, return types, and current/original package identity requirements.

Test-only functions are excluded. Vendored migrator interface stubs remain
excluded. Each production public function is labeled with one of:

- SDK call or transaction builder;
- SDK read or arithmetic implementation;
- intentionally compositional; or
- intentional routine-administration, deployment-bootstrap, or upgrade
  exclusion.

`vault::create` and `deposit_receipt::create_display` are deployment-bootstrap
exclusions. `vault::set_redeem_fee`, ACL operations, and package-admin operations
are routine administration or upgrade exclusions. Their structs and emitted
events remain frozen and decoded.

The new artifacts use the same contracts code baseline and record that the
contracts worktree differs only by the two preserved ABI-neutral files listed
above. If verification discovers any other production difference, work stops
for product-owner review instead of freezing it silently.

## TypeScript and Biome

Upgrade the SDK development dependency to TypeScript `7.0.2`. Preserve strict,
no-emit, NodeNext, exact-optional-property, unchecked-index, erasable-syntax,
and verbatim-module settings unless TypeScript 7 requires a documented syntax
adjustment.

Add Biome `2.5.11` with repository-compatible two-space formatting. Enable:

- `complexity/noExcessiveCognitiveComplexity` as an error with maximum 15;
- unused-import detection;
- type-only import enforcement;
- unresolved-import detection;
- undeclared-dependency detection;
- import-cycle detection; and
- the organize-imports assist.

Biome configuration must use rule names supported by the pinned release. The
initial adoption may apply mechanical formatting and import organization, but
must not add unrelated semantic refactors or broad suppressions. The existing
ABI checker classifier, measured at cognitive complexity 21, is split into
focused helpers until it passes the limit.

Add scripts for `format`, `format:check`, `lint`, and an aggregate `check`. The
aggregate gate includes ABI parity, formatting, lint, TypeScript, and tests.

## Errors and Compatibility

Public additions are additive. Existing import paths, class names, option
shapes, launchpad/migrator/vesting output, and transaction routing remain
compatible.

Input errors use `TypeError` for malformed types, identities, or missing
deployment components and `RangeError` for invalid numeric ranges, following
existing SDK conventions. BCS or event package mismatches fail before a payload
is accepted. Protocol previews reject impossible canonical states but do not
duplicate mutable contract admission policy.

No placeholder deployment IDs are accepted or inserted. Deployment helpers
operate only on caller-supplied, validated identities.

## Verification

Test-driven implementation must prove:

1. every user-facing production call has a composable call method;
2. every frontend-ready operation routes every returned coin or receipt;
3. call targets use current package IDs and type identities use original IDs;
4. shared-object mutability matches the Move signature;
5. vault and receipt BCS decoding validates type, identity, owner shape, and
   numeric bounds;
6. every SDK formula matches Move rounding and boundary vectors;
7. all 20 `blast_sui` and all eight vesting event payloads decode;
8. every new event kind executes a reducer test;
9. ordered replay reconstructs vault custody, supplies, fees, receipt state,
   vesting lifecycle, released totals, and known balances;
10. duplicate replay is idempotent;
11. event-derived state is distinguishable from object ownership, transaction
    effects, and object-read facts;
12. all five production packages are represented in the coverage matrix;
13. the all-contract ABI checker detects field, type, mutability, return, and
    event drift; and
14. no deployment, network record, placeholder identifier, contract change,
    indexer, API, backend, or web integration appears in the diff.

Required final commands include:

```text
cd sdk && npm run format:check
cd sdk && npm run lint
cd sdk && npm run typecheck
cd sdk && npm test
cd sdk && npm run check:abi
```

The relevant contract build, lint, unit, boundary, and ABI commands must be run
again against the preserved contracts tree. A failed required command blocks a
completion claim.

## Delivery

Implementation proceeds in dependency order:

1. toolchain, shared helpers, and `BasisPoints`;
2. vesting and `blast_sui` ABI artifacts;
3. `blast_sui` deployment types, state, reads, and math;
4. composable calls and frontend-ready transactions;
5. `blast_sui` event decoding and replay;
6. vesting event decoding and replay; and
7. coverage documentation, full verification, and final code review.

The final report must provide the exact ABI baseline, every SDK module added or
changed, the all-contract coverage matrix, all verification results, and the
remaining release work before an indexer or API begins.
