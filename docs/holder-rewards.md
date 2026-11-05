# Holder rewards

Holder rewards live in the vault package (`blast_vault::holder_rewards`,
contracts ADR 0137). Every launch and every presale migrates into a
`vault::Vault<Meme, Quote>`; each fee collection credits the sale's
`HolderRewards` fee-split route to the vault's rewards balances, in Meme and in
Quote. Presale vaults pay Meme too. A Blast administrator holding
`blast_core::blast_domain::RewardsAdmin` schedules a Merkle allocation of those
funds on the vault; once the vault's round notice has passed (two hours from
vault creation), anyone publishes it as a shared `Round`, and anyone can relay
a proof. Each leaf pays its committed beneficiary once.

`@interest-protocol/blast-sdk/holder-rewards` supplies integer holder
accounting, Merkle manifests, and `holderRewardsOperator`: the index, prepare,
publish, advance, and relay workflow over a `HolderRewardsStore` that you
supply. Round reads and builders are the vault package's: `getVault`,
`getRound`, `assertRoundMatchesManifest`, `pendingRewardAllocations`, and
`VaultTransactions.scheduleRound`, `publishRound` (permissionless),
`scheduleAndPublishRound` (one PTB, only at a zero round notice),
`cancelRound`, the `*RoundDelay` builders, `claimRewards`, `settleGasReserve`
and `closeRound`. The Node operator is `npm run holder-rewards -- <command> ...`
from this repository; it runs the same workflow over a file store
(`operator/`).

## Rounds

`schedule_round` and `publish_round` require the vault's next round number, a
checkpoint interval that starts at or after the previous round's end, a 32-byte
root and manifest digest, 1 to 65,536 leaves, and a nonzero budget within the
vault's unreserved rewards; the gas reserve is at most 10% of the round's
Quote. Publication reserves that budget into the `Round`. The leaf is
`merkle::leaf(REWARD_LEAF_DOMAIN, bcs(vault ID, round, index, beneficiary,
meme, quote))` = Blake2b-256 of `0x00 || "blast-holder-rewards-v2" || payload`;
internal nodes hash `0x01 || left || right`, and a lone last node pairs with
itself. `buildRewardManifest` reproduces the contracts' vector
(`contracts/docs/vectors/holder-rewards.json`, version 2) byte for byte.

```ts
const manifest = buildRewardManifest({
  vaultId,
  number: vault.nextRound,
  startCheckpoint,
  endCheckpoint,
  allocations,
});
const vaults = new VaultTransactions(vaultDeployment(blast));
const schedule = vaults.scheduleRound({
  memeType,
  quoteType,
  vault, // the shared Vault
  adminCapId, // holds RewardsAdmin
  number: BigInt(manifest.number),
  startCheckpoint: BigInt(manifest.startCheckpoint),
  endCheckpoint: BigInt(manifest.endCheckpoint),
  root: fromHex(manifest.root),
  manifestDigest: fromHex(manifest.manifestDigest),
  leafCount: BigInt(manifest.allocations.length),
  memeAmount: BigInt(manifest.memeAmount),
  quoteAmount: BigInt(manifest.quoteAmount),
  gasReserveAmount: 0n, // at most 10% of the round's Quote
  claimWindowDurationMs: 604_800_000n, // claims stay open seven days from publication
  expectedTreasury, // the core Treasury's destination
});
// After the vault's round notice, anyone publishes it.
const publish = vaults.publishRound({ memeType, quoteType, vault });
// Validate the public manifest before relaying its proofs.
validateRewardManifest(manifest);
const relay = vaults.claimRewards({
  memeType,
  quoteType,
  round, // the shared Round
  leaves: pendingRewardAllocations(roundState, manifest).map((leaf) => ({
    index: BigInt(leaf.index),
    beneficiary: leaf.beneficiary,
    memeAmount: BigInt(leaf.memeAmount),
    quoteAmount: BigInt(leaf.quoteAmount),
    proof: leaf.proof.map((sibling) => fromHex(sibling)),
  })),
});
```

## Paged construction

