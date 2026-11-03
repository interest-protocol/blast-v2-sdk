import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { DelayedEventKind } from "@interest-protocol/blast-admin-sdk/events";
import {
  DELAYED_EVENT_KINDS,
  decodePackageAdministrationEvent,
  delayedEventBcs,
  delayedEventModule,
  packageAdministrationEventBcs,
} from "@interest-protocol/blast-admin-sdk/events";
import {
  delayedActionBcs,
  delayedBcs,
  delayedMapBcs,
  delayedSetBcs,
  entryProposalBcs,
  noticeBcs,
  proposalBcs,
  u64Bcs,
  unitKeyBcs,
} from "@interest-protocol/blast-core/bcs";
import {
  decodeLaunchpadDelayedEvent,
  launchpadDelayedKeys,
  launchpadEventSpecs,
} from "@interest-protocol/blast-launchpad-sdk/events";
import {
  createLaunchpadEventProjection,
  reduceLaunchpadEvent,
} from "@interest-protocol/blast-launchpad-sdk/reducer";
import {
  decodePresalePolicyEvent,
  presaleEventSpecs,
  presalePolicyEventBcs,
  presalePolicyEventSpecs,
} from "@interest-protocol/blast-presale-sdk/events";
import type { BcsType } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const abi = JSON.parse(
  readFileSync(new URL("../abi/pr150-consumers.json", import.meta.url), "utf8"),
) as {
  packages: Record<
    string,
    {
      modules: Record<
        string,
        {
          structs: {
            name: string;
            fields: { name: string; type: unknown }[];
          }[];
        }
      >;
    }
  >;
};
const event = (
  eventType: string,
  bytes: Uint8Array,
  index = 0,
): SuiClientTypes.EventEntry => ({
  packageId: "0x15",
  module: "package_admin",
  eventType,
  bcs: bytes,
  json: null,
  sender: "0xca",
  checkpoint: "7",
  transactionDigest: `tx-${index}`,
  eventIndex: index,
});

test("every fresh launchpad and presale event schema follows compiled field order", () => {
  const modules = {
    launchpad: { events: launchpadEventSpecs },
    presale: { ...presaleEventSpecs, ...presalePolicyEventSpecs },
  };
  for (const [product, entries] of Object.entries(modules)) {
    for (const [module, events] of Object.entries(entries)) {
      for (const [kind, fields] of Object.entries(events)) {
        const compiled = abi.packages[product]!.modules[module]!.structs.find(
          (s) => s.name === kind,
        );
        assert.ok(compiled, `${product}::${module}::${kind}`);
        assert.deepEqual(
          Object.keys(fields),
          compiled.fields.map((f) => f.name),
          kind,
        );
      }
    }
  }
  assert.deepEqual(
    Object.keys(launchpadEventSpecs).sort(),
    abi.packages.launchpad!.modules.events!.structs.map((s) => s.name).sort(),
  );
});

test("every new policy and upgrade event decodes and requires its exact type identity", () => {
  for (const [module, specs] of Object.entries(presalePolicyEventSpecs)) {
    for (const [kind, fields] of Object.entries(specs)) {
      const schema = presalePolicyEventBcs[
        kind as keyof typeof presalePolicyEventBcs
      ] as unknown as BcsType<unknown, Record<string, unknown>>;
      const payload = Object.fromEntries(
        Object.entries(fields).map(([field, type]) => [
          field,
          sample(String(type)),
        ]),
      );
      const input = event(
        `0x15::${module}::${kind}`,
        schema.serialize(payload).toBytes(),
      );
      assert.equal(
        decodePresalePolicyEvent(input, { originalPackageId: "0x15" }).kind,
        kind,
      );
      assert.throws(() =>
        decodePresalePolicyEvent(
          { ...input, eventType: `0x16::${module}::${kind}` },
          { originalPackageId: "0x15" },
        ),
      );
      assert.throws(() =>
        decodePresalePolicyEvent(
          {
            ...input,
            eventType: `${input.eventType}<0x15::package_admin::UpgradeAction>`,
          },
          { originalPackageId: "0x15" },
        ),
      );
    }
  }
});

