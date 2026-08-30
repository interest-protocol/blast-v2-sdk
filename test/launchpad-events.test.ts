import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { BcsType } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiObjectId } from "@mysten/sui/utils";

import {
  decodeLaunchpadEvent,
  launchpadEventBcs,
  launchpadEventSpecs,
} from "../src/launchpad/events.ts";
import type {
  LaunchpadEventKind,
  LaunchpadEventPackageIdentity,
} from "../src/launchpad/events.ts";
import {
  createLaunchpadEventProjection,
  reduceLaunchpadEvent,
} from "../src/launchpad/reducer.ts";

const packages: LaunchpadEventPackageIdentity = {
  packageId: "0x123",
  originalPackageId: "0x122",
};

test("decodes and idempotently reduces every frozen launchpad event", () => {
  const frozenSpecs = readFrozenLaunchpadEventSpecs();
  assert.deepEqual(launchpadEventSpecs, frozenSpecs);
  const kinds = Object.keys(frozenSpecs) as LaunchpadEventKind[];
  assert.equal(kinds.length, 30);

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

test("replays lifecycle, reserves, and launch fee totals from ordered events", () => {
  const events = [
    decoded("LaunchCreated", {
      launch_id: "0xc",
      meme_reserve: 800n,
      real_quote_reserve: 0n,
      pending_burn: 10n,
      protocol_meme_graduation_fee: 20n,
      meme_liquidity_provision: 200n,
      protocol_meme_trade_fees: 0n,
      creator_meme_trade_fees: 0n,
      protocol_quote_trade_fees: 0n,
      creator_quote_trade_fees: 0n,
    }, 0),
    decoded("Bought", {
      launch_id: "0xc",
      meme_reserve: 700n,
      real_quote_reserve: 100n,
      pending_burn_total: undefined,
      protocol_meme_fee_total: 2n,
      creator_meme_fee_total: 3n,
      protocol_quote_fee_total: 4n,
      creator_quote_fee_total: 5n,
      crossed_threshold: false,
    }, 1),
    decoded("Sold", {
      launch_id: "0xc",
      meme_reserve: 720n,
      real_quote_reserve: 80n,
      pending_burn_total: 12n,
      protocol_meme_fee_total: 6n,
      creator_meme_fee_total: 7n,
      protocol_quote_fee_total: 8n,
      creator_quote_fee_total: 9n,
    }, 2),
    decoded("Bought", {
      launch_id: "0xc",
      meme_reserve: 600n,
      real_quote_reserve: 200n,
      protocol_meme_fee_total: 10n,
      creator_meme_fee_total: 11n,
      protocol_quote_fee_total: 12n,
      creator_quote_fee_total: 13n,
      crossed_threshold: true,
    }, 3),
    decoded("CreatorFeesClaimed", {
      launch_id: "0xc",
      meme_amount: 11n,
      quote_amount: 13n,
    }, 4),
    decoded("Migrated", {
      launch_id: "0xc",
      migration_meme: 200n,
      migration_quote: 190n,
      disposed_meme: 612n,
      protocol_meme_fee_total: 30n,
      protocol_quote_fee_total: 31n,
    }, 5),
  ];

  const projection = events.reduce(
    reduceLaunchpadEvent,
    createLaunchpadEventProjection(),
  );
  const launch = projection.launches[normalizeSuiObjectId("0xc")];

  assert.ok(launch);
  assert.equal(launch.lifecycle, "Migrated");
  assert.equal(launch.memeReserve, 0n);
  assert.equal(launch.realQuoteReserve, 0n);
  assert.equal(launch.pendingBurn, 0n);
  assert.equal(launch.creatorMemeFees, 0n);
  assert.equal(launch.creatorQuoteFees, 0n);
  assert.equal(launch.protocolMemeFees, 30n);
  assert.equal(launch.protocolQuoteFees, 31n);
  assert.deepEqual(launch.migration, {
    memeAmount: 200n,
    quoteAmount: 190n,
    disposedMeme: 612n,
    nativeSupplyBurned: false,
    totalSupplyAfter: 1n,
  });
});

test("requires native event position and current/original package identities", () => {
  const valid = suiEvent("LaunchCreated", {}, 0);
  assert.throws(
    () => decodeLaunchpadEvent({ ...valid, checkpoint: null }, packages),
    /checkpoint metadata/,
  );
  assert.throws(
    () =>
      decodeLaunchpadEvent(
        { ...valid, packageId: "0x999" },
        packages,
      ),
    /unexpected emitter package/,
  );
  assert.throws(
    () =>
      decodeLaunchpadEvent(
        {
          ...valid,
          eventType:
            "0x999::events_wrapper::Event<0x999::events::LaunchCreated>",
        },
        packages,
      ),
    /unexpected event package/,
  );
});

function decoded(
  kind: LaunchpadEventKind,
  overrides: Record<string, unknown>,
  eventIndex: number,
) {
  return decodeLaunchpadEvent(
    suiEvent(kind, overrides, eventIndex),
    packages,
  );
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
  if (type === "u64" || type === "u8" || type === "bool" || type === "address") {
    return type;
  }
  if (!isRecord(type)) throw new TypeError("unsupported ABI event field");
  if (type.vector === "u8") return "bytes";
  const datatype = type.Datatype;
  if (!isRecord(datatype)) throw new TypeError("unsupported ABI datatype field");
  if (datatype.name === "ID") return "id";
  if (datatype.name === "TypeName") return "typeName";
  if (datatype.name !== "Option" || !Array.isArray(datatype.type_arguments)) {
    throw new TypeError("unsupported ABI event datatype");
  }
  const argument = datatype.type_arguments[0];
  if (!isRecord(argument)) throw new TypeError("invalid ABI Option argument");
  const inner = argument.argument;
  if (inner === "address") return "optionAddress";
  if (inner === "u64") return "optionU64";
  if (isRecord(inner) && inner.vector === "u8") return "optionBytes";
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
    packageId: packages.packageId,
    module: "events_wrapper",
    sender: "0xd",
    eventType: `${original}::events_wrapper::Event<${original}::events::${kind}>`,
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
      return 1;
    case "bool":
      return false;
    case "bytes":
      return new Uint8Array([1]);
    case "optionAddress":
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
    "Bought",
    "Sold",
    "CreatorFeesClaimed",
    "ProtocolFeesClaimed",
    "Migrated",
  ];
  return [
    ...lifecycle,
    ...kinds.filter((kind) => !lifecycle.includes(kind)),
  ];
}
