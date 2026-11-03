# PR150 consumer ABI

These bindings target a fresh contract stack at `61b55508ce4dd2b2a6e81035eb029cef7994c26a`.
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

Administrative bindings also target the fresh stack:

- ACL metadata contains `adminsTableId` and `adminCount`. `getAclAdminRoles`
  performs a targeted Table lookup; only an absent field means revocation.
  `getAcl` enumerates up to 100 pages and rejects inconsistent reads.
- Launch/config/runtime/creation-policy readers expose applied values plus
  delays and pending proposals. Readiness alone never changes the applied value.
- Replace immediate fee, treasury and witness setters with `schedule*`, followed
  by `apply*` after readiness, or `cancel*` using `CancelAdmin`. Fee proposals
  take `delayMs`; witness admission uses the policy's notice. Witness removal
  and Quote delisting remain immediate.
- `setPresaleProtocolFees` remains a pre-start override, capped by the applied
  `FeePolicy`; the builder supplies that policy reference.
- `scheduleCurveFeeCapReassignment` / `scheduleMetadataCapReassignment` apply
  with `applyCurveFeeCapReassignment` / `applyMetadataCapReassignment`; their
  notice proposals (`schedule*CapDelay`) apply with `applyCurveFeeCapDelay` /
  `applyMetadataCapDelay`. `pending*CapReassignment.value.kind` is `Action`
  for a recipient and `Delay` for a notice change.
- `pause` / `unpause` use separate roles. Launchpad masks are Create=1,
  Trading=2, Migrate=4; presale masks are Create=1, Commit=2, Migrate=8.
- Each package exposes delayed upgrade actions. Compose `authorizeUpgrade`,
  Sui's upgrade command and `commitUpgradeAndAdvance` in one PTB. The commit
  mutates the version container and advances the operational generation.

```ts
const proposal = launchpad.tx.scheduleTradeFees({
  adminCapId, quoteFeeBps: 100n, memeFeeBps: 0n, delayMs: 172_800_000n,
});
// Submit the proposal, wait for its on-chain ready_at_ms, then submit:
const application = launchpad.tx.applyTradeFees();
```

`172_800_000` milliseconds is 48 hours.

### Keyed delayed values (contracts PR 157)

Every delayed setting, one-shot action and allowlist is a `blast_admin::delayed`
`Delayed<K, T>`, `DelayedAction<K, A>` or `DelayedSet<K, E>` that names its
owning object and an owner-only key `K`. Products no longer emit schedule,
cancel or apply events: `delayed` emits `DelayedCreated`, `DelayedScheduled`,
`DelayedCancelled`, `DelayedApplied`, `DelayedDestroyed`, the matching
`Action*` events and `MemberRemoved` under `K`.

- Layouts: `delayedBcs`, `delayedActionBcs`, `delayedSetBcs`, `proposalBcs`,
  `noticeBcs` and `unitKeyBcs` in `@interest-protocol/blast-core/bcs`. A
  zero-field key encodes as one byte.
- Events: `decodeDelayedEvent` checks the admin package, the key's package and
  struct, the value type and the key's family. Each product lists its keys
  (`aclDelayedKeys`, `launchpadDelayedKeys`, `migratorsDelayedKeys`,
  `presaleDelayedKeys`) and wraps the decoder
  (`decodeAclDelayedEvent`, `decodeLaunchpadDelayedEvent`,
  `decodeMigratorsDelayedEvent`, `decodePresaleDelayedEvent`); the product
  reducers take the decoded events beside their own. A migrators vault stores
  the launchpad's `FeeSplit`, so `decodeMigratorsDelayedEvent` also takes the
  launchpad's original package ID.
- Readers: the `PackageAdmin` upgrade slot exposes `delayMs` and a `pending`
  `Proposal<DelayedChange<UpgradeAction>>`; `UpgradeAction` no longer has
  `DelayOnly`. The ACL exposes `pendingSuperAdmin.readyAtMs`.
- Bootstrap: on a fresh deployment every notice that starts at zero can act as
  a setter. `configureNow` schedules and applies each named setting in one PTB
  with a zero notice; `armNotices` then schedules and applies each notice
  (restating a setting's applied value). After that every change waits. The
  launchpad, presale and migrators transactions each have both builders.

```ts
const configure = launchpad.tx.configureNow({
  adminCapId, tradeFees: { quoteFeeBps: 100n, memeFeeBps: 0n },
  migrationWitnessTypes: [cetusWitness],
});
const arm = launchpad.tx.armNotices({
  adminCapId,
  tradeFees: { quoteFeeBps: 100n, memeFeeBps: 0n, delayMs: 172_800_000n },
  migrationDelayMs: 172_800_000n,
  upgrade: { packageAdmin, delayMs: 172_800_000n },
});
``` The compiler-signature matrix checks
roles, argument order and shared-object mutability. Fresh Move-generated golden
bytes check launch, config and runtime decoders. Table ACL, delayed application,
upgrade identity, masks and LP Quote guard have regression tests.

The active `FROZEN_ABI` is the PR150 source snapshot. Historical deployment IDs
retain their original source identity and cannot sign with this SDK. This build
is marked unpublished until a coordinated release and fresh manifest are registered.
The live presale harness requires `BLAST_PRESALE_FIXTURE` naming a fresh fixture
at this source commit, with migration witnesses already scheduled and applied.
