import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import type {
  BlastSuiEventKind,
  BlastSuiEventPayloads,
  BlastSuiNativeFact,
  DecodedBlastSuiEvent,
  VaultCustodyEvent,
} from "../src/blast-sui/index.ts";
import {
  blastSuiEventSpecs,
  createBlastSuiProjection,
  reduceBlastSuiInput,
} from "../src/blast-sui/index.ts";
import { requireBasisPoints } from "../src/lib/integers.ts";

const vaultId = normalizeSuiObjectId("0x1");
const firstReceiptId = normalizeSuiObjectId("0x2");
const secondReceiptId = normalizeSuiObjectId("0x3");

test("replays the ordered vault lifecycle from event-derived facts", () => {
  const events = [
    event("VaultCreated", {
      vault_id: vaultId,
      validator: normalizeSuiAddress("0x4"),
      pool_id: normalizeSuiObjectId("0x5"),
      fun_reserve_sui: 1_000n,
      bootstrap_sui: 200n,
      locked_blast_sui: 300n,
      redeem_fee_bps: requireBasisPoints("redeem fee", 25n),
      custody: custody(1),
    }),
    event("FunSuiMinted", { sui_in: 100n, custody: custody(2) }),
    event("FunSuiRedeemed", { fun_in: 40n, custody: custody(3) }),
    event("BlastSuiDepositRequested", {
      receipt_id: firstReceiptId,
      vault_id: vaultId,
      pool_id: normalizeSuiObjectId("0x5"),
      principal_sui: 70n,
      activation_epoch: 9n,
      custody: custody(4),
    }),
    event("BlastSuiDepositClaimed", {
      receipt_id: firstReceiptId,
      vault_id: vaultId,
      principal_sui: 70n,
      contributed_sui: 65n,
      pool_tokens: 60n,
      blast_out: 55n,
      custody: custody(5),
    }),
    event("BlastSuiDepositRequested", {
      receipt_id: secondReceiptId,
      vault_id: vaultId,
      pool_id: normalizeSuiObjectId("0x5"),
      principal_sui: 30n,
      activation_epoch: 10n,
      custody: custody(6),
    }),
    event("BlastSuiDepositCancelled", {
      receipt_id: secondReceiptId,
      vault_id: vaultId,
      principal_sui: 30n,
      returned_sui: 29n,
    }),
    event("BlastSuiDonated", { sui_in: 11n, custody: custody(7) }),
    event("BlastSuiRedeemed", {
      blast_in: 13n,
      gross_sui: 12n,
      fee_sui: 2n,
      net_sui: 10n,
      custody: custody(8),
    }),
    event("FunYieldSwept", {
      liquid_sui: 8n,
      pool_tokens: 7n,
      swept_sui: 6n,
      custody: custody(9),
    }),
    event("RedeemFeeChanged", {
      old_redeem_fee_bps: requireBasisPoints("old fee", 25n),
      new_redeem_fee_bps: requireBasisPoints("new fee", 40n),
    }),
    event("VaultSynced", { custody: custody(10) }),
    event("NativeStakeUnwound", { custody: custody(11) }),
  ];

  let projection = createBlastSuiProjection();
  for (const lifecycleEvent of events) {
    projection = reduceBlastSuiInput(projection, lifecycleEvent);
    assert.strictEqual(
      reduceBlastSuiInput(projection, lifecycleEvent),
      projection,
    );
  }

  assert.deepEqual(projection.vault?.custody, custody(11));
  assert.strictEqual(projection.latestCustody, projection.vault?.custody);
  assert.equal(projection.vault?.custody.fun_supply, 11_041n);
  assert.equal(projection.vault?.custody.blast_supply, 11_042n);
  assert.equal(projection.vault?.redeemFeeBps, 40n);
  assert.equal(projection.vault?.unwindOnly, true);
  assert.equal(projection.vault?.syncCount, 1);
  assert.deepEqual(projection.totals, {
    funMintedSui: 100n,
    funRedeemedFun: 40n,
    depositPrincipalSui: 100n,
    depositContributedSui: 65n,
    depositClaimedPoolTokens: 60n,
    depositClaimedBlastSui: 55n,
    depositCancelledReturnedSui: 29n,
    donatedSui: 11n,
    blastRedeemed: 13n,
    redemptionGrossSui: 12n,
    redemptionFeeSui: 2n,
    redemptionNetSui: 10n,
    sweptYieldSui: 6n,
  });
  assert.deepEqual(projection.receipts[firstReceiptId], {
    receiptId: firstReceiptId,
    vaultId,
    poolId: normalizeSuiObjectId("0x5"),
    principalSui: 70n,
    activationEpoch: 9n,
    status: "claimed",
    contributedSui: 65n,
    poolTokens: 60n,
    blastOut: 55n,
    returnedSui: 0n,
  });
  assert.equal(projection.receipts[secondReceiptId]?.status, "cancelled");
  assert.equal(projection.receipts[secondReceiptId]?.returnedSui, 29n);
  assert.equal(
    projection.native.depositReceiptOwners[firstReceiptId],
    undefined,
  );
  assert.deepEqual(projection.native.returnedCoinRecipients, {});
});

