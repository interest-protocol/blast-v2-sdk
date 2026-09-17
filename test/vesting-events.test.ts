import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";
import type {
  VestingEventModule,
  VestingEventPackageIdentity,
} from "../src/vesting/events.ts";
import {
  decodeVestingEvent,
  vestingEventBcs,
  vestingEventId,
  vestingEventSpecs,
} from "../src/vesting/events.ts";
import { vestingModule } from "../src/vesting/modules.ts";

const packages: VestingEventPackageIdentity = {
  packageId: "0x123",
  originalPackageId: "0x122",
};

const modules = ["checkpoints", "linear"] as const;
const eventNames = [
  "VestingCanceled",
  "VestingClaimed",
  "VestingClosed",
  "VestingCreated",
] as const;

const commonPayloads = {
  VestingCanceled: {
    vesting_id: "0x1",
    coin_type: "0x2::sui::SUI",
    caller: "0x3",
    beneficiary: "0x4",
    refund_recipient: "0x5",
    beneficiary_amount: 6n,
    refund_amount: 7n,
    released_total: 8n,
  },
  VestingClaimed: {
    vesting_id: "0x1",
    coin_type: "0x2::sui::SUI",
    caller: "0x3",
    beneficiary: "0x4",
    amount: 5n,
    released_total: 6n,
    remaining_balance: 7n,
  },
  VestingClosed: {
    vesting_id: "0x1",
    coin_type: "0x2::sui::SUI",
    caller: "0x3",
    released_total: 4n,
  },
} as const;

const fixtures = [
  {
    module: "checkpoints",
    name: "VestingCanceled",
    payload: commonPayloads.VestingCanceled,
  },
  {
    module: "checkpoints",
    name: "VestingClaimed",
    payload: commonPayloads.VestingClaimed,
  },
  {
    module: "checkpoints",
    name: "VestingClosed",
    payload: commonPayloads.VestingClosed,
  },
  {
    module: "checkpoints",
    name: "VestingCreated",
    payload: {
      vesting_id: "0x1",
      coin_type: "0x2::sui::SUI",
      funder: "0x3",
      beneficiary: "0x4",
      refund_recipient: "0x5",
      cancel_cap_id: "0x6",
      total_amount: 7n,
      checkpoint_count: 8n,
    },
  },
  {
    module: "linear",
    name: "VestingCanceled",
    payload: commonPayloads.VestingCanceled,
  },
  {
    module: "linear",
    name: "VestingClaimed",
    payload: commonPayloads.VestingClaimed,
  },
  {
    module: "linear",
    name: "VestingClosed",
    payload: commonPayloads.VestingClosed,
  },
  {
    module: "linear",
    name: "VestingCreated",
    payload: {
      vesting_id: "0x1",
      coin_type: "0x2::sui::SUI",
      funder: "0x3",
      beneficiary: "0x4",
      refund_recipient: null,
      cancel_cap_id: null,
      total_amount: 7n,
      start_ms: 8n,
      cliff_ms: 9n,
      period_ms: 10n,
      periods: 11n,
    },
  },
] as const;

test("matches the complete ordered frozen vesting event inventory", () => {
  assert.deepEqual(
    modules.flatMap((module) =>
      Object.keys(vestingEventSpecs[module]).map((name) => [module, name]),
    ),
    [
      ["checkpoints", "VestingCanceled"],
      ["checkpoints", "VestingClaimed"],
      ["checkpoints", "VestingClosed"],
      ["checkpoints", "VestingCreated"],
      ["linear", "VestingCanceled"],
      ["linear", "VestingClaimed"],
      ["linear", "VestingClosed"],
      ["linear", "VestingCreated"],
    ],
  );
  assert.deepEqual(normalizedSpecFields(), frozenEventFields());
});

test("decodes every direct vesting event with module identity and native metadata", () => {
  for (const [eventIndex, fixture] of fixtures.entries()) {
    const event = decodeVestingEvent(
      suiEvent(fixture.module, fixture.name, fixture.payload, eventIndex),
      packages,
    );

    assert.equal(event.kind, `${fixture.module}.${fixture.name}`);
    assert.equal(event.module, fixture.module);
    assert.equal(event.name, fixture.name);
    assert.equal(event.payload.vesting_id, normalizeSuiObjectId("0x1"));
    assert.equal(event.payload.coin_type, normalizeStructTag("0x2::sui::SUI"));
    assert.equal(event.emitterPackageId, normalizeSuiObjectId("0x123"));
    assert.equal(event.sender, normalizeSuiAddress("0x9"));
    assert.deepEqual(event.position, {
      checkpoint: 42n,
      transactionDigest: `vesting-${eventIndex}`,
      eventIndex,
    });
    assert.equal(vestingEventId(event), `vesting-${eventIndex}:${eventIndex}`);
  }
});

