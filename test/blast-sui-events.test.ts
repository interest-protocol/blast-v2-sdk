import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { BasisPoints } from "@interest-protocol/blast-core/integers";
import type {
  BlastSuiEventKind,
  BlastSuiEventPackageIdentity,
  BlastSuiEventPayloads,
  PoolSnapshotEvent,
  PositionCustodyEvent,
  VaultCustodyEvent,
} from "@interest-protocol/blast-sui-sdk";
import {
  blastSuiDelayedKeys,
  blastSuiEventBcs,
  blastSuiEventId,
  blastSuiEventSpecs,
  decodeBlastSuiDelayedEvent,
  decodeBlastSuiEvent,
  exchangeRateEventBcs,
  poolSnapshotEventBcs,
  positionCustodyEventBcs,
  vaultCustodyEventBcs,
} from "@interest-protocol/blast-sui-sdk";
import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import {
  BLAST_SUI_FIXTURE,
  blastSuiDelayedEntry,
  blastSuiEventEntry,
  FIXTURE_POOL_0,
  FIXTURE_POOL_1,
  FIXTURE_POOL_2,
  FIXTURE_RECEIPT_ID,
  FIXTURE_VAULT_ID,
  fixtureEventBytes,
} from "./blast-sui-golden.ts";

const packages: BlastSuiEventPackageIdentity = {
  packageId: "0x123",
  originalPackageId: "0x122",
};
const admin = {
  packageId: "0xad",
  acl: { objectId: "0xac", initialSharedVersion: "3" },
};
const delayedIdentity = {
  adminPackageId: admin.packageId,
  originalPackageId: packages.originalPackageId,
};
const SUI = 1_000_000_000n;

const position = (
  pending_sui: bigint,
  active_pool_tokens: bigint,
  active_sui: bigint,
): PositionCustodyEvent => ({ pending_sui, active_pool_tokens, active_sui });
const EMPTY = position(0n, 0n, 0n);
const pool = (
  pool_id: string,
  [epoch, sui_amount, pool_token_amount]: readonly [bigint, bigint, bigint],
  fun_position: PositionCustodyEvent,
  blast_position: PositionCustodyEvent,
): PoolSnapshotEvent => ({
  pool_id,
  exchange_rate: { epoch, sui_amount, pool_token_amount },
  fun_position,
  blast_position,
});
const vaultCustody = (
  fun_liquid: bigint,
  blast_liquid: bigint,
  pools: PoolSnapshotEvent[],
  fun_supply: bigint,
  blast_supply: bigint,
): VaultCustodyEvent => ({
  fun_liquid,
  blast_liquid,
  pools,
  fun_supply,
  blast_supply,
});

const GENESIS_RATE = [1n, 100n * SUI, 100n * SUI] as const;
const RESERVE = SUI / 10n;
const BOOTSTRAP_POOL = pool(
  FIXTURE_POOL_0,
  GENESIS_RATE,
  EMPTY,
  position(10n * SUI, 0n, 0n),
);
const MINTED_POOLS = [
  BOOTSTRAP_POOL,
  pool(FIXTURE_POOL_1, GENESIS_RATE, position(2n * SUI, 0n, 0n), EMPTY),
];
const EPOCH_3_POOL_0_RATE = [
  3n,
  1_333_600_113_000_000_000n,
  113n * SUI,
] as const;
const EPOCH_3_POOL_1_RATE = [
  3n,
  1_333_600_103_500_000_000n,
  103_500_000_000n,
] as const;
const REDEEMED_POOL_0 = pool(
  FIXTURE_POOL_0,
  EPOCH_3_POOL_0_RATE,
  EMPTY,
  position(0n, 11_666_167_218n, 137_681_432_922_138_899n),
);
const FUN_REDEEMED_POOL_1 = pool(
  FIXTURE_POOL_1,
  EPOCH_3_POOL_1_RATE,
  position(0n, 86n, 1_108_112_163n),
  position(0n, 3_499_999_844n, 45_097_586_030_998_877n),
);

