import assert from "node:assert/strict";
import test from "node:test";
import { packageRoleType } from "@interest-protocol/blast-admin-sdk/transactions";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import {
  VAULT_ABORTS,
  vaultAbortName,
} from "@interest-protocol/blast-vault-sdk/aborts";
import {
  VAULT_PAUSE_BITS,
  VaultCalls,
  VaultTransactions,
} from "@interest-protocol/blast-vault-sdk/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";
import {
  abiCoverage,
  moveCallArguments,
  moveCallTypeArguments,
  readAbi,
} from "./abi.ts";
import { deployment, fixture, id } from "./vault-helpers.ts";

const calls = new VaultCalls(deployment);
const coverage = abiCoverage(
  readAbi("production-vault-v1.json", "vault"),
  deployment.packageId,
);
const vault = { objectId: id("0x7a"), initialSharedVersion: 9 };
const round = { objectId: id("0x7b"), initialSharedVersion: 10 };
const types = { memeType: fixture.memeType, quoteType: fixture.quoteType };
const pair = [
  normalizeStructTag(fixture.memeType),
  normalizeStructTag(fixture.quoteType),
];
const digest = new Uint8Array(32).fill(1);
const registryId = `0x${BigInt(fixture.registryId).toString(16)}`;

function moveCalls(tx: Transaction) {
  return coverage
    .check(tx)
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall" ? [command.MoveCall] : [],
    );
}

/** `module::function` and argument descriptors of each call. */
function shape(tx: Transaction) {
  return moveCalls(tx).map((call, index) => [
    `${call.module}::${call.function}`,
    moveCallArguments(tx, index),
  ]);
}

/**
 * Builds each call in its own PTB: one PTB shares an object once, at the
 * strongest mutability any of its calls asks for.
 */
function separately() {
  const built: Transaction[] = [];
  return {
    add(call: (tx: Transaction) => unknown) {
      const tx = new Transaction();
      call(tx);
      built.push(tx);
    },
    shapes: () => built.flatMap(shape),
    typeArguments: () => built.flatMap(moveCallTypeArguments),
  };
}

test("identifies the package's OTW by original ID", () => {
  assert.equal(
    calls.otw,
    normalizeStructTag(
      `${fixture.vaultOriginalPackageId}::blast_vault_package::BLAST_VAULT_PACKAGE`,
    ),
  );
  assert.deepEqual(VAULT_PAUSE_BITS, { Admin: 1 });
});

test("owner calls take the vault, the proof and the version in Move order", () => {
  const tx = new Transaction();
  // Stand-ins for the product's `prove_owner` and core's `fee_split::new`.
  const proof = tx.moveCall({ target: "0x5e::blast_presale::prove_owner" });
  const proposed = tx.moveCall({ target: "0xc0::fee_split::new" });
  const [meme, quote] = tx.add(
    calls.claimOwnerBalances({ ...types, vault, proof }),
  );
  assert.ok(meme && quote);
  tx.add(calls.scheduleFeeSplit({ ...types, vault, proof, proposed }));
  tx.add(calls.cancelFeeSplit({ ...types, vault, proof }));
  assert.deepEqual(shape(tx), [
    ["blast_presale::prove_owner", []],
    ["fee_split::new", []],
    [
      "vault::claim_owner_balances",
      ["shared-mut:0x7a", "result:0", "shared:0xa2"],
    ],
    [
      "vault::schedule_fee_split",
      ["shared-mut:0x7a", "result:0", "shared:0xa2", "result:1", "clock"],
    ],
    ["vault::cancel_fee_split", ["shared-mut:0x7a", "result:0", "shared:0xa2"]],
  ]);
  assert.deepEqual(moveCallTypeArguments(tx).slice(2), [pair, pair, pair]);
  assert.ok(
    moveCalls(tx)
      .slice(2)
      .every((call) => call.package === id("0xf4")),
  );
});

