# PR150 consumer ABI

These bindings target a fresh contract stack at `f661a03462d557dbf6d57c5b82a5ede98519643d`.
The compiled public signatures and ordered fields are frozen separately in
`abi/pr150-consumers.json`; run `npm run check:abi:pr150` with `BLAST_CONTRACTS_DIR`
pointing to a contracts checkout containing that commit. Published mainnet ABI
artifacts and deployment identities retain their historical meaning. Do not use
these new object readers or builders with an older deployment.

Bonding rounds now publish with an explicit `claimDeadlineMs`, `gasReserveAmount`
(including zero) and `expectedTreasury`. Quote reserved for reimbursement is
removed before committing holder allocations. Claims include Clock. A
RewardsAdmin can settle the independent reserve once; anyone can close after the
deadline and return unused holder funds and unused gas reserve. Both launch kinds
accept checkpoint gaps and reject overlapping intervals.

Migrated vaults expose the applied `feeSplit` and its `feeSplitPolicy` (value,
delay and optional proposal). Schedule and cancel do not change fee routing.
Replace immediate venue updates with `scheduleFeeSplit` followed, when ready, by
`settleAndApplyCetusFeeSplit` / `settleAndApplyBluefinFeeSplit`, or presale
`applyAftermathFeeSplit`. Zero delay still requires explicit application. Venue
application settles fees under the prior split first. A presale vault's protocol
fees are also decoded through their delayed policy.

Reducers preserve pending proposals separately from applied shares. Reward
projection separates holder balances from the gas reserve, credits only reserve
returns to unallocated custody, and restores unclaimed balances on closure.

The holder-rewards operator requires a claim window and expected treasury for
both products. Its configured reserve is excluded before the Merkle manifest is
written; it never edits funded leaves to pay for gas.

Consumer integration must pin this source build until a coordinated SDK release
and fresh deployment manifest are available. This change does not publish npm
packages or authorize a production cutover.