/** Every Move-printed event, decoded by hand from the scenario. */
const expectedPayloads: {
  [Kind in BlastSuiEventKind]: BlastSuiEventPayloads[Kind];
} = {
  VaultCreated: {
    vault_id: FIXTURE_VAULT_ID,
    validator:
      "0x5ef2fcf809fb9535ea0aeaea421f683026f06c34569aafc42bcde652ef6dd270",
    pool_id: FIXTURE_POOL_0,
    fun_reserve_sui: RESERVE,
    bootstrap_sui: 10n * SUI,
    locked_blast_sui: 10n * SUI,
    redeem_fee_bps: 2n as BasisPoints,
    custody: vaultCustody(RESERVE, 0n, [BOOTSTRAP_POOL], 0n, 10n * SUI),
  },
  VaultSynced: {
    custody: vaultCustody(
      RESERVE,
      0n,
      [BOOTSTRAP_POOL, pool(FIXTURE_POOL_1, GENESIS_RATE, EMPTY, EMPTY)],
      0n,
      10n * SUI,
    ),
  },
  FunSuiMinted: {
    pool_id: FIXTURE_POOL_1,
    sui_in: 2n * SUI,
    delegated_sui: 2n * SUI,
    custody: vaultCustody(RESERVE, 0n, MINTED_POOLS, 2n * SUI, 10n * SUI),
  },
  BlastSuiDepositRequested: {
    receipt_id: FIXTURE_RECEIPT_ID,
    vault_id: FIXTURE_VAULT_ID,
    pool_id: FIXTURE_POOL_0,
    principal_sui: 3n * SUI,
    activation_epoch: 2n,
    custody: vaultCustody(RESERVE, 0n, MINTED_POOLS, 2n * SUI, 10n * SUI),
  },
  FunReserveToppedUp: {
    sui_in: SUI / 2n,
    custody: vaultCustody(6n * RESERVE, 0n, MINTED_POOLS, 2n * SUI, 10n * SUI),
  },
  BlastSuiDonated: {
    sui_in: SUI,
    custody: vaultCustody(
      RESERVE,
      0n,
      [
        BOOTSTRAP_POOL,
        pool(
          FIXTURE_POOL_1,
          GENESIS_RATE,
          position(2n * SUI, 0n, 0n),
          position(1_500_000_000n, 0n, 0n),
        ),
      ],
      2n * SUI,
      10n * SUI,
    ),
  },
  BlastSuiDepositClaimed: {
    receipt_id: FIXTURE_RECEIPT_ID,
    vault_id: FIXTURE_VAULT_ID,
    principal_sui: 3n * SUI,
    contributed_sui: 3n * SUI,
    claimed_pool_tokens: 3n * SUI,
    blast_out: 2_608_695_652n,
    custody: vaultCustody(
      RESERVE,
      0n,
      [
        pool(
          FIXTURE_POOL_0,
          [2n, 113n * SUI, 113n * SUI],
          EMPTY,
          position(0n, 13n * SUI, 13n * SUI),
        ),
        pool(
          FIXTURE_POOL_1,
          [2n, 103_500_000_000n, 103_500_000_000n],
          position(0n, 2n * SUI, 2n * SUI),
          position(0n, 1_500_000_000n, 1_500_000_000n),
        ),
      ],
      2n * SUI,
      12_608_695_652n,
    ),
  },
  FunYieldSwept: {
    swept_liquid_sui: 0n,
    swept_active_sui: 25_770_048_299_114_819n,
    swept_sui: 25_770_048_299_114_819n,
    custody: vaultCustody(
      RESERVE,
      0n,
      [
        pool(
          FIXTURE_POOL_0,
          EPOCH_3_POOL_0_RATE,
          EMPTY,
          position(0n, 13n * SUI, 153_423_021_849_557_522n),
        ),
        pool(
          FIXTURE_POOL_1,
          EPOCH_3_POOL_1_RATE,
          position(0n, 156n, 2_010_063_924n),
          position(0n, 3_499_999_844n, 45_097_586_030_998_877n),
        ),
      ],
      2n * SUI,
      12_608_695_652n,
    ),
  },
  FunSuiRedeemed: {
    fun_in: SUI,
    custody: vaultCustody(
      1_951_760n,
      0n,
      [
        pool(
          FIXTURE_POOL_0,
          EPOCH_3_POOL_0_RATE,
          EMPTY,
          position(0n, 13n * SUI, 153_423_021_849_557_522n),
        ),
        FUN_REDEEMED_POOL_1,
      ],
      SUI,
      12_608_695_652n,
    ),
  },
  BlastSuiRedeemed: {
    blast_in: SUI,
    gross_sui: 15_744_737_866_606_124n,
    fee_sui: 3_148_947_573_322n,
    net_sui: 15_741_588_919_032_802n,
    custody: vaultCustody(
      1_951_760n,
      8_385_820n,
      [REDEEMED_POOL_0, FUN_REDEEMED_POOL_1],
      SUI,
      11_608_695_652n,
    ),
  },
  BlastSuiDepositCancelled: {
    receipt_id:
      "0xd1f922e3cb6c9213b400810a6aa63cd6ccc67dac3d702b8eb7032e447456996b",
    vault_id: FIXTURE_VAULT_ID,
    principal_sui: 2n * SUI,
    returned_sui: 2n * SUI,
  },
  PoolUnwound: {
    pool_id: FIXTURE_POOL_1,
    custody: vaultCustody(
      1_110_063_923n,
      45_097_586_039_384_697n,
      [REDEEMED_POOL_0],
      SUI,
      11_608_695_652n,
    ),
  },
};