For large allocations, `allocateHolderRewardPage` divides every wallet's weight
by the same frozen global weight, for both the Meme and the Quote budget. Supply
distinct qualifying wallets in canonical address order and carry each result's
`lastAddress` into the next page. Count qualifying wallets before atomic-unit
flooring, sum `pageWeight` to check complete global coverage, and sum
`memeAllocated` and `quoteAllocated` to calculate holder-owned dust. This helper
applies no pricing or eligibility policy.

`buildRewardManifestPages` consumes a `RewardManifestPageStore` with bounded
allocation, Merkle-hash and proof reads/writes. It preserves the BCS digest,
leaf domain, positional indices and odd-node pairing byte for byte. The caller
selects a positive bounded `pageSize`; the 65,536 positive-leaf limit still
applies. Every output page is read back, every proof is checked against the
root, and the function returns a `RewardManifestSummary` only after all pages
complete. Working memory grows with the selected page size and proof depth
rather than all beneficiaries.

The store must bind one immutable allocation snapshot and output namespace,
reject overwrites with different content, and resolve writes only after
durability. Repeating construction after a crash replays identical writes.
Snapshot identity, hashes, durable progress, locks and readiness evidence belong
to the caller's persistence layer. Keep proofs publicly available through a
paged endpoint; a summary alone cannot recover them.
`validateRewardManifestSummary` checks a summary's canonical fields, bounded
leaf count, positive funding and digest lengths; it cannot prove allocations or
eligibility, so require complete durable construction evidence before signing.
`verifyRewardSummaryProof` checks an individual proof against that commitment.

## Operator configuration

Create a JSON config outside the public artifacts:

```json
{
  "grpcUrl": "https://YOUR-ARCHIVAL-SUI-GRPC-ENDPOINT",
  "network": "mainnet",
  "chainId": "EXPECTED-GENESIS-DIGEST",
  "vault": {
    "packageId": "0xCALLABLE_VAULT_PACKAGE",
    "originalPackageId": "0xORIGINAL_VAULT_PACKAGE",
    "registry": { "objectId": "0x...", "initialSharedVersion": "1" },
    "packageVersion": { "objectId": "0x...", "initialSharedVersion": "1" },
    "packageAdmin": { "objectId": "0x...", "initialSharedVersion": "1" },
    "core": {
      "packageId": "0xBLAST_CORE",
      "originalPackageId": "0xBLAST_CORE",
      "treasury": { "objectId": "0x...", "initialSharedVersion": "1" }
    },
    "admin": {
      "packageId": "0xBLAST_ADMIN",
      "acl": { "objectId": "0xBLAST_ACL", "initialSharedVersion": "1" }
    }
  },
  "vaultId": "0xVERIFIED_VAULT",
  "adminCapId": "0xBLAST_ADMIN_CAP_WITH_REWARDS_ADMIN",
  "claimWindowMs": "604800000",
  "gasReserveAmount": "0",
  "expectedTreasury": "0xVERIFIED_BLAST_TREASURY",
  "sender": "0xADMIN_MULTISIG",
  "excludedAddresses": []
}
```

`vault` is the call-ready `VaultDeployment` (`vaultDeployment(blast)` produces
it from a registered release). The vault ID must come from verified migration
history (`VaultCreated`) or `vaultId`. `adminCapId`, `claimWindowMs`,
`gasReserveAmount` (zero disables reimbursement), `expectedTreasury` and
`sender` are needed only for `publish-tx`; a changed core treasury aborts
publication before funds move. The provider must serve checkpoints back to
coin-package creation and the vault's initial shared object version. The
operator checks genesis, checkpoint ordering and digest continuity, transaction
completeness, timestamps, and nonnegative balances. It trusts the provider's
derived balance changes; it does not independently verify checkpoint
signatures or reconstruct every object effect.

## Account, publish, pay

In these examples `config.json` is configuration and `operator-data` is private
working state. All transaction files contain `{ "transaction": "..." }` where
the string is `Transaction.toJSON()`; restore with `Transaction.from(...)` in
your normal signing or multisig workflow. No private publishing key is loaded
by the CLI.