test("anyone calls mirror the vault and holder_rewards arity", () => {
  const tx = separately();
  tx.add(
    calls.payProtocolFeesWithPartner({
      ...types,
      vault,
      partner: { objectId: "0x9a", initialSharedVersion: 4 },
    }),
  );
  tx.add(calls.applyProtocolBps({ ...types, vault }));
  tx.add(calls.assertFeeSplitReady({ ...types, vault }));
  tx.add(calls.publishRound({ ...types, vault }));
  tx.add(
    calls.claim({
      ...types,
      round,
      index: 3n,
      beneficiary: "0xa11ce",
      memeAmount: 10n,
      quoteAmount: 0n,
      proof: [digest, digest],
    }),
  );
  tx.add(calls.closeRound({ ...types, round, vault }));
  tx.add(calls.applyRoundDelay({ ...types, vault }));
  tx.add(calls.poolId({ ...types, vault }));
  tx.add(calls.applyWitness({ witnessType: fixture.venue }));
  tx.add(calls.applyWitnessDelay());
  assert.deepEqual(tx.shapes(), [
    [
      "vault::pay_protocol_fees_with_partner",
      ["shared-mut:0x7a", "shared:0xa2", "shared:0xc2", "shared:0x9a"],
    ],
    ["vault::apply_protocol_bps", ["shared-mut:0x7a", "shared:0xa2", "clock"]],
    ["vault::assert_fee_split_ready", ["shared:0x7a", "clock"]],
    [
      "holder_rewards::publish_round",
      ["shared-mut:0x7a", "shared:0xa2", "shared:0xc2", "clock"],
    ],
    [
      "holder_rewards::claim",
      [
        "shared-mut:0x7b",
        "shared:0xa2",
        "pure",
        "pure",
        "pure",
        "pure",
        "pure",
        "clock",
      ],
    ],
    [
      "holder_rewards::close_round",
      ["shared-mut:0x7b", "shared:0xa2", "shared-mut:0x7a", "clock"],
    ],
    [
      "holder_rewards::apply_round_delay",
      ["shared-mut:0x7a", "shared:0xa2", "clock"],
    ],
    ["vault::pool_id", ["shared:0x7a"]],
    [
      "blast_vault_package::apply_witness",
      [`shared-mut:${registryId}`, "shared:0xa2", "clock"],
    ],
    [
      "blast_vault_package::apply_witness_delay",
      [`shared-mut:${registryId}`, "shared:0xa2", "clock"],
    ],
  ]);
  const typeArguments = tx.typeArguments();
  assert.deepEqual(typeArguments.slice(0, 8), Array(8).fill(pair));
  assert.deepEqual(typeArguments.slice(8), [
    [normalizeStructTag(fixture.venue)],
    [],
  ]);
  assert.throws(
    () =>
      calls.claim({
        ...types,
        round,
        index: 0n,
        beneficiary: "0xa11ce",
        memeAmount: 1n,
        quoteAmount: 0n,
        proof: [new Uint8Array(31)],
      }),
    /32 bytes/,
  );
});

