import assert from "node:assert/strict";
import test from "node:test";
import type { DelayedEventKind } from "@interest-protocol/blast-admin-sdk/events";
import type {
  BlastSuiEventKind,
  BlastSuiEventPayloads,
  BlastSuiNativeFact,
  BlastSuiProjection,
  DecodedBlastSuiDelayedEvent,
  DecodedBlastSuiEvent,
  blastSuiDelayedKeys,
} from "@interest-protocol/blast-sui-sdk";
import {
  blastSuiEventSpecs,
  createBlastSuiProjection,
  decodeBlastSuiDelayedEvent,
  decodeBlastSuiEvent,
  INITIAL_REDEEM_FEE_DELAY_MS,
  reduceBlastSuiInput,
} from "@interest-protocol/blast-sui-sdk";
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import {
  BLAST_SUI_FIXTURE,
  blastSuiDelayedEntry,
  blastSuiEventEntry,
  FIXTURE_POOL_0,
  FIXTURE_POOL_1,
  FIXTURE_POOL_2,
  FIXTURE_RECEIPT_ID,
  FIXTURE_VAULT_ID,
  fixtureEventBytes,
} from "./blast-sui-golden.ts";

const packages = { packageId: "0x123", originalPackageId: "0x122" };
const blastSui = {
  originalPackageId: packages.originalPackageId,
  admin: {
    packageId: "0xad",
    acl: { objectId: "0xac", initialSharedVersion: "3" },
  },
};
const delayedIdentity = {
  adminPackageId: blastSui.admin.packageId,
  originalPackageId: packages.originalPackageId,
};
const vaultId = FIXTURE_VAULT_ID;
/** The fixture cancels a second receipt whose request it does not print. */
const CANCELLED_RECEIPT_ID =
  "0xd1f922e3cb6c9213b400810a6aa63cd6ccc67dac3d702b8eb7032e447456996b";

/** Every Move-printed event, decoded, in the fixture's scenario order. */
const fixture = (
  Object.keys(BLAST_SUI_FIXTURE.events) as BlastSuiEventKind[]
).map((kind, eventIndex) =>
  decodeBlastSuiEvent(
    blastSuiEventEntry(kind, fixtureEventBytes(kind), packages, eventIndex),
    packages,
  ),
);

function fixtureEvent<Kind extends BlastSuiEventKind>(
  kind: Kind,
): Extract<DecodedBlastSuiEvent, { kind: Kind }> {
  const event = fixture.find((candidate) => candidate.kind === kind);
  assert.ok(event, kind);
  return event as Extract<DecodedBlastSuiEvent, { kind: Kind }>;
}

let syntheticIndex = 0;
/** A decoded event outside the fixture, at its own transaction position. */
function event<Kind extends BlastSuiEventKind>(
  kind: Kind,
  payload: BlastSuiEventPayloads[Kind],
): Extract<DecodedBlastSuiEvent, { kind: Kind }> {
  const eventIndex = syntheticIndex++;
  return {
    ...fixtureEvent(kind),
    payload,
    position: {
      checkpoint: 20n,
      transactionDigest: `synthetic-${eventIndex}`,
      eventIndex,
    },
  } as Extract<DecodedBlastSuiEvent, { kind: Kind }>;
}

/** The request the fixture omits, against custody that lists pool 1. */
const cancelledRequest = event("BlastSuiDepositRequested", {
  receipt_id: CANCELLED_RECEIPT_ID,
  vault_id: vaultId,
  pool_id: FIXTURE_POOL_1,
  principal_sui: 2_000_000_000n,
  activation_epoch: 3n,
  custody: fixtureEvent("BlastSuiRedeemed").payload.custody,
});

function replayFixture(): BlastSuiProjection {
  let projection = createBlastSuiProjection();
  for (const input of fixture) {
    if (input.kind === "BlastSuiDepositCancelled") {
      projection = reduceBlastSuiInput(projection, cancelledRequest);
    }
    projection = reduceBlastSuiInput(projection, input);
    assert.strictEqual(reduceBlastSuiInput(projection, input), projection);
  }
  return projection;
}

let delayedIndex = 0;
function delayed(
  kind: DelayedEventKind,
  name: keyof typeof blastSuiDelayedKeys,
  payload: Record<string, unknown>,
): DecodedBlastSuiDelayedEvent {
  return decodeBlastSuiDelayedEvent(
    blastSuiDelayedEntry(kind, name, payload, delayedIdentity, delayedIndex++),
    blastSui,
  );
}

