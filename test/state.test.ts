import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeLaunchConfigObject,
  decodeLaunchObject,
  decodeLaunchTicketObject,
  decodePartnerObject,
  decodeRuntimeConfigObject,
  getLaunch,
  getOpeningRoundBid,
  openingRoundEndMs,
  previewProtocolFeeClaim,
  timelockedValue,
} from "@interest-protocol/blast-launchpad-sdk/state";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import type { LaunchpadFixture } from "./fixtures/launchpad-442116a.ts";
import {
  LAUNCHPAD_FIXTURE_HEX,
  launchpadFixture,
} from "./fixtures/launchpad-442116a.ts";

const launchId =
  "0x489d325645528066bd5fc2fd6e54cedebd2d7e98aa6095740a6b892e1b1c09f7";
const ticketId =
  "0xb6d2ab0253927f724cb33c7641ee60b89ee15056df84f442f1396b40139a44d6";
const partnerId = `0x${LAUNCHPAD_FIXTURE_HEX.partnerId}`;
const memeType = "0x0::sdk_fixture_tests::SDK_FIXTURE_TESTS";
const quoteType = "0x0::sdk_fixture_tests::TEST_QUOTE";
const launchType = `0x0::launch::Launch<${memeType}, ${quoteType}>`;

function launch(fixture: LaunchpadFixture) {
  return decodeLaunchObject(
    {
      objectId: launchId,
      initialSharedVersion: "7",
      mutable: true,
      type: launchType,
      content: launchpadFixture(fixture),
    },
    "0x0",
  );
}

test("decodes a finalized opening-round launch from literal contract bytes", () => {
  const state = launch("launchFinalized");

  assert.equal(state.objectId, launchId);
  assert.equal(state.memeType, normalizeStructTag(memeType));
  assert.equal(state.quoteType, normalizeStructTag(quoteType));
  assert.equal(state.lifecycle, "OpeningRound");
  assert.equal(state.publicStartMs, null);
  assert.equal(state.openingRoundMs, 60_000n);
  assert.equal(openingRoundEndMs(state), null);
  assert.deepEqual(
    [state.openingRoundBids, state.openingRoundQuote, state.openingRoundMeme],
    [0n, 0n, 0n],
  );
  assert.equal(state.sellBurnBps, 1_000n);
  assert.equal(state.virtualQuote, 3_000_000_000_000n);
  assert.equal(state.graduationTarget, 12_345_678_901_237n);
  assert.equal(state.quoteFeeBps, 100n);
  assert.equal(state.memeFeeBps, 250n);
  assert.equal(
    state.migrationWitnessType,
    normalizeStructTag("0x0::sdk_fixture_tests::TEST_MIGRATION_WITNESS"),
  );
  assert.equal(state.poolTickSpacing, 200);
  assert.equal(state.poolFeeRate, 10_000n);
  assert.deepEqual(state.lpFeeSplit, {
    creatorBps: 5_000n,
    autoLpBps: 2_000n,
    rewardsBps: 1_000n,
    burnBps: 1_000n,
    recipients: [{ destination: normalizeSuiAddress("0xf00d"), bps: 1_000n }],
  });
  assert.equal(state.atomicSupply, 1_000_000_000_000_000_000n);
  assert.equal(state.memeReserve, 700_000_000_000_000_000n);
  assert.equal(state.realQuoteReserve, 0n);
  assert.equal(state.pendingBurn, 0n);
  assert.deepEqual(state.allocationPlan, {
    curveMemeBps: 7_000n,
    lpMemeBps: 2_000n,
    lpQuoteBps: 9_500n,
    protocolMemeBps: 750n,
    protocolQuoteBps: 250n,
    recipients: [
      {
        destination: normalizeSuiAddress("0xfeed"),
        memeBps: 250n,
        quoteBps: 250n,
      },
    ],
  });
  assert.equal(state.allocatedMeme, 300_000_000_000_000_000n);
  assert.deepEqual(
    [
      state.protocolMemeFees,
      state.creatorMemeFees,
      state.protocolQuoteFees,
      state.creatorQuoteFees,
      state.protocolSuiFees,
    ],
    [0n, 0n, 0n, 0n, 5_000_000_000n],
  );
  assert.equal(
    state.metadataCapId,
    "0x77520198ea52372717b1278701852c232e32d5cf6e202dde276ce97a265fbe6e",
  );
  assert.deepEqual(state.creatorRecipient, {
    kind: "address",
    address: normalizeSuiAddress("0xc0ffee"),
  });
  assert.equal(state.curveFeeCapId, null);
  assert.equal(state.blastMetadataCapId, null);
  assert.equal(state.partnerId, partnerId);
});