test("requires current emitter and original direct-event type identities", () => {
  const valid = suiEvent(
    "linear",
    "VestingClosed",
    commonPayloads.VestingClosed,
    0,
  );
  assert.throws(
    () => decodeVestingEvent({ ...valid, packageId: "0x999" }, packages),
    /unexpected emitter package/,
  );
  assert.throws(
    () =>
      decodeVestingEvent(
        { ...valid, module: vestingModule("checkpoints") },
        packages,
      ),
    /unexpected emitter module/,
  );
  assert.throws(
    () =>
      decodeVestingEvent(
        {
          ...valid,
          eventType: "0x999::blast_fun_linear_vesting::VestingClosed",
        },
        packages,
      ),
    /unexpected event package/,
  );
  assert.throws(
    () =>
      decodeVestingEvent(
        { ...valid, eventType: "0x122::unknown::VestingClosed" },
        packages,
      ),
    /unsupported vesting event/,
  );
  assert.throws(
    () =>
      decodeVestingEvent(
        { ...valid, eventType: "0x122::blast_fun_linear_vesting::Unknown" },
        packages,
      ),
    /unsupported vesting event/,
  );
  assert.throws(
    () =>
      decodeVestingEvent(
        {
          ...valid,
          eventType: "0x122::blast_fun_linear_vesting::VestingClosed<u8>",
        },
        packages,
      ),
    /unexpected event package/,
  );
});

test("rejects malformed payloads and invalid native positions", () => {
  const valid = suiEvent(
    "linear",
    "VestingClosed",
    commonPayloads.VestingClosed,
    0,
  );
  assert.throws(
    () => decodeVestingEvent({ ...valid, bcs: new Uint8Array() }, packages),
    /offset|length|data|buffer|bytes/i,
  );
  assert.throws(
    () => decodeVestingEvent({ ...valid, checkpoint: null }, packages),
    /checkpoint metadata/,
  );
  assert.throws(
    () => decodeVestingEvent({ ...valid, transactionDigest: "" }, packages),
    /transaction digest/,
  );
  assert.throws(
    () => decodeVestingEvent({ ...valid, eventIndex: -1 }, packages),
    /event index/,
  );
});

test("rejects a malformed coin TypeName", () => {
  const rawClosed = bcs.struct("VestingClosed", {
    vesting_id: bcs.struct("ID", { bytes: bcs.Address }),
    coin_type: bcs.struct("TypeName", {
      name: bcs.struct("AsciiString", { bytes: bcs.vector(bcs.u8()) }),
    }),
    caller: bcs.Address,
    released_total: bcs.u64(),
  });
  const malformed = rawClosed
    .serialize({
      vesting_id: { bytes: "0x1" },
      coin_type: { name: { bytes: [255] } },
      caller: "0x3",
      released_total: 4n,
    })
    .toBytes();
  const valid = suiEvent(
    "linear",
    "VestingClosed",
    commonPayloads.VestingClosed,
    0,
  );
  assert.throws(
    () => decodeVestingEvent({ ...valid, bcs: malformed }, packages),
    /invalid|type|tag|identifier/i,
  );
});

function suiEvent(
  module: VestingEventModule,
  name: (typeof eventNames)[number],
  payload: object,
  eventIndex: number,
): SuiClientTypes.EventEntry {
  const original = normalizeSuiAddress(packages.originalPackageId);
  return {
    packageId: packages.packageId,
    module: vestingModule(module),
    sender: "0x9",
    eventType: `${original}::${vestingModule(module)}::${name}`,
    bcs: (vestingEventBcs[module][name] as BcsType<unknown, object>)
      .serialize(payload)
      .toBytes(),
    json: null,
    checkpoint: "42",
    transactionDigest: `vesting-${eventIndex}`,
    eventIndex,
  };
}

function normalizedSpecFields(): Record<
  string,
  readonly (readonly string[])[]
> {
  return Object.fromEntries(
    modules.flatMap((module) =>
      Object.entries(vestingEventSpecs[module]).map(([name, fields]) => [
        `${module}.${name}`,
        Object.entries(fields),
      ]),
    ),
  );
}

function frozenEventFields(): Record<string, readonly (readonly string[])[]> {
  const artifact = JSON.parse(
    readFileSync(
      new URL("../abi/production-vesting-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    packages: {
      vesting: {
        modules: Record<
          string,
          {
            events: readonly {
              name: string;
              fields: readonly { name: string; type: unknown }[];
            }[];
          }
        >;
      };
    };
  };
  return Object.fromEntries(
    modules.flatMap((module) => {
      const frozenModule =
        artifact.packages.vesting.modules[vestingModule(module)];
      if (!frozenModule) throw new TypeError(`missing frozen ${module} module`);
      return frozenModule.events.map((event) => [
        `${module}.${event.name}`,
        event.fields.map((field) => [
          field.name,
          normalizedMoveType(field.type),
        ]),
      ]);
    }),
  );
}

function normalizedMoveType(type: unknown): string {
  if (typeof type === "string") return type;
  const datatype = (type as { Datatype?: { name?: string } }).Datatype;
  if (datatype?.name === "ID") return "id";
  if (datatype?.name === "TypeName") return "typeName";
  if (datatype?.name === "Option") {
    const argument = (
      type as {
        Datatype: { type_arguments: readonly { argument: unknown }[] };
      }
    ).Datatype.type_arguments[0]?.argument;
    const inner = normalizedMoveType(argument);
    return inner === "id" ? "optionId" : "optionAddress";
  }
  throw new TypeError(`unsupported frozen vesting event type: ${String(type)}`);
}
