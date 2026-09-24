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
  curveMemeBps: 8_000n,
  lpMemeBps: 2_000n,
  lpQuoteBps: 10_000n,
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
  assert.equal(kinds.length, 20);

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

test("replays lifecycle, reserves, protection, and fees from ordered events", () => {
  const plan = {
    curveMemeBps: 7_500n,
    lpMemeBps: 2_000n,
    lpQuoteBps: 9_500n,
    recipients: [{ destination: "0xb", memeBps: 500n, quoteBps: 500n }],
  };
  const fees = (
    protocolMeme: bigint,
    creatorMeme: bigint,
    protocolQuote: bigint,
    creatorQuote: bigint,
  ) => ({
    protocol_meme_fee: protocolMeme,
    creator_meme_fee: creatorMeme,
    protocol_quote_fee: protocolQuote,
    creator_quote_fee: creatorQuote,
  });
  // Zero decimals: the atomic supply is one billion.
  const events = [
    decoded("LaunchTicketCreated", { ticket_id: "0xb", decimals: 0 }, 0),
    decoded(
      "LaunchCreated",
      {
        launch_id: "0xc",
        ticket_id: "0xb",
        pool_tick_spacing: 200,
        pool_fee_rate: 10_000n,
        lp_fee_split: sampleSplit,
        graduation_target: 200n,
        allocation_plan: plan,
        protection_window_ms: 60_000n,
        cumulative_sender_bps: 100n,
        per_transaction_bps: 0n,
      },
      1,
    ),
    decoded(
      "Bought",
      {
        launch_id: "0xc",
        meme_reserve: 740_000_000n,
        real_quote_reserve: 10n,
        ...fees(1n, 1n, 1n, 1n),
      },
      2,
    ),
    decoded("LaunchShared", { launch_id: "0xc", public_start_ms: 1_000n }, 3),
    decoded(
      "Bought",
      {
        launch_id: "0xc",
        meme_reserve: 700_000_000n,
        real_quote_reserve: 100n,
        ...fees(2n, 3n, 4n, 5n),
      },
      4,
    ),
    decoded(
      "Sold",
      {
        launch_id: "0xc",
        meme_reserve: 720_000_000n,
        real_quote_reserve: 80n,
        pending_burn: 12n,
        ...fees(4n, 4n, 4n, 4n),
      },
      5,
    ),
    decoded(
      "Bought",
      {
        launch_id: "0xc",
        meme_reserve: 600_000_000n,
        real_quote_reserve: 200n,
        ...fees(4n, 4n, 4n, 4n),
      },
      6,
    ),
    decoded(
      "CreatorFeesClaimed",
      { launch_id: "0xc", meme_amount: 11n, quote_amount: 13n },
      7,
    ),
    decoded(
      "MigrationAllocationPaid",
      {
        launch_id: "0xc",
        destination: "0xb",
        meme: 50_000_000n,
        quote: 10n,
      },
      8,
    ),
    decoded(
      "Migrated",
      {
        launch_id: "0xc",
        meme: 200n,
        quote: 190n,
        disposed_meme: 612n,
        total_supply_after: 388n,
      },
      9,
    ),
  ];

  const states = events.map((_, index) =>
    events
      .slice(0, index + 1)
      .reduce(reduceLaunchpadEvent, createLaunchpadEventProjection()),
  );
  const launchId = normalizeSuiObjectId("0xc");
  const created = states[1]?.launches[launchId];
  assert.equal(created?.atomicSupply, 1_000_000_000n);
  assert.deepEqual(created?.memeAmounts, {
    curve: 750_000_000n,
    lp: 200_000_000n,
    recipients: [50_000_000n],
  });
  assert.equal(created?.memeReserve, 750_000_000n);
  assert.equal(created?.allocatedMeme, 250_000_000n);
  assert.equal(created?.graduationTarget, 200n);
  assert.equal(created?.poolTickSpacing, 200);
  assert.deepEqual(created?.protection, {
    windowMs: 60_000n,
    cumulativeAtomicLimit: 10_000_000n,
    perTransactionAtomicLimit: 0n,
  });
  assert.equal(states[2]?.launches[launchId]?.publicStartMs, null);
  const shared = states[3]?.launches[launchId];
  assert.equal(shared?.publicStartMs, 1_000n);
  assert.equal(shared?.protectionEndMs, 61_000n);
  assert.equal(states[5]?.launches[launchId]?.pendingBurn, 12n);
  assert.equal(states[6]?.launches[launchId]?.lifecycle, "MigrationReady");
  const paid = states[8]?.launches[launchId];
  assert.equal(paid?.lifecycle, "Migrated");
  assert.equal(paid?.allocatedMeme, 200_000_000n);
  assert.equal(paid?.realQuoteReserve, 190n);
  assert.deepEqual(paid?.allocationPayments, [
    {
      destination: normalizeSuiObjectId("0xb"),
      meme: 50_000_000n,
      quote: 10n,
    },
  ]);

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
    meme: 200n,
    quote: 190n,
    disposedMeme: 612n,
    nativeSupplyBurned: false,
    totalSupplyAfter: 388n,
  });
});

test("replays pre-share purchases that reach the graduation target", () => {
  const projection = [
    decoded("LaunchTicketCreated", { ticket_id: "0xb" }, 0),
    decoded(
      "LaunchCreated",
      { launch_id: "0xc", ticket_id: "0xb", graduation_target: 50n },
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
  const configured = [
    decoded("QuoteSet", { quote: "0x2::sui::SUI", virtual_quote: 7n }, 0),
    decoded("MemeDecimalsSet", { decimals: 8, allowed: true }, 1),
    decoded("MemeDecimalsSet", { decimals: 6, allowed: false }, 2),
    decoded(
      "ProtocolAllocationSet",
      { destination: "0xb", meme_bps: 100n, quote_bps: 200n },
      3,
    ),
    decoded(
      "MigrationWitnessSet",
      { migration_witness: "0xf::cetus::CETUS", allowed: true },
      4,
    ),
  ].reduce(reduceLaunchpadEvent, createLaunchpadEventProjection());

  assert.deepEqual(configured.config.virtualQuotes, { [sui]: 7n });
  assert.deepEqual(configured.config.memeDecimals, { 8: true, 9: true });
  assert.deepEqual(configured.config.migrationWitnesses, { [witness]: true });
  assert.deepEqual(configured.config.protocolAllocation, {
    destination: normalizeSuiObjectId("0xb"),
    memeBps: 100n,
    quoteBps: 200n,
  });

  const removed = [
    decoded("QuoteSet", { quote: "0x2::sui::SUI", virtual_quote: 0n }, 5),
    decoded(
      "MigrationWitnessSet",
      { migration_witness: "0xf::cetus::CETUS", allowed: false },
      6,
    ),
  ].reduce(reduceLaunchpadEvent, configured);
  assert.deepEqual(removed.config.virtualQuotes, {});
  assert.deepEqual(removed.config.migrationWitnesses, {});
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