test("matches the complete frozen blast_sui event inventory and field order", () => {
  assert.deepEqual(Object.keys(blastSuiEventSpecs), [
    "BlastSuiDepositCancelled",
    "BlastSuiDepositClaimed",
    "BlastSuiDepositRequested",
    "BlastSuiDonated",
    "BlastSuiRedeemed",
    "FunReserveToppedUp",
    "FunSuiMinted",
    "FunSuiRedeemed",
    "FunYieldSwept",
    "PoolUnwound",
    "VaultCreated",
    "VaultSynced",
  ]);
  assert.deepEqual(
    Object.keys(BLAST_SUI_FIXTURE.events).sort(),
    Object.keys(blastSuiEventSpecs),
  );
  assert.deepEqual(specFields(), frozenEventFields());
});

test("matches the ordered nested custody fields and BCS layout", () => {
  assert.deepEqual(frozenNestedFields(), {
    ExchangeRate: [
      ["epoch", "u64"],
      ["sui_amount", "u64"],
      ["pool_token_amount", "u64"],
    ],
    PoolSnapshot: [
      ["pool_id", "id"],
      ["exchange_rate", "ExchangeRate"],
      ["fun_position", "PositionCustody"],
      ["blast_position", "PositionCustody"],
    ],
    PositionCustody: [
      ["pending_sui", "u64"],
      ["active_pool_tokens", "u64"],
      ["active_sui", "u64"],
    ],
    VaultCustody: [
      ["fun_liquid", "u64"],
      ["blast_liquid", "u64"],
      ["pools", "vector<PoolSnapshot>"],
      ["fun_supply", "u64"],
      ["blast_supply", "u64"],
    ],
  });

  const poolId = normalizeSuiObjectId("0x55");
  const snapshot = pool(
    poolId,
    [31n, 32n, 33n],
    position(11n, 12n, 13n),
    position(21n, 22n, 23n),
  );
  assert.deepEqual(
    positionCustodyEventBcs.serialize(position(11n, 12n, 13n)).toBytes(),
    u64s([11n, 12n, 13n]),
  );
  assert.deepEqual(
    exchangeRateEventBcs
      .serialize({ epoch: 31n, sui_amount: 32n, pool_token_amount: 33n })
      .toBytes(),
    u64s([31n, 32n, 33n]),
  );
  const snapshotBytes = concat(
    bcs.Address.serialize(poolId).toBytes(),
    u64s([31n, 32n, 33n, 11n, 12n, 13n, 21n, 22n, 23n]),
  );
  assert.deepEqual(
    poolSnapshotEventBcs.serialize(snapshot).toBytes(),
    snapshotBytes,
  );
  assert.deepEqual(
    vaultCustodyEventBcs
      .serialize(vaultCustody(1n, 2n, [snapshot, snapshot], 3n, 4n))
      .toBytes(),
    concat(
      u64s([1n, 2n]),
      new Uint8Array([2]),
      snapshotBytes,
      snapshotBytes,
      u64s([3n, 4n]),
    ),
  );
  assert.deepEqual(
    vaultCustodyEventBcs.parse(
      vaultCustodyEventBcs
        .serialize(vaultCustody(1n, 2n, [], 3n, 4n))
        .toBytes(),
    ),
    vaultCustody(1n, 2n, [], 3n, 4n),
  );
});

