# Presale

`@interest-protocol/blast-sdk/presale` covers the standalone `blast_presale`
package (contracts ADRs 0099 through 0102): overflow presales with capped
commitments, one common fill rate, migration-gated claims, full refunds when a
sale does not migrate, permissionless Cetus or Bluefin migration into a
`PresaleVault`, vesting token and raise shares, Blast's protocol fees and
creation allowlists, LP-fee splits, holder-reward rounds, and the package's own
two-tier administration.

The package is not published, so no release is registered. Once one is,
`presaleDeployment(getBlastDeployment(network))` returns the deployment; until
then pass the IDs from the publish and `package_admin::wrap` effects:

```ts
const presale = new PresaleTransactions({
  packageId, // current package
  originalPackageId, // first publication; names every type
  venueConfig: { objectId, initialSharedVersion },
  // Shared by publication; creation checks it once.
  creationPolicy: { objectId, initialSharedVersion },
  // Shared by publication; creation, migration, and fee collection read it.
  feePolicy: { objectId, initialSharedVersion },
  // Shared by publication; every administrator call checks its AdminCap here.
  adminRegistry: { objectId, initialSharedVersion },
});
```

Deployment shared objects carry no `mutable` flag: each call sets the
mutability its Move signature needs.

## Lifecycle

`Pending -> Open -> Funded -> Migrated`; an underfunded `settle`, or
`cancel_unlaunched` from the LP deadline, ends in `Cancelled`.

| Step | Builder | Notes |
| --- | --- | --- |
| Create and share | `createCetusPresale`, `createBluefinPresale` | One PTB: every rate through `bps::new`, the `RecipientShare` vectors through `recipient_share` (or `vesting_terms` and `vested_recipient_share` for a share with `vesting`), the eligibility policy, `Option<UncappedPhase>`, the venue's `new`, `share`, and the `PresaleCap` transfer. Cetus reserves the pair's pool creation in `VenueConfig` and derives the fee rate from `tickSpacing`. |
| Commit | `commit` with `route: "open" \| "allowlisted" \| "uncapped"` | Sources `amount` Quote with `tx.coin`, and transfers the returned change to `recipient`. The change is zero except in a hard-capped uncapped phase. |
| Settle | `settle`, `cancelUnlaunched` | Anyone may call. |
| Migrate | `migrateCetus`, `migrateBluefin` | Anyone may call. Cetus type arguments are `[Meme, Quote, CoinA, CoinB]` in Cetus order (`cetusMemeSide`). Bluefin takes both `Currency` objects read-only and pays its SUI creation fee from gas. |
| Claim | `claim` | Relays claims for any participants. The last claim takes the rounding remainder. |
| Fees | `collectCetusFees`, `collectBluefinFees` | Pays Blast its share, then every fee recipient. The holder-reward share stays in the vault. |
| Residuals | `claimMigrationResiduals` | The `PresaleCap` holder. |
| Vault LP-fee rates | `setProtocolLpFees` | Takes the `AdminCap`. Sets Blast's share of each asset in one vault's later LP-fee collections, including fees still in the pool. |
| Holder rewards | `publishHolderRewardRound`, `claimHolderRewards`, `closeHolderRewardRound` | Publication takes the `AdminCap` (`adminCapId`). |
| Cap | `destroyCap` | After cancellation only. |
| Blast's rates | `setProtocolFees` | Takes the `AdminCap`. Applies to presales created afterward. |
| Blast's payout address | `setProtocolDestination` | Takes the `AdminCap`. Applies to every later payout. |
| Listing | `setQuoteAllowed`, `setMigrationWitnessAllowed` | Takes the `AdminCap`. Which Quote types and venues presales created afterward may use; existing sales are unaffected. |
| Administration | `replaceAdminCap`, `revokeAdminCap`, `transferSuperAdmin` | Take the `SuperAdminCap` (`superAdminCapId`). See [Administration](#administration). |

`PresaleCalls` exposes each Move call separately for composition.

## Administration

The package does not link `blast_admin`. Publication sends the publisher a
key-only `SuperAdminCap` and one `AdminCap`, and shares an `AdminRegistry`
recording the accepted cap. Every administrator builder passes
`&AdminRegistry` from the deployment and the `AdminCap`; the contract aborts
with `EInvalidAdminCap` unless that cap is the registered one.

The `SuperAdminCap` cannot administer anything itself. `replaceAdminCap` mints a
new `AdminCap`, sends it to `recipient`, and stops the old cap in the same
transaction; `revokeAdminCap` stops all administration until the next
replacement. The `SuperAdminCap` has no `store`, so `transferSuperAdmin` is the
only way to move it. `PresaleClient.getAdminRegistry` reads the accepted cap ID
(null after a revocation), and `decodePresalePolicyEvent` decodes
`AdminCapReplaced` and `AdminCapRevoked`.

## Vesting

A token or raise share may carry `vesting: { cliffMs, periodMs, periods }`.
Migration then locks that share in an irrevocable `blast_fun_vesting` linear
schedule starting at migration instead of paying it: nothing before
`cliffMs`, then a step every `periodMs` until all `periods` have elapsed.
`vestingTerms` mirrors `blast_presale::vesting_terms` (`EInvalidVestingTerms`:
positive period and count, a cliff within the duration, and a duration of at
most 2^63 ms). Fee recipients cannot vest: the builders throw, and
`validateFeeSplit` throws `EInvalidFeeSplit`. Product limits on vesting
durations belong to creation tooling.

Decoded shares and payouts always carry `vesting` (null when unvested).
`PresaleCreated` carries `recipient_vesting` and `raise_recipient_vesting`,
aligned with their recipients; `RecipientAllocated` and `RaiseAllocated` carry
the created schedule's `vesting_id`, which the reducer keeps in
`recipientVestingIds` and `raiseVestingIds`.

## Blast's fees

`fee_policy::FeePolicy` holds four rates, all zero at publication, and the
address Blast is paid at. Every rate is a `bps::Bps`, built in the PTB through
`bps::new`, which aborts above 10,000. Each presale snapshots the rates when it
is created:

- `tokenBps` of the supply joins the supply apportionment, so the creator's
  presale, LP, and recipient BPS must total `10,000 - tokenBps`. Read the
  current policy with `PresaleClient.getFeePolicy` before building a creation.
- `raiseBps` of the raise joins the raise apportionment between the raise
  recipients and the LP. Migration pays it, and Blast's tokens, to the current
  destination (`ProtocolFeesPaid`).
- `lpFeeMemeBps` and `lpFeeQuoteBps` of each collected LP fee, rounded up, go
  to the current destination before the creator's split (`FeesCollected`).
  Migration snapshots them into the vault; the `AdminCap` can then change one
  vault's pair with `setProtocolLpFees` (`ProtocolLpFeesChanged`, which the
  reducer applies to the vault's `protocolLpFeeMemeBps` and
  `protocolLpFeeQuoteBps`). The creator's split of the rest is unchanged.

