import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { BcsType } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import type {
  LaunchpadEventKind,
  LaunchpadEventPackageIdentity,
  LaunchpadEventPayloads,
} from "../src/launchpad/events.ts";
import {
  decodeLaunchpadEvent,
  launchpadEventBcs,
  launchpadEventSpecs,
} from "../src/launchpad/events.ts";
import {
  createLaunchpadEventProjection,
  reduceLaunchpadEvent,
} from "../src/launchpad/reducer.ts";
import { decodeLaunchObject } from "../src/launchpad/state.ts";
import type { LaunchpadFixture } from "./fixtures/launchpad-a2a1db2.ts";
import {
  LAUNCHPAD_FIXTURE_HEX,
  launchpadFixture,
} from "./fixtures/launchpad-a2a1db2.ts";

const packages: LaunchpadEventPackageIdentity = {
  originalPackageId: "0x122",
};
const samplePlan = {
  curveMemeBps: 8_000n,
  lpMemeBps: 2_000n,
  lpQuoteBps: 10_000n,
  protocolMemeBps: 0n,
  protocolQuoteBps: 0n,
  recipients: [],
};
const sampleSplit = {
  creatorBps: 10_000n,
  autoLpBps: 0n,
  rewardsBps: 0n,
  burnBps: 0n,
  recipients: [],
};

test("decodes and idempotently reduces every frozen launchpad event", () => {
  const frozenSpecs = readFrozenLaunchpadEventSpecs();
  assert.deepEqual(launchpadEventSpecs, frozenSpecs);
  const kinds = Object.keys(frozenSpecs) as LaunchpadEventKind[];
  assert.equal(kinds.length, 27);

  let projection = createLaunchpadEventProjection();
  for (const [eventIndex, kind] of orderedForReplay(kinds).entries()) {
    const event = decodeLaunchpadEvent(
      suiEvent(kind, {}, eventIndex),
      packages,
    );
    assert.equal(event.kind, kind);
    assert.equal(event.position.checkpoint, 9n);
    assert.equal(event.position.eventIndex, eventIndex);

    const next = reduceLaunchpadEvent(projection, event);
    assert.equal(next.eventCounts[kind], 1);
    assert.equal(reduceLaunchpadEvent(next, event), next);
    projection = next;
  }
});

test("decodes every literal a2a1db2 launchpad event", () => {
  const launchId =
    "0x489d325645528066bd5fc2fd6e54cedebd2d7e98aa6095740a6b892e1b1c09f7";
  const partnerId = `0x${LAUNCHPAD_FIXTURE_HEX.partnerId}`;
  const payload = <Kind extends LaunchpadEventKind>(
    kind: Kind,
    fixture: LaunchpadFixture,
  ) =>
    decodeLaunchpadEvent(
      fixtureEvent(kind, fixture, "0xad", 0),
      fixturePackages,
    ).payload as LaunchpadEventPayloads[Kind];

  assert.deepEqual(payload("QuoteSet", "quoteSet"), {
    quote: normalizedType("0x0::sdk_fixture_tests::TEST_QUOTE"),
    allowed: true,
  });
  assert.deepEqual(payload("ProtocolAllocationSet", "protocolAllocationSet"), {
    meme_bps: 750n,
    quote_bps: 250n,
  });
  assert.deepEqual(payload("CreationFeeChanged", "creationFeeChanged"), {
    pos0: 5_000_000_000n,
  });
  assert.deepEqual(payload("PartnerAdded", "partnerAdded"), {
    partner_id: partnerId,
  });
  assert.deepEqual(payload("PartnerRemoved", "partnerRemoved"), {
    partner_id: partnerId,
    accepted_until_ms: 604_861_000n,
  });
  const created = payload("LaunchCreated", "launchCreated");
  assert.equal(created.launch_id, launchId);
  assert.equal(created.virtual_quote, 3_000_000_000_000n);
  assert.equal(created.graduation_target, 12_345_678_901_237n);
  assert.equal(created.opening_round_ms, 60_000n);
  assert.equal(created.creation_fee, 5_000_000_000n);
  assert.equal(created.partner_id, partnerId);
  assert.equal(created.allocation_plan.protocolMemeBps, 750n);
  assert.deepEqual(payload("OpeningRoundJoined", "openingRoundJoinedAlice"), {
    launch_id: launchId,
    quote: 2_000_000_000n,
    bids: 3_000_000_000n,
  });
  assert.deepEqual(payload("OpeningRoundSettled", "openingRoundSettled"), {
    launch_id: launchId,
    bids: 3_000_000_000n,
    meme: 675_006_743_324_108n,
    quote: 0n,
  });
  assert.deepEqual(payload("OpeningRoundDelivered", "openingRoundDelivered"), {
    launch_id: launchId,
    bidder: normalizeSuiAddress("0xa11ce"),
    bid: 2_000_000_000n,
    meme: 450_004_495_549_405n,
    quote: 0n,
  });
  assert.deepEqual(payload("ProtocolFeesAccrued", "protocolFeesAccrued"), {
    launch_id: launchId,
    meme_amount: 75_000_000_000_000_000n,
    quote_amount: 308_641_972_531n,
  });
  assert.deepEqual(payload("Migrated", "migrated"), {
    launch_id: launchId,
    meme: 200_000_000_000_000_000n,
    quote: 11_728_394_956_175n,
    disposed_meme: 136_868_278_211_204_051n,
    total_supply_after: 1_000_000_000_000_000_000n,
  });
  assert.deepEqual(payload("ProtocolFeesClaimed", "protocolFeesClaimed"), {
    launch_id: launchId,
    meme_amount: 63_381_456_607_368_908n,
    quote_amount: 276_846_585_632n,
    sui_amount: 4_000_000_000n,
    partner_meme_amount: 15_845_364_151_842_226n,
    partner_quote_amount: 69_211_646_408n,
    partner_sui_amount: 1_000_000_000n,
  });
});

