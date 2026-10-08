import assert from "node:assert/strict";
import test from "node:test";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, toHex } from "@mysten/sui/utils";
import type {
  BlastDeploymentInput,
  DeploymentRejectionCode,
} from "../src/deployments/index.ts";

import {
  BluefinPoolCreationFeeError,
  defineBlastDeployment,
  evaluateProtocolAccess,
  getBluefinPoolCreationFee,
  migratorsDeployment,
  resolveVenueObjects,
  VenueUnavailableError,
} from "../src/deployments/index.ts";
import {
  MigratorCalls,
  MigratorTransactions,
} from "../src/migrators/transactions.ts";
import {
  BLUEFIN_FEE_SNAPSHOT,
  manifestWithVenues,
  runtimeFor,
  VENUE_LINEAGE,
} from "./fixtures/venue-deployment.ts";

/** Each venue's set as manifest paths; its objects live under its own group. */
const VENUE_KEYS = {
  cetus: [
    "packages.cetusClmm",
    "packages.cetusLpBurn",
    "sharedObjects.cetus.config",
    "sharedObjects.cetus.pools",
    "sharedObjects.cetus.burnManager",
  ],
  bluefin: ["packages.bluefinSpot", "sharedObjects.bluefin.config"],
} as const;

/** The value at a dotted manifest path, or undefined. */
function at(manifest: BlastDeploymentInput, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) => (value as Record<string, unknown> | undefined)?.[key],
      manifest,
    );
}

function without(
  manifest: BlastDeploymentInput,
  paths: readonly string[],
): BlastDeploymentInput {
  const copy = structuredClone(manifest) as unknown as Record<string, unknown>;
  for (const path of paths) {
    const keys = path.split(".");
    const last = keys.pop()!;
    const parent = keys.reduce<Record<string, unknown>>(
      (value, key) => value[key] as Record<string, unknown>,
      copy,
    );
    delete parent[last];
  }
  return copy as unknown as BlastDeploymentInput;
}

test("normalizes a complete Cetus set, a complete Bluefin set, or both", () => {
  for (const venues of [
    ["cetus"],
    ["bluefin"],
    ["cetus", "bluefin"],
  ] as const) {
    const deployment = defineBlastDeployment(manifestWithVenues(venues));
    for (const venue of venues) {
      for (const path of VENUE_KEYS[venue]) {
        assert.ok(
          at(deployment as unknown as BlastDeploymentInput, path),
          `${venues} ${path}`,
        );
      }
    }
  }
  // The fixture runtime reports each venue object at its snapshot type.
  const runtime = runtimeFor(manifestWithVenues(["cetus", "bluefin"]));
  for (const [name, type] of Object.entries(VENUE_LINEAGE.types)) {
    assert.equal(runtime.sharedObjects[name]?.type, type, name);
  }
});

test("rejects every partial venue set as an invalid manifest that disables everything", () => {
  for (const venue of ["cetus", "bluefin"] as const) {
    const complete = manifestWithVenues([venue]);
    const keys = VENUE_KEYS[venue];
    const partials = [
      ...keys.map((key) => [key]),
      ...keys.map((key) => keys.filter((other) => other !== key)),
    ];
    for (const removed of partials) {
      const partial = without(complete, removed);
      assert.throws(
        () => defineBlastDeployment(partial),
        { name: "DeploymentManifestError", code: "invalid-manifest" },
        `${venue} without ${removed}`,
      );
      const access = evaluateProtocolAccess({
        manifest: partial,
        mode: "non-production",
        runtime: runtimeFor(complete),
      });
      assert.equal(access.signing, "disabled");
      assert.deepEqual(
        access.signing === "disabled" && access.reasons.map(({ code }) => code),
        ["invalid-manifest"],
      );
      assert.equal(access.venues.cetus.available, false);
      assert.equal(access.venues.bluefin.available, false);
    }
  }
});