const ADMIN = "0xad";
const LAUNCHPAD = "0x15";
const delayedEntry = (
  name: keyof typeof launchpadDelayedKeys,
  kind: DelayedEventKind,
  payload: Record<string, unknown>,
  index: number,
  valueType = launchpadDelayedKeys[name].valueType.replaceAll(
    "{package}",
    LAUNCHPAD,
  ),
): SuiClientTypes.EventEntry => {
  const spec = launchpadDelayedKeys[name];
  return event(
    `${ADMIN}::${delayedEventModule(kind)}::${kind}<${LAUNCHPAD}::${spec.key}, ${valueType}>`,
    delayedEventBcs(kind, spec)
      .serialize({ owner: "0xc0", key: null, ...payload } as never)
      .toBytes(),
    index,
  );
};
const launchpadDelayed = (entry: SuiClientTypes.EventEntry) =>
  decodeLaunchpadDelayedEvent(entry, {
    originalPackageId: LAUNCHPAD,
    adminPackageId: ADMIN,
  });

test("every delayed lifecycle event follows compiled field order", () => {
  const modules = abi.packages.admin!.modules;
  const compiled = (module: string, name: string) =>
    modules[module]!.structs.find((s) => s.name === name)!.fields;
  const changes: Record<string, unknown> = {
    Action: { kind: "Action", action: 3n },
    Set: { kind: "Admission", member: 3n },
    Map: { kind: "Entry", entry: 7n, value: null },
  };
  for (const kind of DELAYED_EVENT_KINDS) {
    const fields = compiled(delayedEventModule(kind), kind);
    const spec = { keyBcs: unitKeyBcs, valueBcs: u64Bcs, entryBcs: u64Bcs };
    const payload = Object.fromEntries(
      fields.map(({ name }) => [
        name,
        name === "owner"
          ? "0xc0"
          : name === "key"
            ? null
            : name === "change"
              ? changes[kind.replace(/[A-Z][a-z]+$/, "")]
              : 1n,
      ]),
    );
    const schema = delayedEventBcs(kind, spec);
    assert.deepEqual(
      Object.keys(schema.parse(schema.serialize(payload as never).toBytes())),
      fields.map((f) => f.name),
      kind,
    );
  }
  const owned = { owner: normalizeSuiAddress("0xc0"), key: null, delay_ms: 1n };
  const proposal = { value: 2n, delay_ms: 3n, ready_at_ms: 4n };
  const notice = { delay_ms: 3n, ready_at_ms: 4n };
  const layouts: [string, string, BcsType<unknown, never>, unknown][] = [
    [
      "delayed",
      "Delayed",
      delayedBcs(unitKeyBcs, u64Bcs) as never,
      { ...owned, value: 2n, pending: proposal },
    ],
    [
      "delayed_action",
      "DelayedAction",
      delayedActionBcs(unitKeyBcs, u64Bcs) as never,
      { ...owned, pending: { ...proposal, value: { kind: "Delay" } } },
    ],
    [
      "delayed_set",
      "DelayedSet",
      delayedSetBcs(unitKeyBcs, u64Bcs) as never,
      {
        ...owned,
        members: [2n],
        admissions: [{ member: 5n, notice }],
        pending_delay: notice,
      },
    ],
    [
      "delayed_map",
      "DelayedMap",
      delayedMapBcs(unitKeyBcs, u64Bcs, u64Bcs) as never,
      {
        ...owned,
        entries: { id: normalizeSuiAddress("0xe1"), size: 1n },
        pending: [
          { entry: 5n, proposal: { value: null, notice } },
          { entry: 6n, proposal: { value: 9n, notice } },
        ],
        pending_delay: null,
      },
    ],
    [
      "delayed_map",
      "EntryProposal",
      entryProposalBcs(u64Bcs) as never,
      { value: 9n, notice },
    ],
    ["delayed", "Proposal", proposalBcs(u64Bcs) as never, proposal],
    ["delayed", "Notice", noticeBcs as never, notice],
  ];
  for (const [module, name, schema, value] of layouts) {
    const bytes = schema.serialize(value as never).toBytes();
    assert.deepEqual(schema.parse(bytes), value, name);
    assert.deepEqual(
      Object.keys(schema.parse(bytes) as object),
      compiled(module, name).map((f) => f.name),
      name,
    );
  }
  // A zero-field key struct is Move's one `dummy_field: bool` byte.
  assert.deepEqual(unitKeyBcs.serialize(null).toBytes(), Uint8Array.of(0));
});

