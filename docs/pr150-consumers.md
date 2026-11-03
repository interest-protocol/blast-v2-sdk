# PR150 consumer ABI

These bindings target a fresh contract stack at `b841a811f1cb299543ce215efda586686f77383d`.
The compiled public signatures and ordered fields are frozen separately in
`abi/pr150-consumers.json`; run `npm run check:abi:pr150` with `BLAST_CONTRACTS_DIR`
pointing to a contracts checkout containing that commit. Published mainnet ABI
artifacts and deployment identities retain their historical meaning. Do not use
these new object readers or builders with an older deployment.

Bonding rounds are scheduled with an explicit `claimWindowMs`, `gasReserveAmount`
(including zero) and `expectedTreasury`, then published (see below). Quote reserved for reimbursement is
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

Every delayed value names its owning object and an owner-only key `K`, and
lives in one of four `blast_admin` modules: `delayed::Delayed<K, T>` (a
setting), `delayed_action::DelayedAction<K, A>` (a one-shot action slot),
`delayed_set::DelayedSet<K, E>` (an allowlist) or
`delayed_map::DelayedMap<K, E, V>` (entries under one shared notice). Products
no longer emit schedule, cancel or apply events. Each module emits its own
lifecycle under `K`: `Delayed*`, `Action*`, `Set*` plus `MemberRemoved`, and
`Map*`.

- Layouts: `delayedBcs`, `delayedActionBcs`, `delayedSetBcs`, `delayedMapBcs`,
  `proposalBcs`, `entryProposalBcs`, `noticeBcs` and `unitKeyBcs` in
  `@interest-protocol/blast-core/bcs`. A zero-field key encodes as one byte.
  `DelayedChange` (`Action | Delay`), `DelayedSetChange` (`Admission | Delay`)
  and `DelayedMapChange` (`Entry { entry, value } | Delay`) decode the change
  enums.
- Events: `decodeDelayedEvent` checks the admin package, the module, the key's
  package and struct, the value types and the key's family; `delayedEventModule`
  names the module of an event kind. Each product lists its keys
  (`aclDelayedKeys`, `launchpadDelayedKeys`, `migratorsDelayedKeys`,
  `presaleDelayedKeys`) and wraps the decoder
  (`decodeAclDelayedEvent`, `decodeLaunchpadDelayedEvent`,
  `decodeMigratorsDelayedEvent`, `decodePresaleDelayedEvent`); the product
  reducers take the decoded events beside their own. A migrators vault stores
  the launchpad's `FeeSplit`, so `decodeMigratorsDelayedEvent` also takes the
  launchpad's original package ID.
- Readers: the `PackageAdmin` upgrade slot exposes `delayMs` and a `pending`
  `Proposal<DelayedChange<UpgradeAction>>`; `UpgradeAction` no longer has
  `DelayOnly`. The ACL exposes `pendingSuperAdmin.readyAtMs`. The LP-fee
  policy's per-coin overrides are a `DelayedMap`: `getLpFeeShares` reads one
  applied entry, and `pendingCoinShares`, `coinSharesDelayMs` and
  `pendingCoinSharesDelay` expose its pending changes and shared notice.
  `scheduleLpFeeCoinShares` and `scheduleClearLpFeeCoinShares` wait that
  notice; `scheduleLpFeeCoinSharesDelay`, `applyLpFeeCoinSharesDelay` and
  `cancelLpFeeCoinSharesDelay` change it.