const BOTH = manifestWithVenues(["cetus", "bluefin"]);
/** Evaluates `manifest` against `runtime`; `null` observes nothing. */
const evaluate = (
  manifest: BlastDeploymentInput,
  runtime: ReturnType<typeof runtimeFor> | null = runtimeFor(manifest),
) =>
  evaluateProtocolAccess({
    manifest,
    mode: "non-production",
    ...(runtime && { runtime }),
  });
const venueCodes = (
  access: ReturnType<typeof evaluate>,
  venue: "cetus" | "bluefin",
) => {
  const availability = access.venues[venue];
  return availability.available ? [] : availability.reasons.map((r) => r.code);
};

test("enables both venues when both complete sets match the runtime", () => {
  const access = evaluate(BOTH);
  assert.equal(access.signing, "enabled");
  assert.deepEqual(access.venues, {
    cetus: { available: true },
    bluefin: { available: true },
  });
});

test("disables only the venue whose route has no recorded set", () => {
  // The base manifest routes Bluefin; only the Cetus set is recorded.
  const access = evaluate(manifestWithVenues(["cetus"]));
  assert.equal(access.signing, "enabled");
  assert.deepEqual(venueCodes(access, "cetus"), []);
  assert.deepEqual(venueCodes(access, "bluefin"), ["venue-unrecorded"]);
  const noRoute = {
    ...BOTH,
    routes: BOTH.routes.filter((r) => r.venue !== "bluefin"),
  };
  const unrouted = evaluate(noRoute);
  assert.equal(unrouted.signing, "enabled");
  assert.deepEqual(venueCodes(unrouted, "cetus"), []);
  assert.deepEqual(venueCodes(unrouted, "bluefin"), ["venue-not-routed"]);
});

test("disables only the venue whose object has another type or lineage, or was not observed", () => {
  const foreign = `0x${"9".repeat(64)}`;
  const cases = [
    [
      "cetus.config",
      "cetus",
      `${foreign}::config::GlobalConfig`,
      "foreign-lineage",
    ],
    ["cetus.pools", "cetus", `${foreign}::factory::Pools`, "foreign-lineage"],
    [
      "cetus.burnManager",
      "cetus",
      `${VENUE_LINEAGE.packages.cetusClmm.originalPackageId}::lp_burn::BurnManager`,
      "foreign-lineage",
    ],
    [
      "cetus.pools",
      "cetus",
      `${VENUE_LINEAGE.packages.cetusClmm.originalPackageId}::config::GlobalConfig`,
      "runtime-mismatch",
    ],
    [
      "bluefin.config",
      "bluefin",
      `${foreign}::config::GlobalConfig`,
      "foreign-lineage",
    ],
    [
      "bluefin.config",
      "bluefin",
      `${VENUE_LINEAGE.packages.bluefinSpot.originalPackageId}::pool::Pool`,
      "runtime-mismatch",
    ],
    ["bluefin.config", "bluefin", null, "runtime-unverified"],
  ] as const;
  for (const [name, venue, type, code] of cases) {
    const runtime = runtimeFor(BOTH);
    if (type === null) delete runtime.sharedObjects[name];
    else runtime.sharedObjects[name]!.type = type;
    const access = evaluate(BOTH, runtime);
    const other = venue === "cetus" ? "bluefin" : "cetus";
    assert.equal(access.signing, "enabled", `${name} ${type}`);
    assert.deepEqual(venueCodes(access, venue), [code], `${name} ${type}`);
    assert.deepEqual(venueCodes(access, other), [], `${name} ${type}`);
  }
});

