# Presale

`@interest-protocol/blast-sdk/presale` covers the standalone `blast_presale`
package (contracts ADRs 0099 through 0102 and 0104): overflow presales with capped
commitments, one common fill rate, migration-gated claims, full refunds when a
sale does not migrate, permissionless Cetus or Bluefin migration into a
`PresaleVault`, vesting token and raise shares, Blast's protocol fees and
creation allowlists, LP-fee splits, holder-reward rounds, and the package's own
two-tier administration.

The package is published on mainnet on its own (contracts ADR 0099), so it
registers before the rest of Blast. `getPresaleDeployment(network)` returns the
complete Blast release's presale once one is registered, and the standalone
release (`BLAST_PRESALE_DEPLOYMENTS`) until then:

```ts
import { getPresaleDeployment } from "@interest-protocol/blast-sdk/deployments";

const presale = new PresaleTransactions(getPresaleDeployment("mainnet"));
```

For another deployment, pass the IDs from the publish and `package_admin::wrap`
effects, validated with `definePresaleDeployment`:

```ts
const presale = new PresaleTransactions(definePresaleDeployment({
  packageId, // current package
  originalPackageId, // first publication; names every type
  venueConfig: { objectId, initialSharedVersion },
  // Shared by publication; creation checks it once.
  creationPolicy: { objectId, initialSharedVersion },
  // Shared by publication; creation, migration, and fee collection read it.
  feePolicy: { objectId, initialSharedVersion },
  // Shared by publication; every administrator call checks its AdminCap here.
  adminRegistry: { objectId, initialSharedVersion },
}));
```

Deployment shared objects carry no `mutable` flag: each call sets the
mutability its Move signature needs.

## Lifecycle

`Pending -> Open -> Funded -> Migrated`; an underfunded `settle`, or
`cancel_unlaunched` from the LP deadline, ends in `Cancelled`.