test("replays all administration events and ignores duplicate events", () => {
  const adminEvents = [
    event("SuperAdminTransferStarted", {
      recipient: normalizeSuiAddress("0x11"),
      execute_after_ms: 500n,
    }),
    event("SuperAdminTransferCancelled", {
      recipient: normalizeSuiAddress("0x11"),
    }),
    event("SuperAdminTransferred", {
      previous_super_admin_cap_id: normalizeSuiObjectId("0x12"),
      new_super_admin_cap_id: normalizeSuiObjectId("0x13"),
      recipient: normalizeSuiAddress("0x14"),
    }),
    event("PackageVersionAdvanced", {
      previous_version: 1n,
      new_version: 2n,
    }),
    event("PackageAdminCreated", {
      package_admin_id: normalizeSuiObjectId("0x15"),
      publisher_id: normalizeSuiObjectId("0x16"),
      upgrade_cap_id: normalizeSuiObjectId("0x17"),
      package_id: normalizeSuiObjectId("0x18"),
      package_version: 2n,
      policy: 0,
    }),
    event("UpgradeAuthorized", {
      package_id: normalizeSuiObjectId("0x18"),
      package_version: 2n,
      policy: 1,
      digest: new Uint8Array([1, 2, 3]),
    }),
    event("UpgradePolicyRestricted", {
      previous_policy: 0,
      new_policy: 1,
    }),
    event("UpgradeCommitted", {
      new_package_id: normalizeSuiObjectId("0x19"),
      previous_version: 2n,
      new_version: 3n,
    }),
  ];

  let projection = createBlastSuiProjection();
  assert.deepEqual(
    projection.eventCounts,
    Object.fromEntries(
      Object.keys(blastSuiEventSpecs).map((kind) => [kind, 0]),
    ),
  );
  for (const adminEvent of adminEvents) {
    projection = reduceBlastSuiInput(projection, adminEvent);
    assert.strictEqual(reduceBlastSuiInput(projection, adminEvent), projection);
  }

  assert.equal(projection.administration.pendingSuperAdminTransfer, null);
  assert.equal(
    projection.administration.activeSuperAdminCapId,
    normalizeSuiObjectId("0x13"),
  );
  assert.equal(projection.administration.packageVersion, 3n);
  assert.equal(
    projection.administration.packageAdmin?.packageAdminId,
    normalizeSuiObjectId("0x15"),
  );
  assert.equal(
    projection.administration.packageAdmin?.packageId,
    normalizeSuiObjectId("0x19"),
  );
  assert.equal(projection.administration.packageAdmin?.packageVersion, 3n);
  assert.equal(
    projection.administration.packageAdmin?.upgradeCapId,
    normalizeSuiObjectId("0x17"),
  );
  assert.equal(
    projection.administration.packageAdmin?.publisherId,
    normalizeSuiObjectId("0x16"),
  );
  assert.equal(projection.administration.packageAdmin?.policy, 1);
  assert.equal(projection.administration.pendingUpgrade, null);
  assert.deepEqual(projection.administration.lastUpgradeAuthorization, {
    packageId: normalizeSuiObjectId("0x18"),
    packageVersion: 2n,
    policy: 1,
    digest: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(projection.administration.lastUpgradePolicyRestriction, {
    previousPolicy: 0,
    newPolicy: 1,
  });
  assert.deepEqual(projection.administration.lastUpgradeCommit, {
    packageId: normalizeSuiObjectId("0x19"),
    previousVersion: 2n,
    newVersion: 3n,
  });
  for (const adminEvent of adminEvents) {
    assert.equal(projection.eventCounts[adminEvent.kind], 1);
  }
});

test("retains the latest canonical custody when replay starts mid-history", () => {
  const latestCustody = custody(20);
  const projection = reduceBlastSuiInput(
    createBlastSuiProjection(),
    event("FunSuiMinted", { sui_in: 9n, custody: latestCustody }),
  );

  assert.equal(projection.vault, null);
  assert.strictEqual(projection.latestCustody, latestCustody);
  assert.equal(projection.latestCustody.fun_supply, 20_041n);
  assert.equal(projection.latestCustody.blast_supply, 20_042n);
});

test("rejects duplicate, unknown, and terminal receipt transitions before accounting", () => {
  const requested = event("BlastSuiDepositRequested", {
    receipt_id: firstReceiptId,
    vault_id: vaultId,
    pool_id: normalizeSuiObjectId("0x5"),
    principal_sui: 70n,
    activation_epoch: 9n,
    custody: custody(30),
  });
  const initial = reduceBlastSuiInput(createBlastSuiProjection(), requested);

  assert.throws(
    () =>
      reduceBlastSuiInput(
        initial,
        event("BlastSuiDepositRequested", requested.payload),
      ),
    /receipt.*already requested/,
  );
  assert.throws(
    () =>
      reduceBlastSuiInput(
        createBlastSuiProjection(),
        event("BlastSuiDepositClaimed", {
          receipt_id: firstReceiptId,
          vault_id: vaultId,
          principal_sui: 70n,
          contributed_sui: 65n,
          pool_tokens: 60n,
          blast_out: 55n,
          custody: custody(31),
        }),
      ),
    /unknown deposit receipt/,
  );

  const claimed = reduceBlastSuiInput(
    initial,
    event("BlastSuiDepositClaimed", {
      receipt_id: firstReceiptId,
      vault_id: vaultId,
      principal_sui: 70n,
      contributed_sui: 65n,
      pool_tokens: 60n,
      blast_out: 55n,
      custody: custody(32),
    }),
  );
  const appliedCount = Object.keys(claimed.appliedEventIds).length;
  assert.throws(
    () =>
      reduceBlastSuiInput(
        claimed,
        event("BlastSuiDepositCancelled", {
          receipt_id: firstReceiptId,
          vault_id: vaultId,
          principal_sui: 70n,
          returned_sui: 69n,
        }),
      ),
    /deposit receipt must be requested/,
  );
  assert.equal(Object.keys(claimed.appliedEventIds).length, appliedCount);
  assert.equal(claimed.totals.depositCancelledReturnedSui, 0n);
});

test("binds receipt events to their discovered vault and principal", () => {
  const created = event("VaultCreated", {
    vault_id: vaultId,
    validator: normalizeSuiAddress("0x4"),
    pool_id: normalizeSuiObjectId("0x5"),
    fun_reserve_sui: 1_000n,
    bootstrap_sui: 200n,
    locked_blast_sui: 300n,
    redeem_fee_bps: requireBasisPoints("redeem fee", 25n),
    custody: custody(40),
  });
  const discovered = reduceBlastSuiInput(createBlastSuiProjection(), created);
  assert.throws(
    () =>
      reduceBlastSuiInput(
        discovered,
        event("BlastSuiDepositRequested", {
          receipt_id: firstReceiptId,
          vault_id: normalizeSuiObjectId("0x99"),
          pool_id: normalizeSuiObjectId("0x5"),
          principal_sui: 70n,
          activation_epoch: 9n,
          custody: custody(41),
        }),
      ),
    /vault.*does not match/,
  );

  const requested = reduceBlastSuiInput(
    discovered,
    event("BlastSuiDepositRequested", {
      receipt_id: firstReceiptId,
      vault_id: vaultId,
      pool_id: normalizeSuiObjectId("0x5"),
      principal_sui: 70n,
      activation_epoch: 9n,
      custody: custody(42),
    }),
  );
  for (const mismatch of [
    { vault_id: normalizeSuiObjectId("0x99"), principal_sui: 70n },
    { vault_id: vaultId, principal_sui: 71n },
  ]) {
    assert.throws(
      () =>
        reduceBlastSuiInput(
          requested,
          event("BlastSuiDepositClaimed", {
            receipt_id: firstReceiptId,
            ...mismatch,
            contributed_sui: 65n,
            pool_tokens: 60n,
            blast_out: 55n,
            custody: custody(43),
          }),
        ),
      /vault.*does not match|principal.*does not match/,
    );
  }
  assert.throws(
    () =>
      reduceBlastSuiInput(
        requested,
        event("BlastSuiDepositCancelled", {
          receipt_id: firstReceiptId,
          vault_id: vaultId,
          principal_sui: 71n,
          returned_sui: 69n,
        }),
      ),
    /principal.*does not match/,
  );
  assert.equal(requested.totals.depositContributedSui, 0n);
});

test("rejects a redemption whose gross amount is not fee plus net", () => {
  const invalid = event("BlastSuiRedeemed", {
    blast_in: 13n,
    gross_sui: 12n,
    fee_sui: 3n,
    net_sui: 10n,
    custody: custody(50),
  });
  const projection = createBlastSuiProjection();

  assert.throws(
    () => reduceBlastSuiInput(projection, invalid),
    /gross SUI must equal fee SUI plus net SUI/,
  );
  assert.equal(Object.keys(projection.appliedEventIds).length, 0);
  assert.equal(projection.totals.redemptionGrossSui, 0n);
});

test("stores normalized ownership and transaction-effect facts only under native state", () => {
  const ownership: BlastSuiNativeFact = {
    source: "objectOwnership",
    kind: "depositReceiptOwnership",
    checkpoint: 20n,
    receiptId: "0x2",
    owner: "0x21",
  };
  const returnedCoin: BlastSuiNativeFact = {
    source: "transactionEffects",
    kind: "returnedCoinRecipient",
    position: { checkpoint: 21n, transactionDigest: "transaction-effects" },
    operation: "redeemBlastSui",
    coinId: "0x22",
    recipient: "0x23",
  };

  let projection = reduceBlastSuiInput(createBlastSuiProjection(), ownership);
  assert.deepEqual(projection.native.depositReceiptOwners[firstReceiptId], {
    source: "objectOwnership",
    checkpoint: 20n,
    owner: normalizeSuiAddress("0x21"),
  });
  assert.equal(Object.keys(projection.appliedEventIds).length, 0);
  assert.strictEqual(reduceBlastSuiInput(projection, ownership), projection);

  projection = reduceBlastSuiInput(projection, returnedCoin);
  assert.deepEqual(Object.values(projection.native.returnedCoinRecipients), [
    {
      ...returnedCoin,
      position: {
        checkpoint: 21n,
        transactionDigest: "transaction-effects",
      },
      coinId: normalizeSuiObjectId("0x22"),
      recipient: normalizeSuiAddress("0x23"),
    },
  ]);
  assert.strictEqual(reduceBlastSuiInput(projection, returnedCoin), projection);
  assert.strictEqual(
    reduceBlastSuiInput(projection, {
      ...returnedCoin,
      operation: "mintFunSui",
      recipient: "0x99",
    }),
    projection,
  );
});

test("merges receipt ownership monotonically and rejects checkpoint conflicts", () => {
  const first: BlastSuiNativeFact = {
    source: "objectOwnership",
    kind: "depositReceiptOwnership",
    checkpoint: 20n,
    receiptId: "0x2",
    owner: "0x21",
  };
  const latest: BlastSuiNativeFact = {
    ...first,
    checkpoint: 22n,
    owner: "0x22",
  };
  let projection = reduceBlastSuiInput(createBlastSuiProjection(), first);
  projection = reduceBlastSuiInput(projection, latest);

  assert.strictEqual(
    reduceBlastSuiInput(projection, { ...first, checkpoint: 21n }),
    projection,
  );
  assert.equal(
    projection.native.depositReceiptOwners[firstReceiptId]?.owner,
    normalizeSuiAddress("0x22"),
  );
  assert.throws(
    () =>
      reduceBlastSuiInput(projection, {
        ...latest,
        owner: "0x23",
      }),
    /ownership conflict at checkpoint 22/,
  );
  assert.strictEqual(reduceBlastSuiInput(projection, latest), projection);
});

test("clears receipt ownership only from a native deletion fact", () => {
  const request = event("BlastSuiDepositRequested", {
    receipt_id: firstReceiptId,
    vault_id: vaultId,
    pool_id: normalizeSuiObjectId("0x5"),
    principal_sui: 70n,
    activation_epoch: 9n,
    custody: custody(60),
  });
  let projection = reduceBlastSuiInput(createBlastSuiProjection(), request);
  projection = reduceBlastSuiInput(projection, {
    source: "objectOwnership",
    kind: "depositReceiptOwnership",
    checkpoint: 30n,
    receiptId: firstReceiptId,
    owner: "0x21",
  });
  projection = reduceBlastSuiInput(
    projection,
    event("BlastSuiDepositClaimed", {
      receipt_id: firstReceiptId,
      vault_id: vaultId,
      principal_sui: 70n,
      contributed_sui: 65n,
      pool_tokens: 60n,
      blast_out: 55n,
      custody: custody(61),
    }),
  );
  assert.equal(
    projection.native.depositReceiptOwners[firstReceiptId]?.owner,
    normalizeSuiAddress("0x21"),
  );
  assert.throws(
    () =>
      reduceBlastSuiInput(projection, {
        source: "transactionEffects",
        kind: "depositReceiptDeleted",
        position: {
          checkpoint: 30n,
          transactionDigest: "same-checkpoint-deletion",
        },
        receiptId: firstReceiptId,
      }),
    /deletion conflicts at checkpoint 30/,
  );

  const deletion: BlastSuiNativeFact = {
    source: "transactionEffects",
    kind: "depositReceiptDeleted",
    position: { checkpoint: 31n, transactionDigest: "receipt-deleted" },
    receiptId: firstReceiptId,
  };
  projection = reduceBlastSuiInput(projection, deletion);
  assert.equal(
    projection.native.depositReceiptOwners[firstReceiptId],
    undefined,
  );
  assert.deepEqual(projection.native.depositReceiptDeletions[firstReceiptId], {
    ...deletion,
    receiptId: firstReceiptId,
  });
  assert.strictEqual(reduceBlastSuiInput(projection, deletion), projection);
  assert.strictEqual(
    reduceBlastSuiInput(projection, {
      source: "objectOwnership",
      kind: "depositReceiptOwnership",
      checkpoint: 29n,
      receiptId: firstReceiptId,
      owner: "0x22",
    }),
    projection,
  );
  assert.throws(
    () =>
      reduceBlastSuiInput(projection, {
        source: "objectOwnership",
        kind: "depositReceiptOwnership",
        checkpoint: 32n,
        receiptId: firstReceiptId,
        owner: "0x22",
      }),
    /deleted deposit receipt cannot have an owner/,
  );
});

test("rejects invalid native fact metadata", () => {
  assert.throws(
    () =>
      reduceBlastSuiInput(createBlastSuiProjection(), {
        source: "objectOwnership",
        kind: "depositReceiptOwnership",
        checkpoint: -1n,
        receiptId: "0x2",
        owner: "0x3",
      }),
    /checkpoint.*u64/,
  );
  assert.throws(
    () =>
      reduceBlastSuiInput(createBlastSuiProjection(), {
        source: "transactionEffects",
        kind: "returnedCoinRecipient",
        position: { checkpoint: 1n, transactionDigest: "" },
        operation: "claimBlastSui",
        coinId: "0x2",
        recipient: "0x3",
      }),
    /transaction digest/,
  );
});

function event<Kind extends BlastSuiEventKind>(
  kind: Kind,
  payload: BlastSuiEventPayloads[Kind],
): Extract<DecodedBlastSuiEvent, { kind: Kind }> {
  const eventIndex = nextEventIndex++;
  return {
    source: "blastSui",
    kind,
    payload,
    emitterPackageId: normalizeSuiObjectId("0x100"),
    sender: normalizeSuiAddress("0x101"),
    position: {
      checkpoint: BigInt(eventIndex + 1),
      transactionDigest: `transaction-${eventIndex}`,
      eventIndex,
    },
  } as unknown as Extract<DecodedBlastSuiEvent, { kind: Kind }>;
}

function custody(seed: number): VaultCustodyEvent {
  const start = BigInt(seed * 1_000);
  return {
    fun_custody: {
      liquid_sui: start + 11n,
      pending_sui: start + 12n,
      active_pool_tokens: start + 13n,
      active_sui: start + 14n,
    },
    blast_custody: {
      liquid_sui: start + 21n,
      pending_sui: start + 22n,
      active_pool_tokens: start + 23n,
      active_sui: start + 24n,
    },
    exchange_rate: {
      epoch: start + 31n,
      sui_amount: start + 32n,
      pool_token_amount: start + 33n,
    },
    fun_supply: start + 41n,
    blast_supply: start + 42n,
  };
}

let nextEventIndex = 0;