test("replays the literal a2a1db2 launch to its object state", () => {
  const launcher = "0xb1a57";
  const steps: Array<[LaunchpadEventKind, LaunchpadFixture, string]> = [
    ["LaunchTicketCreated", "launchTicketCreated", launcher],
    ["LaunchCreated", "launchCreated", launcher],
    ["OpeningRoundJoined", "openingRoundJoinedCreator", launcher],
    ["LaunchShared", "launchShared", launcher],
    ["OpeningRoundJoined", "openingRoundJoinedAlice", "0xa11ce"],
    ["Bought", "boughtSettlement", "0xb0b"],
    ["OpeningRoundSettled", "openingRoundSettled", "0xb0b"],
    ["OpeningRoundDelivered", "openingRoundDelivered", "0xb0b"],
    ["Sold", "sold", "0xa11ce"],
    ["Bought", "boughtGraduation", "0xb0b"],
    ["MigrationAllocationPaid", "migrationAllocationPaid", "0xb0b"],
    ["ProtocolFeesAccrued", "protocolFeesAccrued", "0xb0b"],
    ["Migrated", "migrated", "0xb0b"],
    ["CreatorCapsClaimed", "creatorCapsClaimed", "0xc0ffee"],
    ["CreatorFeesClaimed", "creatorFeesClaimed", "0xc0ffee"],
    ["ProtocolFeesClaimed", "protocolFeesClaimed", "0xc0ffee"],
  ];
  const states = [createLaunchpadEventProjection()];
  for (const [index, [kind, fixture, sender]] of steps.entries()) {
    const event = decodeLaunchpadEvent(
      fixtureEvent(kind, fixture, sender, index),
      fixturePackages,
    );
    states.push(reduceLaunchpadEvent(states.at(-1)!, event));
  }
  const launchId =
    "0x489d325645528066bd5fc2fd6e54cedebd2d7e98aa6095740a6b892e1b1c09f7";
  const at = (step: number) => states[step]!.launches[launchId]!;
  const object = (fixture: LaunchpadFixture) =>
    decodeLaunchObject(
      {
        objectId: launchId,
        initialSharedVersion: "1",
        mutable: true,
        type: "0x0::launch::Launch<0x0::sdk_fixture_tests::SDK_FIXTURE_TESTS, 0x0::sdk_fixture_tests::TEST_QUOTE>",
        content: launchpadFixture(fixture),
      },
      "0x0",
    );
  const comparable = (
    state: Pick<
      ReturnType<typeof object>,
      | "lifecycle"
      | "memeReserve"
      | "realQuoteReserve"
      | "pendingBurn"
      | "allocatedMeme"
      | "openingRoundBids"
      | "openingRoundQuote"
      | "openingRoundMeme"
      | "protocolMemeFees"
      | "creatorMemeFees"
      | "protocolQuoteFees"
      | "creatorQuoteFees"
      | "protocolSuiFees"
      | "publicStartMs"
      | "partnerId"
      | "curveFeeCapId"
      | "blastMetadataCapId"
    >,
  ) => ({
    lifecycle: state.lifecycle,
    memeReserve: state.memeReserve,
    realQuoteReserve: state.realQuoteReserve,
    pendingBurn: state.pendingBurn,
    allocatedMeme: state.allocatedMeme,
    openingRoundBids: state.openingRoundBids,
    openingRoundQuote: state.openingRoundQuote,
    openingRoundMeme: state.openingRoundMeme,
    protocolMemeFees: state.protocolMemeFees,
    creatorMemeFees: state.creatorMemeFees,
    protocolQuoteFees: state.protocolQuoteFees,
    creatorQuoteFees: state.creatorQuoteFees,
    protocolSuiFees: state.protocolSuiFees,
    publicStartMs: state.publicStartMs,
    partnerId: state.partnerId,
    curveFeeCapId: state.curveFeeCapId,
    blastMetadataCapId: state.blastMetadataCapId,
  });

  assert.deepEqual(comparable(at(2)), comparable(object("launchFinalized")));
  assert.deepEqual(comparable(at(5)), comparable(object("launchOpeningRound")));
  assert.deepEqual(comparable(at(7)), comparable(object("launchSettled")));
  assert.deepEqual(
    comparable(at(10)),
    comparable(object("launchMigrationReady")),
  );
  assert.deepEqual(comparable(at(13)), comparable(object("launchMigrated")));
  assert.deepEqual(comparable(at(16)), comparable(object("launchClaimed")));
  assert.deepEqual(at(5).openingRoundBidders, {
    [normalizeSuiAddress("0xb1a57")]: 1_000_000_000n,
    [normalizeSuiAddress("0xa11ce")]: 2_000_000_000n,
  });
  assert.deepEqual(at(8).openingRoundBidders, {
    [normalizeSuiAddress("0xb1a57")]: 1_000_000_000n,
  });
  assert.equal(at(8).openingRoundEndMs, 61_000n);
  assert.deepEqual(at(16).partnerPaid, {
    meme: 15_845_364_151_842_226n,
    quote: 69_211_646_408n,
    sui: 1_000_000_000n,
  });
  assert.deepEqual(at(13).migration, {
    meme: 200_000_000_000_000_000n,
    quote: 11_728_394_956_175n,
    disposedMeme: 136_868_278_211_204_051n,
    totalSupplyAfter: 1_000_000_000_000_000_000n,
  });
});

