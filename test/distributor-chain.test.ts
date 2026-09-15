import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { buildRewardManifest } from "../src/distributor/allocations.ts";
import { decodeHolderCheckpoint } from "../src/distributor/checkpoints.ts";
import {
  decodeDistributor,
  decodeDistributorVersion,
  decodeRewardRound,
  distributorBcs,
  distributorVersionBcs,
  rewardIsClaimed,
  rewardRoundBcs,
} from "../src/distributor/state.ts";
import { DistributorCalls } from "../src/distributor/transactions.ts";

const addr = normalizeSuiAddress;
const MEME = `${addr("0x42")}::meme::MEME`;
const QUOTE = `${addr("0x2")}::sui::SUI`;
const pair = { memeType: MEME, quoteType: QUOTE };
const uid = (id: string) => ({ id: { bytes: addr(id) } });

test("checkpoint decoder verifies complete ordered transaction contents and selects the coin", () => {
  const checkpoint = {
    sequenceNumber: 10n,
    digest: "cp10",
    summary: {
      previousDigest: "cp9",
      timestamp: { seconds: 2n, nanos: 500000000 },
    },
    contents: { transactions: [{ transaction: "tx1" }] },
    transactions: [
      {
        digest: "tx1",
        balanceChanges: [
          { address: "0xa", coinType: MEME, amount: "100" },
          { address: "0xb", coinType: QUOTE, amount: "9" },
        ],
      },
    ],
  };
  assert.deepEqual(decodeHolderCheckpoint(checkpoint, MEME), {
    sequence: 10n,
    digest: "cp10",
    previousDigest: "cp9",
    timestampMs: 2500n,
    changes: [{ address: addr("0xa"), amount: 100n }],
  });
  assert.throws(
    () => decodeHolderCheckpoint({ ...checkpoint, transactions: [] }, MEME),
    /incomplete/,
  );
  assert.throws(
    () =>
      decodeHolderCheckpoint(
        {
          ...checkpoint,
          transactions: [{ digest: "other", balanceChanges: [] }],
        },
        MEME,
      ),
    /digest/,
  );
});

test("distributor decoding binds object ID and package and reads unallocated funds", () => {
  const content = distributorBcs
    .serialize({
      id: uid("0xd"),
      launch: { bytes: addr("0x10") },
      meme: { value: 100n },
      quote: { value: 200n },
      next_round: 2n,
      last_checkpoint: 20n,
    })
    .toBytes();
  const object = {
    objectId: addr("0xd"),
    type: `${addr("0x99")}::distributor::Distributor<${MEME},${QUOTE}>`,
    content,
    initialSharedVersion: "1",
    mutable: true as const,
  };
  const result = decodeDistributor(object, "0x99");
  assert.equal(result.memeAmount, 100n);
  assert.equal(result.nextRound, 2n);
  assert.equal(result.lastCheckpoint, 20n);
  assert.throws(() => decodeDistributor(object, "0x98"), /package/);
  assert.throws(
    () => decodeDistributor({ ...object, objectId: addr("0xe") }, "0x99"),
    /UID/,
  );
});

test("round bitmap decodes claims across word boundaries", () => {
  const content = rewardRoundBcs
    .serialize({
      id: uid("0xc"),
      distributor: { bytes: addr("0xd") },
      number: 1n,
      start_checkpoint: 10n,
      end_checkpoint: 20n,
      root: new Array(32).fill(1),
      manifest_digest: new Array(32).fill(2),
      leaf_count: 257n,
      claimed: [1n << 255n, 1n],
      meme: { value: 20n },
      quote: { value: 40n },
    })
    .toBytes();
  const round = decodeRewardRound(
    {
      objectId: addr("0xc"),
      type: `${addr("0x99")}::distributor::Round<${MEME},${QUOTE}>`,
      content,
      initialSharedVersion: "1",
      mutable: true,
    },
    "0x99",
  );
  assert.equal(rewardIsClaimed(round, 254), false);
  assert.equal(rewardIsClaimed(round, 255), true);
  assert.equal(rewardIsClaimed(round, 256), true);
  assert.throws(() => rewardIsClaimed(round, 257), /index/);
});

test("calls compose enrollment and preserve publisher-cap delivery as a separate transaction step", () => {
  const calls = new DistributorCalls({
    packageId: "0x99",
    packageVersion: "0x77",
  });
  const tx = new Transaction();
  const enrolled = tx.add(
    calls.enroll({
      ...pair,
      curveFeeCap: "0x11",
      launch: "0x10",
      packageVersion: "0x66",
    }),
  );
  const distributor = enrolled[0]!;
  const publisher = enrolled[1]!;
  tx.add(calls.share({ ...pair, distributor }));
  tx.transferObjects([publisher], "0xa");
  const data = tx.getData();
  assert.equal(data.commands[0]?.MoveCall?.module, "distributor");
  assert.equal(data.commands[0]?.MoveCall?.function, "new");
  assert.deepEqual(
    data.commands[0]?.MoveCall?.arguments.map((argument) =>
      argument.$kind === "Input"
        ? data.inputs[argument.Input]?.UnresolvedObject?.objectId
        : argument.$kind,
    ),
    [addr("0x77"), addr("0x11"), addr("0x10"), addr("0x66")],
  );
  assert.equal(data.commands[1]?.MoveCall?.function, "share");
  assert.equal(data.commands[2]?.$kind, "TransferObjects");
});

