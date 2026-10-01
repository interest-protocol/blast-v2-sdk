import assert from "node:assert/strict";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import {
  decodePresaleObject,
  decodePresaleRewardRoundObject,
  decodePresaleVaultObject,
  eligibilityPolicyBcs,
  getPresaleCommitment,
  presaleBcs,
  presaleRewardIsClaimed,
  uncappedPhaseBcs,
} from "../src/presale/state.ts";

// Byte fixtures written field by field from the Move declarations (and the
// `PresaleState` / `VaultState` serde mirrors in the contracts' presale venue
// fork), independently of the SDK's BCS schemas.
const pkg = "0x5e";
const u8 = (value: number) => [value];
const u32 = (value: number) => le(BigInt(value), 4);
const u64 = (value: bigint) => le(value, 8);
const bool = (value: boolean) => [value ? 1 : 0];
const addr = (value: string) =>
  Array.from(Buffer.from(normalizeSuiAddress(value).slice(2), "hex"));
const vec = (items: number[][]) => [items.length, ...items.flat()];
const bytes = (value: number[]) => [value.length, ...value];
const ascii = (value: string) => bytes(Array.from(Buffer.from(value)));

function le(value: bigint, width: number): number[] {
  return Array.from({ length: width }, (_, i) =>
    Number((value >> BigInt(8 * i)) & 0xffn),
  );
}

const root = Array.from({ length: 32 }, (_, i) => i);
const witness = `${"5e".padStart(64, "0")}::cetus::Witness`;

function presaleBytes(): Uint8Array {
  return Uint8Array.from([
    ...addr("0xab"), // id
    ...addr("0xca"), // presale_cap_id
    ...u8(2), // lifecycle: Funded
    ...u64(100n), // duration_ms
    ...u64(50n), // liquidity_window_ms
    ...u64(1_100n), // end_ms
    ...u64(1_150n), // liquidity_deadline_ms
    ...u64(1_000n), // raise_target
    ...u8(1), // eligibility: Allowlisted
    ...bytes(root),
    ...u64(3n),
    ...u8(1), // uncapped: Some
    ...u64(50n), // starts_after_ms
    ...u8(1), // access: Anyone
    ...u64(8n),
    ...u64(250n),
    ...bool(true), // hard_cap
    ...u64(1_050n), // uncapped_from_ms
    ...ascii(witness), // migration_witness
    ...u32(200), // tick_spacing
    ...u64(10_000n), // fee_rate
    ...vec([
      [...addr("0xc0ffee"), ...u64(5_000n)],
      [...addr("0xfee"), ...u64(2_000n)],
    ]),
    ...u64(3_000n), // rewards_fee_bps
    ...u64(4_000n), // total_commitments
    ...u64(3_000n), // remaining_commitments
    ...u64(2n), // participants
    ...u64(3_000n), // quote
    ...u64(10_001n), // token_allocation
    ...u64(7_501n), // sale_tokens
    ...u64(0n), // liquidity_tokens
    ...vec([[...addr("0xa110c"), ...u64(5_000n)]]), // recipient_payouts
    ...u64(0n), // recipient_tokens
    ...vec([[...addr("0x5a1e"), ...u64(200n)]]), // raise_payouts
  ]);
}

const object = (type: string, content: Uint8Array, objectId = "0xab") => ({
  objectId,
  initialSharedVersion: "7",
  type,
  content,
});

test("decodes a Presale from bytes laid out in Move field order", () => {
  const state = decodePresaleObject(
    object(
      `${pkg}::blast_presale::Presale<0xa::meme::MEME, 0x2::sui::SUI>`,
      presaleBytes(),
    ),
    pkg,
  );
  assert.equal(state.lifecycle, "Funded");
  assert.equal(state.presaleCapId, normalizeSuiAddress("0xca"));
  assert.equal(state.memeType, `${normalizeSuiAddress("0xa")}::meme::MEME`);
  assert.deepEqual(state.eligibility, {
    kind: "allowlisted",
    root: Buffer.from(root).toString("hex"),
    leafCount: 3n,
  });
  assert.deepEqual(state.uncapped, {
    startsAfterMs: 50n,
    access: { kind: "anyone", maxParticipants: 8n, minCommitment: 250n },
    hardCap: true,
  });
  assert.equal(state.migrationWitness, `0x${witness}`);
  assert.equal(state.tickSpacing, 200);
  assert.deepEqual(state.feeRecipients, [
    { recipient: normalizeSuiAddress("0xc0ffee"), bps: 5_000n },
    { recipient: normalizeSuiAddress("0xfee"), bps: 2_000n },
  ]);
  assert.deepEqual(
    [
      state.totalCommitments,
      state.remainingCommitments,
      state.participants,
      state.quote,
      state.tokenAllocation,
      state.saleTokens,
      state.liquidityTokens,
      state.recipientTokens,
    ],
    [4_000n, 3_000n, 2n, 3_000n, 10_001n, 7_501n, 0n, 0n],
  );
  assert.deepEqual(state.raisePayouts, [
    { recipient: normalizeSuiAddress("0x5a1e"), amount: 200n },
  ]);
  const parsed = presaleBcs.parse(presaleBytes());
  assert.deepEqual(
    presaleBcs.parse(presaleBcs.serialize(parsed).toBytes()),
    parsed,
  );
});