const pendingFee = (value: bigint, parent: string = vaultId) => ({
  parent,
  key: null,
  value,
  delay_ms: 86_400_000n,
  ready_at_ms: 172_801_000n,
});

test("replays the Move-printed lifecycle into vault, receipts and totals", () => {
  const projection = replayFixture();
  const unwound = fixtureEvent("PoolUnwound").payload.custody;

  assert.deepEqual(projection.vault, {
    vaultId,
    validator:
      "0x5ef2fcf809fb9535ea0aeaea421f683026f06c34569aafc42bcde652ef6dd270",
    bootstrapPoolId: FIXTURE_POOL_0,
    funReserveSui: 100_000_000n,
    bootstrapSui: 10_000_000_000n,
    lockedBlastSui: 10_000_000_000n,
    redeemFeeBps: 2n,
    redeemFeeDelayMs: INITIAL_REDEEM_FEE_DELAY_MS,
    pendingRedeemFee: null,
    custody: unwound,
    syncCount: 1,
  });
  assert.equal(INITIAL_REDEEM_FEE_DELAY_MS, 172_800_000n);
  // The unwind removes pool 1 and leaves the last custody snapshot.
  assert.strictEqual(projection.latestCustody, unwound);
  assert.deepEqual(
    unwound.pools.map((pool) => pool.pool_id),
    [FIXTURE_POOL_0],
  );
  assert.equal(unwound.fun_supply, 1_000_000_000n);
  assert.equal(unwound.blast_supply, 11_608_695_652n);

  assert.deepEqual(projection.totals, {
    funMintedSui: 2_000_000_000n,
    funRedeemedFun: 1_000_000_000n,
    depositPrincipalSui: 5_000_000_000n,
    depositContributedSui: 3_000_000_000n,
    depositClaimedPoolTokens: 3_000_000_000n,
    depositClaimedBlastSui: 2_608_695_652n,
    depositCancelledReturnedSui: 2_000_000_000n,
    donatedSui: 1_000_000_000n,
    funReserveToppedUpSui: 500_000_000n,
    blastRedeemed: 1_000_000_000n,
    redemptionGrossSui: 15_744_737_866_606_124n,
    redemptionFeeSui: 3_148_947_573_322n,
    redemptionNetSui: 15_741_588_919_032_802n,
    sweptYieldSui: 25_770_048_299_114_819n,
  });
  assert.deepEqual(projection.receipts, {
    [FIXTURE_RECEIPT_ID]: {
      receiptId: FIXTURE_RECEIPT_ID,
      vaultId,
      poolId: FIXTURE_POOL_0,
      principalSui: 3_000_000_000n,
      activationEpoch: 2n,
      status: "claimed",
      contributedSui: 3_000_000_000n,
      claimedPoolTokens: 3_000_000_000n,
      blastOut: 2_608_695_652n,
      returnedSui: 0n,
    },
    [CANCELLED_RECEIPT_ID]: {
      receiptId: CANCELLED_RECEIPT_ID,
      vaultId,
      poolId: FIXTURE_POOL_1,
      principalSui: 2_000_000_000n,
      activationEpoch: 3n,
      status: "cancelled",
      contributedSui: 0n,
      claimedPoolTokens: 0n,
      blastOut: 0n,
      returnedSui: 2_000_000_000n,
    },
  });
  assert.deepEqual(projection.eventCounts, {
    ...Object.fromEntries(
      Object.keys(blastSuiEventSpecs).map((kind) => [kind, 1]),
    ),
    BlastSuiDepositRequested: 2,
  });
  assert.equal(Object.keys(projection.appliedEventIds).length, 13);
  assert.deepEqual(projection.native, createBlastSuiProjection().native);
});

test("starts empty and keeps custody seen before the vault is discovered", () => {
  const empty = createBlastSuiProjection();
  assert.deepEqual(
    empty.eventCounts,
    Object.fromEntries(
      Object.keys(blastSuiEventSpecs).map((kind) => [kind, 0]),
    ),
  );
  assert.equal(empty.vault, null);
  assert.equal(empty.latestCustody, null);

  const minted = fixtureEvent("FunSuiMinted");
  const projection = reduceBlastSuiInput(empty, minted);
  assert.equal(projection.vault, null);
  assert.strictEqual(projection.latestCustody, minted.payload.custody);
  assert.equal(projection.totals.funMintedSui, 2_000_000_000n);

  // A sync before discovery counts the event but has no vault to update.
  const synced = reduceBlastSuiInput(projection, fixtureEvent("VaultSynced"));
  assert.equal(synced.vault, null);
  assert.equal(synced.eventCounts.VaultSynced, 1);
});