test("launchpad delayed events decode only under their own key and value types", () => {
  const scheduled = launchpadDelayed(
    delayedEntry(
      "CreationFee",
      "DelayedScheduled",
      { value: 5n, delay_ms: 0n, ready_at_ms: 9n },
      0,
    ),
  );
  assert.equal(scheduled.name, "CreationFee");
  assert.equal(scheduled.kind, "DelayedScheduled");
  assert.deepEqual(scheduled.payload, {
    owner: normalizeSuiAddress("0xc0"),
    key: null,
    value: 5n,
    delay_ms: 0n,
    ready_at_ms: 9n,
  });
  const valid = delayedEntry(
    "CreationFee",
    "DelayedCreated",
    { value: 5n, delay_ms: 0n },
    1,
  );
  for (const eventType of [
    // Another package's key of the same name.
    valid.eventType.replace(
      `${LAUNCHPAD}::launch_config`,
      "0x16::launch_config",
    ),
    // A value type the key never carries.
    valid.eventType.replace(", u64>", ", u8>"),
    // Another admin package.
    valid.eventType.replace(`${ADMIN}::delayed`, "0xae::delayed"),
    // A family the key does not use.
    valid.eventType.replace("DelayedCreated", "ActionCreated"),
  ])
    assert.throws(() => launchpadDelayed({ ...valid, eventType }), eventType);
  assert.throws(() =>
    launchpadDelayed(
      delayedEntry("MigrationWitnesses", "DelayedCreated", {}, 2),
    ),
  );
});

test("delayed proposals do not change applied launchpad economics until applied", () => {
  const before = createLaunchpadEventProjection();
  const fees = { quote_fee_bps: 200n, meme_fee_bps: 300n };
  const scheduled = reduceLaunchpadEvent(
    before,
    launchpadDelayed(
      delayedEntry(
        "TradeFees",
        "DelayedScheduled",
        { value: fees, delay_ms: 10n, ready_at_ms: 1n },
        0,
      ),
    ),
  );
  assert.deepEqual(scheduled.config, before.config);
  assert.equal(
    scheduled.administration.pendingPolicies.TradeFees?.kind,
    "DelayedScheduled",
  );
  const applied = reduceLaunchpadEvent(
    scheduled,
    launchpadDelayed(
      delayedEntry(
        "TradeFees",
        "DelayedApplied",
        { previous_value: fees, value: fees, delay_ms: 10n },
        1,
      ),
    ),
  );
  assert.deepEqual(applied.config.tradeFeeDefaults, {
    quoteFeeBps: 200n,
    memeFeeBps: 300n,
  });
  assert.equal(applied.administration.pendingPolicies.TradeFees, undefined);
  assert.equal(applied.administration.policyDelays.TradeFees, 10n);
  assert.equal(applied.eventCounts.Paused, 0);

  const notice = { kind: "Delay" } as const;
  const upgrade = reduceLaunchpadEvent(
    applied,
    launchpadDelayed(
      delayedEntry(
        "Upgrade",
        "ActionScheduled",
        { change: notice, delay_ms: 20n, ready_at_ms: 1n },
        2,
      ),
    ),
  );
  assert.ok(upgrade.administration.pendingPolicies.Upgrade);
  const armed = reduceLaunchpadEvent(
    upgrade,
    launchpadDelayed(
      delayedEntry(
        "Upgrade",
        "ActionApplied",
        { change: notice, delay_ms: 20n },
        3,
      ),
    ),
  );
  assert.equal(armed.administration.pendingPolicies.Upgrade, undefined);
  assert.equal(armed.administration.policyDelays.Upgrade, 20n);
  // Replaying an applied event changes nothing.
  assert.equal(
    reduceLaunchpadEvent(
      armed,
      launchpadDelayed(
        delayedEntry(
          "Upgrade",
          "ActionApplied",
          { change: notice, delay_ms: 20n },
          3,
        ),
      ),
    ),
    armed,
  );
});

