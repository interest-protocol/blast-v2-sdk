import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRoundObject,
  decodeVaultObject,
  decodeVaultPositions,
  decodeVaultRegistryObject,
  getRound,
  getVault,
  getVaultRegistry,
  rewardIsClaimed,
  roundBcs,
  vaultBcs,
  vaultId,
  vaultRegistryBcs,
} from "@interest-protocol/blast-vault-sdk/state";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { fromHex, toHex } from "@mysten/sui/utils";
import {
  deployment,
  fixture,
  id,
  moveTypeName,
  registryType,
  roundType,
  vaultType,
} from "./vault-helpers.ts";

const partnerId =
  "0x75b6758a05e5945c492eb147dcfe2e58df886a71ff36c25b2ad07bec42cd407a";
const split = [
  { destination: { kind: "Owner" }, bps: 4_000n },
  { destination: { kind: "AutoLp" }, bps: 2_000n },
  { destination: { kind: "HolderRewards" }, bps: 2_000n },
  { destination: { kind: "Burn" }, bps: 1_000n },
  {
    destination: { kind: "Address", address: fixture.feeAddress },
    bps: 1_000n,
  },
];

const object = (objectId: string, type: string, hex: string) => ({
  objectId,
  initialSharedVersion: 5,
  type,
  content: fromHex(hex),
});

test("decodes the Move-printed Vault with every balance and pending change", () => {
  const vault = decodeVaultObject(
    object(fixture.vaultId, vaultType, fixture.objects.vault),
    deployment,
  );
  assert.deepEqual(
    { ...vault, terms: undefined },
    {
      objectId: fixture.vaultId,
      initialSharedVersion: "5",
      memeType: fixture.memeType,
      quoteType: fixture.quoteType,
      terms: undefined,
      venue: fixture.venue,
      poolId: fixture.poolId,
      feeSplit: { routes: split },
      feeSplitDelayMs: 172_800_000n,
      pendingFeeSplit: {
        value: { routes: [{ destination: { kind: "Owner" }, bps: 10_000n }] },
        delay_ms: 172_800_000n,
        ready_at_ms: fixture.clockMs + 172_800_000n,
      },
      protocolBps: { meme_bps: 1_500n, quote_bps: 1_000n },
      protocolBpsDelayMs: 172_800_000n,
      pendingProtocolBps: {
        value: { meme_bps: 500n, quote_bps: 700n },
        delay_ms: 172_800_000n,
        ready_at_ms: fixture.clockMs + 172_800_000n,
      },
      protocol: {
        packageWitness: `${fixture.vaultOriginalPackageId}::vault::VaultWitness`,
        origin: fixture.vaultId,
        partnerId,
        meme: 150_001n + 450_001n,
        quote: 200_001n + 400_001n,
        sui: 0n,
      },
      ownerMeme: 1_020_000n,
      ownerQuote: 1_440_001n,
      autoLpMeme: 13n + 510_000n,
      autoLpQuote: 17n + 720_001n,
      rewardsMeme: 70_000n + 510_000n,
      rewardsQuote: 155_001n + 720_000n,
      burnQuote: 81_001n + 360_000n,
      nextRound: 1n,
      lastCheckpoint: 100n,
      roundDelayMs: 7_200_000n,
      pendingRoundPublication: {
        value: {
          kind: "Action",
          action: {
            number: 1n,
            start_checkpoint: 100n,
            end_checkpoint: 200n,
            root: `${"0".repeat(63)}1`,
            manifest_digest: `${"0".repeat(63)}1`,
            leaf_count: 3n,
            meme_amount: 10n,
            quote_amount: 10n,
            gas_reserve_amount: 1n,
            claim_window_duration_ms: 604_800_000n,
            expected_treasury: fixture.treasury,
          },
        },
        delay_ms: 7_200_000n,
        ready_at_ms: fixture.clockMs + 7_200_000n,
      },
    },
  );
  assert.deepEqual(vault.terms, {
    origin: fixture.saleId,
    packageWitness: fixture.saleWitness,
    feeSplit: { routes: split },
    protocolMemeBps: 1_500n,
    protocolQuoteBps: 1_000n,
    partnerId,
    residuals: "Owner",
  });
});