test("decodes every Move-printed blast_sui event to its exact payload", () => {
  const kinds = Object.keys(blastSuiEventSpecs) as BlastSuiEventKind[];
  for (const [eventIndex, kind] of kinds.entries()) {
    const bytes = fixtureEventBytes(kind);
    const event = decodeBlastSuiEvent(
      blastSuiEventEntry(kind, bytes, packages, eventIndex),
      packages,
    );

    assert.equal(event.source, "blastSui");
    assert.equal(event.kind, kind);
    assert.deepEqual(event.payload, expectedPayloads[kind], kind);
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
    // The SDK layout re-encodes the Move bytes exactly.
    assert.deepEqual(
      (
        blastSuiEventBcs[kind] as unknown as {
          serialize(value: unknown): { toBytes(): Uint8Array };
        }
      )
        .serialize(event.payload)
        .toBytes(),
      bytes,
      kind,
    );
  }
});

test("the fixture events follow the scenario's custody accounting", () => {
  const { BlastSuiRedeemed: redeemed, PoolUnwound: unwound } = expectedPayloads;
  assert.equal(redeemed.gross_sui, redeemed.fee_sui + redeemed.net_sui);
  // Removing pool 1 moves each ledger's active SUI there into its liquid SUI.
  const removed = redeemed.custody.pools[1];
  assert.ok(removed);
  assert.equal(removed.pool_id, unwound.pool_id);
  assert.equal(
    unwound.custody.fun_liquid,
    redeemed.custody.fun_liquid + removed.fun_position.active_sui,
  );
  assert.equal(
    unwound.custody.blast_liquid,
    redeemed.custody.blast_liquid + removed.blast_position.active_sui,
  );
  assert.deepEqual(
    unwound.custody.pools.map((snapshot) => snapshot.pool_id),
    [FIXTURE_POOL_0],
  );
  // The top-up raises funSUI liquid SUI by exactly its input.
  assert.equal(
    expectedPayloads.FunReserveToppedUp.custody.fun_liquid -
      expectedPayloads.BlastSuiDepositRequested.custody.fun_liquid,
    expectedPayloads.FunReserveToppedUp.sui_in,
  );
});

test("requires current emitter and original wrapper/payload identities", () => {
  const valid = blastSuiEventEntry(
    "VaultSynced",
    fixtureEventBytes("VaultSynced"),
    packages,
    0,
  );
  const original = normalizeSuiObjectId(packages.originalPackageId);
  const foreign = normalizeSuiObjectId("0x999");

  assert.throws(
    () => decodeBlastSuiEvent({ ...valid, packageId: "0x999" }, packages),
    /unexpected emitter package/,
  );
  assert.throws(
    () => decodeBlastSuiEvent({ ...valid, module: "events" }, packages),
    /unexpected emitter module/,
  );
  for (const eventType of [
    `${foreign}::blast_events::Event<${original}::events::VaultSynced>`,
    `${original}::wrong_wrapper::Event<${original}::events::VaultSynced>`,
    `${original}::blast_events::Wrong<${original}::events::VaultSynced>`,
  ]) {
    assert.throws(
      () => decodeBlastSuiEvent({ ...valid, eventType }, packages),
      /unexpected event package/,
    );
  }
  for (const eventType of [
    `${original}::blast_events::Event<${original}::wrong_events::VaultSynced>`,
    `${original}::blast_events::Event<${foreign}::events::VaultSynced>`,
    `${original}::blast_events::Event<${original}::events::RedeemFeeChanged>`,
    `${original}::blast_events::Event<${original}::events::NativeStakeUnwound>`,
  ]) {
    assert.throws(
      () => decodeBlastSuiEvent({ ...valid, eventType }, packages),
      /unexpected payload type/,
    );
  }
});

