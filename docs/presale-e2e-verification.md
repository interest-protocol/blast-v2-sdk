# Versioned presale end-to-end verification

The test-only mainnet core `0xafc415fa1187577c60205ccff10151fca540b088a3b84f798b90ae0642fa83f8`
completed **89 signed transactions**, each preceded by a simulation with
`checksEnabled: true`. Eighteen additional validated simulations rejected the
expected invalid operations. No transaction in this run disabled validation.
Production deployment presets and `Published.toml` routing were not changed.

The exact transaction digests, checkpoints and retained object IDs are in
[`presale-mainnet-e2e.json`](../test/fixtures/presale-mainnet-e2e.json). The
[contracts deployment record](https://github.com/interest-protocol/blast-v2-contracts/blob/main/deployments/sui/mainnet/2026-10-20-blast-presale-versioned-e2e.json)
adds source hashes, compiler-resolved dependencies, capability custody, negative
simulations and cleanup evidence. The tested SDK runtime is commit
`00b034514fb1635e940458f3d14b5850093688cb`; no runtime fix was necessary.

## Executed flows

| SDK path | Signed result and independent assertions |
| --- | --- |
| Cetus creation, commit, settle, migrate, claim | 0.01 SUI target; two participants, hard-cap change returned; pool created; LP burned into custody; claims paid 40%/60% of buyer allocation; repeat claim rejected |
| Bluefin creation, commit, settle, migrate, claim | Worthless TEST_SUI quote; live creation fee queried; pool created and position locked; the same funding and claim assertions |
| Aftermath creation and migration | Fresh immutable vendor linked to the new core; fresh LP coin per sale; both `migrateAftermath` and `settleAndMigrateAftermath` executed; reservations consumed, DAO OwnerCap delivered to its compiled treasury, complete LP coin owned by `0x0` |
| Cetus and Bluefin migration residuals | Nonzero residuals claimed with the matching PresaleCap; both vault residual balances became zero; repeat claims rejected |
| Cetus and Bluefin standalone vaults | New funded positions created in the test pools, then passed to `newCetusVault` / `newBluefinVault`; resulting shared vaults read successfully and collected fees |
| Cetus and Bluefin fees | Buy and sell generated both assets' fees; `collectCetusFees` / `collectBluefinFees` split gross amounts into protocol, recipients and holder shares; empty collection also succeeded |
| Per-vault rates | `setProtocolLpFees` changed both LP rates; resulting state decoded correctly |
| Per-sale rates and partner payouts | Before opening, `setPresaleProtocolFees` changed a fifth sale's raise fee to 3%; migration held fees, `payProtocolFeesWithPartner` paid the partner 20% and Blast 80%; `payProtocolLpFeesWithPartner` subsequently emptied both pending LP-fee balances |
| Holder rewards | A funded Bluefin round reserved 72,000,000 TEST_SUI atoms for leaves plus 24,000,000 for gas; relayed claim paid 24,000,000; reimbursement paid 12,000,000; expiry returned 48,000,000 unclaimed atoms; vault retained 204,000,000 |
| Reward rejection paths | Altered proof, duplicate claim, reserve overdraw, duplicate settlement and premature close rejected with exact module/abort codes |
| Aftermath swaps | Both directions succeeded; exactly 2% of input reached the compiled DAO treasury; LP custody remained at `0x0` |

Aftermath DAO pools intentionally have no Blast presale vault or holder-reward
round. Their fee recipient is the vendor's compiled treasury. The native core
Aftermath module remains excluded from SDK routes.

## Repeatable, read-only verification

```sh
node --test --test-concurrency=1 scripts/presale-e2e.test.mjs
```

This opt-in test rechecks all 89 signed receipts, obtains their checkpoints from
the ledger, decodes actual core and vendor events through the SDK, verifies
retained sale/vault/LP state, and simulates all five retained vaults' fee-collection
builders with validation enabled. It never loads keys, signs, broadcasts, grants
roles or modifies chain state. Transient RPC transport failures have bounded
retries; assertions and Move aborts do not. `SUI_GRPC_URL` can select another
mainnet gRPC endpoint.

This checker verifies historical execution and current retained state. It does
not republish fixtures or replay consumed TreasuryCaps, commitments, reservations
or reward rounds. Fresh execution requires new sale tokens and LP capabilities,
and the temporary roles/admissions described in the deployment record. The
workspace's raw signed-run harness, simulations and receipts are retained at
`outputs/operations/2026-10-20-presale-validated-e2e/`.

The SDK's strict event decoders require ledger positions. Core `getTransaction`
events do not include them; the checker fetches the authoritative checkpoint and
uses the transaction's event index rather than inventing metadata.

## Cleanup and limits

- Quote and migrator allowlists are empty again; default fees are zero and the
  original fee destination is restored. The task AdminCap and all its roles
  were revoked and destroyed. Production policies were untouched.
- The test partner was scheduled for removal using the contract's seven-day
  delay. Closed quote/migrator admissions already prevent new sales.
- Five sales are migrated and all ten participant commitments are claimed.
  The reward round is closed, residuals are claimed, and partner fees are paid.
  Test LP remains deliberately locked, and unallocated holder balances remain
  in their vaults. Vendor AdminCap and PartnerCap remain with the test publisher.
- Net transaction gas was **0.491872672 SUI**. Cetus additionally used 0.01 SUI
  for its sale, 0.0001 SUI for a standalone position and 0.001 SUI for its buy.
  Other economic flows used worthless public-faucet TEST_SUI.
- Cetus rejected the custom quote at pool reservation (factory abort 7); its
  successful lifecycle used SUI. Both Aftermath sales use sale-token-first
  ordering; this run does not claim new reverse-order coverage.
- The immutable vendor is bound to generation 1. Before a future core activation
  changes that generation, new sales need a compatible vendor.

The vendor build, strict lint, 10 Move tests and exact live Aftermath ABI checks
passed. The SDK's offline suite and typecheck also pass; the live checker is
separate from the offline suite because it depends on a reachable mainnet RPC.