test("the Vault layout re-encodes the Move bytes exactly", () => {
  const parsed = vaultBcs.parse(fromHex(fixture.objects.vault));
  const reencoded = vaultBcs
    .serialize({
      ...parsed,
      terms: {
        ...parsed.terms,
        packageWitness: moveTypeName(parsed.terms.packageWitness),
      },
      protocol: {
        ...parsed.protocol,
        packageWitness: moveTypeName(parsed.protocol.packageWitness),
      },
    })
    .toBytes();
  assert.equal(toHex(reencoded), fixture.objects.vault);
});

test("vaultId derives the Move vault ID from the registry, witness and sale", () => {
  assert.equal(
    vaultId(deployment, fixture.saleWitness, fixture.saleId),
    fixture.vaultId,
  );
});

test("decodes a published Round, then the same Round paid and settled", () => {
  const published = decodeRoundObject(
    object(fixture.roundId, roundType, fixture.objects.roundPublished),
    deployment,
  );
  const settled = decodeRoundObject(
    object(fixture.roundId, roundType, fixture.objects.roundSettled),
    deployment,
  );
  const common = {
    objectId: fixture.roundId,
    initialSharedVersion: "5",
    memeType: fixture.memeType,
    quoteType: fixture.quoteType,
    vaultId: fixture.vaultId,
    number: 0n,
    claimDeadlineAtMs: fixture.clockMs,
    leafCount: 1,
    treasury: fixture.treasury,
  };
  assert.deepEqual(
    { ...published, root: undefined },
    {
      ...common,
      root: undefined,
      claimedBitmap: [0n],
      meme: 100_000n,
      quote: 200_000n,
      gasReserve: 20_000n,
    },
  );
  assert.equal(published.root.length, 64);
  assert.deepEqual(
    { ...settled, root: published.root },
    {
      ...common,
      root: published.root,
      claimedBitmap: [1n],
      meme: 0n,
      quote: 0n,
      gasReserve: null,
    },
  );
  assert.equal(rewardIsClaimed(published.claimedBitmap, 0), false);
  assert.equal(rewardIsClaimed(settled.claimedBitmap, 0), true);
  for (const hex of [
    fixture.objects.roundPublished,
    fixture.objects.roundSettled,
  ]) {
    assert.equal(
      toHex(roundBcs.serialize(roundBcs.parse(fromHex(hex))).toBytes()),
      hex,
    );
  }
});

test("rewardIsClaimed reads 256 leaves per word and rejects indexes past the bitmap", () => {
  const bitmap = [1n << 255n, 1n << 4n];
  assert.equal(rewardIsClaimed(bitmap, 255), true);
  assert.equal(rewardIsClaimed(bitmap, 260), true);
  assert.equal(rewardIsClaimed(bitmap, 0), false);
  assert.throws(() => rewardIsClaimed(bitmap, 512), RangeError);
  assert.throws(() => rewardIsClaimed(bitmap, -1), RangeError);
  assert.throws(() => rewardIsClaimed(bitmap, 1.5), RangeError);
});

test("decodes the registry's admitted witnesses, pending admission and delay", () => {
  const registry = decodeVaultRegistryObject(
    object(fixture.registryId, registryType, fixture.objects.registry),
    deployment,
  );
  assert.deepEqual(registry, {
    objectId: fixture.registryId,
    initialSharedVersion: "5",
    witnesses: [fixture.venue, fixture.saleWitness],
    delayMs: 0n,
    pendingDelay: { delay_ms: 172_800_000n, ready_at_ms: 1_000n },
    pendingWitnesses: {
      [fixture.otherVenue]: { delay_ms: 0n, ready_at_ms: 1_000n },
    },
  });
  const parsed = vaultRegistryBcs.parse(fromHex(fixture.objects.registry));
  const reencoded = vaultRegistryBcs
    .serialize({
      ...parsed,
      witnesses: {
        ...parsed.witnesses,
        members: parsed.witnesses.members.map(moveTypeName),
        admissions: parsed.witnesses.admissions.map((admission) => ({
          ...admission,
          member: moveTypeName(admission.member),
        })),
      },
    })
    .toBytes();
  assert.equal(toHex(reencoded), fixture.objects.registry);
});