test("rejects a mint or request into a pool its custody does not list", () => {
  const created = reduceBlastSuiInput(
    createBlastSuiProjection(),
    fixtureEvent("VaultCreated"),
  );
  const minted = fixtureEvent("FunSuiMinted");
  const requested = fixtureEvent("BlastSuiDepositRequested");

  for (const unlisted of [
    event("FunSuiMinted", { ...minted.payload, pool_id: FIXTURE_POOL_2 }),
    event("BlastSuiDepositRequested", {
      ...requested.payload,
      pool_id: FIXTURE_POOL_2,
    }),
    // Pool 1 is listed in later custody, not at creation.
    event("FunSuiMinted", {
      ...minted.payload,
      custody: fixtureEvent("VaultCreated").payload.custody,
    }),
  ]) {
    assert.throws(
      () => reduceBlastSuiInput(created, unlisted),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message ===
          `picked pool ${unlisted.payload.pool_id} is not listed`,
    );
  }
  assert.equal(Object.keys(created.appliedEventIds).length, 1);
  assert.equal(created.totals.funMintedSui, 0n);
  assert.equal(created.totals.depositPrincipalSui, 0n);
  assert.deepEqual(created.receipts, {});
  assert.strictEqual(
    created.latestCustody,
    fixtureEvent("VaultCreated").payload.custody,
  );
});

test("schedules, cancels and applies the redeem fee from delayed events", () => {
  const replayed = replayFixture();
  const scheduled = delayed("DelayedScheduled", "RedeemFee", pendingFee(7n));
  let projection = reduceBlastSuiInput(replayed, scheduled);
  assert.deepEqual(projection.vault?.pendingRedeemFee, {
    value: 7n,
    delay_ms: 86_400_000n,
    ready_at_ms: 172_801_000n,
  });
  assert.strictEqual(reduceBlastSuiInput(projection, scheduled), projection);

  projection = reduceBlastSuiInput(
    projection,
    delayed("DelayedCancelled", "RedeemFee", pendingFee(7n)),
  );
  assert.equal(projection.vault?.pendingRedeemFee, null);
  assert.equal(projection.vault?.redeemFeeBps, 2n);

  projection = reduceBlastSuiInput(
    projection,
    delayed("DelayedScheduled", "RedeemFee", pendingFee(9n)),
  );
  const applied = delayed("DelayedApplied", "RedeemFee", {
    parent: vaultId,
    key: null,
    previous_value: 2n,
    value: 9n,
    delay_ms: 86_400_000n,
  });
  projection = reduceBlastSuiInput(projection, applied);
  assert.equal(projection.vault?.redeemFeeBps, 9n);
  assert.equal(projection.vault?.redeemFeeDelayMs, 86_400_000n);
  assert.equal(projection.vault?.pendingRedeemFee, null);
  assert.strictEqual(reduceBlastSuiInput(projection, applied), projection);
  assert.equal(
    Object.keys(projection.appliedEventIds).length,
    Object.keys(replayed.appliedEventIds).length + 4,
  );
  // Delayed events do not count as blast Sui event kinds.
  assert.deepEqual(projection.eventCounts, replayed.eventCounts);
});