test("publication and claims carry the immutable allocation and expose no withdrawal recipient", () => {
  const calls = new DistributorCalls({
    packageId: "0x99",
    packageVersion: "0x77",
  });
  const manifest = buildRewardManifest({
    distributorId: "0xd",
    number: 0n,
    startCheckpoint: 1n,
    endCheckpoint: 2n,
    allocations: [{ beneficiary: "0xa", memeAmount: 10n, quoteAmount: 20n }],
  });
  const tx = new Transaction();
  const round = tx.add(
    calls.publishRound({ ...pair, publisherCap: "0x12", manifest }),
  );
  tx.add(calls.shareRound({ ...pair, round }));
  tx.add(
    calls.claim({
      ...pair,
      round: "0xc",
      allocation: manifest.allocations[0]!,
    }),
  );
  assert.deepEqual(
    tx.getData().commands.map((command) => command.MoveCall?.function),
    ["publish_round", "share_round", "claim"],
  );
  assert.throws(
    () =>
      calls.publishRound({
        ...pair,
        publisherCap: "0x12",
        manifest: { ...manifest, quoteAmount: "999" },
      }),
    /mismatch/,
  );
});

test("all reward transitions use the shared version and admin controls take the admin cap", () => {
  const calls = new DistributorCalls({
    packageId: "0x100",
    packageVersion: "0x77",
  });
  const tx = new Transaction();
  tx.add(
    calls.enroll({
      ...pair,
      curveFeeCap: "0x11",
      launch: "0x10",
      packageVersion: "0x66",
    }),
  );
  tx.add(
    calls.collectCurveFees({
      ...pair,
      distributor: "0xd",
      launch: "0x10",
      packageVersion: "0x66",
    }),
  );
  tx.add(
    calls.collectLpFees({
      ...pair,
      distributor: "0xd",
      lpVault: "0x13",
      migratorsVersion: "0x14",
    }),
  );
  const manifest = buildRewardManifest({
    distributorId: "0xd",
    number: 0n,
    startCheckpoint: 1n,
    endCheckpoint: 2n,
    allocations: [{ beneficiary: "0xa", memeAmount: 1n, quoteAmount: 0n }],
  });
  tx.add(calls.publishRound({ ...pair, publisherCap: "0x12", manifest }));
  tx.add(
    calls.claim({
      ...pair,
      round: "0xc",
      allocation: manifest.allocations[0]!,
    }),
  );
  tx.add(calls.setPaused({ adminCap: "0x41", paused: true }));
  tx.add(calls.migrate({ adminCap: "0x41" }));
  tx.add(
    calls.lockLpFees({
      ...pair,
      distributor: "0xd",
      lpVault: "0x13",
      migratorsVersion: "0x14",
      lpFeeCap: "0x15",
    }),
  );
  const data = tx.getData();
  const inputIndex = (id: string) =>
    data.inputs.findIndex(
      (input) => input.UnresolvedObject?.objectId === addr(id),
    );
  const controlIndex = inputIndex("0x77");
  assert.notEqual(controlIndex, -1);
  for (const [i, arg] of [
    [0, 0],
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 1],
    [5, 0],
    [6, 0],
    [7, 1],
  ]) {
    const call = data.commands[i!]!.MoveCall!;
    assert.equal(call.package, addr("0x100"));
    const input = call.arguments[arg!]!;
    assert(input.$kind === "Input");
    assert.equal(input.Input, controlIndex);
  }
  for (const [i, fn] of [
    [5, "set_paused"],
    [6, "migrate"],
  ] as const) {
    const call = data.commands[i]!.MoveCall!;
    assert.equal(call.module, "distributor");
    assert.equal(call.function, fn);
    const adminCap = call.arguments[1]!;
    assert(adminCap.$kind === "Input");
    assert.equal(adminCap.Input, inputIndex("0x41"));
  }
  const objectArguments = (index: number) =>
    data.commands[index]?.MoveCall?.arguments.map((argument) =>
      argument.$kind === "Input" ? argument.Input : -1,
    );
  assert.deepEqual(
    objectArguments(2),
    ["0xd", "0x100", "0x13", "0x14"].map((id) =>
      id === "0x100" ? controlIndex : inputIndex(id),
    ),
  );
  assert.equal(data.commands[7]?.MoveCall?.function, "lock_lp_fees");
  assert.deepEqual(objectArguments(7), [
    inputIndex("0xd"),
    controlIndex,
    inputIndex("0x13"),
    inputIndex("0x14"),
    inputIndex("0x15"),
  ]);
});

test("version reads use the original type origin and expose pause without trusting the callable package ID", () => {
  const object = {
    objectId: addr("0x77"),
    type: `${addr("0x99")}::distributor::Version`,
    content: distributorVersionBcs
      .serialize({ id: uid("0x77"), version: 2n, paused: true })
      .toBytes(),
    initialSharedVersion: "1",
    mutable: true as const,
  };
  const version = decodeDistributorVersion(object, "0x99");
  assert.equal(version.version, 2n);
  assert.equal(version.paused, true);
  assert.throws(() => decodeDistributorVersion(object, "0x100"), /type/);
  assert.throws(
    () =>
      decodeDistributorVersion({ ...object, objectId: addr("0x78") }, "0x99"),
    /UID/,
  );
});
