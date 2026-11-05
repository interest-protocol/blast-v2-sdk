import assert from "node:assert/strict";
import test from "node:test";
import { decodeHolderCheckpoint } from "@interest-protocol/blast-core/rewards/checkpoints";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const addr = normalizeSuiAddress;
const MEME = `${addr("0x42")}::meme::MEME`;
const QUOTE = `${addr("0x2")}::sui::SUI`;

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