test("records but ignores validator and foreign-parent delayed events; defers pre-discovery ones", () => {
  const replayed = replayFixture();
  const ignored = [
    delayed("DelayedCreated", "RedeemFee", {
      parent: vaultId,
      key: null,
      value: 2n,
      delay_ms: 172_800_000n,
    }),
    delayed(
      "DelayedScheduled",
      "RedeemFee",
      pendingFee(7n, normalizeSuiObjectId("0x99")),
    ),
    delayed("SetCreated", "Validators", {
      parent: vaultId,
      key: null,
      delay_ms: 0n,
    }),
    delayed("SetScheduled", "Validators", {
      parent: vaultId,
      key: null,
      change: { kind: "Admission", member: FIXTURE_POOL_2 },
      delay_ms: 0n,
      ready_at_ms: 1_000n,
    }),
    delayed("MemberRemoved", "Validators", {
      parent: vaultId,
      key: null,
      member: FIXTURE_POOL_1,
    }),
  ];

  let projection = replayed;
  for (const input of ignored) {
    projection = reduceBlastSuiInput(projection, input);
    assert.strictEqual(reduceBlastSuiInput(projection, input), projection);
  }
  assert.deepEqual(projection.vault, replayed.vault);
  assert.equal(
    Object.keys(projection.appliedEventIds).length,
    Object.keys(replayed.appliedEventIds).length + ignored.length,
  );

  const early = delayed("DelayedScheduled", "RedeemFee", pendingFee(7n));
  const initial = createBlastSuiProjection();
  // Before discovery a delayed event is not recorded, so a later replay applies it.
  assert.strictEqual(reduceBlastSuiInput(initial, early), initial);
  const discovered = reduceBlastSuiInput(initial, fixtureEvent("VaultCreated"));
  assert.equal(discovered.vault?.pendingRedeemFee, null);
  const replayedEarly = reduceBlastSuiInput(discovered, early);
  assert.equal(replayedEarly.vault?.pendingRedeemFee?.value, 7n);
});

test("rejects duplicate, unknown and terminal receipt transitions before accounting", () => {
  const requested = fixtureEvent("BlastSuiDepositRequested");
  const claimed = fixtureEvent("BlastSuiDepositClaimed");
  const initial = reduceBlastSuiInput(createBlastSuiProjection(), requested);

  assert.throws(
    () =>
      reduceBlastSuiInput(
        initial,
        event("BlastSuiDepositRequested", requested.payload),
      ),
    new RegExp(`deposit receipt ${FIXTURE_RECEIPT_ID} already requested`),
  );
  assert.throws(
    () => reduceBlastSuiInput(createBlastSuiProjection(), claimed),
    new RegExp(`unknown deposit receipt ${FIXTURE_RECEIPT_ID}`),
  );

  const afterClaim = reduceBlastSuiInput(initial, claimed);
  const appliedCount = Object.keys(afterClaim.appliedEventIds).length;
  assert.throws(
    () =>
      reduceBlastSuiInput(
        afterClaim,
        event("BlastSuiDepositCancelled", {
          receipt_id: FIXTURE_RECEIPT_ID,
          vault_id: vaultId,
          principal_sui: 3_000_000_000n,
          returned_sui: 3_000_000_000n,
        }),
      ),
    /deposit receipt must be requested/,
  );
  assert.throws(
    () =>
      reduceBlastSuiInput(
        afterClaim,
        event("BlastSuiDepositClaimed", claimed.payload),
      ),
    /deposit receipt must be requested/,
  );
  assert.equal(Object.keys(afterClaim.appliedEventIds).length, appliedCount);
  assert.equal(afterClaim.totals.depositCancelledReturnedSui, 0n);
  assert.equal(afterClaim.totals.depositClaimedBlastSui, 2_608_695_652n);
});

test("binds receipt events to their discovered vault and principal", () => {
  const other = normalizeSuiObjectId("0x99");
  const discovered = reduceBlastSuiInput(
    createBlastSuiProjection(),
    fixtureEvent("VaultCreated"),
  );
  const requested = fixtureEvent("BlastSuiDepositRequested");
  const claimed = fixtureEvent("BlastSuiDepositClaimed");

  assert.throws(
    () =>
      reduceBlastSuiInput(
        discovered,
        event("BlastSuiDepositRequested", {
          ...requested.payload,
          vault_id: other,
        }),
      ),
    /deposit receipt vault does not match discovered vault/,
  );
  assert.equal(discovered.eventCounts.BlastSuiDepositRequested, 0);

  const projection = reduceBlastSuiInput(discovered, requested);
  for (const [mismatch, message] of [
    [
      { vault_id: other },
      /deposit receipt vault does not match discovered vault/,
    ],
    [
      { principal_sui: 3_000_000_001n },
      /deposit receipt principal does not match/,
    ],
  ] as const) {
    assert.throws(
      () =>
        reduceBlastSuiInput(
          projection,
          event("BlastSuiDepositClaimed", { ...claimed.payload, ...mismatch }),
        ),
      message,
    );
    assert.throws(
      () =>
        reduceBlastSuiInput(
          projection,
          event("BlastSuiDepositCancelled", {
            receipt_id: FIXTURE_RECEIPT_ID,
            vault_id: vaultId,
            principal_sui: 3_000_000_000n,
            returned_sui: 3_000_000_000n,
            ...mismatch,
          }),
        ),
      message,
    );
  }
  assert.equal(projection.totals.depositContributedSui, 0n);

  // Without a discovered vault, the receipt's own vault must still match.
  const undiscovered = reduceBlastSuiInput(
    createBlastSuiProjection(),
    requested,
  );
  assert.throws(
    () =>
      reduceBlastSuiInput(
        undiscovered,
        event("BlastSuiDepositClaimed", {
          ...claimed.payload,
          vault_id: other,
        }),
      ),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message === "deposit receipt vault does not match",
  );
});