test("witness admissions wait their own notice and removals are immediate", () => {
  const witness =
    "0x0000000000000000000000000000000000000000000000000000000000000015::cetus::Witness";
  const admission = { kind: "Admission", member: witness } as const;
  const created = reduceLaunchpadEvent(
    createLaunchpadEventProjection(),
    launchpadDelayed(
      delayedEntry("MigrationWitnesses", "SetCreated", { delay_ms: 7n }, 0),
    ),
  );
  const scheduled = reduceLaunchpadEvent(
    created,
    launchpadDelayed(
      delayedEntry(
        "MigrationWitnesses",
        "SetScheduled",
        { change: admission, delay_ms: 7n, ready_at_ms: 9n },
        1,
      ),
    ),
  );
  assert.ok(
    scheduled.administration.pendingPolicies[`MigrationWitnesses:${witness}`],
  );
  assert.deepEqual(scheduled.config.migrationWitnesses, {});
  const admitted = reduceLaunchpadEvent(
    scheduled,
    launchpadDelayed(
      delayedEntry(
        "MigrationWitnesses",
        "SetApplied",
        { change: admission, delay_ms: 3n },
        2,
      ),
    ),
  );
  assert.deepEqual(admitted.config.migrationWitnesses, { [witness]: true });
  assert.deepEqual(admitted.administration.pendingPolicies, {});
  // The admission's notice is not a new set notice.
  assert.equal(admitted.administration.policyDelays.MigrationWitnesses, 7n);
  const removed = reduceLaunchpadEvent(
    admitted,
    launchpadDelayed(
      delayedEntry(
        "MigrationWitnesses",
        "MemberRemoved",
        { member: witness },
        3,
      ),
    ),
  );
  assert.deepEqual(removed.config.migrationWitnesses, {});
});

test("cap reassignments are tracked per launch", () => {
  const launch = (owner: string, index: number) =>
    launchpadDelayed({
      ...delayedEntry(
        "CurveFeeCapReassignment",
        "ActionScheduled",
        {
          change: { kind: "Action", action: "0xb0b" },
          delay_ms: 1n,
          ready_at_ms: 2n,
        },
        index,
      ),
      bcs: delayedEventBcs(
        "ActionScheduled",
        launchpadDelayedKeys.CurveFeeCapReassignment,
      )
        .serialize({
          owner,
          key: null,
          change: { kind: "Action", action: "0xb0b" },
          delay_ms: 1n,
          ready_at_ms: 2n,
        } as never)
        .toBytes(),
    });
  const state = [launch("0xa1", 0), launch("0xa2", 1)].reduce(
    reduceLaunchpadEvent,
    createLaunchpadEventProjection(),
  );
  assert.deepEqual(Object.keys(state.administration.pendingPolicies).sort(), [
    `CurveFeeCapReassignment:${normalizeSuiAddress("0xa1")}`,
    `CurveFeeCapReassignment:${normalizeSuiAddress("0xa2")}`,
  ]);
});

test("native upgrade events authenticate the admin package and product marker", () => {
  const marker = "0x15::blast_fun::BLAST_FUN";
  for (const [kind, schema] of Object.entries(packageAdministrationEventBcs)) {
    const compiled =
      abi.packages.admin!.modules.blast_admin_events!.structs.find(
        (s) => s.name === kind,
      )!;
    const payload = Object.fromEntries(
      compiled.fields.map((f) => [f.name, compiledSample(f.type)]),
    );
    const bcs = (schema as unknown as BcsType<unknown, Record<string, unknown>>)
      .serialize(payload)
      .toBytes();
    const input = event(`0xad::blast_admin_events::${kind}<${marker}>`, bcs);
    assert.equal(
      decodePackageAdministrationEvent(input, {
        adminPackageId: "0xad",
        packageMarker: marker,
      }).kind,
      kind,
    );
    assert.throws(() =>
      decodePackageAdministrationEvent(input, {
        adminPackageId: "0xae",
        packageMarker: marker,
      }),
    );
    assert.throws(() =>
      decodePackageAdministrationEvent(input, {
        adminPackageId: "0xad",
        packageMarker: "0x16::blast_fun::BLAST_FUN",
      }),
    );
  }
});

function sample(type: string): unknown {
  switch (type) {
    case "u8":
      return 1;
    case "u64":
      return 1n;
    case "address":
    case "id":
      return "0xca";
    case "typeName":
      return "0x15::test::Witness";
    case "bool":
      return true;
    default:
      throw new Error(`unhandled fixture type ${type}`);
  }
}
function compiledSample(type: unknown): unknown {
  if (typeof type === "string") return sample(type);
  const value = type as { vector?: unknown; Datatype?: { name: string } };
  if (value.vector) return [1, 2, 3];
  if (value.Datatype?.name === "ID") return "0xca";
  throw new Error(`unhandled compiler type ${JSON.stringify(type)}`);
}
