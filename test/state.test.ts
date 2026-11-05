import assert from "node:assert/strict";
import test from "node:test";
import { previewProtocolFeesPaid } from "@interest-protocol/blast-core/protocol-fees";
import {
  LAUNCHPAD_ABORTS,
  launchpadAbortName,
} from "@interest-protocol/blast-launchpad-sdk/aborts";
import {
  decodeLaunchConfigObject,
  decodeLaunchObject,
  decodeLaunchTicketObject,
  decodeRuntimeConfigObject,
  launchId as deriveLaunchId,
  getLaunch,
  getLaunchByMeme,
  getOpeningRoundBid,
  launchVaultId,
  openingRoundEndMs,
} from "@interest-protocol/blast-launchpad-sdk/state";
import { getPartnerAcceptance } from "@interest-protocol/blast-partners-sdk/state";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { DERIVED_ID_FIXTURE } from "./fixtures/derived-ids.ts";
import type { LaunchpadFixture } from "./fixtures/launchpad-4fe8d73.ts";
import {
  FIXTURE_PACKAGE_ID,
  LAUNCHPAD_FIXTURE_HEX,
  launchpadFixture,
} from "./fixtures/launchpad-4fe8d73.ts";

const launchId = `0x${LAUNCHPAD_FIXTURE_HEX.launchId}`;
const registryId = `0x${LAUNCHPAD_FIXTURE_HEX.registryId}`;
const configId = `0x${LAUNCHPAD_FIXTURE_HEX.configId}`;
/** The Move test runner's address for `blast_core`. */
const FIXTURE_CORE_ID = "0x173a";
const venue = normalizeStructTag(`${FIXTURE_CORE_ID}::migration::TestVenue`);
const ticketId =
  "0xb6d2ab0253927f724cb33c7641ee60b89ee15056df84f442f1396b40139a44d6";
const partnerId = `0x${LAUNCHPAD_FIXTURE_HEX.partnerId}`;
const memeType = `${FIXTURE_PACKAGE_ID}::sdk_fixture_tests::SDK_FIXTURE_TESTS`;
const quoteType = `${FIXTURE_PACKAGE_ID}::sdk_fixture_tests::TEST_QUOTE`;
const launchType = `${FIXTURE_PACKAGE_ID}::launch::Launch<${memeType}, ${quoteType}>`;

function launch(fixture: LaunchpadFixture) {
  return decodeLaunchObject(
    {
      objectId: launchId,
      initialSharedVersion: "7",
      mutable: true,
      type: launchType,
      content: launchpadFixture(fixture),
    },
    FIXTURE_PACKAGE_ID,
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
  assert.equal(state.venue, venue);
  assert.deepEqual(state.lpFeeSplit, {
    routes: [
      { destination: { kind: "Owner" }, bps: 5_000n },
      { destination: { kind: "AutoLp" }, bps: 2_000n },
      { destination: { kind: "HolderRewards" }, bps: 1_000n },
      { destination: { kind: "Burn" }, bps: 1_000n },
      {
        destination: {
          kind: "Address",
          address: normalizeSuiAddress("0xf00d"),
        },
        bps: 1_000n,
      },
    ],
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
        recipient: {
          destination: normalizeSuiAddress("0xfeed"),
          vestingTerms: {
            cliffDelayMs: 1_000n,
            periodDurationMs: 2_000n,
            periods: 3n,
          },
        },
        memeBps: 250n,
        quoteBps: 250n,
      },
    ],
  });
  assert.equal(state.allocatedMeme, 300_000_000_000_000_000n);
  assert.deepEqual(state.protocolFees, {
    packageWitness: normalizeStructTag(
      `${FIXTURE_PACKAGE_ID}::blast_fun::PackageWitness`,
    ),
    origin: launchId,
    partnerId,
    meme: 0n,
    quote: 0n,
    sui: 5_000_000_000n,
  });
  assert.deepEqual([state.creatorMemeFees, state.creatorQuoteFees], [0n, 0n]);
  assert.equal(
    state.metadataCapId,
    "0x77520198ea52372717b1278701852c232e32d5cf6e202dde276ce97a265fbe6e",
  );
  assert.deepEqual(state.creatorRecipient, {
    kind: "address",
    address: normalizeSuiAddress("0xc0ffee"),
  });
  assert.equal(state.curveFeeCapDelayMs, 172_800_000n);
  assert.equal(state.creatorMetadataCapDelayMs, 172_800_000n);
  assert.equal(state.pendingCurveFeeCapReassignment, null);
  assert.equal(state.pendingCreatorMetadataCapReassignment, null);
  assert.equal(state.curveFeeCapId, null);
  assert.equal(state.creatorMetadataCapId, null);
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
    migrated.protocolFees.meme - ready.protocolFees.meme,
    75_000_000_000_000_000n,
  );
  assert.equal(
    migrated.protocolFees.quote - ready.protocolFees.quote,
    308_641_972_531n,
  );

  const claimed = launch("launchClaimed");
  assert.equal(claimed.creatorRecipient, null);
  assert.equal(
    claimed.curveFeeCapId,
    "0xd61ead5141eb403c577271ab6407f911211808138a3413a7de64734243b28f59",
  );
  assert.equal(
    claimed.creatorMetadataCapId,
    "0x2e7c7744e7aca1de732a399d6e43e81b6c151e30ccc86553742f1a57eeb32b08",
  );
  assert.deepEqual(
    [
      claimed.protocolFees.meme,
      claimed.protocolFees.quote,
      claimed.protocolFees.sui,
      claimed.creatorMemeFees,
      claimed.creatorQuoteFees,
    ],
    [0n, 0n, 0n, 0n, 0n],
  );
});