A cancelled sale pays Blast nothing, and its token share stays locked.

## Creation allowlists

`creation_policy::CreationPolicy` lists the Quote types and the migration
witnesses (`cetus::Witness`, `bluefin::Witness`) new presales may use; both
sets are empty at publication, so the `AdminCap` must allow at least one of each
before any sale can be created. Creation checks it once
(`EQuoteNotAllowed`, `EMigrationWitnessNotAllowed`); a later delisting never
touches a live sale. Read it with `PresaleClient.getCreationPolicy` before
building a creation; `previewPresaleCreation` does not check it.

## Previews

`math.ts` mirrors the contract's arithmetic in integer atoms and its abort
order. A preview throws `PresaleAbortError` with the Move error name.

- `previewPresaleCreation` runs every check `blast_presale::new` makes in order,
  after those of the PTB's constructors (`bps::new` throws `EInvalidBps` first),
  and returns the exact apportionment:
  `apportionSupply` and `apportionRaise` use largest remainder, with Blast's
  token and raise shares from `config.protocolFees`. Earlier shares win ties. The function also returns the seed sqrt price that `is_seedable`
  checks. `validateBluefinPresaleTier` adds `bluefin::new`'s bounds.
- `previewCommit` mirrors `record_commitment` with its route guards: wallet
  cap, minimum, participant bound, uncapped phase, and hard cap. It returns the
  accepted Quote, the change, and the `Committed` totals.
- `previewSettlement` and `previewClaim` mirror `settle` and `claim_payout`:
  `tokens = floor(allocation * c / C)` and `refund = floor((C - R) * c / C)`. On
  cancellation, the refund is the full commitment.
- `apportionFee` mirrors `presale_vault::fee_shares`, and `splitCollectedFee`
  mirrors `split_fees` for one asset: Blast's share first, then the split.

## Allowlists and reward rounds

