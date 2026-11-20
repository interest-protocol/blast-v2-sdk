# @interest-protocol/blast-boosts-sdk

The boosts package in the [Blast SDK monorepo](https://github.com/interest-protocol/blast-v2-sdk).

```sh
npm install @interest-protocol/blast-boosts-sdk
```

See the repository README and docs for usage, development, and release guidance.

## Governance

This SDK targets the contracts source at `ca076654`. Configure
`adminPackageId` with the shared admin package and each product’s
`packageVersion` with the adapter’s shared version object for that release.

Use `addBoostsGovernanceCall(tx, manifest, productKey, action)` to append a
call to a transaction. Pass the witness from the shared ACL’s `sign_in` for
scheduling, cancellation, partner changes, withdrawals and package governance.
Applying a scheduled policy is permissionless. Applying the order cap reads the
product’s bound venue objects. Partner changes use the Boosts protocol’s list.

| Action | Witness role |
| --- | --- |
| Schedule fees or add/remove a partner | Launch core `FeeAdmin` |
| Schedule a NAV or order cap | Boosts core `RiskAdmin` |
| Cancel a pending vault change | Launch core `CancelAdmin` |
| Withdraw fees to the shared treasury | Launch core `TreasuryAdmin` |
| Unpause | Shared admin `UnpauseAdmin<BLAST_BOOSTS_AFTERMATH>` |
| Activate an upgrade or make the package immutable | Shared admin `UpgradeAdmin<BLAST_BOOSTS_AFTERMATH>` |

After matching the aborting package ID, pass its Move module name and numeric
code to `boostsCoreAbortName` or `boostsAdapterAbortName`. Shared-package
aborts retain the identity of the package that raised them.