test("rejects malformed BCS and invalid native event metadata", () => {
  const valid = blastSuiEventEntry(
    "VaultSynced",
    fixtureEventBytes("VaultSynced"),
    packages,
    0,
  );

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

test("validates the VaultCreated redeem fee as basis points", () => {
  const created = expectedPayloads.VaultCreated;
  acceptsBasisPoints(created.redeem_fee_bps);
  assert.throws(() =>
    blastSuiEventBcs.VaultCreated.serialize({
      ...created,
      redeem_fee_bps: 10_001n,
    }),
  );

  // Rewrite the fee in the Move bytes: it follows three IDs and three u64s.
  const bytes = fixtureEventBytes("VaultCreated");
  const offset = 3 * 32 + 3 * 8;
  assert.deepEqual(bytes.slice(offset, offset + 8), u64s([2n]));
  bytes.set(u64s([10_001n]), offset);
  assert.throws(
    () =>
      decodeBlastSuiEvent(
        blastSuiEventEntry("VaultCreated", bytes, packages, 0),
        packages,
      ),
    /basis points/,
  );
});

test("decodes the vault's delayed redeem fee and validator set events", () => {
  const parent = FIXTURE_VAULT_ID;
  const blastSui = { originalPackageId: packages.originalPackageId, admin };
  const cases = [
    {
      kind: "DelayedCreated",
      name: "RedeemFee",
      payload: { parent, key: null, value: 2n, delay_ms: 172_800_000n },
    },
    {
      kind: "DelayedScheduled",
      name: "RedeemFee",
      payload: {
        parent,
        key: null,
        value: 7n,
        delay_ms: 172_800_000n,
        ready_at_ms: 172_801_000n,
      },
    },
    {
      kind: "DelayedCancelled",
      name: "RedeemFee",
      payload: {
        parent,
        key: null,
        value: 7n,
        delay_ms: 172_800_000n,
        ready_at_ms: 172_801_000n,
      },
    },
    {
      kind: "DelayedApplied",
      name: "RedeemFee",
      payload: {
        parent,
        key: null,
        previous_value: 2n,
        value: 7n,
        delay_ms: 172_800_000n,
      },
    },
    {
      kind: "SetCreated",
      name: "Validators",
      payload: { parent, key: null, delay_ms: 0n },
    },
    {
      kind: "SetScheduled",
      name: "Validators",
      payload: {
        parent,
        key: null,
        change: { kind: "Admission", member: FIXTURE_POOL_2 },
        delay_ms: 0n,
        ready_at_ms: 1_000n,
      },
    },
    {
      kind: "SetScheduled",
      name: "Validators",
      payload: {
        parent,
        key: null,
        change: { kind: "Delay" },
        delay_ms: 172_800_000n,
        ready_at_ms: 1_000n,
      },
    },
    {
      kind: "SetApplied",
      name: "Validators",
      payload: {
        parent,
        key: null,
        change: { kind: "Admission", member: FIXTURE_POOL_1 },
        delay_ms: 0n,
      },
    },
    {
      kind: "MemberRemoved",
      name: "Validators",
      payload: { parent, key: null, member: FIXTURE_POOL_1 },
    },
  ] as const;

  for (const [eventIndex, { kind, name, payload }] of cases.entries()) {
    const event = decodeBlastSuiDelayedEvent(
      blastSuiDelayedEntry(kind, name, payload, delayedIdentity, eventIndex),
      blastSui,
    );
    assert.equal(event.source, "delayed");
    assert.equal(event.kind, kind);
    assert.equal(event.name, name);
    assert.deepEqual(event.payload, payload);
    assert.equal(event.sender, normalizeSuiAddress("0x16"));
    assert.deepEqual(event.position, {
      checkpoint: 10n,
      transactionDigest: `delayed-${eventIndex}`,
      eventIndex,
    });
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(blastSuiDelayedKeys).map(([name, spec]) => [
        name,
        [spec.key, spec.family, spec.valueType],
      ]),
    ),
    {
      RedeemFee: ["vault::RedeemFeeKey", "setting", "u64"],
      Validators: ["vault::ValidatorKey", "set", "0x2::object::ID"],
    },
  );
});

test("rejects delayed events of another admin package, key or family", () => {
  const blastSui = { originalPackageId: packages.originalPackageId, admin };
  const valid = blastSuiDelayedEntry(
    "DelayedCreated",
    "RedeemFee",
    { parent: FIXTURE_VAULT_ID, key: null, value: 2n, delay_ms: 1n },
    delayedIdentity,
    0,
  );

  assert.throws(
    () =>
      decodeBlastSuiDelayedEvent(valid, {
        ...blastSui,
        admin: { ...admin, packageId: "0xae" },
      }),
    /unexpected delayed event type/,
  );
  assert.throws(
    () =>
      decodeBlastSuiDelayedEvent(valid, {
        ...blastSui,
        originalPackageId: "0x999",
      }),
    /unexpected delayed event key/,
  );
  const adminId = normalizeSuiAddress(admin.packageId);
  const original = normalizeSuiAddress(packages.originalPackageId);
  for (const eventType of [
    `${adminId}::delayed::DelayedCreated<${original}::vault::OtherKey, u64>`,
    // A setting kind under the set key.
    `${adminId}::delayed::DelayedCreated<${original}::vault::ValidatorKey, 0x2::object::ID>`,
    // The fee key with a value type other than u64.
    `${adminId}::delayed::DelayedCreated<${original}::vault::RedeemFeeKey, u8>`,
  ]) {
    assert.throws(
      () => decodeBlastSuiDelayedEvent({ ...valid, eventType }, blastSui),
      /unexpected delayed event key/,
    );
  }
});

function specFields(): Record<string, Array<[string, string]>> {
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

type AbiField = { name: string; type: unknown };
type AbiStruct = { name: string; fields: AbiField[] };

function frozenEventFields(): Record<string, Array<[string, string]>> {
  return Object.fromEntries(
    readFrozenEventsModule().events.map((event) => [
      event.name,
      event.fields.map(
        (field) => [field.name, abiType(field.type)] as [string, string],
      ),
    ]),
  );
}

function frozenNestedFields(): Record<string, Array<[string, string]>> {
  return Object.fromEntries(
    readFrozenEventsModule().structs.map((struct) => [
      struct.name,
      struct.fields.map(
        (field) => [field.name, nestedType(field.type)] as [string, string],
      ),
    ]),
  );
}

function readFrozenEventsModule(): {
  events: AbiStruct[];
  structs: AbiStruct[];
} {
  const artifact = JSON.parse(
    readFileSync(
      new URL("../abi/production-blast-sui-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    packages: {
      blastSui: {
        modules: { events: { events: AbiStruct[]; structs: AbiStruct[] } };
      };
    };
  };
  return artifact.packages.blastSui.modules.events;
}

function abiType(type: unknown): string {
  if (type === "u64" || type === "address") return type;
  const name = datatypeName(type);
  if (name === "ID") return "id";
  if (name === "VaultCustody") return "vaultCustody";
  throw new TypeError(`unsupported ABI event field: ${JSON.stringify(type)}`);
}

function nestedType(type: unknown): string {
  if (type === "u64") return type;
  if (isRecord(type) && "vector" in type) {
    return `vector<${nestedType(type.vector)}>`;
  }
  const name = datatypeName(type);
  return name === "ID" ? "id" : name;
}

function datatypeName(type: unknown): string {
  if (!isRecord(type) || !isRecord(type.Datatype)) {
    throw new TypeError(`unsupported ABI type: ${JSON.stringify(type)}`);
  }
  return String(type.Datatype.name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function u64s(values: readonly bigint[]): Uint8Array {
  return concat(...values.map((value) => bcs.u64().serialize(value).toBytes()));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

function acceptsBasisPoints(_value: BasisPoints): void {}
