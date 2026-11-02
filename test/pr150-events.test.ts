import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  decodePackageAdministrationEvent,
  packageAdministrationEventBcs,
} from "@interest-protocol/blast-admin-sdk/events";
import {
  decodeLaunchpadEvent,
  launchpadEventBcs,
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
  for (const kind of [
    "UpgradeActionScheduled",
    "UpgradeActionCancelled",
  ] as const) {
    const schema = launchpadEventBcs[kind];
    const payload = {
      action: { $kind: "DelayOnly" as const, DelayOnly: true as const },
      ready_at_ms: 10n,
      delay_ms: 20n,
    };
    const input = event(
      `0x15::blast_events::Event<0x15::events::${kind}<0x15::package_admin::UpgradeAction>>`,
      schema.serialize(payload).toBytes(),
    );
    assert.equal(
      decodeLaunchpadEvent(input, { originalPackageId: "0x15" }).kind,
      kind,
    );
    assert.throws(() =>
      decodeLaunchpadEvent(
        {
          ...input,
          eventType: input.eventType.replace(
            "0x15::package_admin",
            "0x16::package_admin",
          ),
        },
        { originalPackageId: "0x15" },
      ),
    );
  }
});

test("scheduled policies do not change applied economics, and delay-only upgrade apply clears the proposal", () => {
  const decode = (
    kind:
      | "TradeFeesScheduled"
      | "LaunchTradeFeesChanged"
      | "UpgradeActionScheduled"
      | "UpgradeDelayChanged",
    payload: Record<string, unknown>,
    index: number,
  ) => {
    const schema = launchpadEventBcs[kind] as unknown as BcsType<
      unknown,
      Record<string, unknown>
    >;
    const generic =
      kind === "UpgradeActionScheduled"
        ? "<0x15::package_admin::UpgradeAction>"
        : "";
    return decodeLaunchpadEvent(
      event(
        `0x15::blast_events::Event<0x15::events::${kind}${generic}>`,
        schema.serialize(payload).toBytes(),
        index,
      ),
      { originalPackageId: "0x15" },
    );
  };
  const before = createLaunchpadEventProjection();
  const scheduled = reduceLaunchpadEvent(
    before,
    decode(
      "TradeFeesScheduled",
      {
        quote_fee_bps: 200n,
        meme_fee_bps: 300n,
        ready_at_ms: 1n,
        delay_ms: 10n,
      },
      0,
    ),
  );
  assert.deepEqual(scheduled.config, before.config);
  assert.ok(scheduled.administration.pendingPolicies.TradeFees);
  const applied = reduceLaunchpadEvent(
    scheduled,
    decode(
      "LaunchTradeFeesChanged",
      { quote_fee_bps: 200n, meme_fee_bps: 300n },
      1,
    ),
  );
  assert.equal(applied.config.tradeFeeDefaults?.quoteFeeBps, 200n);
  assert.equal(applied.administration.pendingPolicies.TradeFees, undefined);
  const upgrade = reduceLaunchpadEvent(
    applied,
    decode(
      "UpgradeActionScheduled",
      { action: { DelayOnly: true }, ready_at_ms: 1n, delay_ms: 20n },
      2,
    ),
  );
  assert.ok(upgrade.administration.pendingPolicies.UpgradeAction);
  const changed = reduceLaunchpadEvent(
    upgrade,
    decode("UpgradeDelayChanged", { delay_ms: 20n }, 3),
  );
  assert.equal(changed.administration.pendingPolicies.UpgradeAction, undefined);
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
    case "upgradeAction":
      return { DelayOnly: true };
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