test("replays pre-share purchases that reach the graduation target", () => {
  const projection = [
    decoded("LaunchTicketCreated", { ticket_id: "0xb" }, 0),
    decoded(
      "LaunchCreated",
      {
        launch_id: "0xc",
        ticket_id: "0xb",
        graduation_target: 50n,
        opening_round_ms: 0n,
      },
      1,
    ),
    decoded("Bought", { launch_id: "0xc", real_quote_reserve: 50n }, 2),
  ].reduce(reduceLaunchpadEvent, createLaunchpadEventProjection());
  const launch = projection.launches[normalizeSuiObjectId("0xc")];

  assert.equal(launch?.lifecycle, "MigrationReady");
  assert.equal(launch?.publicStartMs, null);
});

test("replays launch configuration policy", () => {
  const sui = normalizedType("0x2::sui::SUI");
  const witness = normalizedType("0xf::cetus::CETUS");
  const partner = normalizeSuiObjectId("0x77");
  const configured = [
    decoded("QuoteSet", { quote: "0x2::sui::SUI", allowed: true }, 0),
    decoded("MemeDecimalsSet", { decimals: 8, allowed: true }, 1),
    decoded("MemeDecimalsSet", { decimals: 6, allowed: false }, 2),
    decoded("ProtocolAllocationSet", { meme_bps: 100n, quote_bps: 200n }, 3),
    decoded(
      "MigrationWitnessSet",
      { migration_witness: "0xf::cetus::CETUS", allowed: true },
      4,
    ),
    decoded("CreationFeeChanged", { pos0: 5_000_000_000n }, 5),
    decoded("PartnerAdded", { partner_id: "0x77" }, 6),
  ].reduce(reduceLaunchpadEvent, createLaunchpadEventProjection());

  assert.deepEqual(configured.config.quotes, { [sui]: true });
  assert.deepEqual(configured.config.memeDecimals, { 8: true, 9: true });
  assert.deepEqual(configured.config.migrationWitnesses, { [witness]: true });
  assert.deepEqual(configured.config.protocolAllocation, {
    memeBps: 100n,
    quoteBps: 200n,
  });
  assert.equal(configured.config.creationFee, 5_000_000_000n);
  assert.deepEqual(configured.config.partners, {
    [partner]: { acceptedUntilMs: null },
  });

  const removed = [
    decoded("QuoteSet", { quote: "0x2::sui::SUI", allowed: false }, 7),
    decoded(
      "MigrationWitnessSet",
      { migration_witness: "0xf::cetus::CETUS", allowed: false },
      8,
    ),
    decoded(
      "PartnerRemoved",
      { partner_id: "0x77", accepted_until_ms: 9_000n },
      9,
    ),
  ].reduce(reduceLaunchpadEvent, configured);
  assert.deepEqual(removed.config.quotes, {});
  assert.deepEqual(removed.config.migrationWitnesses, {});
  assert.deepEqual(removed.config.partners, {
    [partner]: { acceptedUntilMs: 9_000n },
  });
});