test("decodes a launch ticket from literal contract bytes", () => {
  const ticket = decodeLaunchTicketObject(
    {
      objectId: ticketId,
      type: `${FIXTURE_PACKAGE_ID}::launch_ticket::LaunchTicket<${memeType}>`,
      content: launchpadFixture("launchTicket"),
    },
    FIXTURE_PACKAGE_ID,
  );

  assert.deepEqual(ticket, {
    objectId: ticketId,
    memeType: normalizeStructTag(memeType),
    meme: 1_000_000_000_000_000_000n,
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
        FIXTURE_PACKAGE_ID,
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

  const state = await getLaunch(client, launchId, FIXTURE_PACKAGE_ID);

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
    await getOpeningRoundBid(client, launchId, "0xa11ce", FIXTURE_PACKAGE_ID),
    2_000_000_000n,
  );
  assert.equal(
    await getOpeningRoundBid(client, launchId, "0xb0b", FIXTURE_PACKAGE_ID),
    0n,
  );
  assert.deepEqual(requests[0], {
    parentId: launchId,
    name: {
      type: `${normalizeSuiAddress(FIXTURE_PACKAGE_ID)}::launch::OpeningRoundBidKey`,
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
  const config = decodeLaunchConfigObject(
    {
      objectId: configId,
      initialSharedVersion: "3",
      type: `${FIXTURE_PACKAGE_ID}::launch_config::LaunchConfig`,
      content: launchpadFixture("launchConfig"),
    },
    FIXTURE_PACKAGE_ID,
  );
  assert.deepEqual(config.memeDecimals, [6, 9, 8]);
  assert.deepEqual(config.quotes, [normalizeStructTag(quoteType)]);
  assert.equal(config.quoteFeeBps, 100n);
  assert.equal(config.memeFeeBps, 250n);
  assert.deepEqual(config.venues, [venue]);
  assert.equal(config.venueDelayMs, 0n);
  assert.equal(config.pendingVenueDelay, null);
  assert.deepEqual(config.pendingVenues, {});
  assert.deepEqual(config.protocolAllocation, {
    memeBps: 750n,
    quoteBps: 250n,
  });
  assert.deepEqual(config.protocolLpFees, {
    memeBps: 2_000n,
    quoteBps: 1_000n,
  });
  assert.equal(config.creationFee, 5_000_000_000n);
  // Every delayed value names the object storing it.
  assert.equal(config.tradeFeesPolicy.owner, config.objectId);
  assert.equal(config.tradeFeesPolicy.pending, null);
  assert.equal(config.creationFeePolicy.delay_ms, 0n);
  assert.deepEqual(config.partners, {
    owner: configId,
    acceptance_ends_at_ms: {
      id: "0xa058cccb1180e0c063232bed5fcf330614d57c74f056f8b3db0317812e129eb2",
      size: 1n,
    },
  });

  const runtime = decodeRuntimeConfigObject({
    objectId:
      "0x06d553b842f768751ef60436013fd9a563de7986dc8991a2b3a8edb7037fc8ed",
    initialSharedVersion: "4",
    type: `${FIXTURE_PACKAGE_ID}::runtime_config::RuntimeConfig`,
    content: launchpadFixture("runtimeConfig"),
  });
  assert.deepEqual(runtime.creatorClaimSigners, ["09".repeat(32)]);
  assert.equal(runtime.claimSignerDelayMs, 172_800_000n);
  assert.equal(runtime.pendingClaimSignerDelay, null);
  assert.deepEqual(runtime.pendingClaimSigners, {});
  assert.equal(runtime.protocolFeeShareBps, 3_000n);
  assert.equal(runtime.protocolFeeSharePolicy.owner, runtime.objectId);
});

test("reads a partner's acceptance from the config's PartnerList table", async () => {
  const requests: unknown[] = [];
  const client = {
    core: {
      getDynamicField: async (request: unknown) => {
        requests.push(request);
        if (requests.length === 2)
          throw new ObjectError("NOT_FOUND", "none", { reason: "notFound" });
        return {
          dynamicField: {
            value: { bcs: Uint8Array.from(Array(8).fill(0xff)) },
          },
        };
      },
    },
  } as unknown as ClientWithCoreApi;
  const tableId =
    "0xa058cccb1180e0c063232bed5fcf330614d57c74f056f8b3db0317812e129eb2";
  assert.equal(
    await getPartnerAcceptance(client, tableId, partnerId),
    (1n << 64n) - 1n,
  );
  assert.equal(await getPartnerAcceptance(client, tableId, "0xb0b"), null);
  assert.deepEqual(requests[0], {
    parentId: tableId,
    name: {
      type: "0x2::object::ID",
      bcs: Uint8Array.from(Buffer.from(partnerId.slice(2), "hex")),
    },
  });
});

test("derives the launch and its vault from the registries", async () => {
  const launchpad = {
    originalPackageId: FIXTURE_PACKAGE_ID,
    launchRegistry: { objectId: registryId, initialSharedVersion: 1 },
  };
  // The Move-printed launch ID of the fixture's Meme.
  assert.equal(deriveLaunchId(launchpad, memeType), launchId);
  const requested: string[] = [];
  const client = {
    core: {
      getObject: async ({ objectId }: { objectId: string }) => {
        requested.push(objectId);
        return {
          object: {
            objectId,
            owner: { $kind: "Shared", Shared: { initialSharedVersion: "7" } },
            type: launchType,
            content: launchpadFixture("launchSettled"),
          },
        };
      },
    },
  } as unknown as ClientWithCoreApi;
  const state = await getLaunchByMeme(client, launchpad, memeType);
  assert.deepEqual(requested, [launchId]);
  assert.equal(state.objectId, launchId);

  const fixture = DERIVED_ID_FIXTURE;
  assert.equal(
    launchVaultId(
      {
        originalPackageId: fixture.launchpadOriginalPackageId,
        vault: {
          originalPackageId: fixture.vaultOriginalPackageId,
          registry: {
            objectId: fixture.vaultRegistryId,
            initialSharedVersion: 1,
          },
        },
      },
      fixture.launchOriginId,
    ),
    fixture.launchVaultId,
  );
});

test("previews the literal partnered protocol fee claim with core's previewProtocolFeesPaid", () => {
  const migrated = launch("launchMigrated");
  assert.deepEqual(previewProtocolFeesPaid(migrated.protocolFees, 2_000n), {
    meme_amount: 63_381_456_607_368_908n,
    quote_amount: 276_846_585_632n,
    sui_amount: 4_000_000_000n,
    partner_id: partnerId,
    partner_meme_amount: 15_845_364_151_842_226n,
    partner_quote_amount: 69_211_646_408n,
    partner_sui_amount: 1_000_000_000n,
  });
});

test("names the launchpad's numeric abort codes", () => {
  assert.equal(LAUNCHPAD_ABORTS.length, 35);
  assert.equal(launchpadAbortName(0), "EInvalidTradeFeeBps");
  assert.equal(launchpadAbortName(32), "EUnguardedDelay");
  assert.equal(launchpadAbortName(34), "EInvalidLpFeeBps");
  assert.equal(launchpadAbortName(35), null);
  assert.equal(launchpadAbortName(-1), null);
});