test("keeps every core reason global and marks both venues unavailable", () => {
  const runtime = runtimeFor(BOTH);
  const chain = { ...runtime, chainIdentifier: "other-chain" };
  const movedVenue = structuredClone(runtime);
  movedVenue.sharedObjects["cetus.pools"]!.initialSharedVersion = "1";
  const movedCore = structuredClone(runtime);
  movedCore.sharedObjects["launchpad.launchConfig"]!.initialSharedVersion =
    "99";
  const foreignCore = structuredClone(runtime);
  foreignCore.sharedObjects["migrators.lpFeePolicy"]!.type =
    `0x${"9".repeat(64)}::lp_fee_policy::LpFeePolicy`;
  const otherCommit = {
    ...BOTH,
    source: { ...BOTH.source, contractsCommit: "9".repeat(40) },
  };
  const cases: [
    BlastDeploymentInput,
    ReturnType<typeof runtimeFor> | null,
    DeploymentRejectionCode,
  ][] = [
    [BOTH, chain, "runtime-mismatch"],
    [BOTH, movedVenue, "runtime-mismatch"],
    [BOTH, movedCore, "runtime-mismatch"],
    [BOTH, foreignCore, "foreign-lineage"],
    [BOTH, null, "runtime-unverified"],
    [otherCommit, runtimeFor(otherCommit), "abi-mismatch"],
  ];
  for (const [manifest, observed, code] of cases) {
    const access = evaluate(manifest, observed);
    assert.equal(access.signing, "disabled", code);
    assert.ok(
      access.signing === "disabled" &&
        access.reasons.some((entry) => entry.code === code),
      code,
    );
    for (const venue of ["cetus", "bluefin"] as const) {
      assert.ok(venueCodes(access, venue).includes(code), `${venue} ${code}`);
    }
  }
  const production = evaluateProtocolAccess({
    manifest: BOTH,
    mode: "production",
    runtime,
  });
  assert.equal(production.signing, "disabled");
  assert.ok(venueCodes(production, "cetus").includes("environment-mismatch"));
  assert.ok(venueCodes(production, "bluefin").includes("environment-mismatch"));
});

/** Each shared input of `tx` as `objectId -> mutable`. */
function sharedInputs(tx: Transaction): Record<string, boolean> {
  return Object.fromEntries(
    tx
      .getData()
      .inputs.flatMap((input) =>
        input.$kind === "Object" && input.Object.$kind === "SharedObject"
          ? [
              [
                input.Object.SharedObject.objectId,
                input.Object.SharedObject.mutable,
              ],
            ]
          : [],
      ),
  );
}

