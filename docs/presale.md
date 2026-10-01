# Presale

`@interest-protocol/blast-sdk/presale` covers the standalone `blast_presale`
package (contracts ADR 0099, ADR 0100, ADR 0101): overflow presales with capped
commitments, one common fill rate, migration-gated claims, full refunds when a
sale does not migrate, permissionless Cetus or Bluefin migration into a
`PresaleVault`, Blast's protocol fees, LP-fee splits, and holder-reward rounds.

The package is not published, so no release is registered. Once one is,
`presaleDeployment(getBlastDeployment(network))` returns the deployment; until
then pass the IDs from the publish and `package_admin::wrap` effects:

```ts
const presale = new PresaleTransactions({
  packageId, // current package
  originalPackageId, // first publication; names every type
  venueConfig: { objectId, initialSharedVersion },
  // Shared by publication; creation, migration, and fee collection read it.
  feePolicy: { objectId, initialSharedVersion },
  // blast_admin and its shared ACL, for RewardsAdmin, FeeAdmin, and TreasuryAdmin sign-in.
  admin: { packageId: adminPackageId, acl: { objectId, initialSharedVersion } },
});
```

Deployment shared objects carry no `mutable` flag: each call sets the
mutability its Move signature needs.

## Lifecycle

`Pending -> Open -> Funded -> Migrated`; an underfunded `settle`, or
`cancel_unlaunched` from the LP deadline, ends in `Cancelled`.

| Step | Builder | Notes |
| --- | --- | --- |
| Create and share | `createCetusPresale`, `createBluefinPresale` | One PTB: `recipient_allocation` / `fee_recipient` vectors, the eligibility policy, `Option<UncappedPhase>`, the venue's `new`, `share`, and the `PresaleCap` transfer. Cetus reserves the pair's pool creation in `VenueConfig` and derives the fee rate from `tickSpacing`. |
| Commit | `commit` with `route: "open" \| "allowlisted" \| "uncapped"` | Sources `amount` Quote with `tx.coin`, and transfers the returned change to `recipient`. The change is zero except in a hard-capped uncapped phase. |
| Settle | `settle`, `cancelUnlaunched` | Anyone may call. |
| Migrate | `migrateCetus`, `migrateBluefin` | Anyone may call. Cetus type arguments are `[Meme, Quote, CoinA, CoinB]` in Cetus order (`cetusMemeSide`). Bluefin takes both `Currency` objects read-only and pays its SUI creation fee from gas. |
| Claim | `claim` | Relays claims for any participants. The last claim takes the rounding remainder. |
| Fees | `collectCetusFees`, `collectBluefinFees` | Pays Blast its share, then every fee recipient. The holder-reward share stays in the vault. |
| Residuals | `claimMigrationResiduals` | The `PresaleCap` holder. |
| Holder rewards | `publishHolderRewardRound`, `claimHolderRewards`, `closeHolderRewardRound` | Publication signs in as `blast_presale_domain::RewardsAdmin` (`PresaleCalls.signIn`) in the same PTB; `roleType` names the role for `AdminTransactions.grantRole`. |
| Cap | `destroyCap` | After cancellation only. |
| Blast's rates | `setProtocolFees` | Signs in as `FeeAdmin`. Applies to presales created afterward. |
| Blast's payout address | `setProtocolDestination` | Signs in as `TreasuryAdmin`. Applies to every later payout. |

`PresaleCalls` exposes each Move call separately for composition.

## Blast's fees

`fee_policy::FeePolicy` holds four rates, all zero at publication, and the
address Blast is paid at. Each presale snapshots the rates when it is created:

- `tokenBps` of the supply joins the supply apportionment, so the creator's
  presale, LP, and recipient BPS must total `10,000 - tokenBps`. Read the
  current policy with `PresaleClient.getFeePolicy` before building a creation.
- `raiseBps` of the raise joins the raise apportionment between the raise
  recipients and the LP. Migration pays it, and Blast's tokens, to the current
  destination (`ProtocolFeesPaid`).
- `lpMemeBps` and `lpQuoteBps` of each collected LP fee, rounded up, go to the
  current destination before the creator's split (`FeesCollected`).

A cancelled sale pays Blast nothing, and its token share stays locked.

## Previews

`math.ts` mirrors the contract's arithmetic in integer atoms and its abort
order. A preview throws `PresaleAbortError` with the Move error name.

- `previewPresaleCreation` runs every check `blast_presale::new` makes in order,
  including those of its constructors, and returns the exact apportionment:
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
`Commitment` dynamic field, a `PresaleVault`, a reward `Round`, and the
`FeePolicy`. `decodePresaleEvent` decodes the 16 events generic over
`<SaleToken, Quote>`. `PresaleVaultCreated` adds a `Venue` type argument.
`decodePresaleFeePolicyEvent` decodes `FeesChanged` and `DestinationChanged`,
which have no type arguments.
`reducePresaleEvent` rebuilds each presale's lifecycle, windows, commitments,
and custody balances, its vault, and its rounds. `Committed` has no wallet
field, so the reducer keys commitments by the event sender.

## ABI coverage

`abi/production-presale-v1.json` freezes the package at contracts `442116a`,
with the ADR 0101 amendment. Every public function is classified:

- **Builders:** all 14 `blast_presale` functions; `fee_policy` `set_fees` and
  `set_destination`; `cetus` and `bluefin` `new`, `migrate`, and
  `collect_fees`; `presale_vault::claim_migration_residuals`; and
  `holder_rewards` `publish_round`, `claim`, and `close_round`.
- **Off-chain mirror:** `merkle_tree::node` and `verify` (`allowlist.ts`).
- **Excluded:** `package_admin::wrap` (deployment), and `authorize_upgrade` and
  `commit_upgrade` (upgrade custody, which CLI publish tooling drives).
