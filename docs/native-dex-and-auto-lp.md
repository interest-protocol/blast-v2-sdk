# Native DEX and auto-LP

The independently deployed Move packages have separate SDK entry points:
`@blast-fun/sdk/dex` and `@blast-fun/sdk/auto-lp`. Native migration belongs to
the DEX. The auto-LP adapter holds a creator capability and a DEX position,
collects fees, and deposits paired assets while retaining excess balances.

Use `DexClient` / `blastDex` and `AutoLpClient` / `blastAutoLp` with a Sui Core
API client. Each client exposes `.call` for composable PTB calls and `.tx` for
complete common transactions. The calls cover every public function of the
packages. `DexTransactions` delivers returned coins, refunds, and positions to
the specified recipient; auto-LP calls return no custody assets.

## Deployment identity

Supply the current execution package ID, original package ID, and the singleton
Factory or Control object ID and initial shared version. The auto-LP deployment
also contains its DEX deployment. `dexDeployment` and `autoLpDeployment` extract
these from the common deployment registry. No unpublished network addresses
are supplied by the SDK.

Execution targets use current package IDs. Object/event types and dynamic-object
field keys use original IDs. The canonical pool lookup takes the **original
Meme type**, as required by the factory's `TypeName` key; it cannot infer an
original package from a later defining package address. Pool pairs remain in
Meme/Quote order; callers must not lexically sort the types.

Factory and Control mutability follows each Move signature. Other object and
coin arguments accept standard Sui `TransactionObjectInput` values, including
results from earlier PTB calls. The transaction resolver can resolve object IDs.

## Quotes and execution limits

Every amount is a `bigint` in atomic units. Time is milliseconds for deadlines
and preview timestamps. Pool state stores the last trade time in seconds.

`previewDexBuy` and `previewDexSell` mirror the capped Q32 volume decay and
integrated fee, including integer budget inversion, fee ceilings, reserve output
floors, and optional Meme burns. They report the smallest effective-fee limit
that admits the rounded fee. This can exceed the configured marginal cap by
rounding dust. Burn and price impact are separate from that fee limit.

`previewDexDeposit` returns the limiting share issuance, actual rounded-up asset
contributions, and both refunds. `previewDexWithdrawal` returns principal only;
position fees remain separately claimable. `previewDexPositionFees` carries
forward the position's fractional Q64 entitlement.

A swap builder requires explicit minimum output, maximum effective fee and
deadline. Supplying `currency` to the complete buy/sell builder selects the
registry burn entrypoint. Burn-enabled pools require that input; use the
appropriate decoded pool policy. The contract enforces supply authority.

## Compounding

Enrollment consumes the CreatorCap and fixes a nonzero executor. It creates and
shares the vault with no withdrawal or executor-replacement path. Anyone can
collect curve, external LP, native LP or own-position fees and contribute Meme
or Quote. External venue harvesting is composed upstream of the creator claim.
An empty source claim may abort according to that source's policy.

`AutoLpClient.previewCompound(vaultId)` combines the retained balances and
claimable own-position Quote fees, then previews paired deposits and leftovers.
The reads are separate snapshots. The executor must approve price and timing,
then explicitly provide all four execution bounds:

```ts
const vault = await autoLp.getVault(vaultId);
const preview = await autoLp.previewCompound(vaultId);

// Approve this reserve ratio independently before signing. These exact limits
// reject an increase in either spend or a decrease in the quoted shares.
const transaction = autoLp.tx.compound({
  memeType: vault.memeType,
  quoteType: vault.quoteType,
  vault: vault.objectId,
  pool: vault.poolId,
  maximumMeme: preview.memeUsed,
  maximumQuote: preview.quoteUsed,
  minimumShares: preview.shares,
  deadlineMs: approvedDeadlineMs,
});
```

Compounding uses the current vault balances, claims its own position fees, and
checks actual paired consumption against both signed maximums before depositing.
Additional fees or contributions after quoting can make a tight transaction
abort; obtain and approve a new quote. One-sided, empty, or sub-share balances
skip the deposit and remain in custody. There are no balancing swaps.

The enrolled executor must submit transactions and pay gas; on-chain code does
not schedule itself. A malicious executor can approve economically bad prices,
and a lost executor stops future deposits. SDK previews supply no independent
price oracle or execution authority.

## Objects and replay

Readers decode reserves, fee pots, share checkpoints, Factory, native locked LP
vaults, and auto-LP state. Child readers use the native dynamic-object-field API
for the sealed Position and CreatorCap and validate type lineage and pool
bindings. Network RPC discovery remains a deployment verification step.

Event codecs reject emitter/type lineage mismatches and malformed BCS. For
replay spanning upgrades, pass `historicalPackageIds` containing the explicitly
trusted earlier execution IDs alongside the current `packageId` and the stable
`originalPackageId`. Other emitters and type lineages remain rejected. Feed
`applyDexEvent` and `applyAutoLpEvent` complete canonical history in transaction
and event order. They deduplicate by transaction digest/event index and reject
backward checkpoints or inconsistent conservation. They cannot sort transactions
within a checkpoint without the caller's canonical ordering. Replaying mutates
the supplied projection; it does not grant authority to execute transactions.
DEX pool creation supplies the pair types for joining auto-LP enrollment events.
Position ownership must come from object state/effects, never from a claim sender.

The frozen native ABI, shared integer vectors and SDK tests pin these boundaries.
After regenerating the contract vectors, `npm run check:abi:write` copies the
canonical DEX fixture into the SDK; `npm run check:abi` rejects any drift.
Local verification does not establish live external venue behavior or immutable
package custody; those remain contract release gates.