test("decodes the opening round, settlement, migration, and claims", () => {
  const joined = launch("launchOpeningRound");
  assert.equal(joined.lifecycle, "OpeningRound");
  assert.equal(joined.publicStartMs, 1_000n);
  assert.equal(openingRoundEndMs(joined), 61_000n);
  assert.equal(joined.openingRoundBids, 3_000_000_000n);
  assert.equal(joined.openingRoundQuote, 3_000_000_000n);

  // The settlement bought 675,006,743,324,108 net Meme with the whole pot.
  const settled = launch("launchSettled");
  assert.equal(settled.lifecycle, "Live");
  assert.equal(settled.openingRoundBids, 3_000_000_000n);
  assert.equal(settled.openingRoundQuote, 0n);
  assert.equal(settled.openingRoundMeme, 675_006_743_324_108n);
  assert.equal(settled.memeReserve, 699_307_685_391_462_453n);
  assert.equal(settled.realQuoteReserve, 2_970_000_000n);

  const ready = launch("launchMigrationReady");
  assert.equal(ready.lifecycle, "MigrationReady");
  assert.equal(ready.realQuoteReserve, 12_345_678_901_237n);

  const migrated = launch("launchMigrated");
  assert.equal(migrated.lifecycle, "Migrated");
  assert.deepEqual(
    [migrated.memeReserve, migrated.realQuoteReserve, migrated.allocatedMeme],
    [0n, 0n, 0n],
  );
  // Blast's one-time migration fee joined the protocol ledger.
  assert.equal(
    migrated.protocolMemeFees - ready.protocolMemeFees,
    75_000_000_000_000_000n,
  );
  assert.equal(
    migrated.protocolQuoteFees - ready.protocolQuoteFees,
    308_641_972_531n,
  );

  const claimed = launch("launchClaimed");
  assert.equal(claimed.creatorRecipient, null);
  assert.equal(
    claimed.curveFeeCapId,
    "0xd61ead5141eb403c577271ab6407f911211808138a3413a7de64734243b28f59",
  );
  assert.equal(
    claimed.blastMetadataCapId,
    "0x2e7c7744e7aca1de732a399d6e43e81b6c151e30ccc86553742f1a57eeb32b08",
  );
  assert.deepEqual(
    [
      claimed.protocolMemeFees,
      claimed.creatorMemeFees,
      claimed.protocolQuoteFees,
      claimed.creatorQuoteFees,
      claimed.protocolSuiFees,
    ],
    [0n, 0n, 0n, 0n, 0n],
  );
});

test("decodes a launch ticket from literal contract bytes", () => {
  const ticket = decodeLaunchTicketObject(
    {
      objectId: ticketId,
      type: `0x0::launch_ticket::LaunchTicket<${memeType}>`,
      content: launchpadFixture("launchTicket"),
    },
    "0x0",
  );

  assert.deepEqual(ticket, {
    objectId: ticketId,
    memeType: normalizeStructTag(memeType),
    meme: 1_000_000_000_000_000_000n,
    treasuryCapId:
      "0xdba72804cc9504a82bbaa13ed4a83a0e2c6219d7e45125cf57fd10cbab957a97",
    totalSupply: 1_000_000_000_000_000_000n,
    metadataCapId:
      "0x77520198ea52372717b1278701852c232e32d5cf6e202dde276ce97a265fbe6e",
    creatorRecipient: {
      kind: "address",
      address: normalizeSuiAddress("0xc0ffee"),
    },
    decimals: 9,
    burnable: false,
    sellBurnBps: 1_000n,
  });
  assert.throws(
    () =>
      decodeLaunchTicketObject(
        {
          objectId: ticketId,
          type: `0x1::launch_ticket::LaunchTicket<${memeType}>`,
          content: launchpadFixture("launchTicket"),
        },
        "0x0",
      ),
    /unexpected package/,
  );
});

test("preserves the initial shared version returned by the Core API", async () => {
  const client = {
    core: {
      getObject: async () => ({
        object: {
          objectId: launchId,
          owner: { $kind: "Shared", Shared: { initialSharedVersion: "7" } },
          type: launchType,
          content: launchpadFixture("launchSettled"),
        },
      }),
    },
  } as unknown as ClientWithCoreApi;

  const state = await getLaunch(client, launchId, "0x0");

  assert.deepEqual(
    [state.objectId, state.initialSharedVersion, state.mutable],
    [launchId, "7", true],
  );
});