| Step | Builder | Notes |
| --- | --- | --- |
| Create and share | `createCetusPresale`, `createBluefinPresale` | One PTB: every rate through `bps::new`, the `RecipientShare` vectors through `recipient_share` (or `vesting_terms` and `vested_recipient_share` for a share with `vesting`), the eligibility policy, `Option<UncappedPhase>`, the LP-fee split through `fee_split`, the venue's `new`, `set_partner` when `partner` is given, `share` from `startMs`, and the `PresaleCap` transfer. Cetus reserves the pair's pool creation in `VenueConfig` and derives the fee rate from `tickSpacing`. The windows count from `startMs`, or from execution once it has passed (`0n` opens at once), so a sale can be created a day ahead; commitments abort with `EPresaleNotStarted` until then. |
| Commit | `commit` with `route: "open" \| "allowlisted" \| "uncapped"` | Sources `amount` Quote with `tx.coin`, and transfers the returned change to `recipient`. The change is zero except in a hard-capped uncapped phase. |
| Settle | `settle`, `cancelUnlaunched` | Anyone may call. |
| Migrate | `migrateCetus`, `migrateBluefin` | Anyone may call. Cetus type arguments are `[Meme, Quote, CoinA, CoinB]` in Cetus order (`cetusMemeSide`). Bluefin takes both `Currency` objects read-only and pays its SUI creation fee from gas. Pass the sale's `partner` when it names one, and the same PTB pays it. |
| Pay Blast and its partner | `payProtocolFeesWithPartner` | Anyone may call, once, after a partnered sale migrates; use it on its own for a sale another migrator migrated. See [Partners](#partners). |
| Claim | `claim` | Relays claims for any participants. The last claim takes the rounding remainder. Under participant vesting, each claim locks the participant's tokens in a new schedule starting at that claim. |
| Fees | `collectCetusFees`, `collectBluefinFees` | Pays Blast its share, then every fee recipient. The holder-reward share stays in the vault. |
| Residuals | `claimMigrationResiduals` | The `PresaleCap` holder. |
| Holder rewards | `publishHolderRewardRound`, `claimHolderRewards`, `closeHolderRewardRound` | Publication takes the `AdminCap` (`adminCapId`). |
| Cap | `destroyCap` | After cancellation only. |
| Blast's rates | `setProtocolFees` | Takes the `AdminCap`. Applies to presales created afterward. |
| Blast's rates on one sale | `setPresaleProtocolFees` | Takes the `AdminCap`. Only before the sale's `startMs` (`EPresaleStarted`). See [Blast's fees](#blasts-fees). |
| Blast's LP-fee rates on one vault | `setProtocolLpFees` | Takes the `AdminCap`. Applies to that vault's later collections, including fees already in the pool. The contract rejects an unchanged pair (`ProtocolLpFeesChanged`). |
| Blast's payout address | `setProtocolDestination` | Takes the `AdminCap`. Applies to every later payout. |
| Partners | `addPartner`, `removePartner` | Take the `AdminCap`. Which Blast partners presales created afterward may name: added at once, removed after `PARTNER_DELAY_MS`. |
| Listing | `setQuoteAllowed`, `setMigrationWitnessAllowed` | Takes the `AdminCap`. Which Quote types and migrators presales created afterward may use; existing sales are unaffected. A migrator is a `venue` of this package or the `witnessType` of an external migrator's `Witness` struct. |
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

A sale may also set `participantVesting` in `PresaleTerms` (null pays tokens
out), built as `Option<VestingTerms>` right after the sale's token rate. Each
claim after migration then locks the participant's tokens in its own
irrevocable schedule that starts at that claim, not at migration, and pays the
Quote refund at once. A claim with no tokens, including every claim of a
cancelled sale, creates no schedule. Since a schedule starts at its claim,
relaying `claim` for every participant right after migration starts every
schedule together.

Decoded shares and payouts always carry `vesting` (null when unvested).
`PresaleCreated` carries `participant_vesting`, and `recipient_vesting` and
`raise_recipient_vesting` aligned with their recipients; `RecipientAllocated`,
`RaiseAllocated`, and `Claimed` carry the created schedule's `vesting_id`,
which the reducer keeps in `recipientVestingIds`, `raiseVestingIds`, and
`participantVestingIds`. `PresaleState.participantVesting` holds the sale's
terms.

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
  destination (`ProtocolFeesPaid`); a sale naming a partner pays them through
  `pay_protocol_fees_with_partner` instead (see [Partners](#partners)).
- `lpFeeMemeBps` and `lpFeeQuoteBps` of each collected LP fee, rounded up, go
  to the current destination before the creator's split (`FeesCollected`).
  The vault snapshots them at migration; `setProtocolLpFees` later replaces
  one vault's pair (`ProtocolLpFeesChanged`).

Until a sale's `startMs`, `setPresaleProtocolFees` may replace all four of
its rates within the same bounds (`ProtocolFeesChanged`). Blast's new amounts
are its rates of the supply and of the raise, each rounded down. The token
difference moves to or from the buyers' `tokenAllocation`, which must keep a
token; the Quote difference moves to or from the LP's, which must stay positive
and seed a poolable price. Recipients' amounts and the LP's tokens are
unchanged. Apply `ProtocolFeesChanged` after `PresaleCreated`: it replaces the
sale's rates, Blast's Quote and tokens, and the sale allocation.

A cancelled sale pays Blast nothing, and its token share stays locked.

## Partners

A sale may name one Blast partner (contracts ADR 0106), set once, at creation:
pass `partner` to `createCetusPresale` or `createBluefinPresale`, and the PTB
calls `set_partner` between the venue's `new` and `share`. The
`CreationPolicy` must accept the partner (`EPartnerNotAccepted`); after the
share it never changes. `PresaleOpened.partner_id` records it, and
`PresaleState.partnerId` reads it.

The partner earns its `blast_partners` cut of Blast's raise fee, and of nothing
else: Blast's token fee and LP fees are never divided with a partner. A
partnered sale's migration releases the same raise and LP as any sale but holds
Blast's fees (`PresaleState.unpaidProtocolQuote`).
`pay_protocol_fees_with_partner` then pays the partner its cut in force, rounded
down, and Blast the rest and all its tokens. It emits `ProtocolFeesPaid` with
`partner_quote`, and `blast_partners` emits `PartnerPaid`. A sale without a
partner pays Blast at migration as before, with `partner_quote` zero. Pass the
sale's `partner` to `migrateCetus` or `migrateBluefin` to pay it in the
migration PTB; `payProtocolFeesWithPartner` does it alone, and aborts on a sale
it does not owe (`EWrongPartner`, `ENoPartnerPayout`).

## Creation allowlists

`creation_policy::CreationPolicy` lists the Quote types and the migration
witnesses (`cetus::Witness`, `bluefin::Witness`, or an external migrator's) new
presales may use, and the partners they may name (see [Partners](#partners)); both sets are empty at publication, so the `AdminCap` must
allow at least one of each before any sale can be created. Creation checks it
once (`EQuoteNotAllowed`, `EMigrationWitnessNotAllowed`); a later delisting never
touches a live sale. `blast_presale::new` and `migrate` are public (contracts
ADR 0104), so a migrator in another package, such as a partner's vendor package,
creates and migrates sales with its own sealed `Witness` once allowed. Pass that
struct as `setMigrationWitnessAllowed({ witnessType })`; the contract rejects a
primitive, a vector, or a framework (`0x1` or `0x2`) type
(`EInvalidMigrationWitness`), any of which anyone can construct, and the
builder throws before it reaches the chain. Read it with `PresaleClient.getCreationPolicy` before
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
- `previewSettlement` and `previewClaim` mirror `settle` and `claim`:
  `tokens = floor(allocation * c / C)` and `refund = floor((C - R) * c / C)`. On
  cancellation, the refund is the full commitment. `previewClaim` also returns
  the `vesting` terms its tokens lock under, null when they are paid out.
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
`decodePresaleEvent` decodes the 16
events generic over `<SaleToken, Quote>`. `PresaleVaultCreated` adds a `Venue`
type argument. `decodePresalePolicyEvent` decodes `FeesChanged`,
`DestinationChanged`, `QuoteSet`, `MigrationWitnessSet`, `PartnerAdded`,
`PartnerRemoved`, `AdminCapReplaced`, and `AdminCapRevoked`, which have no type
arguments.
`reducePresaleEvent` rebuilds each presale's lifecycle, windows, commitments,
and custody balances, its vault, and its rounds. `Committed` has no wallet
field, so the reducer keys commitments by the event sender. The `Presale`
object stores only its start: `PresaleState` derives the end, LP deadline, and
uncapped start from it, and `participants` counts the wallets still holding a
commitment, which `Claimed.remaining_participants` reports after each claim;
the claim that leaves one takes the rounding remainder.

## ABI coverage

`abi/production-presale-v1.json` freezes the package at contracts `55e1ac0`,
with the approved amendments it lists. Every public function is classified:

- **Builders:** all 19 `blast_presale` functions; `blast_presale_admin`
  `replace_admin_cap`, `revoke_admin_cap`, and `transfer_super_admin`;
  `fee_policy` `set_fees` and
  `set_destination`; `creation_policy` `set_quote_allowed`,
  `set_migration_witness_allowed`, `add_partner`, and `remove_partner`; `cetus` and `bluefin` `new`, `migrate`, and
  `collect_fees`; `presale_vault` `claim_migration_residuals` and
  `set_protocol_lp_fees`; and
  `holder_rewards` `publish_round`, `claim`, and `close_round`.
- **Compositional:** `bps::new`, which every rate argument passes through.
- **Move composition:** `blast_presale::new` and `migrate`, which a migrator's
  own module calls with its sealed witness; no transaction can construct one.
- **Off-chain mirror:** the package-internal `merkle_tree::node` and `verify`
  (`allowlist.ts`);
  `bps::value` and `apply_up` (`math.ts`).
- **Excluded:** `package_admin::wrap` (deployment), and `authorize_upgrade` and
  `commit_upgrade` (upgrade custody, which CLI publish tooling drives).
