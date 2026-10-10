# Holder rewards

Holder rewards live in the migrators package (`blast_holder_rewards`, contracts
ADR 0089) and, for presales, in the presale package (`holder_rewards`); the separate distributor package, its enrollment, `PublisherCap`,
and pause switch are gone. Every LP-fee collection credits the creator's
`FeeSplit` rewards share to the launch's `LpVault`. A Blast administrator
publishes a Merkle allocation of those funds as a shared `Round`, and anyone can
relay a proof; each leaf pays its committed beneficiary once.

`@interest-protocol/blast-sdk/holder-rewards` supplies integer holder
accounting, Merkle manifests, round reads, permissionless payout helpers, and
`holderRewardsOperator`: the index, prepare, publish, advance, and relay
workflow over a `HolderRewardsStore` that you supply. The transaction builders
are `MigratorTransactions.publishHolderRewardRound` and `claimHolderRewards`.
The Node operator is `npm run holder-rewards -- <command> ...` from this
repository; it runs the same workflow over a file store (`operator/`). The
builders require verified deployment IDs. Presale's registered October 9
lineage predates the reserve/routing APIs; those require a new verified
publication and a safe financial cutover. See [presale rounds](presale.md#allowlists-and-reward-rounds).

## Rounds

`publish_round` requires the vault's next round number, a checkpoint interval
that starts where the previous round ended for migrators, or at/after it for
the new presale daily publication logic, a 32-byte root and manifest digest,
1 to 65,536 leaves, and a nonzero budget within the vault's unreserved rewards.
It reserves that budget into the `Round`, which keeps the vault, number, root,
leaf count, claim bitmap, and funds; the checkpoints and manifest digest are in
its `RoundPublished` event. The leaf is the Blake2b-256 hash of
`0x00 || "blast-holder-rewards-v1" || bcs(vault ID, round, index, beneficiary,
meme, quote)`, internal nodes hash `0x01 || left || right`, and a lone last node
pairs with itself. `buildRewardManifest` reproduces the contracts' vector
(`contracts/docs/vectors/holder-rewards.json`) byte for byte.

```ts
const manifest = buildRewardManifest({
  vaultId,
  number: vault.nextRound,
  startCheckpoint,
  endCheckpoint,
  allocations,
  leafDomain: MIGRATOR_REWARD_LEAF_DOMAIN, // presale rounds: PRESALE_REWARD_LEAF_DOMAIN
});
const publish = client.blastMigrators.tx.publishHolderRewardRound({
  memeType,
  quoteType,
  vault, // the shared LpVault, mutable
  adminCapId,
  manifest,
});
const relay = client.blastMigrators.tx.claimHolderRewards({
  memeType,
  quoteType,
  round, // the shared Round, mutable
  allocations: pendingRewardAllocations(
    roundState,
    manifest,
    MIGRATOR_REWARD_LEAF_DOMAIN,
  ),
});
```

## Paged construction

For large daily presale allocations, `allocateHolderRewardPage` divides every
wallet's weight by the same frozen global weight. Supply distinct qualifying
wallets in canonical address order and carry each result's `lastAddress` into
the next page. Count qualifying wallets before atomic-unit flooring, sum
`pageWeight` to check complete global coverage, and sum `quoteAllocated` to
calculate holder-owned dust. This helper applies no pricing or eligibility policy.

`buildRewardManifestPages` consumes a `RewardManifestPageStore` with bounded
allocation, Merkle-hash and proof reads/writes. It preserves the existing BCS
digest, leaf domains, positional indices and odd-node pairing byte for byte.
The caller selects a positive bounded `pageSize`; the 65,536 positive-leaf limit
still applies. Every output page is read back, every proof is checked against
the root, and the function returns a `RewardManifestSummary` only after all
pages complete. Working memory grows with the selected page size and proof
depth rather than all beneficiaries.

The store must bind one immutable allocation snapshot and output namespace,
reject overwrites with different content, and resolve writes only after
durability. Repeating construction after a crash replays identical writes.
Snapshot identity, hashes, durable progress, locks and readiness evidence belong
to the caller's persistence layer. Keep proofs publicly available through a
paged endpoint; a summary alone cannot recover them.

`PresaleTransactions.publishHolderRewardReserveRound` accepts the completed
summary without loading all proofs. Its summary checks cover canonical fields,
the presale leaf domain, bounded leaf count, positive funding and full digest
lengths. They cannot prove allocations or eligibility from a summary alone:
the caller must require complete durable construction evidence before signing.
`verifyRewardSummaryProof` checks an individual proof against that commitment.

## Operator configuration

Create a JSON config outside the public artifacts:

```json
{
  "grpcUrl": "https://YOUR-ARCHIVAL-SUI-GRPC-ENDPOINT",
  "network": "mainnet",
  "chainId": "EXPECTED-GENESIS-DIGEST",
  "deployment": {
    "packageId": "0xCALLABLE_MIGRATORS_PACKAGE",
    "originalPackageId": "0xORIGINAL_MIGRATORS_PACKAGE",
    "launchpad": {
      "packageId": "0xCALLABLE_LAUNCHPAD_PACKAGE",
      "originalPackageId": "0xORIGINAL_LAUNCHPAD_PACKAGE",
      "admin": {
        "packageId": "0xBLAST_ADMIN_PACKAGE",
        "acl": { "objectId": "0x...", "initialSharedVersion": "1" }
      },
      "partnersPackageId": "0xBLAST_PARTNERS_PACKAGE",
      "timelockPackageId": "0xBLAST_FUN_TIMELOCK_PACKAGE",
      "packageVersion": { "objectId": "0x...", "initialSharedVersion": "1" },
      "launchConfig": { "objectId": "0x...", "initialSharedVersion": "1" },
      "runtimeConfig": { "objectId": "0x...", "initialSharedVersion": "1" }
    },
    "migratorsVersion": { "objectId": "0x...", "initialSharedVersion": "1" },
    "lpFeePolicy": { "objectId": "0x...", "initialSharedVersion": "1" },
    "venueConfig": { "objectId": "0x...", "initialSharedVersion": "1" }
  },
  "vaultId": "0xVERIFIED_LP_VAULT",
  "adminCapId": "0xBLAST_ADMIN_CAP",
  "sender": "0xADMIN_MULTISIG",
  "excludedAddresses": []
}
```

For a presale vault, set `"product": "presale"`, pass the call-ready
`PresaleDeployment` (`getPresaleDeployment("mainnet")`) as `deployment`, the
`Vault` ID as `vaultId`, and a Blast `AdminCap` holding the presale's
`blast_presale_domain::RewardsAdmin` role as `adminCapId`; `publish-tx` signs it
in. Presale rounds also need `claimWindowMs`: `publish-tx` sets the
round's claim deadline that far after it builds the transaction. Presale
manifests use `PRESALE_REWARD_LEAF_DOMAIN`, and `relay` reads the presale
`holder_rewards::Round`; the commands are otherwise the same.

```json
{
  "grpcUrl": "https://YOUR-ARCHIVAL-SUI-GRPC-ENDPOINT",
  "network": "mainnet",
  "chainId": "EXPECTED-GENESIS-DIGEST",
  "product": "presale",
  "deployment": { "packageId": "0x...", "originalPackageId": "0x...", "venueConfig": { "objectId": "0x...", "initialSharedVersion": "1" }, "creationPolicy": { "objectId": "0x...", "initialSharedVersion": "1" }, "feePolicy": { "objectId": "0x...", "initialSharedVersion": "1" }, "admin": { "packageId": "0x...", "acl": { "objectId": "0x...", "initialSharedVersion": "1" } } },
  "vaultId": "0xVERIFIED_PRESALE_VAULT",
  "adminCapId": "0xBLAST_ADMIN_CAP",
  "claimWindowMs": "604800000",
  "sender": "0xADMIN_MULTISIG",
  "excludedAddresses": []
}
```

`adminCapId` and `sender` are needed only for `publish-tx`. `deployment` is the
call-ready `MigratorsDeployment` (`migratorsDeployment(blast)` produces it from
a registered release). The vault ID must come from verified migration history
(`VaultCreated`). The provider must serve checkpoints back to coin-package
creation and the vault's initial shared object version. The operator checks
genesis, checkpoint ordering and digest continuity, transaction completeness,
timestamps, and nonnegative balances. It trusts the provider's derived balance
changes; it does not independently verify checkpoint signatures or reconstruct
every object effect.

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
# Read the confirmed RoundPublished event to obtain the shared Round ID.
npm run holder-rewards -- advance --config config.json --dir operator-data --round 0xROUND
npm run holder-rewards -- relay --config config.json --dir operator-data --round 0xROUND --manifest operator-data/rounds/0/manifest.json
```

Collection is permissionless and venue specific
(`MigratorTransactions.collectCetusFees` or `collectBluefinFees`); the operator
does not collect. `prepare` allocates the vault's whole unreserved rewards
balance at the time it runs.

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

`advance` checks the confirmed round against the manifest (vault, number, root,
and leaf count) and the vault's last checkpoint against the manifest's end,
resets holding weights at the same checkpoint, and allows the next interval. Old manifests and
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
journal through durable public storage before signing. The contract emits the
manifest digest in `RoundPublished`, not its bytes or URL. Availability is necessary for
independent claims.

Publication is trusted allocation: a Blast administrator can allocate rewards
to itself, omit holders, or commit a malformed tree. On-chain checks prevent
reserving more than the vault's unreserved rewards but do not prove the root's
totals or historical eligibility. Incorrect commitments have no cancellation
or sweep. Funded claims stay payable while the migrators package version is
current; the migrators package stays upgradeable (ADR 0088), so an upgrade
advances the version and relinks claims.
