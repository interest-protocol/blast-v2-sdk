# Versioned presale SDK verification

The explicit live check targets the **test-only mainnet** presale published on
2026-10-20:
`0xafc415fa1187577c60205ccff10151fca540b088a3b84f798b90ae0642fa83f8`.
Its generation-1 `PackageVersion` is
`0xe7634c9e47c0ad15c02e52e73cf7b261f064cb00aaedbf6393683ca31ddee7f0`.
The [contracts deployment record](https://github.com/interest-protocol/blast-v2-contracts/blob/d34d70900d6798b30a932b256e50868c40ec867c/deployments/sui/mainnet/2026-10-20-blast-presale-versioned-activation-test.json)
records publication, activation, test currencies and cleanup.

Run from this checkout with Node 22.18 or later and installed dependencies:

```sh
node --test --test-concurrency=1 scripts/presale-live.test.mjs
```

`SUI_GRPC_URL` optionally selects another mainnet gRPC endpoint. The test never
loads a signer, broadcasts a transaction or spends gas. It is separate from
`npm test` because it needs a reachable mainnet node and these retained fixtures.
The fixture is test data, not a registered SDK deployment or application preset.

## Coverage

| Layer | What is checked |
| --- | --- |
| Deployed ABI | All 51 core functions classified as SDK builders/compositional constructors: visibility, entry flag, generic constraints, parameter types and mutability, return types and defining package identities |
| SDK construction | Every public method of `PresaleTransactions` (31) and `PresaleCalls` (50, including helpers), using the existing transaction assertions; every one of the 51 core functions must be called by those tests |
| Validated mainnet simulation | Fee policy, treasury destination, quote admission and Cetus/Bluefin witness admission succeed after role grants in the same simulated transaction |
| Live lifecycle checks | Both retained cancelled sales reject settle, cancel, each of the three commit routes and fee changes with the exact lifecycle abort; claim rejects a missing commitment |
| Version input | Substituting a `FeePolicy` for `PackageVersion` fails at command 0, argument 1 with `TypeMismatch` |
| Live Move inspection | Cetus and Bluefin creation each succeed with fixed supply, burn-only supply, allowlist/eligible-only uncapped phase and vesting; pre-share fee updates and sharing succeed |
| Currency admission | Both venues reject genuine regulated and pausable currencies with `ESaleTokenNotUnregulated` (35), with no emitted events |
| SDK reads | Shared versions, activated generation, closed creation policy, fee policy, cancelled sale state and missing commitments decode correctly |
| Retained state | Shared deployment objects, ACL, test currencies and TreasuryCaps have identical object digests after the run |

Creation inspection combines publisher-owned TreasuryCaps with root-owned admin
capabilities to temporarily admit the test sale inside one simulated transaction.
Those **12 inspections disable transaction validation**; they establish Move
execution and serialization, not authorization of that combined transaction.
The separate administrator and lifecycle simulations keep validation enabled.
No permissions, allowlists, coin supplies or objects are changed on-chain.

The runner imports the existing construction tests and instruments the builder
classes only within its own process. A new public method or core ABI builder
without construction coverage fails the final coverage assertion. This exposed
and closed the missing eligible-only uncapped-phase construction test.

## Recorded result (2026-10-20)

- Opt-in verification: **120 passed**, no failures or skips, including the
  imported construction tests.
- Full offline SDK suite: **446 passed**, no failures, 3 existing skips.
- Typecheck and formatting passed. Lint exited successfully with 79 existing
  warnings outside the changed files; the changed files pass without warnings.
- All retained-object digest comparisons passed. No transaction was broadcast.
- No SDK runtime change was needed.

## Limits

This is not a claim that every economic path was executed on mainnet. Successful
commit/settle/migration, pool-position vault creation, LP fee collection, partner
payouts and holder reward publication/claims/settlement still have construction
and deployed-ABI coverage, but no successful live lifecycle fixtures in this
new deployment. The retained sales are cancelled and have no commitments or
vaults. The earlier contracts deployment tests exercised sale creation and
cancellation on-chain.

Aftermath vendor builders pass their construction tests. This deployment has no
compatible Aftermath vendor package configured, so they are not live-certified
against it. The core package's native Aftermath module remains intentionally
excluded from SDK routes. A matching vendor deployment and funded lifecycle
fixtures are required before certifying those complete flows.
