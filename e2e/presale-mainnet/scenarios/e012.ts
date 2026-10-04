/**
 * E2E-012: a Merkle allowlist with tiered caps, wallets topping up in steps,
 * then a hard-capped phase that lifts the caps. p2 holds two leaves with
 * different caps, which proves a top-up must quote the cap it first used.
 */
import { Transaction } from "@mysten/sui/transactions";
import { toHex } from "@mysten/sui/utils";

import {
  merkleLayers,
  merkleProof,
  merkleRoot,
} from "../../../src/lib/merkle.ts";
import type { AllowlistProof } from "../../../src/presale/index.ts";
import {
  allowlistLeaf,
  verifyAllowlistProof,
} from "../../../src/presale/index.ts";
import {
  balanceChange,
  check,
  equal,
  event,
  exec,
  expectAbort,
  waitUntil,
} from "../chain.ts";
import { wallets } from "../env.ts";
import {
  addMigrate,
  addSettle,
  claimTx,
  coins,
  commit,
  commitTx,
  createSale,
  defaultTerms,
  recordMigration,
  saveSale,
  u64,
} from "../sale.ts";

const SALE_TOKENS = (coins(1_000_000_000) * 6_000n) / 10_000n;

export async function e012(): Promise<void> {
  const w = wallets();
  const entries = [
    { wallet: w.p1.toSuiAddress(), walletCap: coins(30) },
    { wallet: w.p2.toSuiAddress(), walletCap: coins(20) },
    { wallet: w.p3.toSuiAddress(), walletCap: coins(50) },
    { wallet: w.p2.toSuiAddress(), walletCap: coins(40) },
  ];
  const layers = merkleLayers(
    entries.map((entry, index) =>
      allowlistLeaf(BigInt(index), entry.wallet, entry.walletCap),
    ),
  );
  const root = toHex(merkleRoot(layers));
  const proof = (index: number, walletCap?: bigint): AllowlistProof => {
    const entry = entries[index] as (typeof entries)[number];
    return {
      index: BigInt(index),
      wallet: entry.wallet,
      walletCap: walletCap ?? entry.walletCap,
      proof: merkleProof(layers, index).map(toHex),
    };
  };
  for (const index of [0, 1, 2, 3]) {
    check(
      `leaf ${index} verifies off chain`,
      verifyAllowlistProof(root, 4n, proof(index)),
    );
  }
  const leaf = (index: number, walletCap?: bigint) => ({
    allowlist: proof(index, walletCap),
  });

  const { record, executed } = await createSale({
    scenario: "E2E-012",
    letter: "C",
    creator: w.creator,
    venue: "bluefin",
    terms: defaultTerms({
      raiseTarget: coins(80),
      durationMs: 6n * 60_000n,
      eligibility: { kind: "allowlisted", root, leafCount: 4n },
      uncapped: {
        startsAfterMs: 3n * 60_000n,
        access: { kind: "eligible" },
        hardCap: true,
      },
    }),
  });
  saveSale("e012", record);
  const opened = event(executed, "PresaleOpened");

  // Capped phase: top-ups to the cap.
  for (const step of [1, 2, 3]) {
    const done = await commit(
      `p1 top-up ${step} of 10`,
      record,
      w.p1,
      coins(10),
      leaf(0),
    );
    equal(
      `p1 total after step ${step}`,
      u64(event(done, "Committed").wallet_commitment),
      coins(10 * step),
    );
  }
  await expectAbort(
    "p1 past its 30 cap",
    w.p1,
    commitTx(record, w.p1, coins(1), leaf(0)),
    {
      module: "blast_presale",
      code: 9,
    },
  );
  await commit(
    "p2 commits 20 under its 20 leaf",
    record,
    w.p2,
    coins(20),
    leaf(1),
  );
  await expectAbort(
    "p2 tops up quoting its other 40 leaf",
    w.p2,
    commitTx(record, w.p2, coins(5), leaf(3)),
    { module: "blast_presale", code: 11 },
  );
  await expectAbort(
    "unlisted p4 replays p1's proof",
    w.p4,
    commitTx(record, w.p4, coins(5), leaf(0)),
    {
      module: "blast_presale",
      code: 11,
    },
  );
  await expectAbort(
    "p3 claims a larger cap",
    w.p3,
    commitTx(record, w.p3, coins(5), leaf(2, coins(60))),
    { module: "blast_presale", code: 11 },
  );
  await expectAbort(
    "p3 uses another wallet's index",
    w.p3,
    commitTx(record, w.p3, coins(5), {
      allowlist: { ...proof(1), wallet: w.p3.toSuiAddress() },
    }),
    { module: "blast_presale", code: 11 },
  );
  await expectAbort(
    "commit_open on an allowlist sale",
    w.p3,
    commitTx(record, w.p3, coins(5), "open"),
    {
      module: "blast_presale",
      code: 12,
    },
  );
  await expectAbort(
    "commit_uncapped on an allowlist sale",
    w.p3,
    commitTx(record, w.p3, coins(5), "uncapped"),
    { module: "blast_presale", code: 24 },
  );
  await commit("p3 commits 25", record, w.p3, coins(25), leaf(2));

  // Hard-capped phase: listed wallets exceed their caps.
  await waitUntil(u64(opened.uncapped_from_ms), "the uncapped phase");
  const past = await commit(
    "p2 commits 3 past its 20 cap",
    record,
    w.p2,
    coins(3),
    leaf(1),
  );
  equal(
    "p2 total 23",
    u64(event(past, "Committed").wallet_commitment),
    coins(23),
  );
  await commit(
    "p2 commits 1 quoting its 40 leaf once caps lift",
    record,
    w.p2,
    coins(1),
    leaf(3),
  );
  await expectAbort(
    "unlisted p4 in the phase",
    w.p4,
    commitTx(record, w.p4, coins(5), leaf(0)),
    {
      module: "blast_presale",
      code: 11,
    },
  );
  const fill = await commit(
    "p3 offers 10 when 1 remains",
    record,
    w.p3,
    coins(10),
    leaf(2),
  );
  equal("only 1 accepted", u64(event(fill, "Committed").quote), coins(1));
  equal(
    "p3 pays only 1",
    balanceChange(fill, w.p3.toSuiAddress(), record.quoteType),
    -coins(1),
  );
  await expectAbort(
    "p1 commits after the hard cap filled",
    w.p1,
    commitTx(record, w.p1, coins(1), leaf(0)),
    {
      module: "blast_presale",
      code: 25,
    },
  );

  await waitUntil(u64(opened.end_ms), "E2E-012 window end");
  const keeper = new Transaction();
  addSettle(keeper, record);
  addMigrate(keeper, record);
  const migrated = await exec(
    "relayer settles and migrates",
    w.relayer,
    keeper,
  );
  const done = recordMigration(record, migrated);
  saveSale("e012", done);

  const claimed = await exec(
    "relayer claims for p1, p2, p3",
    w.relayer,
    claimTx(
      done,
      [w.p1, w.p2, w.p3].map((key) => key.toSuiAddress()),
    ),
  );
  const got = (key: typeof w.p1) =>
    balanceChange(claimed, key.toSuiAddress(), done.memeType);
  equal("p1 tokens 30/80", got(w.p1), (SALE_TOKENS * 30n) / 80n);
  equal("p2 tokens 24/80", got(w.p2), (SALE_TOKENS * 24n) / 80n);
  equal("all tokens delivered", got(w.p1) + got(w.p2) + got(w.p3), SALE_TOKENS);
}
