/** Opt-in mainnet receipt/state verification and validated simulations. Never signs. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { decodeAftermathDaoPresaleEvent } from "@interest-protocol/blast-presale-sdk/aftermath-dao";
import { PresaleClient } from "@interest-protocol/blast-presale-sdk/client";
import {
  decodePresaleEvent,
  decodePresalePolicyEvent,
} from "@interest-protocol/blast-presale-sdk/events";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { VENUE_LINEAGE } from "../test/fixtures/venue-deployment.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../test/fixtures/presale-mainnet-e2e.json", import.meta.url),
    "utf8",
  ),
);
const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: process.env.SUI_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443",
});
const sdk = new PresaleClient(client, fixture.deployment);
const events = [];
// The suite only reads/simulates, so retrying a transient RPC failure is safe.
// Assertions and Move aborts are never retried.
function liveTest(name, run) {
  test(name, async () => {
    await setTimeout(300);
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (
          attempt === 3 ||
          !["UNAVAILABLE", "RESOURCE_EXHAUSTED", "DEADLINE_EXCEEDED"].includes(
            error.code,
          )
        )
          throw error;
        await setTimeout(1000 * 2 ** attempt);
      }
    }
  });
}
const ref = (identity, mutable) => ({ ...identity, mutable });
async function object(id) {
  return (
    await client.core.getObject({ objectId: id, include: { json: true } })
  ).object;
}
async function simulate(tx) {
  tx.setSender(fixture.sender);
  tx.setGasBudget(100_000_000);
  const result = await client.core.simulateTransaction({
    transaction: tx,
    checksEnabled: true,
    include: { effects: true, events: true },
  });
  assert.equal(
    result.$kind,
    "Transaction",
    JSON.stringify(result.FailedTransaction?.status),
  );
  assert.equal(result.Transaction.status.success, true);
}
for (const receipt of fixture.transactions) {
  liveTest(`executed with validation: ${receipt.action}`, async () => {
    const result = await client.core.getTransaction({
      digest: receipt.digest,
      include: { effects: true, events: true },
    });
    assert.equal(result.$kind, "Transaction");
    const tx = result.Transaction;
    assert.equal(tx.status.success, true);
    assert.equal(tx.digest, receipt.digest);
    // Core transaction events omit ledger positions; verify the checkpoint
    // through the gRPC ledger before using the SDK's strict replay decoders.
    const { response } = await client.ledgerService.getTransaction({
      digest: receipt.digest,
      readMask: { paths: ["checkpoint"] },
    });
    const checkpoint = response.transaction.checkpoint.toString();
    assert.equal(checkpoint, receipt.checkpoint);
    for (const [eventIndex, raw] of tx.events.entries()) {
      const event = {
        ...raw,
        checkpoint,
        transactionDigest: receipt.digest,
        eventIndex,
      };
      if (event.eventType.startsWith(`${fixture.deployment.packageId}::`)) {
        events.push(
          event.eventType.includes("<")
            ? decodePresaleEvent(event, fixture.deployment)
            : decodePresalePolicyEvent(event, fixture.deployment),
        );
      }
      if (
        event.eventType.startsWith(
          `${fixture.deployment.aftermath.packageId}::`,
        )
      ) {
        decodeAftermathDaoPresaleEvent(event, {
          packageId: fixture.deployment.aftermath.packageId,
          originalPackageId: fixture.deployment.aftermath.packageId,
        });
      }
    }
  });
}
for (const [venue, sale] of Object.entries(fixture.sales)) {
  liveTest(`${venue}: migrated and every commitment claimed`, async () => {
    const state = await sdk.getPresale(sale.presale.objectId);
    assert.equal(state.lifecycle, "Migrated");
    assert.equal(state.totalCommitments, BigInt(sale.raiseTarget));
    for (const participant of [fixture.sender, fixture.adminSender])
      assert.equal(
        await sdk.getCommitment(sale.presale.objectId, participant),
        null,
      );
  });
}
for (const [venue, vault] of Object.entries(fixture.vaults)) {
  liveTest(`${venue}: vault custody and residuals`, async () => {
    const state = await sdk.getVault(vault.vault.objectId);
    assert.equal(state.poolId, vault.pool.objectId);
    assert.equal(state.migrationMemeResidual, 0n);
    assert.equal(state.migrationQuoteResidual, 0n);
    assert.equal(state.unpaidProtocolMeme, 0n);
    assert.equal(state.unpaidProtocolQuote, 0n);
  });
  liveTest(`${venue}: fee collection builder validates`, async () => {
    const cetus = VENUE_LINEAGE.sharedObjects.cetus;
    const tx = venue.startsWith("cetus")
      ? sdk.tx.collectCetusFees({
          ...vault,
          cetusConfig: ref(cetus.config, false),
          burnManager: ref(cetus.burnManager, false),
        })
      : sdk.tx.collectBluefinFees({
          ...vault,
          bluefinConfig: ref(VENUE_LINEAGE.sharedObjects.bluefin.config, false),
        });
    await simulate(tx);
  });
}
for (const pool of fixture.aftermathPools) {
  liveTest(`Aftermath custody: ${pool.daoFeePoolId}`, async () => {
    const lp = await object(pool.lpCoinId),
      owner = await object(pool.ownerCapId),
      dao = await object(pool.daoFeePoolId);
    assert.equal(lp.owner.AddressOwner, `0x${"0".repeat(64)}`);
    assert.equal(BigInt(lp.json.balance), BigInt(pool.lp));
    assert.equal(owner.owner.AddressOwner, fixture.aftermathTreasury);
    assert.equal(dao.json.fee_recipient, fixture.aftermathTreasury);
    assert.equal(Number(dao.json.fee_bps), 200);
  });
}
liveTest("reward closure returns the unclaimed budget", async () => {
  const state = await sdk.getVault(fixture.rewards.vaultId);
  assert.equal(
    state.holderRewardsQuote,
    BigInt(fixture.rewards.remainingQuote),
  );
  assert.equal(state.nextRound, 1n);
});
after(() => {
  for (const kind of [
    "PresaleMigrated",
    "Claimed",
    "VaultCreated",
    "FeesCollected",
    "MigrationResidualsClaimed",
    "ProtocolFeesPaid",
    "ProtocolLpFeesPaid",
    "RoundPublished",
    "RewardClaimed",
    "GasReserveSettled",
    "RoundClosed",
  ])
    assert.ok(
      events.some((event) => event.kind === kind),
      `missing decoded ${kind}`,
    );
});
