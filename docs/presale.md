# Presale

`@interest-protocol/blast-sdk/presale` (`@interest-protocol/blast-presale-sdk`)
covers the `blast_presale` package of the launch stack (contracts ADR 0137 and
its 2026-11-05 amendment) and the Aftermath DAO-pool vendor
`blast_aftermath_dao_presale`: presales with capped commitments that overflow
at one common fill rate or fill first come up to a hard cap, an early close
once a hard-capped raise is full, migration-gated claims, full refunds when a
sale does not migrate, and the two-call migration hand-off to the sale's venue.

The presale holds no venue, vault or holder-reward code. A venue's `prepare`
issues the `VenueTicket` that `blast_presale::new` redeems; `migrate` returns
a `Migration` that only that venue redeems in the same PTB. The Cetus and
Bluefin venues are `blast_migrators` (`@interest-protocol/blast-migrators-sdk`),
shared with launches; a migrated sale's LP lives in a `blast_vault` vault
(`@interest-protocol/blast-vault-sdk`), which the sale's `PresaleCap` holder
controls through `prove_owner`. The vendor creates no vault.

The fresh stack is unpublished; no mainnet manifest is registered. Pass the IDs
the publish and `package_admin::wrap` effects return:

```ts
const presale = new PresaleTransactions({
  packageId, // current package
  originalPackageId, // first publication; names every type
  packageVersion, // PackageVersion<BLAST_PRESALE_PACKAGE>
  packageAdmin, // PackageAdmin<BLAST_PRESALE_PACKAGE>
  creationPolicy,
  feePolicy,
  presaleRegistry,
  core, // blast_core and its Treasury
  admin, // blast_admin and its ACL
  partners,
  vault, // blast_vault, for owner actions and vault IDs
  migrators, // blast_migrators, the Cetus and Bluefin venues
  aftermathDaoPresale, // optional: the vendor and Aftermath's shared objects
});
```

Shared objects carry no `mutable` flag: each call sets the mutability its Move
signature needs. When a sponsor pays gas, pass `{ useGasCoin: false }` so a SUI
quote or Bluefin's creation fee comes from the sender's coins.

## Lifecycle

`Pending -> Open -> Funded -> Migrated`; an underfunded `settle`, or
`cancel_unlaunched` from the LP deadline, ends in `Cancelled`.

| Step | Builder | Notes |
| --- | --- | --- |
| Create and share | `createPresale` | One PTB: the venue's `prepare` (`venue: "cetus" \| "bluefin" \| "aftermathDao"`), `new`, `set_supply`, `set_token_allocations`, `set_participant_vesting`, `set_raise`, `set_windows`, `set_eligibility`, `set_uncapped_phase`, `set_hard_cap`, `set_fee_split`, `set_partner` (the optional ones when given), `finalize`, `set_protocol_fees` when `protocolFees` names a `FeeAdmin` cap, `share` from `commitmentStartsAtMs`, and the `PresaleCap` to `capRecipient`. Rates go through core `bps::new`, recipients through core `payout::recipient` (vesting under `payout::vesting_terms`) and `recipient_share`, the LP-fee split through core `fee_split::new`. |
| Commit | `commit` with `route: "open" \| "allowlisted" \| "uncapped"` | Sources `amount` Quote with `tx.coin` and sends the returned change, zero except under a hard cap, to `recipient`. |
| Settle | `settle`, `cancelUnlaunched` | Anyone. `settle` works from the window's end, or once the raise is full under a hard cap with `closesWhenFilled` (`canClosePresaleEarly`). |
| Migrate | `migrate` | Anyone: optional `settle`, `blast_presale::migrate`, the venue's `migrate` redeeming the `Migration`, and `pay_protocol_fees_with_partner` when `partner` is given. |
| Pay Blast and its partner | `payProtocolFeesWithPartner` | Anyone, after a partnered sale migrates; an empty ledger pays nothing. |
| Claim | `claim` | Relays claims for any participants; the last claim takes the rounding remainder. Under participant vesting each claim locks the tokens in a schedule from the claim. |
| Owner | `claimOwnerBalances`, `scheduleFeeSplit`, `cancelFeeSplit` | `prove_owner` with the `PresaleCap`, then the vault call in the same PTB. `claim_owner_balances` aborts when both owner balances are zero. |
| Cap | `destroyCap` | After cancellation only. |

