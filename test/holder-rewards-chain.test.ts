import assert from "node:assert/strict";
import test from "node:test";
import { decodeHolderCheckpoint } from "@interest-protocol/blast-core/rewards/checkpoints";
import {
  decodeRewardRound,
  rewardIsClaimed,
  rewardRoundBcs,
} from "@interest-protocol/blast-core/rewards/state";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const addr = normalizeSuiAddress;
const MEME = `${addr("0x42")}::meme::MEME`;
const QUOTE = `${addr("0x2")}::sui::SUI`;
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

test("round bitmap decodes claims across word boundaries", () => {
  const content = rewardRoundBcs
    .serialize({
      id: uid("0xc"),
      vault: { bytes: addr("0xd") },
      number: 1n,
      root: new Array(32).fill(1),
      leaf_count: 257n,
      claimed: [1n << 255n, 1n],
      meme: { value: 20n },
      quote: { value: 40n },
    })
    .toBytes();
  const round = decodeRewardRound(
    {
      objectId: addr("0xc"),
      type: `${addr("0x99")}::blast_holder_rewards::Round<${MEME},${QUOTE}>`,
      content,
      initialSharedVersion: "1",
      mutable: true,
    },
    "0x99",
  );
  assert.equal(round.vaultId, addr("0xd"));
  assert.throws(
    () =>
      decodeRewardRound(
        {
          objectId: addr("0xc"),
          type: `${addr("0x98")}::blast_holder_rewards::Round<${MEME},${QUOTE}>`,
          content,
          initialSharedVersion: "1",
          mutable: true,
        },
        "0x99",
      ),
    /invalid holder-reward round type/,
  );
  assert.equal(rewardIsClaimed(round, 254), false);
  assert.equal(rewardIsClaimed(round, 255), true);
  assert.equal(rewardIsClaimed(round, 256), true);
  assert.throws(() => rewardIsClaimed(round, 257), /index/);
});