test("replays creator claims and signer changes", () => {
  const beforeRevocation = [
    decoded(
      "CreatorCapsClaimed",
      {
        meme: "0xa::meme::MEME",
        curve_fee_cap_id: "0x20",
        metadata_cap_id: "0x21",
      },
      30,
    ),
    decoded(
      "CreatorClaimSignerSet",
      {
        pos0: new Uint8Array([9]),
      },
      31,
    ),
  ].reduce(reduceLaunchpadEvent, createLaunchpadEventProjection());

  assert.deepEqual(
    beforeRevocation.administration.creatorClaimSignerPublicKey,
    new Uint8Array([9]),
  );
  const projection = reduceLaunchpadEvent(
    beforeRevocation,
    decoded("CreatorClaimSignerSet", { pos0: new Uint8Array() }, 32),
  );
  assert.deepEqual(
    projection.administration.creatorCapClaims[
      normalizedType("0xa::meme::MEME")
    ],
    {
      memeType: normalizedType("0xa::meme::MEME"),
      claimant: normalizeSuiObjectId("0xd"),
      curveFeeCapId: normalizeSuiObjectId("0x20"),
      metadataCapId: normalizeSuiObjectId("0x21"),
    },
  );
  assert.equal(projection.administration.creatorClaimSignerPublicKey, null);
});

