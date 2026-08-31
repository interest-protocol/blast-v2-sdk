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
  BlastSuiEventKind,
  BlastSuiEventPackageIdentity,
  BlastSuiEventPayloads,
} from "../src/blast-sui/index.ts";
import {
  blastSuiEventBcs,
  blastSuiEventId,
  blastSuiEventSpecs,
  decodeBlastSuiEvent,
  exchangeRateEventBcs,
  poolCustodyEventBcs,
  vaultCustodyEventBcs,
} from "../src/blast-sui/index.ts";
import type { BasisPoints } from "../src/lib/integers.ts";

const packages: BlastSuiEventPackageIdentity = {
  packageId: "0x123",
  originalPackageId: "0x122",
};

const custody = {
  fun_custody: {
    liquid_sui: 11n,
    pending_sui: 12n,
    active_pool_tokens: 13n,
    active_sui: 14n,
  },
  blast_custody: {
    liquid_sui: 21n,
    pending_sui: 22n,
    active_pool_tokens: 23n,
    active_sui: 24n,
  },
  exchange_rate: {
    epoch: 31n,
    sui_amount: 32n,
    pool_token_amount: 33n,
  },
  fun_supply: 41n,
  blast_supply: 42n,
};

type BlastSuiEventPayloadInput<Kind extends BlastSuiEventKind> = Parameters<
  (typeof blastSuiEventBcs)[Kind]["serialize"]
>[0];

const fixtures = [
  {
    kind: "AdminDestroyed",
    payload: { admin_cap_id: "0x20", was_active: false },
  },
  {
    kind: "AdminGranted",
    payload: { admin_cap_id: "0x21", recipient: "0x22" },
  },
  { kind: "AdminRevoked", payload: { admin_cap_id: "0x23" } },
  {
    kind: "BlastSuiDepositCancelled",
    payload: {
      receipt_id: "0x1",
      vault_id: "0x2",
      principal_sui: 101n,
      returned_sui: 102n,
    },
  },
  {
    kind: "BlastSuiDepositClaimed",
    payload: {
      receipt_id: "0x3",
      vault_id: "0x4",
      principal_sui: 103n,
      contributed_sui: 104n,
      pool_tokens: 105n,
      blast_out: 106n,
      custody,
    },
  },
  {
    kind: "BlastSuiDepositRequested",
    payload: {
      receipt_id: "0x5",
      vault_id: "0x6",
      pool_id: "0x7",
      principal_sui: 107n,
      activation_epoch: 108n,
      custody,
    },
  },
  { kind: "BlastSuiDonated", payload: { sui_in: 109n, custody } },
  {
    kind: "BlastSuiRedeemed",
    payload: {
      blast_in: 110n,
      gross_sui: 111n,
      fee_sui: 112n,
      net_sui: 113n,
      custody,
    },
  },
  { kind: "FunSuiMinted", payload: { sui_in: 114n, custody } },
  { kind: "FunSuiRedeemed", payload: { fun_in: 115n, custody } },
  {
    kind: "FunYieldSwept",
    payload: {
      liquid_sui: 116n,
      pool_tokens: 117n,
      swept_sui: 118n,
      custody,
    },
  },
  { kind: "NativeStakeUnwound", payload: { custody } },
  {
    kind: "PackageCapabilityAdded",
    payload: {
      package_admin_id: "0x8",
      capability_id: "0xc",
      capability_type:
        "0x2::coin_registry::MetadataCap<0x122::blast_sui::BLAST_SUI>",
    },
  },
  {
    kind: "PackageAdminCreated",
    payload: {
      package_admin_id: "0x8",
      publisher_id: "0x9",
      upgrade_cap_id: "0xa",
      package_id: "0xb",
      package_version: 119n,
      policy: 1,
    },
  },
  {
    kind: "PackageVersionAdvanced",
    payload: { previous_version: 120n, new_version: 121n },
  },
  {
    kind: "RedeemFeeChanged",
    payload: { old_redeem_fee_bps: 30n, new_redeem_fee_bps: 40n },
  },
  {
    kind: "SuperAdminTransferCancelled",
    payload: { recipient: "0xc" },
  },
  {
    kind: "SuperAdminTransferStarted",
    payload: { recipient: "0xd", execute_after_ms: 122n },
  },
  {
    kind: "SuperAdminTransferred",
    payload: {
      previous_super_admin_cap_id: "0xe",
      new_super_admin_cap_id: "0xf",
      recipient: "0x10",
    },
  },
  {
    kind: "UpgradeAuthorized",
    payload: { digest: new Uint8Array([1, 2, 3]) },
  },
  {
    kind: "UpgradeCommitted",
    payload: {
      new_package_id: "0x12",
      previous_version: 124n,
      new_version: 125n,
    },
  },
  {
    kind: "UpgradePolicyRestricted",
    payload: { previous_policy: 1, new_policy: 2 },
  },
  {
    kind: "VaultCreated",
    payload: {
      vault_id: "0x13",
      validator: "0x14",
      pool_id: "0x15",
      fun_reserve_sui: 126n,
      bootstrap_sui: 127n,
      locked_blast_sui: 128n,
      redeem_fee_bps: 50n,
      custody,
    },
  },
  { kind: "VaultSynced", payload: { custody } },
] as const satisfies ReadonlyArray<
  {
    [Kind in BlastSuiEventKind]: {
      kind: Kind;
      payload: BlastSuiEventPayloadInput<Kind>;
    };
  }[BlastSuiEventKind]
