# Holder rewards

Holder rewards live in the migrators package (`blast_holder_rewards`, contracts
ADR 0089); the separate distributor package, its enrollment, `PublisherCap`,
and pause switch are gone. Every LP-fee collection credits the creator's
`FeeSplit` rewards share to the launch's `LpVault`. A Blast administrator
publishes a Merkle allocation of those funds as a shared `Round`, and anyone can
relay a proof; each leaf pays its committed beneficiary once.

`@interest-protocol/blast-sdk/holder-rewards` supplies integer holder
accounting, Merkle manifests, round reads, and permissionless payout helpers.
The transaction builders are `MigratorTransactions.publishHolderRewardRound` and
`claimHolderRewards`. The Node operator is
`npm run holder-rewards -- <command> ...` from this repository. The packages are
unpublished; supply verified deployment IDs.

## Rounds

`publish_round` requires the vault's next round number, a checkpoint interval
that starts where the previous round ended, a 32-byte root and manifest digest,
1 to 65,536 leaves, and a nonzero budget within the vault's unreserved rewards.
It reserves that budget into the `Round`. The leaf is the Blake2b-256 hash of
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
  allocations: pendingRewardAllocations(roundState, manifest),
});
```

## Operator configuration

Create a JSON config outside the public artifacts:

```json
{
  "grpcUrl": "https://YOUR-ARCHIVAL-SUI-GRPC-ENDPOINT",
  "network": "testnet",
  "chainId": "EXPECTED-GENESIS-DIGEST",
  "deployment": {
    "packageId": "0xCALLABLE_MIGRATORS_PACKAGE",
    "originalPackageId": "0xORIGINAL_MIGRATORS_PACKAGE",
    "launchpad": {
      "packageId": "0xCALLABLE_LAUNCHPAD_PACKAGE",
      "originalPackageId": "0xORIGINAL_LAUNCHPAD_PACKAGE",
      "adminPackageId": "0xBLAST_ADMIN_PACKAGE",
      "packageVersion": { "objectId": "0x...", "initialSharedVersion": "1", "mutable": false },
      "launchConfig": { "objectId": "0x...", "initialSharedVersion": "1", "mutable": false },
      "runtimeConfig": { "objectId": "0x...", "initialSharedVersion": "1", "mutable": false },
      "acl": { "objectId": "0x...", "initialSharedVersion": "1", "mutable": false }
    },
    "migratorsVersion": { "objectId": "0x...", "initialSharedVersion": "1", "mutable": false },
    "lpFeePolicy": { "objectId": "0x...", "initialSharedVersion": "1", "mutable": false },
    "venueConfig": { "objectId": "0x...", "initialSharedVersion": "1", "mutable": false }
  },
  "vaultId": "0xVERIFIED_LP_VAULT",
  "adminCapId": "0xBLAST_ADMIN_CAP",
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
totals or historical eligibility. Incorrect commitments have no cancellation
or sweep. Funded claims stay payable while the migrators package version is
current; the migrators package stays upgradeable (ADR 0088), so an upgrade
advances the version and relinks claims.
