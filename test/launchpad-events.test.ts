import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { BcsType } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiObjectId } from "@mysten/sui/utils";
import type {
  LaunchpadEventKind,
  LaunchpadEventPackageIdentity,
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

const packages: LaunchpadEventPackageIdentity = {
  originalPackageId: "0x122",
};
const samplePlan = {
  channels: [{ channelId: 1n, role: "Liquidity", destination: "0xa" }],
  meme: [
    { channelId: 0n, bps: 8_000n },
    { channelId: 1n, bps: 2_000n },
  ],
  quote: [{ channelId: 1n, bps: 10_000n }],
};
const sampleSplit = {
  creatorBps: 10_000n,
  autoLpBps: 0n,
  rewardsBps: 0n,
  recipients: [],
};

test("decodes and idempotently reduces every frozen launchpad event", () => {
  const frozenSpecs = readFrozenLaunchpadEventSpecs();
  assert.deepEqual(launchpadEventSpecs, frozenSpecs);
  const kinds = Object.keys(frozenSpecs) as LaunchpadEventKind[];
  assert.equal(kinds.length, 26);

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

test("replays lifecycle, reserves, protection, and fee deltas from ordered events", () => {
  const plan = {
    channels: [
      { channelId: 1n, role: "Liquidity", destination: "0xa" },
      { channelId: 2n, role: "Protocol", destination: "0xb" },
    ],
    meme: [
      { channelId: 0n, bps: 7_500n },
      { channelId: 1n, bps: 2_000n },
      { channelId: 2n, bps: 500n },
    ],
    quote: [
      { channelId: 1n, bps: 9_500n },
      { channelId: 2n, bps: 500n },
    ],
  };
  const events = [
    decoded(
      "LaunchTicketCreated",
      { ticket_id: "0xb", decimals: 6, atomic_supply: 1_000n },
      0,
    ),
    decoded(
      "LaunchCreated",
      {
        launch_id: "0xc",
        ticket_id: "0xb",
        decimals: 6,
        atomic_supply: 1_000n,
        pool_tick_spacing: 200,
        pool_fee_rate: 10_000n,
        lp_fee_split: sampleSplit,
        graduation_target: 200n,
        allocation_plan: plan,
        meme_amounts: [750n, 200n, 50n],
      },
      1,
    ),
    decoded(
      "ProtectionConfigured",
      {
        launch_id: "0xc",
        window_ms: 60_000n,
        cumulative_sender_bps: 100n,
        cumulative_atomic_limit: 10n,
        per_transaction_bps: 0n,
        per_transaction_atomic_limit: 0n,
      },
      2,
    ),
    decoded(
      "PreShareBought",
      {
        launch_id: "0xc",
        post_meme_reserve: 740n,
        post_real_quote_reserve: 10n,
        protocol_meme_fee_delta: 1n,
        creator_meme_fee_delta: 1n,
        protocol_quote_fee_delta: 1n,
        creator_quote_fee_delta: 1n,
      },
      3,
    ),
    decoded(
      "LaunchShared",
      {
        launch_id: "0xc",
        public_start_ms: 1_000n,
        pre_share_buy_completed: true,
      },
      4,
    ),
    decoded(
      "Bought",
      {
        launch_id: "0xc",
        meme_reserve: 700n,
        real_quote_reserve: 100n,
        protocol_meme_fee_delta: 2n,
        creator_meme_fee_delta: 3n,
        protocol_quote_fee_delta: 4n,
        creator_quote_fee_delta: 5n,
      },
      5,
    ),
    decoded(
      "Sold",
      {
        launch_id: "0xc",
        meme_reserve: 720n,
        real_quote_reserve: 80n,
        pending_burn_total: 12n,
        protocol_meme_fee_delta: 4n,
        creator_meme_fee_delta: 4n,
        protocol_quote_fee_delta: 4n,
        creator_quote_fee_delta: 4n,
      },
      6,
    ),
    decoded(
      "Bought",
      {
        launch_id: "0xc",
        meme_reserve: 600n,
        real_quote_reserve: 200n,
        protocol_meme_fee_delta: 4n,
        creator_meme_fee_delta: 4n,
        protocol_quote_fee_delta: 4n,
        creator_quote_fee_delta: 4n,
      },
      7,
    ),
    decoded(
      "CreatorFeesClaimed",
      { launch_id: "0xc", meme_amount: 11n, quote_amount: 13n },
      8,
    ),
    decoded(
      "MigrationAllocationPaid",
      {
        launch_id: "0xc",
        channel_id: 2n,
        destination: "0xb",
        meme: 50n,
        quote: 10n,
      },
      9,
    ),
    decoded(
      "Migrated",
      {
        launch_id: "0xc",
        supplied_meme: 199n,
        supplied_quote: 190n,
        residual_meme: 1n,
        residual_quote: 0n,
        liquidity: 5_000n,
        disposed_meme: 612n,
        total_supply_after: 388n,
      },
      10,
    ),
  ];

  const states = events.map((_, index) =>
    events
      .slice(0, index + 1)
      .reduce(reduceLaunchpadEvent, createLaunchpadEventProjection()),
  );
  const launchId = normalizeSuiObjectId("0xc");
  const created = states[1]?.launches[launchId];
  assert.equal(created?.memeReserve, 750n);
  assert.equal(created?.allocatedMeme, 250n);
  assert.equal(created?.graduationTarget, 200n);
  assert.equal(created?.poolTickSpacing, 200);
  const shared = states[4]?.launches[launchId];
  assert.equal(shared?.publicStartMs, 1_000n);
  assert.equal(shared?.protectionEndMs, 61_000n);
  assert.equal(shared?.preShareBuyCompleted, true);
  assert.equal(shared?.protection?.cumulativeAtomicLimit, 10n);
  assert.equal(states[7]?.launches[launchId]?.lifecycle, "MigrationReady");
  assert.equal(
    states[9]?.launches[launchId]?.allocationPayments[0]?.destination,
    normalizeSuiObjectId("0xb"),
  );

  const launch = states.at(-1)?.launches[launchId];
  assert.ok(launch);
  assert.equal(launch.lifecycle, "Migrated");
  assert.equal(launch.memeReserve, 0n);
  assert.equal(launch.realQuoteReserve, 0n);
  assert.equal(launch.pendingBurn, 0n);
  assert.equal(launch.allocatedMeme, 0n);
  assert.equal(launch.creatorMemeFees, 0n);
  assert.equal(launch.creatorQuoteFees, 0n);
  assert.equal(launch.protocolMemeFees, 11n);
  assert.equal(launch.protocolQuoteFees, 13n);
  assert.deepEqual(launch.migration, {
    suppliedMeme: 199n,
    suppliedQuote: 190n,
    residualMeme: 1n,
    residualQuote: 0n,
    liquidity: 5_000n,
    disposedMeme: 612n,
    nativeSupplyBurned: false,
    totalSupplyAfter: 388n,
  });
});

test("replays launch configuration policy", () => {
  const projection = [
    decoded("QuoteAllowed", { quote: "0x2::sui::SUI", virtual_quote: 7n }, 0),
    decoded("MemeDecimalsAllowed", { pos0: 8 }, 1),
    decoded("MemeDecimalsDisallowed", { pos0: 6 }, 2),
    decoded(
      "ProtocolAllocationConfigured",
      { channel_id: 9n, destination: "0xb", meme_bps: 100n, quote_bps: 200n },
      3,
    ),
  ].reduce(reduceLaunchpadEvent, createLaunchpadEventProjection());

  assert.deepEqual(projection.config.quotes, {
    [normalizedType("0x2::sui::SUI")]: { virtualQuote: 7n },
  });
  assert.deepEqual(projection.config.memeDecimals, { 8: true, 9: true });
  assert.deepEqual(projection.config.protocolAllocation, {
    channelId: 9n,
    destination: normalizeSuiObjectId("0xb"),
    memeBps: 100n,
    quoteBps: 200n,
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
    decoded("CreatorClaimSignerRevoked", {}, 32),
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
        revoked_curve_fee_cap_id: "0x20",
        curve_fee_cap_id: "0x30",
        recipient: "0xe",
      },
      3,
    ),
    decoded(
      "MetadataCapReassigned",
      {
        launch_id: "0xc",
        revoked_metadata_cap_id: null,
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
  if (type.vector === "u64") return "u64Vector";
  const datatype = type.Datatype;
  if (!isRecord(datatype))
    throw new TypeError("unsupported ABI datatype field");
  if (datatype.name === "ID") return "id";
  if (datatype.name === "TypeName") return "typeName";
  if (datatype.name === "String") return "string";
  if (datatype.name === "AllocationPlan") return "allocationPlan";
  if (datatype.name === "FeeSplit") return "feeSplit";
  if (datatype.name !== "Option" || !Array.isArray(datatype.type_arguments)) {
    throw new TypeError("unsupported ABI event datatype");
  }
  return optionDescriptor(datatype.type_arguments[0]);
}

function optionDescriptor(argument: unknown): string {
  if (!isRecord(argument)) throw new TypeError("invalid ABI Option argument");
  const inner = argument.argument;
  if (inner === "address") return "optionAddress";
  if (inner === "u64") return "optionU64";
  if (!isRecord(inner)) throw new TypeError("unsupported ABI Option field");
  if (inner.vector === "u8") return "optionBytes";
  if (isRecord(inner.Datatype) && inner.Datatype.name === "ID") {
    return "optionId";
  }
  throw new TypeError("unsupported ABI Option event field");
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
    case "u64Vector":
      return [1n];
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
    case "optionAddress":
    case "optionId":
    case "optionBytes":
    case "optionU64":
      return null;
    default:
      throw new TypeError(`unknown event field descriptor: ${descriptor}`);
  }
}

function orderedForReplay(kinds: LaunchpadEventKind[]): LaunchpadEventKind[] {
  const lifecycle: LaunchpadEventKind[] = [
    "LaunchTicketCreated",
    "LaunchCreated",
    "ProtectionConfigured",
    "PreShareBought",
    "LaunchShared",
    "Bought",
    "Sold",
    "CreatorFeesClaimed",
    "ProtocolFeesClaimed",
    "MigrationAllocationPaid",
    "Migrated",
  ];
  return [...lifecycle, ...kinds.filter((kind) => !lifecycle.includes(kind))];
}

function normalizedType(type: string): string {
  return type.replace(
    /^0x([0-9a-f]+)::/,
    (_match, address: string) => `0x${address.padStart(64, "0")}::`,
  );
}