>;

test("matches the complete frozen blast_sui event inventory", () => {
  const expectedNames = [
    "AdminDestroyed",
    "AdminGranted",
    "AdminRevoked",
    "BlastSuiDepositCancelled",
    "BlastSuiDepositClaimed",
    "BlastSuiDepositRequested",
    "BlastSuiDonated",
    "BlastSuiRedeemed",
    "FunSuiMinted",
    "FunSuiRedeemed",
    "FunYieldSwept",
    "NativeStakeUnwound",
    "PackageCapabilityAdded",
    "PackageAdminCreated",
    "PackageVersionAdvanced",
    "RedeemFeeChanged",
    "SuperAdminTransferCancelled",
    "SuperAdminTransferStarted",
    "SuperAdminTransferred",
    "UpgradeAuthorized",
    "UpgradeCommitted",
    "UpgradePolicyRestricted",
    "VaultCreated",
    "VaultSynced",
  ];

  assert.deepEqual(Object.keys(blastSuiEventSpecs), expectedNames);
  assert.equal(fixtures.length, 24);
  assert.deepEqual(normalizedSpecFields(), frozenEventFields());
});

test("matches ordered nested custody fields and BCS layout", () => {
  assert.deepEqual(frozenNestedFields(), {
    PoolCustody: [
      ["liquid_sui", "u64"],
      ["pending_sui", "u64"],
      ["active_pool_tokens", "u64"],
      ["active_sui", "u64"],
    ],
    ExchangeRate: [
      ["epoch", "u64"],
      ["sui_amount", "u64"],
      ["pool_token_amount", "u64"],
    ],
    VaultCustody: [
      ["fun_custody", "poolCustody"],
      ["blast_custody", "poolCustody"],
      ["exchange_rate", "exchangeRate"],
      ["fun_supply", "u64"],
      ["blast_supply", "u64"],
    ],
  });
  assert.deepEqual(
    poolCustodyEventBcs.serialize(custody.fun_custody).toBytes(),
    serializedU64s([11n, 12n, 13n, 14n]),
  );
  assert.deepEqual(
    exchangeRateEventBcs.serialize(custody.exchange_rate).toBytes(),
    serializedU64s([31n, 32n, 33n]),
  );
  assert.deepEqual(
    vaultCustodyEventBcs.serialize(custody).toBytes(),
    serializedU64s([
      11n,
      12n,
      13n,
      14n,
      21n,
      22n,
      23n,
      24n,
      31n,
      32n,
      33n,
      41n,
      42n,
    ]),
  );
});

test("decodes every wrapped blast_sui event payload", () => {
  for (const [eventIndex, fixture] of fixtures.entries()) {
    const event = decodeBlastSuiEvent(
      suiEvent(fixture.kind, fixture.payload, eventIndex),
      packages,
    );

    assert.equal(event.source, "blastSui");
    assert.equal(event.kind, fixture.kind);
    assert.deepEqual(
      event.payload,
      normalizePayload(fixture.kind, fixture.payload),
    );
    assert.equal(
      event.emitterPackageId,
      normalizeSuiObjectId(packages.packageId),
    );
    assert.equal(event.sender, normalizeSuiAddress("0x16"));
    assert.deepEqual(event.position, {
      checkpoint: 9n,
      transactionDigest: `transaction-${eventIndex}`,
      eventIndex,
    });
    assert.equal(
      blastSuiEventId(event),
      `transaction-${eventIndex}:${eventIndex}`,
    );
  }
});