test("resolves each available venue's objects into the builders' typed inputs", () => {
  const access = evaluate(BOTH);
  const cetus = resolveVenueObjects(access, "cetus");
  const bluefin = resolveVenueObjects(access, "bluefin");
  const { sharedObjects: venueObjects, packages } = VENUE_LINEAGE;
  /** Each venue object under the short name its builder input uses. */
  const ids = {
    cetusConfig: venueObjects.cetus.config,
    cetusPools: venueObjects.cetus.pools,
    cetusBurnManager: venueObjects.cetus.burnManager,
    bluefinConfig: venueObjects.bluefin.config,
  };
  const ref = <const M extends boolean>(
    identity: { objectId: string; initialSharedVersion: string },
    mutable: M,
  ) => ({ ...identity, mutable });
  assert.deepEqual(cetus, {
    venue: "cetus",
    packages: {
      cetusClmm: packages.cetusClmm,
      cetusLpBurn: packages.cetusLpBurn,
    },
    create: {
      cetusConfig: ref(ids.cetusConfig, false),
      cetusPools: ref(ids.cetusPools, true),
    },
    migrate: {
      cetusConfig: ref(ids.cetusConfig, false),
      cetusPools: ref(ids.cetusPools, true),
      burnManager: ref(ids.cetusBurnManager, true),
    },
    fees: {
      cetusConfig: ref(ids.cetusConfig, false),
      burnManager: ref(ids.cetusBurnManager, false),
    },
    buyback: { cetusConfig: ref(ids.cetusConfig, false) },
  });
  assert.deepEqual(bluefin, {
    venue: "bluefin",
    packages: { bluefinSpot: packages.bluefinSpot },
    migrate: { bluefinConfig: ref(ids.bluefinConfig, true) },
    fees: { bluefinConfig: ref(ids.bluefinConfig, false) },
    buyback: { bluefinConfig: ref(ids.bluefinConfig, false) },
  });

  // The builders accept them as given, each at the mutability its call takes.
  assert.ok(access.signing === "enabled");
  const migrators = migratorsDeployment(access.deployment);
  const calls = new MigratorCalls(migrators);
  const sdk = new MigratorTransactions(migrators);
  const types = { memeType: "0xa::meme::MEME", quoteType: "0x2::sui::SUI" };
  const shared = <const M extends boolean>(id: string, mutable: M) => ({
    objectId: id,
    initialSharedVersion: "7",
    mutable,
  });
  const created = new Transaction();
  created.add(
    calls.newCetusLaunch({
      ...types,
      ...cetus.create,
      ticket: "0xb",
      tickSpacing: 200,
    }),
  );
  const migrated = sdk.migrateCetus({
    ...types,
    ...cetus.migrate,
    memeSide: "b",
    launch: shared("0xe1", true),
    memeCurrency: shared("0xe2", true),
  });
  const collected = sdk.collectCetusFees({
    ...types,
    ...cetus.fees,
    memeSide: "b",
    vault: shared("0xe3", true),
    memeCurrency: shared("0xe2", true),
    pool: shared("0xe4", true),
  });
  const bluefinMigrated = sdk.migrateBluefin({
    ...types,
    ...bluefin.migrate,
    launch: shared("0xe1", true),
    memeCurrency: shared("0xe2", true),
    quoteCurrency: shared("0xe5", false),
    creationFee: 0n,
  });
  const bluefinCollected = sdk.collectBluefinFees({
    ...types,
    ...bluefin.fees,
    vault: shared("0xe3", true),
    memeCurrency: shared("0xe2", true),
    pool: shared("0xe4", true),
  });
  const pick = (tx: Transaction, names: (keyof typeof ids)[]) => {
    const inputs = sharedInputs(tx);
    return Object.fromEntries(
      names.map((name) => [name, inputs[ids[name].objectId]]),
    );
  };
  assert.deepEqual(pick(created, ["cetusConfig", "cetusPools"]), {
    cetusConfig: false,
    cetusPools: true,
  });
  assert.deepEqual(
    pick(migrated, ["cetusConfig", "cetusPools", "cetusBurnManager"]),
    {
      cetusConfig: false,
      cetusPools: true,
      cetusBurnManager: true,
    },
  );
  assert.deepEqual(pick(collected, ["cetusConfig", "cetusBurnManager"]), {
    cetusConfig: false,
    cetusBurnManager: false,
  });
  assert.deepEqual(pick(bluefinMigrated, ["bluefinConfig"]), {
    bluefinConfig: true,
  });
  assert.deepEqual(pick(bluefinCollected, ["bluefinConfig"]), {
    bluefinConfig: false,
  });
});

test("refuses to resolve an unavailable venue, with that venue's reasons", () => {
  const cetusOnly = evaluate(manifestWithVenues(["cetus"]));
  assert.ok(resolveVenueObjects(cetusOnly, "cetus"));
  assert.throws(
    () => resolveVenueObjects(cetusOnly, "bluefin"),
    (error) =>
      error instanceof VenueUnavailableError &&
      error.venue === "bluefin" &&
      error.reasons.map(({ code }) => code).join() === "venue-unrecorded",
  );
  const disabled = evaluate(BOTH, null);
  for (const venue of ["cetus", "bluefin"] as const) {
    assert.throws(
      () => resolveVenueObjects(disabled, venue),
      (error) =>
        error instanceof VenueUnavailableError &&
        error.reasons.map(({ code }) => code).join() === "runtime-unverified",
    );
  }
});

/** A `dynamic_field::Field` object's contents split into its BCS name and value. */
function splitField(hex: string): { name: Uint8Array; value: Uint8Array } {
  const bytes = fromHex(hex);
  const nameLength = 1 + bytes[32]!; // ULEB length (< 128) and the string
  return {
    name: bytes.slice(32, 32 + nameLength),
    value: bytes.slice(32 + nameLength),
  };
}

