/**
 * E2E-022: holder-reward rounds funded from the E2E-014 vault's holder share.
 * Publishes round 0, pays claims (one relayed), proves every claim and publish
 * gate, closes the round after its deadline so the unclaimed rest returns to
 * the vault, and publishes round 1 contiguously.
 */
import { Transaction } from "@mysten/sui/transactions";
import { fromHex } from "@mysten/sui/utils";

import type {
  RewardManifest,
  RewardProof,
} from "../../../src/holder-rewards/allocations.ts";
import {
  buildRewardManifest,
  PRESALE_REWARD_LEAF_DOMAIN,
} from "../../../src/holder-rewards/allocations.ts";
import {
  balanceChange,
  created,
  equal,
  event,
  exec,
  expectAbort,
  sharedVersion,
  single,
  waitUntil,
} from "../chain.ts";
import { ADMIN_CAP, DEPLOYMENT, deployer, presale, wallets } from "../env.ts";
import type { SaleRecord, Shared } from "../sale.ts";
import { mut, sale, types, u64 } from "../sale.ts";

export async function e022(): Promise<void> {
  const w = wallets();
  const admin = deployer();
  const record = sale("e014");
  const vault = record.vault as Shared;
  const before = await presale.getVault(vault.objectId);
  equal(
    "holder share accrued",
    before.holderRewardsMeme > 0n && before.holderRewardsQuote > 0n,
    true,
  );
  equal("no round yet", before.nextRound, 0n);

  const share = (amount: bigint, bps: bigint) => (amount * bps) / 10_000n;
  const manifest = buildRewardManifest({
    vaultId: vault.objectId,
    number: 0n,
    startCheckpoint: 100n,
    endCheckpoint: 200n,
    leafDomain: PRESALE_REWARD_LEAF_DOMAIN,
    allocations: [
      {
        beneficiary: w.p1.toSuiAddress(),
        memeAmount: share(before.holderRewardsMeme, 4_000n),
        quoteAmount: share(before.holderRewardsQuote, 4_000n),
      },
      {
        beneficiary: w.p2.toSuiAddress(),
        memeAmount: share(before.holderRewardsMeme, 3_000n),
        quoteAmount: share(before.holderRewardsQuote, 3_000n),
      },
      {
        beneficiary: w.r2.toSuiAddress(),
        memeAmount: share(before.holderRewardsMeme, 2_000n),
        quoteAmount: 0n,
      },
    ],
  });
  const deadline = BigInt(Date.now()) + 3n * 60_000n;
  const next = (start: bigint, number = 1n) =>
    buildRewardManifest({
      vaultId: vault.objectId,
      number,
      startCheckpoint: start,
      endCheckpoint: start + 100n,
      leafDomain: PRESALE_REWARD_LEAF_DOMAIN,
      allocations: [
        { beneficiary: w.p3.toSuiAddress(), memeAmount: 1n, quoteAmount: 1n },
      ],
    });

  await rawPublishAborts(record, manifest, deadline);
  await expectAbort(
    "publish round 1 first",
    admin,
    publish(record, next(100n), deadline),
    {
      module: "holder_rewards",
      code: 0,
    },
  );
  await expectAbort(
    "a deadline already past",
    admin,
    publish(record, manifest, BigInt(Date.now()) - 1_000n),
    {
      module: "holder_rewards",
      code: 9,
    },
  );

  const published = await exec(
    "admin publishes round 0",
    admin,
    publish(record, manifest, deadline),
  );
  const roundEvent = event(published, "RoundPublished");
  equal(
    "unallocated meme stays in the vault",
    u64(roundEvent.meme_unallocated),
    before.holderRewardsMeme - u64(manifest.memeAmount),
  );
  const roundId = created(
    published,
    `${DEPLOYMENT.originalPackageId}::holder_rewards::Round<`,
  );
  const round = {
    objectId: roundId,
    initialSharedVersion: sharedVersion(published, roundId),
  };

  const leaf = (address: string) =>
    manifest.allocations.find(
      (allocation) => allocation.beneficiary === address,
    ) as RewardProof;
  const claim = (allocation: RewardProof) =>
    single((tx) =>
      tx.add(
        presale.call.claimHolderReward({
          ...types(record),
          round: mut(round),
          allocation,
        }),
      ),
    );

  const own = await exec(
    "p1 claims its reward",
    w.p1,
    claim(leaf(w.p1.toSuiAddress())),
  );
  equal(
    "p1 paid its meme",
    balanceChange(own, w.p1.toSuiAddress(), record.memeType),
    u64(leaf(w.p1.toSuiAddress()).memeAmount),
  );
  const relayed = await exec(
    "relayer claims for p2",
    w.relayer,
    claim(leaf(w.p2.toSuiAddress())),
  );
  equal(
    "p2 paid its quote",
    balanceChange(relayed, w.p2.toSuiAddress(), record.quoteType),
    u64(leaf(w.p2.toSuiAddress()).quoteAmount),
  );
  await expectAbort("p1 claims twice", w.p1, claim(leaf(w.p1.toSuiAddress())), {
    module: "holder_rewards",
    code: 6,
  });
  await expectAbort(
    "r2's leaf with inflated amounts",
    w.r2,
    claim({
      ...leaf(w.r2.toSuiAddress()),
      memeAmount: String(u64(leaf(w.r2.toSuiAddress()).memeAmount) + 1n),
    }),
    { module: "holder_rewards", code: 8 },
  );
  await expectAbort(
    "an index past the leaves",
    w.r2,
    claim({ ...leaf(w.r2.toSuiAddress()), index: "3" }),
    {
      module: "holder_rewards",
      code: 5,
    },
  );

  await expectAbort(
    "round 1 with a checkpoint gap",
    admin,
    publish(record, next(150n), deadline),
    {
      module: "holder_rewards",
      code: 1,
    },
  );

  const close = single((tx) =>
    tx.add(
      presale.call.closeHolderRewardRound({
        ...types(record),
        round: mut(round),
        vault: mut(vault),
      }),
    ),
  );
  await expectAbort("close before the deadline", w.relayer, close, {
    module: "holder_rewards",
    code: 11,
  });
  await waitUntil(deadline, "the round 0 claim deadline");
  const closed = event(
    await exec(
      "relayer closes round 0",
      w.relayer,
      single((tx) =>
        tx.add(
          presale.call.closeHolderRewardRound({
            ...types(record),
            round: mut(round),
            vault: mut(vault),
          }),
        ),
      ),
    ),
    "RoundClosed",
  );
  equal(
    "r2's unclaimed meme returned",
    u64(closed.meme_returned),
    u64(leaf(w.r2.toSuiAddress()).memeAmount),
  );
  const after = await presale.getVault(vault.objectId);
  equal(
    "vault holder meme = before - claimed",
    after.holderRewardsMeme,
    before.holderRewardsMeme -
      u64(leaf(w.p1.toSuiAddress()).memeAmount) -
      u64(leaf(w.p2.toSuiAddress()).memeAmount),
  );
  equal("next round is 1", after.nextRound, 1n);
  await exec(
    "admin publishes round 1 contiguously",
    admin,
    publish(record, next(200n), BigInt(Date.now()) + 60_000n),
  );
}