test("replays creator capability claims, reassignments, and metadata", () => {
  const created = [
    decoded("LaunchTicketCreated", { ticket_id: "0xb" }, 0),
    decoded("LaunchCreated", { launch_id: "0xc", ticket_id: "0xb" }, 1),
  ].reduce(reduceLaunchpadEvent, createLaunchpadEventProjection());
  const launchId = normalizeSuiObjectId("0xc");
  assert.equal(created.launches[launchId]?.curveFeeCapId, null);
  assert.equal(created.launches[launchId]?.blastMetadataCapId, null);
  assert.equal(created.launches[launchId]?.memeMetadata, null);

  const claimed = reduceLaunchpadEvent(
    created,
    decoded(
      "CreatorCapsClaimed",
      {
        meme: "0xa::meme::MEME",
        curve_fee_cap_id: "0x20",
        metadata_cap_id: "0x21",
      },
      2,
    ),
  );
  assert.equal(
    claimed.launches[launchId]?.curveFeeCapId,
    normalizeSuiObjectId("0x20"),
  );
  assert.equal(
    claimed.launches[launchId]?.blastMetadataCapId,
    normalizeSuiObjectId("0x21"),
  );

  const projection = [
    decoded(
      "CurveFeeCapReassigned",
      {
        launch_id: "0xc",
        curve_fee_cap_id: "0x30",
        recipient: "0xe",
      },
      3,
    ),
    decoded(
      "MetadataCapReassigned",
      {
        launch_id: "0xc",
        metadata_cap_id: "0x31",
        recipient: "0xe",
      },
      4,
    ),
    decoded(
      "MemeMetadataUpdated",
      {
        launch_id: "0xc",
        name: "Dog Coin",
        description: "Good dog",
        icon_url: "https://example.com/dog.png",
      },
      5,
    ),
  ].reduce(reduceLaunchpadEvent, claimed);
  const launch = projection.launches[launchId];

  assert.equal(launch?.curveFeeCapId, normalizeSuiObjectId("0x30"));
  assert.equal(launch?.blastMetadataCapId, normalizeSuiObjectId("0x31"));
  assert.deepEqual(launch?.memeMetadata, {
    name: "Dog Coin",
    description: "Good dog",
    iconUrl: "https://example.com/dog.png",
  });
});

test("authenticates events by type, not by the transaction's called package", () => {
  const valid = suiEvent("Migrated", {}, 0);
  assert.throws(
    () => decodeLaunchpadEvent({ ...valid, checkpoint: null }, packages),
    /checkpoint metadata/,
  );
  // Adapters in the migrators package emit `Migrated` from their own entry.
  assert.equal(
    decodeLaunchpadEvent(
      { ...valid, packageId: "0x999", module: "cetus" },
      packages,
    ).kind,
    "Migrated",
  );
  assert.throws(
    () =>
      decodeLaunchpadEvent(
        {
          ...valid,
          eventType: "0x999::blast_events::Event<0x999::events::LaunchCreated>",
        },
        packages,
      ),
    /unexpected event package/,
  );
});

test("uses transaction digest and event index as the stable replay identity", () => {
  const first = decodeLaunchpadEvent(
    suiEvent("LaunchCreated", {}, 0),
    packages,
  );
  const correctedCheckpoint = decodeLaunchpadEvent(
    { ...suiEvent("LaunchCreated", {}, 0), checkpoint: "10" },
    packages,
  );
  const projection = reduceLaunchpadEvent(
    reduceLaunchpadEvent(
      createLaunchpadEventProjection(),
      decoded("LaunchTicketCreated", {}, 1),
    ),
    first,
  );

  assert.equal(
    reduceLaunchpadEvent(projection, correctedCheckpoint),
    projection,
  );
});

function decoded(
  kind: LaunchpadEventKind,
  overrides: Record<string, unknown>,
  eventIndex: number,
) {
  return decodeLaunchpadEvent(suiEvent(kind, overrides, eventIndex), packages);
}

function readFrozenLaunchpadEventSpecs(): Record<
  string,
  Record<string, string>