test("round-trips both eligibility policies and uncapped accesses", () => {
  const open = Uint8Array.from([0, ...u64(5_000n), ...u64(2n), ...u64(500n)]);
  assert.deepEqual(eligibilityPolicyBcs.parse(open), {
    kind: "open",
    walletCap: 5_000n,
    maxParticipants: 2n,
    minCommitment: 500n,
  });
  assert.deepEqual(
    eligibilityPolicyBcs.serialize(eligibilityPolicyBcs.parse(open)).toBytes(),
    open,
  );
  const eligible = Uint8Array.from([...u64(50n), 0, 0]);
  assert.deepEqual(uncappedPhaseBcs.parse(eligible), {
    startsAfterMs: 50n,
    access: { kind: "eligible" },
    hardCap: false,
  });
  assert.deepEqual(
    uncappedPhaseBcs.serialize(uncappedPhaseBcs.parse(eligible)).toBytes(),
    eligible,
  );
});

test("rejects a foreign type, package, or mismatched UID", () => {
  const type = `${pkg}::blast_presale::Presale<0xa::meme::MEME, 0x2::sui::SUI>`;
  assert.throws(() =>
    decodePresaleObject(object(type, presaleBytes()), "0x99"),
  );
  assert.throws(() =>
    decodePresaleObject(
      object(type.replace("Presale<", "Other<"), presaleBytes()),
      pkg,
    ),
  );
  assert.throws(
    () => decodePresaleObject(object(type, presaleBytes(), "0xac"), pkg),
    /mismatched UID/,
  );
});

test("decodes a PresaleVault from bytes laid out in Move field order", () => {
  const content = Uint8Array.from([
    ...addr("0xba"), // id
    ...addr("0xab"), // presale_id
    ...addr("0xca"), // presale_cap_id
    ...addr("0x9001"), // pool_id
    ...vec([[...addr("0xc0ffee"), ...u64(7_000n)]]),
    ...u64(3_000n), // rewards_fee_bps
    ...u64(1n), // migration_meme_residual
    ...u64(0n), // migration_quote_residual
    ...u64(30n), // rewards_meme
    ...u64(3n), // rewards_quote
    ...u64(2n), // next_round
    ...u8(1), // last_checkpoint: Some
    ...u64(99n),
  ]);
  const vault = decodePresaleVaultObject(
    object(
      `${pkg}::presale_vault::PresaleVault<0xa::meme::MEME, 0x2::sui::SUI>`,
      content,
      "0xba",
    ),
    pkg,
  );
  assert.deepEqual(
    [
      vault.presaleId,
      vault.presaleCapId,
      vault.poolId,
      vault.rewardsFeeBps,
      vault.migrationMemeResidual,
      vault.migrationQuoteResidual,
      vault.rewardsMeme,
      vault.rewardsQuote,
      vault.nextRound,
      vault.lastCheckpoint,
    ],
    [
      normalizeSuiAddress("0xab"),
      normalizeSuiAddress("0xca"),
      normalizeSuiAddress("0x9001"),
      3_000n,
      1n,
      0n,
      30n,
      3n,
      2n,
      99n,
    ],
  );
});

test("decodes a holder-reward Round and its claim bitmap", () => {
  const content = Uint8Array.from([
    ...addr("0xd0"), // id
    ...addr("0xba"), // vault
    ...u64(1n), // number
    ...u64(5_000n), // claim_deadline_ms
    ...bytes(root),
    ...u64(300n), // leaf_count
    ...vec([le(1n << 5n, 32), le(1n, 32)]), // claimed: leaves 5 and 256
    ...u64(40n), // meme
    ...u64(5n), // quote
  ]);
  const round = decodePresaleRewardRoundObject(
    object(
      `${pkg}::holder_rewards::Round<0xa::meme::MEME, 0x2::sui::SUI>`,
      content,
      "0xd0",
    ),
    pkg,
  );
  assert.equal(round.vaultId, normalizeSuiAddress("0xba"));
  assert.deepEqual(
    [
      round.number,
      round.claimDeadlineMs,
      round.leafCount,
      round.memeRemaining,
      round.quoteRemaining,
    ],
    [1n, 5_000n, 300n, 40n, 5n],
  );
  assert.equal(presaleRewardIsClaimed(round, 5n), true);
  assert.equal(presaleRewardIsClaimed(round, 256n), true);
  assert.equal(presaleRewardIsClaimed(round, 4n), false);
  assert.throws(() => presaleRewardIsClaimed(round, 300n), /out of bounds/);
});

test("reads a wallet's commitment dynamic field, null when absent", async () => {
  const requests: unknown[] = [];
  const client = (value: Uint8Array | null) =>
    ({
      core: {
        getDynamicField: async (request: unknown) => {
          requests.push(request);
          if (!value) {
            throw new ObjectError("notExists", "missing", {
              reason: "notFound",
            });
          }
          return { dynamicField: { value: { bcs: value } } };
        },
      },
    }) as unknown as ClientWithCoreApi;

  const commitment = await getPresaleCommitment(
    client(Uint8Array.from([...u64(501n), ...u64(5_000n)])),
    "0xab",
    "0xa11ce",
    pkg,
  );
  assert.deepEqual(commitment, { quote: 501n, walletCap: 5_000n });
  assert.deepEqual(requests[0], {
    parentId: normalizeSuiAddress("0xab"),
    name: {
      type: `${normalizeSuiAddress(pkg)}::blast_presale::CommitmentKey`,
      bcs: Uint8Array.from(addr("0xa11ce")),
    },
  });
  assert.equal(
    await getPresaleCommitment(client(null), "0xab", "0xa11ce", pkg),
    null,
  );
});