`buildAllowlist` builds the positional Blake2b-256 tree `merkle_tree::verify`
checks. Each leaf is `0x00 || "blast-presale-v1" || bcs(index, wallet, cap)`.
`verifyAllowlistProof` checks one proof. Presale reward rounds use the migrators'
manifest with the leaf domain `PRESALE_REWARD_LEAF_DOMAIN`
(`0x00 || "blast-presale-holder-rewards-v1"`):

```ts
const manifest = buildRewardManifest({ ...round, leafDomain: PRESALE_REWARD_LEAF_DOMAIN });
```

`publishHolderRewardRound` rejects a manifest from any other domain or vault.

## Reads and replay

`PresaleClient` (`blastPresale()` extension) reads a `Presale`, a wallet's
`Commitment` dynamic field, a `PresaleVault`, a reward `Round`, the
`FeePolicy`, the `CreationPolicy`, and the `AdminRegistry`.
`decodePresaleEvent` decodes the 17
events generic over `<SaleToken, Quote>`. `PresaleVaultCreated` adds a `Venue`
type argument. `decodePresalePolicyEvent` decodes `FeesChanged`,
`DestinationChanged`, `QuoteSet`, `MigrationWitnessSet`, `AdminCapReplaced`, and
`AdminCapRevoked`, which have no type arguments.
`reducePresaleEvent` rebuilds each presale's lifecycle, windows, commitments,
and custody balances, its vault, and its rounds. `Committed` has no wallet
field, so the reducer keys commitments by the event sender.

## ABI coverage

`abi/production-presale-v1.json` freezes the package at contracts `a3aa934`.
Every public function is classified:

- **Builders:** all 15 `blast_presale` functions; `blast_presale_admin`
  `replace_admin_cap`, `revoke_admin_cap`, and `transfer_super_admin`;
  `fee_policy` `set_fees` and
  `set_destination`; `creation_policy` `set_quote_allowed` and
  `set_migration_witness_allowed`; `cetus` and `bluefin` `new`, `migrate`, and
  `collect_fees`; `presale_vault` `claim_migration_residuals` and
  `set_protocol_lp_fees`; and
  `holder_rewards` `publish_round`, `claim`, and `close_round`.
- **Compositional:** `bps::new`, which every rate argument passes through.
- **Off-chain mirror:** `bps::value` and `apply_up` (`math.ts`). The
  `merkle_tree` functions are package-only; `allowlist.ts` mirrors them.
- **Excluded:** `package_admin::wrap` (deployment), and `authorize_upgrade` and
  `commit_upgrade` (upgrade custody, which CLI publish tooling drives).

## Parity vectors

`tests/vectors/presale-events.json` holds real emitted presale and policy
events with the expected `decodePresaleEvent` (or `decodePresalePolicyEvent`)
output and the expected `reducePresaleEvent` projection (`presales`, `vaults`,
`rounds`) after each event. Bigints are decimal strings. Its SHA-256 is pinned
in `presale-events.sha256` (`sha256sum -c` format).
`test/presale-vectors.test.ts` refuses a file that does not match the pin, then
replays every case through the decoders and the reducer. blast-infra vendors
the same file and pin as its parity gate.

Each case is one sale's full event history in ledger order, or one batch of
policy events, with its `source` (`localnet` or `mainnet:<chain id>`) and the
package's original ID. `kinds` lists the event kinds the cases cover;
`pending_kinds` lists the rest. There is no testnet stage.