const feeTable = splitField(BLUEFIN_FEE_SNAPSHOT.tableField);
const suiFee = splitField(BLUEFIN_FEE_SNAPSHOT.suiField);
/** The table's UID, the parent of its entries. */
const feeTableId = toHex(feeTable.value.slice(0, 32));

type FeeClientOptions = {
  configMissing?: boolean;
  configType?: string;
  tableField?: boolean;
  tableType?: string;
  entry?: Uint8Array | null;
};

const missingField = () =>
  new ObjectError("notExists", "missing", { reason: "notFound" });
const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  toHex(left) === toHex(right);

/** The stub's `getDynamicField`: the snapshot's fee table, then its SUI entry. */
function feeField(
  options: FeeClientOptions,
  {
    parentId,
    name,
  }: { parentId: string; name: { type: string; bcs: Uint8Array } },
) {
  assert.equal(name.type, "0x1::string::String");
  const config = VENUE_LINEAGE.sharedObjects.bluefin.config.objectId;
  if (parentId === config && sameBytes(name.bcs, feeTable.name)) {
    if (options.tableField === false) throw missingField();
    const type =
      options.tableType ?? "0x2::table::Table<0x1::string::String, u64>";
    return { dynamicField: { value: { type, bcs: feeTable.value } } };
  }
  if (parentId === `0x${feeTableId}` && sameBytes(name.bcs, suiFee.name)) {
    const entry = options.entry === undefined ? suiFee.value : options.entry;
    if (entry === null) throw missingField();
    return { dynamicField: { value: { type: "u64", bcs: entry } } };
  }
  throw missingField();
}

/** A Core API stub serving the snapshot's Bluefin config and fee fields. */
function feeClient(options: FeeClientOptions): ClientWithCoreApi {
  const bluefinConfig = VENUE_LINEAGE.sharedObjects.bluefin.config;
  return {
    core: {
      getObject: async ({ objectId }: { objectId: string }) => {
        assert.equal(objectId, bluefinConfig.objectId);
        if (options.configMissing) throw missingField();
        return {
          object: {
            objectId,
            type: options.configType ?? VENUE_LINEAGE.types["bluefin.config"],
            owner: {
              $kind: "Shared",
              Shared: {
                initialSharedVersion: bluefinConfig.initialSharedVersion,
              },
            },
          },
        };
      },
      getDynamicField: async (request: {
        parentId: string;
        name: { type: string; bcs: Uint8Array };
      }) => feeField(options, request),
    },
  } as unknown as ClientWithCoreApi;
}

test("reads Bluefin's exact SUI pool-creation fee from the recorded config", async () => {
  const deployment = defineBlastDeployment(BOTH);
  // The pinned snapshot holds a zero fee.
  assert.equal(await getBluefinPoolCreationFee(feeClient({}), deployment), 0n);
  // 2,000,000,000 MIST as a little-endian u64.
  const twoSui = fromHex("0094357700000000");
  assert.equal(
    await getBluefinPoolCreationFee(feeClient({ entry: twoSui }), deployment),
    2_000_000_000n,
  );
});

test("fails with a typed error for a missing config, field, entry, set, or a foreign config", async () => {
  const deployment = defineBlastDeployment(BOTH);
  const fails = async (
    code: string,
    client: ClientWithCoreApi,
    target = deployment,
  ) =>
    assert.rejects(
      getBluefinPoolCreationFee(client, target),
      (error) =>
        error instanceof BluefinPoolCreationFeeError && error.code === code,
      code,
    );
  await fails("config-missing", feeClient({ configMissing: true }));
  await fails("fee-field-missing", feeClient({ tableField: false }));
  await fails("fee-entry-missing", feeClient({ entry: null }));
  await fails(
    "fee-field-invalid",
    feeClient({ tableType: "0x2::table::Table<0x1::string::String, u128>" }),
  );
  await fails(
    "foreign-lineage",
    feeClient({ configType: `0x${"9".repeat(64)}::config::GlobalConfig` }),
  );
  await fails(
    "venue-unrecorded",
    feeClient({}),
    defineBlastDeployment(manifestWithVenues(["cetus"])),
  );
});
