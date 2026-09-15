# Optional holder rewards

`@blast-fun/sdk/distributor` supplies transaction calls, state/custody reads,
integer holder accounting, Merkle manifests, and permissionless payout helpers.
The Node operator is `npm run distributor -- <command> ...` from this repository.
This is an unpublished contract integration; supply verified deployment IDs.

## Enrollment option

After the creator capability claim, choose whether to keep creator rewards or
enroll in holder rewards. The optional branch can be part of the same transaction:

```ts
import { DistributorCalls } from "@blast-fun/sdk/distributor";

const calls = new DistributorCalls({
  packageId: distributorPackageId,
  packageVersion: distributorVersionId,
});
const pair = { memeType, quoteType };
// curveFeeCap may be an existing object ID or the earlier claim's transaction result.
if (holderRewardsEnabled) {
  const [distributor, publisher] = tx.add(
    calls.enroll({
      ...pair,
      curveFeeCap,
      launch: launchId,
      packageVersion: launchpadVersionId,
    }),
  );
  tx.add(calls.share({ ...pair, distributor: distributor! }));
  tx.transferObjects([publisher!], publisherMultisigAddress);
} else {
  tx.transferObjects([curveFeeCap], creatorAddress);
}
```

For an existing ID, pass `tx.object(curveFeeCapId)` as `curveFeeCap` in this
example. The Blast metadata capability stays on its existing path. Enrollment
destroys the `CurveFeeCap` and binds the launch's curve creator fees to the
distributor object permanently; no fee capability survives, so there is no
opt-out and no administrator reassignment. After migration, the vault's LP-fee
right starts pending; the distributor binds it through the enrolled launch with
no capability using
`calls.lockLpFees({ ...pair, distributor, lpVault, migratorsVersion, launch })`.
If the creator already claimed the vault's `LpFeeCap`, its holder binds it with
`calls.lockLpFeesWithCap({ ...pair, distributor, lpVault, migratorsVersion, lpFeeCap })`.
`getLaunch(...).curveFeeAuthority` and `getLpVault(...).lpFeeAuthority` expose the
bound custodian ID for UI/explorer custody evidence. `getDistributor` and
`getRewardRound` read the funds and claim bitmap.

## Operator configuration

Create a JSON config outside the public artifacts:

```json
{
  "grpcUrl": "https://YOUR-ARCHIVAL-SUI-GRPC-ENDPOINT",
  "network": "testnet",
  "chainId": "EXPECTED-GENESIS-DIGEST",
  "packageId": "0xVERIFIED_CALLABLE_DISTRIBUTOR_PACKAGE",
  "originalPackageId": "0xORIGINAL_DISTRIBUTOR_PACKAGE",
  "distributorVersionId": "0xDISTRIBUTOR_VERSION_OBJECT",
  "launchpadOriginalPackageId": "0xVERIFIED_CORE_ORIGINAL_PACKAGE",
  "distributorId": "0xDISTRIBUTOR",
  "publisherCapId": "0xPUBLISHER_CAP",
  "packageVersionId": "0xCORE_VERSION_OBJECT",
  "migratorsVersionId": "0xMIGRATORS_VERSION_OBJECT",
  "lpVaultId": "0xVERIFIED_MIGRATION_VAULT",
  "sender": "0xPUBLISHER_MULTISIG",
  "excludedAddresses": []
}
```

`lpVaultId`, `packageVersionId`, `migratorsVersionId`, `publisherCapId`, and `sender` are needed only for
the relevant commands. `packageId` selects callable bytecode;
`originalPackageId` remains the first package ID across compatible upgrades for
object types and dynamic-field lookup. `distributorVersionId` is the singleton
created at distributor publication; `packageVersionId` is the separate core
version object used for curve collection, and `migratorsVersionId` is the
migrators version object used for LP collection. The provider must serve checkpoints back to coin-package creation
and the distributor's initial shared object version. The operator checks genesis,
checkpoint ordering/digest continuity, transaction completeness, timestamps and
nonnegative balances. It trusts the provider's derived balance changes; it does
not independently verify checkpoint signatures or reconstruct every object effect.

## Collect, account, publish, pay

In these examples `config.json` is configuration and `operator-data` is private
working state. All transaction files contain `{ "transaction": "..." }` where
the string is `Transaction.toJSON()`; restore with `Transaction.from(...)` in your
normal signing or multisig workflow. No private publishing key is loaded by the CLI.

```sh
npm run distributor -- inspect --config config.json --dir operator-data
npm run distributor -- collect-curve-tx --config config.json --dir operator-data
# Sign/execute collection externally, then wait for confirmation.
npm run distributor -- index --config config.json --dir operator-data --until 123456
npm run distributor -- prepare --config config.json --dir operator-data
npm run distributor -- publish-tx --config config.json --dir operator-data
# Review accounting; make the manifest public; sign/execute publish-tx externally.
# Read the confirmed RoundPublished event to obtain the shared Round ID.
npm run distributor -- advance --config config.json --dir operator-data --round 0xROUND
npm run distributor -- relay --config config.json --dir operator-data --round 0xROUND --manifest operator-data/rounds/0/manifest.json
```