test("decoders reject another package's type and a mismatched UID", () => {
  const other = vaultType.replace(fixture.vaultOriginalPackageId, id("0xbad"));
  assert.throws(
    () =>
      decodeVaultObject(
        object(fixture.vaultId, other, fixture.objects.vault),
        deployment,
      ),
    /is not a vault Vault/,
  );
  assert.throws(
    () =>
      decodeVaultObject(
        object(id("0x1234"), vaultType, fixture.objects.vault),
        deployment,
      ),
    /mismatched UID/,
  );
  assert.throws(
    () =>
      decodeRoundObject(
        object(fixture.roundId, vaultType, fixture.objects.roundPublished),
        deployment,
      ),
    /is not a vault Round/,
  );
  assert.throws(
    () =>
      decodeVaultRegistryObject(
        object(fixture.registryId, vaultType, fixture.objects.registry),
        deployment,
      ),
    /is not the vault registry/,
  );
});

const positionType = (key: string, venue: string = fixture.venue) =>
  `${fixture.vaultOriginalPackageId}::vault::${key}<${venue}>`;

test("decodeVaultPositions reads the venue from PositionKey<Venue>", () => {
  assert.deepEqual(
    decodeVaultPositions(
      [{ name: { type: positionType("PositionKey") }, childId: "0xa1" }],
      deployment,
    ),
    { venue: fixture.venue, positionId: id("0xa1"), autoLpPositionId: null },
  );
  assert.deepEqual(
    decodeVaultPositions(
      [
        {
          name: {
            type: `0x2::dynamic_object_field::Wrapper<${positionType("AutoLpPositionKey")}>`,
          },
          childId: "0xa2",
        },
        { name: { type: positionType("PositionKey") }, childId: "0xa1" },
      ],
      deployment,
    ),
    {
      venue: fixture.venue,
      positionId: id("0xa1"),
      autoLpPositionId: id("0xa2"),
    },
  );
  assert.throws(
    () => decodeVaultPositions([], deployment),
    /exactly one venue/,
  );
  assert.throws(
    () =>
      decodeVaultPositions(
        [
          { name: { type: positionType("PositionKey") }, childId: "0xa1" },
          {
            name: {
              type: positionType("AutoLpPositionKey", fixture.otherVenue),
            },
            childId: "0xa2",
          },
        ],
        deployment,
      ),
    /exactly one venue/,
  );
  assert.throws(
    () =>
      decodeVaultPositions(
        [{ name: { type: "0x2::object::ID" }, childId: "0xa1" }],
        deployment,
      ),
    /unexpected vault dynamic field/,
  );
});

test("readers fetch shared objects and the vault's position fields", async () => {
  const objects: Record<string, { type: string; hex: string }> = {
    [fixture.vaultId]: { type: vaultType, hex: fixture.objects.vault },
    [fixture.roundId]: { type: roundType, hex: fixture.objects.roundSettled },
    [fixture.registryId]: { type: registryType, hex: fixture.objects.registry },
  };
  const client = {
    core: {
      getObject: async ({ objectId }: { objectId: string }) => {
        const found = objects[objectId];
        assert.ok(found, objectId);
        return {
          object: {
            objectId,
            type: found.type,
            content: fromHex(found.hex),
            owner: { $kind: "Shared", Shared: { initialSharedVersion: "7" } },
          },
        };
      },
      listDynamicFields: async ({ parentId }: { parentId: string }) => {
        assert.equal(parentId, fixture.vaultId);
        return {
          hasNextPage: false,
          cursor: null,
          dynamicFields: [
            {
              $kind: "DynamicObject",
              name: {
                type: positionType("PositionKey"),
                bcs: new Uint8Array([0]),
              },
              childId: id("0xa1"),
            },
          ],
        };
      },
    },
  } as unknown as ClientWithCoreApi;
  const vault = await getVault(client, fixture.vaultId, deployment);
  assert.equal(vault.venue, fixture.venue);
  assert.equal(vault.positionId, id("0xa1"));
  assert.equal(vault.initialSharedVersion, "7");
  assert.equal(
    (await getRound(client, fixture.roundId, deployment)).gasReserve,
    null,
  );
  assert.deepEqual((await getVaultRegistry(client, deployment)).witnesses, [
    fixture.venue,
    fixture.saleWitness,
  ]);
});