test("admin calls take the witness after the vault or registry", () => {
  const registry = `shared-mut:${registryId}`;
  const tx = separately();
  const adminWitness = "0xaa";
  const scheduleProtocolBps = calls.scheduleProtocolBps({
    ...types,
    vault,
    adminWitness,
    memeBps: 500n,
    quoteBps: 3_000n,
  });
  tx.add(scheduleProtocolBps);
  tx.add(calls.cancelProtocolBps({ ...types, vault, adminWitness }));
  tx.add(
    calls.scheduleRound({
      ...types,
      vault,
      adminWitness,
      number: 1n,
      startCheckpoint: 100n,
      endCheckpoint: 200n,
      root: digest,
      manifestDigest: digest,
      leafCount: 3n,
      memeAmount: 10n,
      quoteAmount: 10n,
      gasReserveAmount: 1n,
      claimWindowDurationMs: 604_800_000n,
      expectedTreasury: fixture.treasury,
    }),
  );
  tx.add(calls.cancelRound({ ...types, vault, adminWitness }));
  tx.add(
    calls.scheduleRoundDelay({ ...types, vault, adminWitness, delayMs: 0n }),
  );
  tx.add(calls.cancelRoundDelay({ ...types, vault, adminWitness }));
  tx.add(
    calls.settleGasReserve({
      ...types,
      round,
      vault,
      adminWitness,
      reimbursementAmount: 5n,
    }),
  );
  tx.add(calls.scheduleWitness({ witnessType: fixture.venue, adminWitness }));
  tx.add(calls.removeWitness({ witnessType: fixture.venue, adminWitness }));
  tx.add(calls.cancelWitness({ witnessType: fixture.venue, adminWitness }));
  tx.add(calls.scheduleWitnessDelay({ adminWitness, delayMs: 172_800_000n }));
  tx.add(calls.cancelWitnessDelay({ adminWitness }));
  tx.add(calls.unpause({ unpauseAdmin: adminWitness, bits: 1 }));
  tx.add(calls.makeImmutable({ upgradeAdmin: adminWitness }));
  const witness = "object:0xaa";
  assert.deepEqual(tx.shapes(), [
    ["bps::new", ["pure"]],
    ["bps::new", ["pure"]],
    [
      "vault::schedule_protocol_bps",
      [
        "shared-mut:0x7a",
        witness,
        "shared:0xa2",
        "result:0",
        "result:1",
        "clock",
      ],
    ],
    ["vault::cancel_protocol_bps", ["shared-mut:0x7a", witness, "shared:0xa2"]],
    [
      "holder_rewards::schedule_round",
      [
        "shared-mut:0x7a",
        witness,
        "shared:0xa2",
        ...Array(11).fill("pure"),
        "clock",
      ],
    ],
    [
      "holder_rewards::cancel_round",
      ["shared-mut:0x7a", witness, "shared:0xa2"],
    ],
    [
      "holder_rewards::schedule_round_delay",
      ["shared-mut:0x7a", witness, "shared:0xa2", "pure", "clock"],
    ],
    [
      "holder_rewards::cancel_round_delay",
      ["shared-mut:0x7a", witness, "shared:0xa2"],
    ],
    [
      "holder_rewards::settle_gas_reserve",
      ["shared-mut:0x7b", witness, "shared:0xa2", "shared-mut:0x7a", "pure"],
    ],
    [
      "blast_vault_package::schedule_witness",
      [registry, witness, "shared:0xa2", "clock"],
    ],
    ["blast_vault_package::remove_witness", [registry, witness, "shared:0xa2"]],
    ["blast_vault_package::cancel_witness", [registry, witness, "shared:0xa2"]],
    [
      "blast_vault_package::schedule_witness_delay",
      [registry, witness, "shared:0xa2", "pure", "clock"],
    ],
    [
      "blast_vault_package::cancel_witness_delay",
      [registry, witness, "shared:0xa2"],
    ],
    [
      "blast_vault_package::unpause",
      [
        registry.replace("-mut", ""),
        witness,
        "shared:0xa3",
        "shared-mut:0xa2",
        "shared:0xc2",
        "pure",
      ],
    ],
    [
      "blast_vault_package::make_immutable",
      ["shared-mut:0xa3", witness, "shared:0xa2", "clock"],
    ],
  ]);
  const bps = new Transaction();
  bps.add(scheduleProtocolBps);
  assert.deepEqual(
    moveCalls(bps).map((call) => call.package),
    [id("0xc0"), id("0xc0"), id("0xf4")],
    "Bps comes from the core package",
  );
});

test("builders reject what the contract can never accept", () => {
  const adminWitness = "0xaa";
  assert.throws(
    () =>
      calls.scheduleProtocolBps({
        ...types,
        vault,
        adminWitness,
        memeBps: 3_001n,
        quoteBps: 0n,
      }),
    /at most 3000/,
  );
  const terms = {
    ...types,
    vault,
    adminWitness,
    number: 0n,
    startCheckpoint: 0n,
    endCheckpoint: 1n,
    root: digest,
    manifestDigest: digest,
    leafCount: 1n,
    memeAmount: 1n,
    quoteAmount: 0n,
    gasReserveAmount: 0n,
    claimWindowDurationMs: 1n,
    expectedTreasury: fixture.treasury,
  };
  assert.throws(
    () => calls.scheduleRound({ ...terms, root: new Uint8Array(31) }),
    /root must be 32 bytes/,
  );
  assert.throws(() => calls.scheduleRound({ ...terms, memeAmount: -1n }));
  assert.throws(() => calls.unpause({ unpauseAdmin: adminWitness, bits: 0 }));
  assert.throws(() => calls.unpause({ unpauseAdmin: adminWitness, bits: 256 }));
});