test("requires current emitter and original wrapper/payload identities", () => {
  const valid = suiEvent("VaultSynced", { custody }, 0);

  assert.throws(
    () => decodeBlastSuiEvent({ ...valid, packageId: "0x999" }, packages),
    /unexpected emitter package/,
  );
  assert.throws(
    () => decodeBlastSuiEvent({ ...valid, module: "events" }, packages),
    /unexpected emitter module/,
  );
  assert.throws(
    () =>
      decodeBlastSuiEvent(
        {
          ...valid,
          eventType: wrappedType(
            "VaultSynced",
            "0x999",
            packages.originalPackageId,
          ),
        },
        packages,
      ),
    /unexpected event package/,
  );
  assert.throws(
    () =>
      decodeBlastSuiEvent(
        {
          ...valid,
          eventType: `${normalizeSuiObjectId(packages.originalPackageId)}::wrong_wrapper::Event<${normalizeSuiObjectId(packages.originalPackageId)}::events::VaultSynced>`,
        },
        packages,
      ),
    /unexpected event package/,
  );
  assert.throws(
    () =>
      decodeBlastSuiEvent(
        {
          ...valid,
          eventType: `${normalizeSuiObjectId(packages.originalPackageId)}::events_wrapper::Event<${normalizeSuiObjectId(packages.originalPackageId)}::wrong_events::VaultSynced>`,
        },
        packages,
      ),
    /unexpected payload type/,
  );
  assert.throws(
    () =>
      decodeBlastSuiEvent(
        {
          ...valid,
          eventType: wrappedType(
            "VaultSynced",
            packages.originalPackageId,
            "0x999",
          ),
        },
        packages,
      ),
    /unexpected payload type/,
  );
});

test("rejects malformed BCS and invalid native event metadata", () => {
  const valid = suiEvent("VaultSynced", { custody }, 0);

  assert.throws(() =>
    decodeBlastSuiEvent({ ...valid, bcs: new Uint8Array([1]) }, packages),
  );
  assert.throws(
    () => decodeBlastSuiEvent({ ...valid, checkpoint: null }, packages),
    /checkpoint metadata/,
  );
  assert.throws(
    () => decodeBlastSuiEvent({ ...valid, transactionDigest: "" }, packages),
    /transaction digest/,
  );
  for (const eventIndex of [-1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => decodeBlastSuiEvent({ ...valid, eventIndex }, packages),
      /event index/,
    );
  }
});

test("validates all redeem-fee basis-point fields", () => {
  const vaultCreatedFixture = fixtures.find(
    (fixture) => fixture.kind === "VaultCreated",
  );
  if (!vaultCreatedFixture) throw new TypeError("missing VaultCreated fixture");

  const boundaryEvent = decodeBlastSuiEvent(
    suiEvent(
      "RedeemFeeChanged",
      { old_redeem_fee_bps: 0n, new_redeem_fee_bps: 10_000n },
      0,
    ),
    packages,
  );
  if (boundaryEvent.kind !== "RedeemFeeChanged") {
    throw new TypeError("expected RedeemFeeChanged");
  }
  acceptsBasisPoints(boundaryEvent.payload.old_redeem_fee_bps);
  acceptsBasisPoints(boundaryEvent.payload.new_redeem_fee_bps);
  assert.equal(boundaryEvent.payload.old_redeem_fee_bps, 0n);
  assert.equal(boundaryEvent.payload.new_redeem_fee_bps, 10_000n);

  const vaultCreatedEvent = decodeBlastSuiEvent(
    suiEvent("VaultCreated", vaultCreatedFixture.payload, 0),
    packages,
  );
  if (vaultCreatedEvent.kind !== "VaultCreated") {
    throw new TypeError("expected VaultCreated");
  }
  acceptsBasisPoints(vaultCreatedEvent.payload.redeem_fee_bps);

  assert.throws(() =>
    blastSuiEventBcs.RedeemFeeChanged.serialize({
      old_redeem_fee_bps: 10_001n,
      new_redeem_fee_bps: 1n,
    }),
  );
  assert.throws(() =>
    blastSuiEventBcs.RedeemFeeChanged.serialize({
      old_redeem_fee_bps: 1n,
      new_redeem_fee_bps: 10_001n,
    }),
  );
  assert.throws(() =>
    blastSuiEventBcs.VaultCreated.serialize({
      ...vaultCreatedFixture.payload,
      redeem_fee_bps: 10_001n,
    }),
  );

  const invalidBytes = bcs
    .struct("RedeemFeeChanged", {
      old_redeem_fee_bps: bcs.u64(),
      new_redeem_fee_bps: bcs.u64(),
    })
    .serialize({ old_redeem_fee_bps: 10_001n, new_redeem_fee_bps: 1n })
    .toBytes();
  assert.throws(
    () =>
      decodeBlastSuiEvent(
        {
          ...suiEvent(
            "RedeemFeeChanged",
            { old_redeem_fee_bps: 1n, new_redeem_fee_bps: 1n },
            0,
          ),
          bcs: invalidBytes,
        },
        packages,
      ),
    /basis points/,
  );
});