Pinned at SHA-256
`6da23d838c476c9c66ff07c41de93752468780de8bee3ad98d17446dd4c0bcf7`, from the
localnet stage on contracts `a3aa934` with `sui` 1.77.2 (which contains the
contracts' framework revision `06734f6`):

| Case | Events |
| --- | --- |
| `policy` | `QuoteSet`, `MigrationWitnessSet`, `FeesChanged`, `DestinationChanged` |
| `admin` | `AdminCapReplaced` (naming the publication's `AdminCap` as the previous cap), then `AdminCapRevoked` |
| `open-funded` | Created with a vested 600 BPS and an unvested 400 BPS token share and a vested 2,000 BPS raise share, opened, four `commit_open` commitments from three wallets (one wallet twice), funded by `settle` with a 5 SUI overflow |
| `open-missed-raise-refunded` | Created with a 1,000 BPS token share vesting over exactly 2^63 ms (the contract's bound), two commitments below the raise, cancelled by `settle`, two refund `Claimed` relayed in one PTB |
| `allowlisted-funded` | Two `commit_allowlisted` commitments with `buildAllowlist` proofs, funded |
| `uncapped-hard-cap-filled` | Two capped commitments, then a `commit_uncapped` offering 6 SUI that the hard cap fills with the last 4, funded |

`pending_kinds`: `PresaleMigrated`, `ProtocolFeesPaid`, `RaiseAllocated`,
`RecipientAllocated`, `PresaleVaultCreated`, `FeesCollected`,
`MigrationResidualsClaimed`, `ProtocolLpFeesChanged`, `RoundPublished`,
`RoundClosed`, `RewardClaimed`. A localnet cannot reach them: `blast_presale`
links the Cetus and Bluefin interface stubs, whose bodies are `abort 0`, so
migration aborts, and `cancel_unlaunched` needs the seven-day liquidity window
to pass. The vesting schedules migration creates (and their
`blast_fun_vesting` events) are out of this file's kinds for the same reason.
They come from mainnet capture.

### Localnet stage

```bash
npm run vectors:presale -- localnet --contracts ../contracts
```

Uses the localnet at `--rpc` (default `http://127.0.0.1:9000`, faucet
`--faucet` `http://127.0.0.1:9123`), or starts
`sui start --force-regenesis --with-faucet` and stops it afterward. Point
`--rpc` and `--faucet` at a localnet you started on other ports (for example
`sui start --force-regenesis --with-faucet=127.0.0.1:9323 --fullnode-rpc-port 9310`)
to keep it off the defaults; the stage only starts one when `--rpc` does not
answer. It copies `sui/presale` and `sui/migrators/interfaces` from the
contracts worktree and publishes `blast_presale` with
`sui client test-publish --build-env mainnet --publish-unpublished-deps`
under its own client config, keystore, and ephemeral pubfile. That also
publishes IntegerLibrary, IntegerMate, BluefinSpot, the Cetus interface stubs,
and `blast_fun_vesting` on the localnet: an ephemeral publication ignores a
dependency's mainnet `Published.toml` or `published-at`. Publication sends the
deployer the `SuperAdminCap` and the `AdminCap`; the stage sets the policies
with that `AdminCap`, then replaces and revokes it (`admin`, after every call
that needs it), runs the sales with `PresaleTransactions`, and captures them
into `--out` (default `tests/vectors/presale-events.json`). Every sale uses the
Bluefin venue: `cetus::new` calls aborting interface stubs. Each sale's window
is 240 s so its commits land on a loaded host. It writes the transaction
digests to `--digests-out` (default: beside its temporary directory, which it
removes on success). `--out` must end in `.json`, because the pin is written
beside it as `.sha256`. It took 440 s.

The `sui` binary must contain the contracts' framework revision. Bluefin's
interface pins IntegerMate `sui-v1.1.2`, which `blast_presale` overrides; the
CLI ignores that override when it publishes Bluefin, so the stage records the
pinned copy at the published override's address.

### Capture

```bash
npm run vectors:presale -- capture --rpc https://fullnode.mainnet.sui.io:443 --digests mainnet-digests.json
```

The digests file names the package and the transactions to capture:

```json
{
  "original_package_id": "0x…",
  "cases": [{ "name": "bluefin-migration", "digests": ["<migrate digest>"] }]
}
```

Capture reads every event of the package's `blast_presale`, `presale_vault`,
`holder_rewards`, `fee_policy`, `creation_policy`, and `blast_presale_admin`
modules over gRPC. For
each case it keeps the full history of the one sale its transactions touch
(through the sale's vault and rounds), so one digest per sale is enough, or
the listed transactions' policy events when they touch no sale. It recomputes
the expected output with the SDK, replaces cases of the same name in place in
`--out`, appends new ones, and rewrites `kinds`, `pending_kinds`, and the pin.
The fullnode must still hold each captured sale's oldest event, so capture
soon after the transactions (mainnet retained about 14.5 days of events in
October 2026). Capture refuses a sale whose history does not start at its
`PresaleCreated`, and a listed event it cannot map to a sale. It ignores
unlisted vault or round events whose creation event is no longer retained.
Mainnet capture stages:

1. A migration (`PresaleMigrated`, `ProtocolFeesPaid`, `RaiseAllocated`,
   `RecipientAllocated`, `PresaleVaultCreated`) and the claims after it.
2. `MigrationResidualsClaimed`, `FeesCollected`, `ProtocolLpFeesChanged`,
   `RoundPublished`, `RewardClaimed`, and `RoundClosed`.
3. A liquidity-deadline cancellation (`cancel_unlaunched` and its refunds).

Run against the localnet digests, capture reproduces the localnet stage's file
byte for byte, including from only the last transaction of each sale.
