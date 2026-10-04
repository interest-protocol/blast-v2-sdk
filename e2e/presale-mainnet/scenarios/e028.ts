/**
 * E2E-028: a holder-reward round on the Cetus vault (E2E-011, SUI Quote),
 * funded from the holder share its LP fees accrued in E2E-020. One allocation
 * is claimed; the other returns to the vault when the round closes.
 */
import type { RewardProof } from "../../../src/holder-rewards/allocations.ts";
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
import type { Shared } from "../sale.ts";
import { mut, sale, types, u64 } from "../sale.ts";

export async function e028(): Promise<void> {
  const w = wallets();
  const record = sale("e011");
  const vault = record.vault as Shared;
  const before = await presale.getVault(vault.objectId);
  equal(
    "Cetus holder share accrued",
    before.holderRewardsMeme > 0n && before.holderRewardsQuote > 0n,
    true,
  );
  const half = (amount: bigint) => amount / 2n;
  const manifest = buildRewardManifest({
    vaultId: vault.objectId,
    number: before.nextRound,
    startCheckpoint: 1_000n,
    endCheckpoint: 2_000n,
    leafDomain: PRESALE_REWARD_LEAF_DOMAIN,
    allocations: [
      {
        beneficiary: w.p1.toSuiAddress(),
        memeAmount: half(before.holderRewardsMeme),
        quoteAmount: half(before.holderRewardsQuote),
      },
      {
        beneficiary: w.r1.toSuiAddress(),
        memeAmount: half(before.holderRewardsMeme),
        quoteAmount: 0n,
      },
    ],
  });
  const deadline = BigInt(Date.now()) + 90_000n;
  const published = await exec(
    "admin publishes a round on the Cetus vault",
    deployer(),
    single((tx) =>
      tx.add(
        presale.call.publishHolderRewardRound({
          ...types(record),
          vault: mut(vault),
          adminCap: ADMIN_CAP,
          manifest,
          claimDeadlineMs: deadline,
        }),
      ),
    ),
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

  const paid = await exec(
    "relayer claims p1's SUI and tokens",
    w.relayer,
    claim(leaf(w.p1.toSuiAddress())),
  );
  equal(
    "p1 paid its SUI",
    balanceChange(paid, w.p1.toSuiAddress(), record.quoteType),
    u64(leaf(w.p1.toSuiAddress()).quoteAmount),
  );
  equal(
    "p1 paid its tokens",
    balanceChange(paid, w.p1.toSuiAddress(), record.memeType),
    u64(leaf(w.p1.toSuiAddress()).memeAmount),
  );
  await expectAbort("p1 claims twice", w.p1, claim(leaf(w.p1.toSuiAddress())), {
    module: "holder_rewards",
    code: 6,
  });

  await waitUntil(deadline, "the Cetus round deadline");
  const closed = event(
    await exec(
      "relayer closes the round",
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
    "r1's unclaimed tokens returned",
    u64(closed.meme_returned),
    u64(leaf(w.r1.toSuiAddress()).memeAmount),
  );
  const after = await presale.getVault(vault.objectId);
  equal(
    "vault keeps everything not claimed",
    after.holderRewardsQuote,
    before.holderRewardsQuote - u64(leaf(w.p1.toSuiAddress()).quoteAmount),
  );
}