function suiEvent<Kind extends BlastSuiEventKind>(
  kind: Kind,
  payload: BlastSuiEventPayloadInput<Kind>,
  eventIndex: number,
): SuiClientTypes.EventEntry {
  const schema = blastSuiEventBcs[kind] as unknown as BcsType<
    unknown,
    BlastSuiEventPayloadInput<Kind>
  >;
  return {
    packageId: packages.packageId,
    module: "events_wrapper",
    sender: "0x16",
    eventType: wrappedType(
      kind,
      packages.originalPackageId,
      packages.originalPackageId,
    ),
    bcs: schema.serialize(payload).toBytes(),
    json: null,
    checkpoint: "9",
    transactionDigest: `transaction-${eventIndex}`,
    eventIndex,
  };
}

function wrappedType(
  kind: BlastSuiEventKind,
  wrapperAddress: string,
  payloadAddress: string,
): string {
  return `${normalizeSuiObjectId(wrapperAddress)}::events_wrapper::Event<${normalizeSuiObjectId(payloadAddress)}::events::${kind}>`;
}

function normalizePayload<Kind extends BlastSuiEventKind>(
  kind: Kind,
  payload: BlastSuiEventPayloadInput<Kind>,
): BlastSuiEventPayloads[Kind] {
  const spec = blastSuiEventSpecs[kind];
  return Object.fromEntries(
    Object.entries(spec).map(([field, descriptor]) => {
      const value = (payload as Record<string, unknown>)[field];
      if (descriptor === "id")
        return [field, normalizeSuiObjectId(value as string)];
      if (descriptor === "address")
        return [field, normalizeSuiAddress(value as string)];
      if (descriptor === "typeName")
        return [field, normalizeStructTag(value as string)];
      return [field, value];
    }),
  ) as BlastSuiEventPayloads[Kind];
}

function normalizedSpecFields(): Record<string, Array<[string, string]>> {
  return Object.fromEntries(
    Object.entries(blastSuiEventSpecs).map(([name, spec]) => [
      name,
      Object.entries(spec).map(
        ([field, descriptor]) =>
          [field, descriptor === "basisPoints" ? "u64" : descriptor] as [
            string,
            string,
          ],
      ),
    ]),
  );
}

function frozenEventFields(): Record<string, Array<[string, string]>> {
  return Object.fromEntries(
    readFrozenEventsModule().events.map((event) => [
      event.name,
      event.fields.map(
        (field) =>
          [field.name, normalizedAbiType(field.type)] as [string, string],
      ),
    ]),
  );
}

function frozenNestedFields(): Record<string, Array<[string, string]>> {
  const nestedNames = new Set(["PoolCustody", "ExchangeRate", "VaultCustody"]);
  return Object.fromEntries(
    readFrozenEventsModule()
      .structs.filter((struct) => nestedNames.has(struct.name))
      .map((struct) => [
        struct.name,
        struct.fields.map(
          (field) =>
            [field.name, normalizedAbiType(field.type)] as [string, string],
        ),
      ]),
  );
}

function readFrozenEventsModule(): {
  events: Array<{
    name: string;
    fields: Array<{ name: string; type: unknown }>;
  }>;
  structs: Array<{
    name: string;
    fields: Array<{ name: string; type: unknown }>;
  }>;
} {
  const artifact = JSON.parse(
    readFileSync(
      new URL("../abi/production-blast-sui-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    packages: {
      blastSui: {
        modules: {
          events: {
            events: Array<{
              name: string;
              fields: Array<{ name: string; type: unknown }>;
            }>;
            structs: Array<{
              name: string;
              fields: Array<{ name: string; type: unknown }>;
            }>;
          };
        };
      };
    };
  };
  return artifact.packages.blastSui.modules.events;
}

function normalizedAbiType(type: unknown): string {
  if (type === "bool" || type === "u64" || type === "u8" || type === "address")
    return type;
  if (!isRecord(type)) throw new TypeError("unsupported ABI event field");
  if (type.vector === "u8") return "bytes";
  const datatype = type.Datatype;
  if (!isRecord(datatype))
    throw new TypeError("unsupported ABI datatype field");
  if (datatype.name === "ID") return "id";
  if (datatype.name === "VaultCustody") return "vaultCustody";
  if (datatype.name === "PoolCustody") return "poolCustody";
  if (datatype.name === "ExchangeRate") return "exchangeRate";
  if (datatype.name === "TypeName") return "typeName";
  throw new TypeError(
    `unsupported ABI event datatype: ${String(datatype.name)}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function serializedU64s(values: readonly bigint[]): Uint8Array {
  return Uint8Array.from(
    values.flatMap((value) => Array.from(bcs.u64().serialize(value).toBytes())),
  );
}

function acceptsBasisPoints(_value: BasisPoints): void {}