test("VaultTransactions sign in with each call's role first", () => {
  const txs = new VaultTransactions(deployment);
  const adminCapId = id("0xcafe");
  const role = (tx: Transaction) => moveCallTypeArguments(tx)[0]?.[0];
  const core = (name: Parameters<typeof coreRoleType>[1]) =>
    coreRoleType(deployment.core, name);
  const cases: [Transaction, string][] = [
    [
      txs.scheduleProtocolBps({
        ...types,
        vault,
        adminCapId,
        memeBps: 1n,
        quoteBps: 1n,
      }),
      core("FeeAdmin"),
    ],
    [
      txs.cancelProtocolBps({ ...types, vault, adminCapId }),
      core("CancelAdmin"),
    ],
    [txs.cancelRound({ ...types, vault, adminCapId }), core("CancelAdmin")],
    [
      txs.scheduleRoundDelay({ ...types, vault, adminCapId, delayMs: 0n }),
      core("RewardsAdmin"),
    ],
    [
      txs.cancelRoundDelay({ ...types, vault, adminCapId }),
      core("CancelAdmin"),
    ],
    [
      txs.settleGasReserve({
        ...types,
        round,
        vault,
        adminCapId,
        reimbursementAmount: 0n,
      }),
      core("RewardsAdmin"),
    ],
    [
      txs.scheduleWitness({ witnessType: fixture.venue, adminCapId }),
      core("VenueAdmin"),
    ],
    [
      txs.removeWitness({ witnessType: fixture.venue, adminCapId }),
      core("VenueAdmin"),
    ],
    [
      txs.cancelWitness({ witnessType: fixture.venue, adminCapId }),
      core("CancelAdmin"),
    ],
    [txs.scheduleWitnessDelay({ adminCapId, delayMs: 1n }), core("VenueAdmin")],
    [txs.cancelWitnessDelay({ adminCapId }), core("CancelAdmin")],
    [
      txs.unpause({ adminCapId, bits: 1 }),
      packageRoleType(deployment.admin, calls.otw, "UnpauseAdmin"),
    ],
    [
      txs.makeImmutable({ adminCapId }),
      packageRoleType(deployment.admin, calls.otw, "UpgradeAdmin"),
    ],
  ];
  for (const [tx, expected] of cases) {
    const [signIn, call] = moveCalls(tx);
    assert.equal(
      `${signIn?.module}::${signIn?.function}`,
      "blast_acl::sign_in",
    );
    assert.equal(role(tx), expected, call?.function);
    assert.deepEqual(moveCallArguments(tx, 0), [
      "shared:0xac",
      "object:0xcafe",
    ]);
    assert.ok(
      moveCallArguments(tx, moveCalls(tx).length - 1).includes("result:0"),
      "the call borrows the sign-in witness",
    );
  }
  const scheduled = txs.scheduleAndPublishRound({
    ...types,
    vault,
    adminCapId,
    number: 0n,
    startCheckpoint: 0n,
    endCheckpoint: 1n,
    root: digest,
    manifestDigest: digest,
    leafCount: 1n,
    memeAmount: 1n,
    quoteAmount: 0n,
    gasReserveAmount: 0n,
    claimWindowDurationMs: 1n,
    expectedTreasury: fixture.treasury,
  });
  assert.equal(role(scheduled), core("RewardsAdmin"));
  assert.deepEqual(
    moveCalls(scheduled).map((call) => call.function),
    ["sign_in", "schedule_round", "publish_round"],
  );
});

test("VaultTransactions relay every leaf of one round in one PTB", () => {
  const txs = new VaultTransactions(deployment);
  const leaf = (index: bigint) => ({
    index,
    beneficiary: "0xa11ce",
    memeAmount: 1n,
    quoteAmount: 2n,
    proof: [digest],
  });
  const tx = txs.claimRewards({
    ...types,
    round,
    leaves: [leaf(0n), leaf(1n)],
  });
  assert.deepEqual(
    moveCalls(tx).map((call) => call.function),
    ["claim", "claim"],
  );
  assert.throws(() => txs.claimRewards({ ...types, round, leaves: [] }));
  for (const tx of [
    txs.payProtocolFeesWithPartner({
      ...types,
      vault,
      partner: { objectId: "0x9a", initialSharedVersion: 4 },
    }),
    txs.applyProtocolBps({ ...types, vault }),
    txs.publishRound({ ...types, vault }),
    txs.closeRound({ ...types, round, vault }),
    txs.applyRoundDelay({ ...types, vault }),
    txs.applyWitness({ witnessType: fixture.venue }),
    txs.applyWitnessDelay(),
  ]) {
    assert.equal(moveCalls(tx).length, 1);
  }
});

test("the abort table follows errors.move's 35 codes", () => {
  assert.equal(VAULT_ABORTS.length, 35);
  assert.equal(vaultAbortName(0), "EInvalidWitness");
  assert.equal(vaultAbortName(6), "ENothingToClaim");
  assert.equal(vaultAbortName(21), "ETreasuryChanged");
  assert.equal(vaultAbortName(34), "EReturnedExceedsTaken");
  assert.equal(vaultAbortName(35), null);
  assert.equal(vaultAbortName(-1), null);
});

test("every classified blast_vault builder is built and matches the frozen ABI", () => {
  coverage.assertEveryBuilder(25);
});