For post-migration collection, compose the existing venue-specific fee collector
with `calls.collectLpFees(...)`, or execute the venue collection before the
operator's `collect-lp-tx` output. That command sweeps the **already accrued**
creator share in the vault. It does not discover pools or invoke venue collectors.
The vault ID must come from verified launch migration history. Collection aborts
with core's `nothing_accrued` when both creator-fee balances are zero. Another
collector may have swept them first: refresh chain state before retrying, and
skip an empty sweep. A combined venue-collection/sweep transaction also rolls back
the venue collection if the creator share is zero (for example, the protocol
receives the full fee). Use separate transactions when zero creator fees are
possible. An aborted PTB did not complete any of its other operations; never
silently treat the entire transaction as successful.

`index` replays from the coin's defining package creation, starts reward weighting
at distributor enrollment, and saves batches of up to 100 checkpoints plus a
matching ledger watermark. Journal files are arrays named
`checkpoints/batch-FIRST_SEQUENCE.json`; each journal is durable before its ledger
snapshot. The final partial batch is flushed at `--until`. A failed fetch or crash
replays only the unfinished batch and never advances its durable watermark early.
Each resulting address balance applies until the next checkpoint. Same-checkpoint
transfers are netted. Whole-token precision is never used: amounts are atomic-unit
`bigint`, weight is atomic units × milliseconds, and proportional division rounds
down. Dust remains available in the distributor for later rounds.

`prepare` writes `rounds/N/accounting.json`, `manifest.json`, and `pending.json`.
It allocates both available assets according to eligible holding time and freezes
indexing until publication is confirmed. No weight or no payable amount means no
round. Exclusions include the zero address, distributor, launch, configured vault,
and additional configured custody addresses. Set a public, stable eligibility
policy before publishing. Accounting excludes balances inside contracts and does
not infer the beneficial owners of exchange/LP custody. Rounds are limited to
65,536 payable addresses; exceeding this limit stops preparation rather than
silently dropping holders. Larger populations require a separate shard design.

`advance` checks the confirmed round against the full manifest, resets holding
weights at the same checkpoint, and allows the next interval. Old manifests and
rounds remain usable. `relay` reads the on-chain bitmap and emits unsigned batches
of up to ten unpaid claims. Anyone can run it using a public manifest and round ID.
To execute payouts with a gas-only key, provide `DISTRIBUTOR_RELAYER_KEY` through
your secret manager and add `--execute`. This supports an Ed25519 `suiprivkey`;
the relay key needs no PublisherCap. Rerunning refreshes paid bits. A racing claim
can abort a batch, after which rerunning skips the already paid allocations.

## Recovery and trust

Use one writer per data directory. Files are fsynced and atomically renamed with
the checkpoint watermark in the same ledger. Checkpoint journals are committed
before their matching state snapshot; retry overwrites an unfinished journal with
the same first sequence. After a process crash, first verify
no operator is running, then remove the stale `operator-data/.lock` directory.
Re-running indexing or advance is safe. Preserve the directory through deployment.
If rebuilding from scratch after prior publications, replay to each published
round's end and call `advance` with that round and its original manifest in order;
then resume indexing. Never invent a new holder snapshot to skip missing history.
Batching reduces persistence overhead but still reads every historical checkpoint.
Measure provider throughput and backlog for mature coins; this single-process
keeper has not been benchmarked as a high-volume archival indexer.

Publish each round's manifest, accounting policy, exclusions and checkpoint journal
through durable public storage before signing. The contract stores the manifest
digest, not its bytes or URL. Availability is necessary for independent claims.
An independent reviewer can replay checkpoints and recompute the allocation.

A multisig owning PublisherCap approves the root through native Sui signatures.
This remains trusted allocation: a malicious publisher can allocate new rewards
to itself, omit holders, or commit a malformed/unfunded tree. On-chain budget checks
prevent reserving more than collected funds, but do not prove the root's totals
or historical eligibility. Incorrect commitments have no cancellation or sweep.
Existing funded claims remain payable if the publisher or keeper disappears,
provided the distributor is on its active generation and unpaused.

## Pause and compatible upgrades

The owner retains the native distributor UpgradeCap. The holder of the
distributor `AdminCap`, created at publication, can pause/resume or migrate
after a compatible upgrade:

```ts
tx.add(calls.setPaused({ adminCap: adminCapId, paused: true }));
// To resume, use paused: false. After a versioned upgrade, use:
// tx.add(calls.migrate({ adminCap: adminCapId }));
```

`getDistributorVersion` and operator `inspect` expose canonical version and
pause state; `inspect` also reports the launch's curve-fee authority and whether
it is bound to this distributor. All reward mutations check
these on chain; indexing can continue during a pause.

Pause stops enrollment, fee collection, publishing, and payouts. An admin resumes
existing claims without rewriting their allocations or replay bits. The owner
repairs bugs through a compatible upgrade of the same package, preserving stored
layouts and public signatures. A behavioral cutover increments the compiled
version; the admin then calls `migrate` using the new callable `packageId`.
Migration preserves pause and rejects rollback or repetition.
Dependency-only relinks can retain the operational generation. Test relinked curve
collection before an upstream core cutover. A fresh independent publication cannot
access the old package's bound creator fees or round balances.

Current fee custody is verifiable, but the upgrade owner can change its rules.
The admin can keep payouts paused. This integration has no live deployment
addresses and still requires a real compatible-upgrade rehearsal and live venue
verification before release.