- Bootstrap: on a fresh deployment every notice that starts at zero can act as
  a setter. `configureNow` schedules and applies each named setting in one PTB
  with a zero notice; `armNotices` then schedules and applies each notice
  (restating a setting's applied value). After that every change waits. The
  launchpad, presale and migrators transactions each have both builders.
  Upgrade custody is not bootstrapped this way: `wrap` starts each
  `PackageAdmin` at a 48-hour notice, so `scheduleUpgradeDelay` and every
  upgrade action wait it from publication.
- Presale: once a sale is shared, `setPresaleProtocolFees` may only lower each
  rate (`EProtocolFeesIncreased`).

### Claim signers, reward rounds and partners (contracts #161–#164)

- Claim signers: `RuntimeConfig.creator_claim_signers` is a
  `DelayedSet<ClaimSignerKey, vector<u8>>`; any admitted key verifies an
  account claim, and an empty set rejects them. `RuntimeConfigState` exposes
  `creatorClaimSigners` (lowercase hex), `pendingClaimSigners`,
  `claimSignerDelayMs` and `pendingClaimSignerDelay`. `setCreatorClaimSigner`
  is gone: `scheduleCreatorClaimSigner` (`ClaimSignerAdmin`, at most four live
  plus pending keys, abort 43 `ETooManyClaimSigners`), `applyCreatorClaimSigner`
  (anyone) and `cancelCreatorClaimSigner` (`CancelAdmin`) admit a key;
  `revokeCreatorClaimSigner` takes the key and removes it at once, live or
  pending. `schedule/apply/cancelCreatorClaimSignerDelay` change the signer
  notice, which starts at zero. Keys accept bytes or hex. The lifecycle is the
  `ClaimSigners` delayed key (`Set*`, `MemberRemoved`); `CreatorClaimSignerSet`
  is gone and the launchpad projection keeps `creatorClaimSigners`.
- Reward rounds: `LpVault` and the presale `Vault` end with
  `round_publication: DelayedAction<RoundPublicationKey, RoundTerms>`
  (`roundPublication`, terms decoded by `rewardRoundTermsBcs`).
  `scheduleHolderRewardRound` (`RewardsAdmin`) takes `claimWindowMs`, a
  duration that publication starts; `publishHolderRewardRound` is
  permissionless and takes no terms; `scheduleAndPublishHolderRewardRound`
  does both while the vault's round notice is zero (its default);
  `cancelHolderRewardRound` (`CancelAdmin`) and
  `schedule/apply/cancelHolderRewardRoundDelay` complete the slot. The
  `RoundPublication` delayed key decodes `Action*` events; `ActionScheduled`
  carries the full terms and `RoundPublished` the computed deadline. The
  presale `holder_rewards` and `presale_vault` abort maps follow the
  renumbered errors.
- Partners: `Partner.share_bps` and `cap_id` are `Delayed<ShareKey, u64>` and
  `Delayed<CapKey, ID>` with a fixed seven-day notice. Payouts read the applied
  share and take no Clock (`claimProtocolFees` with a partner,
  `claimProtocolLpFeesWithPartner`, `payProtocolFeesWithPartner`,
  `payProtocolLpFeesWithPartner`, `partnerPayment`); `setRecipient` takes no
  Clock. `applyShare`/`applyCap` (anyone) and `cancelShare`/`cancelCap`
  (`PartnerAdmin`) are new. `PartnerUpdated` carries only the recipient;
  `decodePartnerDelayedEvent` decodes the `Share` and `Cap` lifecycle and
  `reducePartnerEvent` projects applied and pending terms. `abi/pr150-consumers.json`
  now freezes the partners package too.
- Bootstrap: launchpad `configureNow` admits `creatorClaimSigners`;
  `armNotices` raises `claimSignerDelayMs`, and the migrators and presale
  `armNotices` raise each named vault's round notice (`roundNotices`). Round
  notices stay zero unless the operator names a vault.

```ts
const configure = launchpad.tx.configureNow({
  adminCapId, tradeFees: { quoteFeeBps: 100n, memeFeeBps: 0n },
  migrationWitnessTypes: [cetusWitness],
});
const arm = launchpad.tx.armNotices({
  adminCapId,
  tradeFees: { quoteFeeBps: 100n, memeFeeBps: 0n, delayMs: 172_800_000n },
  migrationDelayMs: 172_800_000n,
  claimSignerDelayMs: 172_800_000n,
});
const armLpFees = migrators.tx.armNotices({
  adminCapId, coinSharesDelayMs: 172_800_000n,
  roundNotices: [{ memeType, quoteType, vault, delayMs: 86_400_000n }],
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