> {
  const artifact = JSON.parse(
    readFileSync(
      new URL("../abi/production-launchpad-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    packages: {
      launchpad: {
        modules: {
          events: {
            events: Array<{
              name: string;
              fields: Array<{ name: string; type: unknown }>;
            }>;
          };
        };
      };
    };
  };
  return Object.fromEntries(
    artifact.packages.launchpad.modules.events.events.map((event) => [
      event.name,
      Object.fromEntries(
        event.fields.map((field) => [field.name, abiDescriptor(field.type)]),
      ),
    ]),
  );
}

function abiDescriptor(type: unknown): string {
  if (
    type === "u64" ||
    type === "u128" ||
    type === "u32" ||
    type === "u8" ||
    type === "bool" ||
    type === "address"
  ) {
    return type;
  }
  if (!isRecord(type)) throw new TypeError("unsupported ABI event field");
  if (type.vector === "u8") return "bytes";
  const datatype = type.Datatype;
  if (!isRecord(datatype))
    throw new TypeError("unsupported ABI datatype field");
  if (datatype.name === "ID") return "id";
  if (datatype.name === "Option") {
    const [argument] = datatype.type_arguments as Array<{
      argument: { Datatype?: { name?: string } };
    }>;
    if (argument?.argument.Datatype?.name === "ID") return "optionId";
  }
  if (datatype.name === "TypeName") return "typeName";
  if (datatype.name === "String") return "string";
  if (datatype.name === "AllocationPlan") return "allocationPlan";
  if (datatype.name === "FeeSplit") return "feeSplit";
  if (datatype.name === "CreatorRecipient") return "creatorRecipient";
  throw new TypeError("unsupported ABI event datatype");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function suiEvent(
  kind: LaunchpadEventKind,
  overrides: Record<string, unknown>,
  eventIndex: number,
): SuiClientTypes.EventEntry {
  const original = normalizeSuiObjectId(packages.originalPackageId);
  return {
    packageId: "0x123",
    module: "launch",
    sender: "0xd",
    eventType: `${original}::blast_events::Event<${original}::events::${kind}>`,
    bcs: encodePayload(kind, overrides),
    json: null,
    checkpoint: "9",
    transactionDigest: `transaction-${eventIndex}`,
    eventIndex,
  };
}

function encodePayload(
  kind: LaunchpadEventKind,
  overrides: Record<string, unknown>,
): Uint8Array {
  const spec = launchpadEventSpecs[kind];
  const payload = Object.fromEntries(
    Object.entries(spec).map(([field, descriptor]) => [
      field,
      Object.hasOwn(overrides, field)
        ? overrides[field]
        : sampleValue(descriptor),
    ]),
  );
  const schema = launchpadEventBcs[kind] as unknown as BcsType<
    unknown,
    Record<string, unknown>
  >;
  return schema.serialize(payload).toBytes();
}

function sampleValue(descriptor: string): unknown {
  switch (descriptor) {
    case "id":
      return "0xc";
    case "optionId":
      return null;
    case "typeName":
      return "0xa::meme::MEME";
    case "address":
      return "0xd";
    case "u64":
      return 1n;
    case "u8":
    case "u32":
      return 1;
    case "u128":
      return 1n;
    case "creatorRecipient":
      return { kind: "address", address: "0xe" };
    case "allocationPlan":
      return samplePlan;
    case "feeSplit":
      return sampleSplit;
    case "bool":
      return false;
    case "bytes":
      return new Uint8Array([1]);
    case "string":
      return "meme";
    default:
      throw new TypeError(`unknown event field descriptor: ${descriptor}`);
  }
}

function orderedForReplay(kinds: LaunchpadEventKind[]): LaunchpadEventKind[] {
  const lifecycle: LaunchpadEventKind[] = [
    "LaunchTicketCreated",
    "LaunchCreated",
    "OpeningRoundJoined",
    "LaunchShared",
    "Bought",
    "OpeningRoundSettled",
    "OpeningRoundDelivered",
    "Sold",
    "CreatorFeesClaimed",
    "ProtocolFeesClaimed",
    "MigrationAllocationPaid",
    "ProtocolFeesAccrued",
    "Migrated",
  ];
  return [...lifecycle, ...kinds.filter((kind) => !lifecycle.includes(kind))];
}

const fixturePackages: LaunchpadEventPackageIdentity = {
  originalPackageId: "0x0",
};

function fixtureEvent(
  kind: LaunchpadEventKind,
  fixture: LaunchpadFixture,
  sender: string,
  eventIndex: number,
): SuiClientTypes.EventEntry {
  const original = normalizeSuiObjectId("0x0");
  return {
    packageId: original,
    module: "launch",
    sender,
    eventType: `${original}::blast_events::Event<${original}::events::${kind}>`,
    bcs: launchpadFixture(fixture),
    json: null,
    checkpoint: "1",
    transactionDigest: `fixture-${eventIndex}`,
    eventIndex: 0,
  };
}

function normalizedType(type: string): string {
  return type.replace(
    /^0x([0-9a-f]+)::/,
    (_match, address: string) => `0x${address.padStart(64, "0")}::`,
  );
}