test("reads a bidder's undelivered opening-round Quote", async () => {
  const requests: unknown[] = [];
  const client = {
    core: {
      getDynamicField: async (request: unknown) => {
        requests.push(request);
        if (requests.length === 2)
          throw new ObjectError("NOT_FOUND", "none", { reason: "notFound" });
        return {
          dynamicField: {
            value: { bcs: Uint8Array.from([0, 148, 53, 119, 0, 0, 0, 0]) },
          },
        };
      },
    },
  } as unknown as ClientWithCoreApi;

  assert.equal(
    await getOpeningRoundBid(client, launchId, "0xa11ce", "0x0"),
    2_000_000_000n,
  );
  assert.equal(await getOpeningRoundBid(client, launchId, "0xb0b", "0x0"), 0n);
  assert.deepEqual(requests[0], {
    parentId: launchId,
    name: {
      type: `${normalizeSuiAddress("0x0")}::launch::OpeningRoundBidKey`,
      bcs: Uint8Array.from(
        Buffer.from(normalizeSuiAddress("0xa11ce").slice(2), "hex"),
      ),
    },
  });
});

test("rejects a launch object whose embedded UID does not match", () => {
  assert.throws(
    () =>
      decodeLaunchObject({
        objectId: "0xf",
        initialSharedVersion: "7",
        mutable: true,
        type: launchType,
        content: launchpadFixture("launchFinalized"),
      }),
    /mismatched UID/,
  );
});

test("decodes launch and runtime configuration from literal contract bytes", () => {
  const config = decodeLaunchConfigObject({
    objectId:
      "0xa4137e2ed945e7f4e8c307001c32e97472fb3eebb8f7b4ab7534b447d22da89b",
    initialSharedVersion: "3",
    type: "0x0::launch_config::LaunchConfig",
    content: launchpadFixture("launchConfig"),
  });
  assert.deepEqual(config.memeDecimals, [6, 9]);
  assert.equal(
    config.quotesTableId,
    "0x5ef2fcf809fb9535ea0aeaea421f683026f06c34569aafc42bcde652ef6dd270",
  );
  assert.equal(config.quoteCount, 1n);
  assert.equal(config.quoteFeeBps, 100n);
  assert.equal(config.memeFeeBps, 250n);
  assert.deepEqual(config.migrationWitnessTypes, [
    normalizeStructTag("0x0::sdk_fixture_tests::TEST_MIGRATION_WITNESS"),
  ]);
  assert.deepEqual(config.protocolAllocation, {
    memeBps: 750n,
    quoteBps: 250n,
  });
  assert.equal(config.creationFee, 5_000_000_000n);

  const runtime = decodeRuntimeConfigObject({
    objectId:
      "0xa058cccb1180e0c063232bed5fcf330614d57c74f056f8b3db0317812e129eb2",
    initialSharedVersion: "4",
    type: "0x0::runtime_config::RuntimeConfig",
    content: launchpadFixture("runtimeConfig"),
  });
  assert.deepEqual(runtime.creatorClaimSignerPublicKey, new Uint8Array());
  assert.equal(runtime.protocolFeeShareBps, 3_000n);
});

test("decodes a partner and previews the partner's share of a protocol claim", () => {
  const partner = decodePartnerObject({
    objectId: partnerId,
    initialSharedVersion: "5",
    type: "0x0::blast_partners::Partner",
    content: launchpadFixture("partner"),
  });
  assert.equal(partner.recipient, normalizeSuiAddress("0xbeef"));
  assert.deepEqual(partner.shareBps, {
    before: 2_000n,
    after: 2_000n,
    atMs: 0n,
    delayMs: 604_800_000n,
  });
  assert.equal(timelockedValue(partner.shareBps, 61_000n), 2_000n);
  assert.equal(
    timelockedValue({ before: 1n, after: 2n, atMs: 10n, delayMs: 5n }, 9n),
    1n,
  );

  // The literal claim: the ledger held these totals before the claim.
  assert.deepEqual(
    previewProtocolFeeClaim({
      meme: 79_226_820_759_211_134n,
      quote: 346_058_232_040n,
      sui: 5_000_000_000n,
      partnerShareBps: 2_000n,
    }),
    {
      meme: 63_381_456_607_368_908n,
      quote: 276_846_585_632n,
      sui: 4_000_000_000n,
      partnerMeme: 15_845_364_151_842_226n,
      partnerQuote: 69_211_646_408n,
      partnerSui: 1_000_000_000n,
    },
  );
});