```sh
npm run holder-rewards -- inspect --config config.json --dir operator-data
npm run holder-rewards -- index --config config.json --dir operator-data --until 123456
npm run holder-rewards -- prepare --config config.json --dir operator-data
npm run holder-rewards -- publish-tx --config config.json --dir operator-data
# Review accounting; make the manifest public; sign/execute publish-tx externally.
# That schedules the round. After the vault's round notice (two hours by
# default), rerun publish-tx: it now builds the permissionless publication.
# Read the confirmed RoundPublished event to obtain the shared Round ID.
npm run holder-rewards -- advance --config config.json --dir operator-data --round 0xROUND
npm run holder-rewards -- relay --config config.json --dir operator-data --round 0xROUND --manifest operator-data/rounds/0/manifest.json
```

Collection is permissionless and venue specific
(`MigratorTransactions.collectCetusFees` or `collectBluefinFees`); the operator
does not collect. `prepare` allocates the vault's whole unreserved rewards
balance, in both assets, at the time it runs.

`index` replays from the coin's defining package creation, starts reward
weighting at the vault's creation (migration), and saves batches of up to 100
checkpoints plus a matching ledger watermark. Journal files are arrays named
`checkpoints/batch-FIRST_SEQUENCE.json`; each journal is durable before its
ledger snapshot. The final partial batch is flushed at `--until`. A failed fetch
or crash replays only the unfinished batch and never advances its durable
watermark early. Each resulting address balance applies until the next
checkpoint. Same-checkpoint transfers are netted. Amounts are atomic-unit
`bigint`, weight is atomic units × milliseconds, and proportional division
rounds down. Dust stays in the vault's rewards balance for later rounds.

`prepare` writes `rounds/N/accounting.json`, `manifest.json`, and
`pending.json`. It allocates both assets according to eligible holding time and
freezes indexing until publication is confirmed. No weight or no payable amount
means no round. Exclusions include the zero address, the vault, and additional
configured custody addresses. Set a public, stable eligibility policy before
publishing. Accounting excludes balances inside contracts and does not infer the
beneficial owners of exchange or LP custody. Rounds are limited to 65,536
payable addresses; exceeding this limit stops preparation rather than silently
dropping holders.

`advance` checks the confirmed round against the full manifest, resets holding
weights at the same checkpoint, and allows the next interval. Old manifests and
rounds remain usable. `relay` reads the on-chain bitmap and emits unsigned
batches of up to ten unpaid claims. Anyone can run it using a public manifest
and round ID. To execute payouts with a gas-only key, provide
`HOLDER_REWARDS_RELAYER_KEY` through your secret manager and add `--execute`.
This supports an Ed25519 `suiprivkey`; the relay key needs no admin
capability. Rerunning refreshes paid bits. A racing claim can abort a batch,
after which rerunning skips the already paid allocations.

## Recovery and trust

Use one writer per data directory. Files are fsynced and atomically renamed with
the checkpoint watermark in the same ledger. After a process crash, first verify
no operator is running, then remove the stale `operator-data/.lock` directory.
The file store's lock is a local directory, so it does not protect a vault
written from more than one host. A service supplies its own
`HolderRewardsStore`: each `write` must be atomic and durable before it
resolves, and `withLock` must exclude every other writer across processes and
hosts (for example, a Postgres transaction-scoped advisory lock keyed by vault,
which also releases when its connection dies).
Re-running indexing or advance is safe. If rebuilding from scratch after prior
publications, replay to each published round's end and call `advance` with that
round and its original manifest in order; then resume indexing. Never invent a
new holder snapshot to skip missing history.

Publish each round's manifest, accounting policy, exclusions, and checkpoint
journal through durable public storage before signing. The contract stores the
manifest digest, not its bytes or URL. Availability is necessary for
independent claims.

Publication is trusted allocation: a Blast administrator can allocate rewards
to itself, omit holders, or commit a malformed tree. On-chain checks prevent
reserving more than the vault's unreserved rewards but do not prove the root's
totals or historical eligibility. A scheduled round can be cancelled before
publication; a published round returns its unclaimed balances and unsettled gas
reserve to the vault at its claim deadline (`close_round`, permissionless).
Claims never pause and stay payable while the vault package version is
current; a vault upgrade advances the version and the migrators relink in the
same window.
