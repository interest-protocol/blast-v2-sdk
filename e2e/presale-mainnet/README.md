# E2E-042: final native Aftermath package

Status: **prepared, not executed against the final package**. The attached legacy runner is
adapted to the `FinalizeTicket<Meme, Quote>` ABI merged in contracts PR #108. The
reference contracts revision is `0fa909c871c7c879f85f881c4ec699c57364b00e`;
record the exact revision actually published in the configuration. No old package is a default.

`aftermath::new` returns `(initializer, ticket)`. Setters borrow result 0;
`aftermath::finalize` consumes results 0 and 1, with the ticket at argument 2.
Creation shares the sale and reservation and temporarily admits SUI/the native witness
inside the same transaction, restoring their original admission values before it ends.
The runner grants a separate temporary AdminCap to the creator. Cleanup revokes and
destroys only that cap; existing grants, fee settings and policy entries are preserved.

## Evidence carried forward

The `PRIOR_EVIDENCE` manifest in `target.ts` includes source hashes and receipt IDs.
Its paths refer to the Blast workspace (the deployment record is in the contracts repo).
Older evidence is included separately in the eventual record, never counted as a final-package
transaction or a completed FinalizeTicket check.

| Existing evidence | Reused coverage | Limit |
| --- | --- | --- |
| Contracts `deployments/sui/mainnet/2026-10-20-blast-presale-versioned-e2e.json` | Signed vendor lifecycles and shared Aftermath integration | These sales used the vendor, not the native adapter. The old E2E-042 description's claim that they tested the native branch is incorrect. |
| Workspace `outputs/operations/2026-10-21-aftermath-sui-live/verification.json` | 14 signed native transactions on `0x2c0c…844d`: SUI-first creation, migration, both swaps, fee receipts, treasury routing, holder rewards and claims | Older unversioned package, before FinalizeTicket. Native SUI-first migration is already proven there. |
| Workspace `outputs/operations/2026-10-21-aftermath-reverse-order/verification.json` | Both orders on both older native packages, custody and exact migration amounts | Reconstructed simulations with ownership checks disabled; not signed lifecycles. The LP publication was real. |

The final-package run is a release verification of the new creation gate and its complete
lifecycle. It does not require repeating the earlier 89-transaction matrix or reward-distribution
exercise. E2E-042 remains open until the final-package receipts and cleanup are recorded.
It alone does not establish both signed coin orders on the final package or authorize production
witness admission. Application indexing/frontend-fee coverage is separate.

## Configure and preflight

From this checkout, copy `deployment.final.example.json` to `deployment.local.json`.
Fill every `SET_…` value from the **final publication and activation receipts**. Use full
nonzero 32-byte IDs and decimal strings for initial shared versions. The template retains the
existing ACL/root, testkit and public operator addresses; replace them if the final deployment
uses different ones. Use a fresh final publication (`packageId = originalPackageId`).
`SALE_F` is the candidate unused test token; preflight checks its availability. If another run
used it, choose another available testkit letter before starting with a new state file.
The fee recipient must differ from the creator and governed treasury.

```bash
export E2E_DEPLOYMENT="$PWD/e2e/presale-mainnet/deployment.local.json"
export E2E_STATE="$PWD/e2e/presale-mainnet/state.local.json"
node e2e/presale-mainnet/run.ts e042 preflight
```

Preflight loads no keys and submits nothing. It checks mainnet identity, the live native
FinalizeTicket ABI, the final package's publication receipt, each singleton's defining type
and shared version, the root's ownership and ACL binding, SUI coin order, test-token availability,
and the SDK LP publication template. The LP probe uses checks-disabled dev-inspect and is labeled
as such; it does not count as a signed result. Every submission repeats target validation and
requires a checks-enabled simulation of the exact transaction bytes before signing.

A final deployment configuration is required even for `lp`, `setup`, `cleanup` and `record`.
Missing/legacy configurations, old ABIs and state from another target are rejected.
The recorded commit is the operator's source declaration; chain reads verify package/object
identity and ABI, not a reproducible source-to-bytecode build.

The runner uses the public SDK native creation/finalize/share calls,
`migrateNativeAftermath`, and `collectNativeAftermathFees`. The SDK ABI snapshot
is frozen at the final contracts revision; the vendor methods retain their existing behavior.
See [the SDK native flow](../../docs/presale.md#native-aftermath-pools) for application use.

## Execute when the final deployment is available

The deployer publishes the LP coin, creates/funds/migrates, swaps and claims. The ACL root
signs grants/revocation with deployer-sponsored gas. Keys can remain in the local Sui Ed25519
keystore, or be supplied as `DEPLOYER_KEY` / `ADMINISTRATOR_KEY` environment secrets.
The runner requires that each key matches its configured address.

```bash
node e2e/presale-mainnet/run.ts e042
node e2e/presale-mainnet/run.ts e042 cleanup
E2E_RECORD_OUT="$PWD/e2e/presale-mainnet/record.local.json" \
  node e2e/presale-mainnet/run.ts e042 record
```

Optional `lp` and `setup` phases prepare just those resources. The normal run does both.
It raises 0.01 SUI, buys with 0.002 SUI and sells half the resulting Meme. The raise seeds
permanent test liquidity and the LP coin goes to `0x0`. Supply is 1 billion tokens at nine
decimals: 5,000 BPS to participants, the balance after the configured protocol token fee to LP.
The pool takes 200 BPS DAO fees. Swaps allow 0.5% slippage from a fresh validation-enabled quote.
Per-transaction gas is capped at 0.1 SUI; the default cumulative gross gas allowance is 0.5 SUI
(`E2E_BUDGET_MIST` can increase it). This allowance is a ceiling, not an estimate of actual cost.
The payer needs enough balance for the gas cap plus in-transaction SUI inputs.

The runtime journal is private and ignored by Git. It saves signed bytes before submission and
receipts before processing assertions. Rerunning a phase reuses the saved transaction instead
of signing a duplicate. A pending submission is retried with its original bytes/signatures;
if it has expired or failed, inspect its digest and reconcile state before taking further action.
Do not delete or reuse state to force a rerun of an uncertain transaction. A PID lock prevents
concurrent processes from sharing one state file; after a crash, verify that PID has exited before
removing a stale `.lock`. Use distinct states/configurations for distinct runs. External state
paths must also be kept private and out of Git.

`record` requires migration, both swaps, collection, claims, cleanup, and passing checks, then
re-reads every tracked transaction from mainnet and requires checkpointed success. It reports
exact receipts, coin ordering, pool balances, LP/OwnerCap custody, fees and gas separately from
prior evidence. It never writes contracts docs automatically. After review, copy `record.local.json`
to contracts `deployments/sui/mainnet/` and update that repo's `docs/presale-mainnet-e2e.md` status
paragraph with its final package and record link. Retain the raw evidence log and private journal.

## Local verification

```bash
node_modules/.bin/tsc -p e2e/presale-mainnet/tsconfig.json
node --test --test-concurrency=1 test/presale-mainnet-e042.test.ts
```

The regression tests are also included by the SDK's normal `npm test`. They check result/ticket
threading, sharing, atomic admission restoration, old ABI rejection and target/state binding.
No key or network is needed for these tests. Use the workspace heavy-job guard for broad SDK
checks. The final-package preflight and lifecycle must still be run after publication.