test("rejects a redemption whose gross amount is not fee plus net", () => {
  const redeemed = fixtureEvent("BlastSuiRedeemed");
  const projection = createBlastSuiProjection();

  assert.throws(
    () =>
      reduceBlastSuiInput(
        projection,
        event("BlastSuiRedeemed", {
          ...redeemed.payload,
          fee_sui: redeemed.payload.fee_sui + 1n,
        }),
      ),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message === "gross SUI must equal fee SUI plus net SUI",
  );
  assert.equal(Object.keys(projection.appliedEventIds).length, 0);
  assert.equal(projection.totals.redemptionGrossSui, 0n);
});

test("stores normalized ownership and transaction-effect facts only under native state", () => {
  const ownership: BlastSuiNativeFact = {
    source: "objectOwnership",
    kind: "depositReceiptOwnership",
    checkpoint: 20n,
    receiptId: FIXTURE_RECEIPT_ID,
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
  assert.deepEqual(projection.native.depositReceiptOwners[FIXTURE_RECEIPT_ID], {
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
    receiptId: FIXTURE_RECEIPT_ID,
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
    projection.native.depositReceiptOwners[FIXTURE_RECEIPT_ID]?.owner,
    normalizeSuiAddress("0x22"),
  );
  assert.throws(
    () => reduceBlastSuiInput(projection, { ...latest, owner: "0x23" }),
    /ownership conflict at checkpoint 22/,
  );
  assert.strictEqual(reduceBlastSuiInput(projection, latest), projection);
});

test("clears receipt ownership only from a native deletion fact", () => {
  let projection = reduceBlastSuiInput(
    createBlastSuiProjection(),
    fixtureEvent("BlastSuiDepositRequested"),
  );
  projection = reduceBlastSuiInput(projection, {
    source: "objectOwnership",
    kind: "depositReceiptOwnership",
    checkpoint: 30n,
    receiptId: FIXTURE_RECEIPT_ID,
    owner: "0x21",
  });
  projection = reduceBlastSuiInput(
    projection,
    fixtureEvent("BlastSuiDepositClaimed"),
  );
  assert.equal(
    projection.native.depositReceiptOwners[FIXTURE_RECEIPT_ID]?.owner,
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
        receiptId: FIXTURE_RECEIPT_ID,
      }),
    /deletion conflicts at checkpoint 30/,
  );

  const deletion: BlastSuiNativeFact = {
    source: "transactionEffects",
    kind: "depositReceiptDeleted",
    position: { checkpoint: 31n, transactionDigest: "receipt-deleted" },
    receiptId: FIXTURE_RECEIPT_ID,
  };
  projection = reduceBlastSuiInput(projection, deletion);
  assert.equal(
    projection.native.depositReceiptOwners[FIXTURE_RECEIPT_ID],
    undefined,
  );
  assert.deepEqual(
    projection.native.depositReceiptDeletions[FIXTURE_RECEIPT_ID],
    deletion,
  );
  assert.strictEqual(reduceBlastSuiInput(projection, deletion), projection);
  assert.strictEqual(
    reduceBlastSuiInput(projection, {
      source: "objectOwnership",
      kind: "depositReceiptOwnership",
      checkpoint: 29n,
      receiptId: FIXTURE_RECEIPT_ID,
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
        receiptId: FIXTURE_RECEIPT_ID,
        owner: "0x22",
      }),
    /deleted deposit receipt cannot have an owner/,
  );
  assert.throws(
    () =>
      reduceBlastSuiInput(projection, {
        ...deletion,
        position: { checkpoint: 33n, transactionDigest: "deleted-again" },
      }),
    /deletion provenance conflicts/,
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