`createPresale` takes the sale token's zero-supply `TreasuryCap`, which Cetus's
`prepare` borrows mutably, Bluefin's immutably, and `new` takes by value, and
its Coin Registry `Currency`, which `finalize` requires `Unregulated`
(`ESaleTokenNotUnregulated`). The windows count from `commitmentStartsAtMs`, or
from execution once that has passed; until the start Blast's `FeeAdmin` may
lower the sale's rates.

`PresaleCalls` exposes each Move call separately, in Move argument order, for
composition; `PresaleTransactions.call`, `.migrators`, `.vault` and
`.aftermathDaoPresale` are the calls each composition uses.

## Aftermath DAO pools

The vendor's `AdminCap` holder prepares a sale token with the
`CreatePoolCapV2` of a fresh Aftermath LP coin. `publishAftermathLpCoin`
publishes that coin; `verifyAftermathLpCoin` reads its capability back and
returns the `AftermathLpCoin` `createPresale` requires, because the contract
cannot bind `Lp` to the capability and a wrong `Lp` aborts only at migration,
leaving the sale refundable at its LP deadline. The same sender holds the
`AdminCap`, the `CreatePoolCapV2` and the sale's `TreasuryCap`.

`prepare<Lp, SaleToken, Quote, PackageWitness>` fixes the fourth type argument
to the presale's `blast_presale_package::PackageWitness` and shares a
`PoolCreation<Lp, SaleToken>`; `findPoolCreation` (or
`PresaleClient.getPoolCreation`) reads it back from the creation transaction's
`PoolCreationReserved`. `migrate({ venue: "aftermathDao", lpType, poolCreation })`
seeds a 50/50 Aftermath pool behind a DAO-fee pool paying the partner
treasury 2% (`AFTERMATH_DAO_FEE_BPS`, `AFTERMATH_DAO_TREASURY`) and locks the
LP at `0x0`. The `CreationPolicy` must admit the vendor's
`blast_aftermath_dao_presale::Venue` (`AftermathDaoPresaleCalls.venueType`).

## Administration

Admin calls sign in with an `AdminCap` (`adminCapId`) through the shared ACL
for one `blast_core::blast_domain` role each:

| Builder | Role |
| --- | --- |
| `setQuoteAllowed` | `ListingAdmin` |
| `scheduleVenue`, `removeVenue`, `scheduleVenueDelay` | `VenueAdmin` |
| `cancelVenue`, `cancelVenueDelay`, `cancelFees` | `CancelAdmin` |
| `addPartner`, `removePartner`, `scheduleFees`, `setProtocolFees` | `FeeAdmin` |
| `applyVenue`, `applyVenueDelay`, `applyFees` | anyone, once ready |
| `unpause` | `package_admin::UnpauseAdmin<BLAST_PRESALE_PACKAGE>` |

`unpause` (`creation_policy::unpause`) aborts with `EUnguardedDelay` until the
venue and fee delays are guarded; `PRESALE_PAUSE_BITS` are `Create`, `Commit`
and `Migrate`. Pausing and upgrades are the admin package's generic
`AdminCalls` with `otw = PresaleCalls.otw`. On a fresh deployment,
`configureNow` sets the fees, Quotes, venues and partners at zero delays and
`armNotices` then raises the delays. Blast's fees are paid to the core
`Treasury`; the presale has no destination of its own.

## Previews and reads

`previewPresaleCreation` mirrors `finalize`'s checks in abort order and returns
the exact supply and raise apportionment (core `bps::apportion`) and the seed
price; `previewCommit`, `previewSettlement` and `previewClaim` mirror the sale
calls. Previews throw `PresaleAbortError` with the `blast_presale` or
`blast_core` error name; `presaleAbortName` and `aftermathDaoPresaleAbortName`
name numeric abort codes.

`presaleId(deployment, saleTokenType)` derives a sale's ID from the
`PresaleRegistry`; `presaleVaultId(vault, deployment, presaleId)` derives its
vault's. `PresaleClient` reads a sale, a wallet's commitment, and the fee and
creation policies. `decodePresaleEvent` decodes `blast_presale::PresaleCreated`
and the `events` structs; `decodePresalePolicyEvent` decodes
`QuoteAllowed<Quote>`; `decodePresaleDelayedEvent` decodes the venue and fee
delayed events. `reducePresaleEvent` rebuilds each sale from those events and
core's `ProtocolFeesPaid` (origin = presale ID).

Allowlists are `buildAllowlist` / `verifyAllowlistProof` over core
`merkleLeaf("blast-presale-v1", bcs(index, wallet, wallet_cap))`.