function publish(
  record: SaleRecord,
  manifest: RewardManifest,
  claimDeadlineMs: bigint,
): Transaction {
  return single((tx) =>
    tx.add(
      presale.call.publishHolderRewardRound({
        ...types(record),
        vault: mut(record.vault as Shared),
        adminCap: ADMIN_CAP,
        manifest,
        claimDeadlineMs,
      }),
    ),
  );
}

/** Publish gates the SDK validates client-side, sent as raw calls so the contract rejects them. */
async function rawPublishAborts(
  record: SaleRecord,
  manifest: RewardManifest,
  deadline: bigint,
): Promise<void> {
  const admin = deployer();
  const root = [...fromHex(manifest.root)];
  const raw = (overrides: {
    start?: bigint;
    end?: bigint;
    root?: number[];
    leaves?: bigint;
    meme?: bigint;
    quote?: bigint;
  }) => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${DEPLOYMENT.packageId}::holder_rewards::publish_round`,
      typeArguments: [record.memeType, record.quoteType],
      arguments: [
        tx.sharedObjectRef({ ...(record.vault as Shared), mutable: true }),
        tx.sharedObjectRef({ ...DEPLOYMENT.adminRegistry, mutable: false }),
        tx.object(ADMIN_CAP),
        tx.pure.u64(0),
        tx.pure.u64(overrides.start ?? 100n),
        tx.pure.u64(overrides.end ?? 200n),
        tx.pure.vector("u8", overrides.root ?? root),
        tx.pure.vector("u8", root),
        tx.pure.u64(overrides.leaves ?? 3n),
        tx.pure.u64(overrides.meme ?? 1n),
        tx.pure.u64(overrides.quote ?? 1n),
        tx.pure.u64(deadline),
        tx.object.clock(),
      ],
    });
    return tx;
  };
  await expectAbort(
    "an empty checkpoint interval",
    admin,
    raw({ start: 200n, end: 200n }),
    { module: "holder_rewards", code: 1 },
  );
  await expectAbort("a 31-byte root", admin, raw({ root: root.slice(1) }), {
    module: "holder_rewards",
    code: 2,
  });
  await expectAbort("zero leaves", admin, raw({ leaves: 0n }), {
    module: "holder_rewards",
    code: 3,
  });
  await expectAbort("an empty budget", admin, raw({ meme: 0n, quote: 0n }), {
    module: "holder_rewards",
    code: 4,
  });
}
