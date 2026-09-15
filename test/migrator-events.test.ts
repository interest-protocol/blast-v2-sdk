import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { BcsType } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiObjectId } from "@mysten/sui/utils";
import type { LaunchpadEventKind } from "../src/launchpad/events.ts";
import {
  decodeLaunchpadEvent,
  launchpadEventBcs,
  launchpadEventSpecs,
} from "../src/launchpad/events.ts";
import type {
  MigratorEventKind,
  MigratorEventPackageIdentity,
} from "../src/migrators/events.ts";
import {
  decodeMigratorEvent,
  migratorEventBcs,
  migratorEventSpecs,
} from "../src/migrators/events.ts";
import {
  createLaunchpadProductProjection,
  reduceLaunchpadProductInput,
} from "../src/migrators/reducer.ts";

const launchpadPackages = { packageId: "0x123", originalPackageId: "0x122" };
const migratorPackages: MigratorEventPackageIdentity = {
  packageId: "0x321",
  originalPackageId: "0x320",
};

test("decodes and idempotently reduces every frozen migrator event", () => {
  assert.deepEqual(migratorEventSpecs, readFrozenMigratorEventSpecs());
  const kinds = Object.keys(migratorEventSpecs) as MigratorEventKind[];
  assert.equal(kinds.length, 15);

  let projection = createLaunchpadProductProjection();
  for (const [eventIndex, kind] of kinds.entries()) {
    const event = decodeMigratorEvent(
      migratorSuiEvent(kind, {}, eventIndex),
      migratorPackages,
    );
    assert.equal(event.kind, kind);
    const next = reduceLaunchpadProductInput(projection, event);
    assert.equal(next.migrators.eventCounts[kind], 1);
    assert.equal(reduceLaunchpadProductInput(next, event), next);
    projection = next;
  }
});

test("replays the launch-to-vault lifecycle and LP-fee snapshots", () => {
  const inputs = [
    launchpadDecoded(
      "LaunchTicketCreated",
      {
        ticket_id: "0xb",
        initial_supply: 1_000n,
      },
      0,
    ),
    launchpadDecoded(
      "LaunchCreated",
      {
        launch_id: "0xc",
        ticket_id: "0xb",
        meme_reserve: 800n,
      },
      1,
    ),
    launchpadDecoded(
      "Migrated",
      {
        launch_id: "0xc",
        migration_meme: 200n,
        migration_quote: 190n,
        disposed_meme: 610n,
      },
      2,
    ),
    migratorDecoded(
      "VaultCreated",
      {
        vault_id: "0xd",
        pool_id: "0xe",
        position_id: "0xf",
        venue: "0x320::cetus::Venue",
      },
      3,
    ),
    migratorDecoded(
      "MigrationCompleted",
      {
        launch_id: "0xc",
        vault_id: "0xd",
        pool_id: "0xe",
        venue: "0x320::cetus::Venue",
        source_meme_amount: 200n,
        source_quote_amount: 190n,
        used_meme_amount: 199n,
        used_quote_amount: 189n,
        residual_meme_amount: 1n,
        residual_quote_amount: 1n,
        sqrt_price_x64: 100n,
        tick_spacing: 260,
        fee_rate: 40_000n,
      },
      4,
    ),
    migratorDecoded(
      "LpFeesCollected",
      {
        vault_id: "0xd",
        pool_id: "0xe",
        position_id: "0xf",
        venue: "0x320::cetus::Venue",
        protocol_meme_fee_delta: 11n,
        creator_meme_fee_delta: 12n,
        protocol_quote_fee_delta: 13n,
        creator_quote_fee_delta: 14n,
        principal_liquidity: 1_000n,
      },
      5,
    ),
    migratorDecoded(
      "LpFeesCollected",
      {
        vault_id: "0xd",
        pool_id: "0xe",
        position_id: "0xf",
        venue: "0x320::cetus::Venue",
        protocol_meme_fee_delta: 2n,
        creator_meme_fee_delta: 3n,
        protocol_quote_fee_delta: 4n,
        creator_quote_fee_delta: 5n,
        principal_liquidity: 1_000n,
      },
      6,
    ),
    migratorDecoded(
      "CreatorFeesClaimed",
      {
        vault_id: "0xd",
      },
      7,
    ),
    migratorDecoded(
      "ProtocolFeesClaimed",
      {
        vault_id: "0xd",
      },
      8,
    ),
  ];

  const beforeCreatorClaim = inputs
    .slice(0, -2)
    .reduce(reduceLaunchpadProductInput, createLaunchpadProductProjection());
  const accruedVault =
    beforeCreatorClaim.migrators.vaults[normalizeSuiObjectId("0xd")];
  assert.equal(accruedVault?.protocolMemeFees, 13n);
  assert.equal(accruedVault?.creatorMemeFees, 15n);
  assert.equal(accruedVault?.protocolQuoteFees, 17n);
  assert.equal(accruedVault?.creatorQuoteFees, 19n);

  const beforeProtocolClaim = inputs
    .slice(0, -1)
    .reduce(reduceLaunchpadProductInput, createLaunchpadProductProjection());
  const beforeClaimVault =
    beforeProtocolClaim.migrators.vaults[normalizeSuiObjectId("0xd")];
  assert.equal(beforeClaimVault?.protocolMemeFees, 13n);
  assert.equal(beforeClaimVault?.creatorMemeFees, 0n);
  assert.equal(beforeClaimVault?.protocolQuoteFees, 17n);
  assert.equal(beforeClaimVault?.creatorQuoteFees, 0n);
  assert.equal(beforeClaimVault?.protocolMemeResidual, 1n);
  assert.equal(beforeClaimVault?.protocolQuoteResidual, 1n);

  const projection = reduceLaunchpadProductInput(
    beforeProtocolClaim,
    inputs.at(-1)!,
  );
  const launch = projection.launchpad.launches[normalizeSuiObjectId("0xc")];
  const vault = projection.migrators.vaults[normalizeSuiObjectId("0xd")];

  assert.equal(launch?.lifecycle, "Migrated");
  assert.equal(launch?.memeReserve, 0n);
  assert.equal(launch?.realQuoteReserve, 0n);
  assert.ok(vault);
  assert.equal(vault.launchId, normalizeSuiObjectId("0xc"));
  assert.equal(vault.poolId, normalizeSuiObjectId("0xe"));
  assert.equal(vault.positionId, normalizeSuiObjectId("0xf"));
  assert.equal(vault.protocolMemeFees, 0n);
  assert.equal(vault.creatorMemeFees, 0n);
  assert.equal(vault.protocolQuoteFees, 0n);
  assert.equal(vault.creatorQuoteFees, 0n);
  assert.equal(vault.protocolMemeResidual, 0n);
  assert.equal(vault.protocolQuoteResidual, 0n);
  assert.equal(vault.migration?.residualMemeAmount, 1n);
  assert.equal(vault.migration?.residualQuoteAmount, 1n);
  assert.equal(vault.principalLiquidity, 1_000n);
});

test("replays Aftermath policy and locked weighted-pool migration facts", () => {
  const inputs = [
    migratorDecoded(
      "AftermathPolicyUpdated",
      {
        old_meme_weight: 500_000_000_000_000_000n,
        old_quote_weight: 500_000_000_000_000_000n,
        old_dao_fee_bps: 200,
        new_meme_weight: 600_000_000_000_000_000n,
        new_quote_weight: 400_000_000_000_000_000n,
        new_dao_fee_bps: 300,
      },
      0,
    ),
    migratorDecoded(
      "VaultCreated",
      {
        vault_id: "0xd",
        pool_id: "0xe",
        position_id: "0xf",
        venue: "0x320::aftermath::Venue",
        meme: "0xa::meme::MEME",
        quote: "0x2::sui::SUI",
      },
      1,
    ),
    migratorDecoded(
      "AftermathMigrationCompleted",
      {
        launch_id: "0xc",
        vault_id: "0xd",
        inner_pool_id: "0x10",
        dao_fee_pool_id: "0xe",
        venue: "0x320::aftermath::Venue",
        lp: "0x30::af_lp::AF_LP",
        meme: "0xa::meme::MEME",
        quote: "0x2::sui::SUI",
        meme_amount: 200n,
        quote_amount: 190n,
        locked_lp_amount: 180n,
        meme_weight: 600_000_000_000_000_000n,
        quote_weight: 400_000_000_000_000_000n,
        flatness: 0n,
        swap_in_fee: 100_000_000_000_000n,
        dao_fee_bps: 300,
      },
      2,
    ),
    migratorDecoded(
      "AftermathDaoFeeUpdated",
      {
        vault_id: "0xd",
        dao_fee_pool_id: "0xe",
        old_dao_fee_bps: 300,
        new_dao_fee_bps: 350,
      },
      3,
    ),
  ];

  const projection = inputs.reduce(
    reduceLaunchpadProductInput,
    createLaunchpadProductProjection(),
  );
  const vault = projection.migrators.vaults[normalizeSuiObjectId("0xd")];

  assert.deepEqual(projection.migrators.aftermathPolicy, {
    memeWeight: 600_000_000_000_000_000n,
    quoteWeight: 400_000_000_000_000_000n,
    daoFeeBps: 300,
    source: "override",
  });
  assert.ok(vault?.migration?.kind === "aftermath");
  assert.equal(vault.migration.lockedLpAmount, 180n);
  assert.equal(vault.migration.memeWeight, 600_000_000_000_000_000n);
  assert.equal(vault.migration.quoteWeight, 400_000_000_000_000_000n);
  assert.equal(vault.migration.innerPoolId, normalizeSuiObjectId("0x10"));
  assert.equal(vault.migration.daoFeePoolId, normalizeSuiObjectId("0xe"));
  assert.equal(vault.migration.swapInFee, 100_000_000_000_000n);
  assert.equal(vault.migration.daoFeeBps, 350);
  assert.equal(vault.protocolMemeResidual, 0n);
  assert.equal(vault.protocolQuoteResidual, 0n);
});

test("replays migration-born LP-fee claims, reissuance, and custodian locks", () => {
  const vaultId = normalizeSuiObjectId("0xd");
  const created = reduceLaunchpadProductInput(
    createLaunchpadProductProjection(),
    migratorDecoded("VaultCreated", { vault_id: "0xd" }, 0),
  );
  assert.deepEqual(created.migrators.vaults[vaultId]?.lpFeeAuthority, {
    kind: "pending",
  });

  const claimed = reduceLaunchpadProductInput(
    created,
    migratorDecoded(
      "LpFeeCapClaimed",
      { vault_id: "0xd", lp_fee_cap_id: "0x20", claimant: "0xe" },
      1,
    ),
  );
  assert.deepEqual(claimed.migrators.vaults[vaultId]?.lpFeeAuthority, {
    kind: "cap",
    capId: normalizeSuiObjectId("0x20"),
  });

  const reissued = reduceLaunchpadProductInput(
    claimed,
    migratorDecoded(
      "LpFeeCapIssued",
      {
        vault_id: "0xd",
        revoked_lp_fee_cap_id: "0x20",
        lp_fee_cap_id: "0x21",
        recipient: "0xf",
      },
      2,
    ),
  );
  assert.deepEqual(reissued.migrators.vaults[vaultId]?.lpFeeAuthority, {
    kind: "cap",
    capId: normalizeSuiObjectId("0x21"),
  });

  const locked = reduceLaunchpadProductInput(
    reissued,
    migratorDecoded(
      "LpFeesLocked",
      { vault_id: "0xd", lp_fee_cap_id: "0x21", custodian_id: "0x30" },
      3,
    ),
  );
  assert.deepEqual(locked.migrators.vaults[vaultId]?.lpFeeAuthority, {
    kind: "custodian",
    custodianId: normalizeSuiObjectId("0x30"),
  });

  const pendingLocked = reduceLaunchpadProductInput(
    created,
    migratorDecoded(
      "LpFeesLocked",
      { vault_id: "0xd", lp_fee_cap_id: null, custodian_id: "0x31" },
      4,
    ),
  );
  assert.deepEqual(pendingLocked.migrators.vaults[vaultId]?.lpFeeAuthority, {
    kind: "custodian",
    custodianId: normalizeSuiObjectId("0x31"),
  });
});

test("replays LP-fee protocol share defaults and project overrides", () => {
  const pinned = [
    migratorDecoded("LpProtocolFeeShareChanged", { pos0: 3_000n }, 40),
    migratorDecoded(
      "ProjectLpProtocolFeeShareSet",
      { meme: "0xa::meme::MEME", protocol_fee_share_bps: 2_500n },
      41,
    ),
    migratorDecoded(
      "ProjectLpProtocolFeeShareSet",
      { meme: "0xb::partner::PARTNER", protocol_fee_share_bps: 1_000n },
      42,
    ),
  ].reduce(reduceLaunchpadProductInput, createLaunchpadProductProjection());

  assert.equal(pinned.migrators.lpFeePolicy.protocolFeeShareBps, 3_000n);
  assert.deepEqual(pinned.migrators.lpFeePolicy.projectProtocolFeeShareBps, {
    [normalizedType("0xa::meme::MEME")]: 2_500n,
    [normalizedType("0xb::partner::PARTNER")]: 1_000n,
  });

  const projection = [
    migratorDecoded(
      "ProjectLpProtocolFeeShareSet",
      { meme: "0xa::meme::MEME", protocol_fee_share_bps: 5_000n },
      43,
    ),
    migratorDecoded(
      "ProjectLpProtocolFeeShareCleared",
      { pos0: "0xa::meme::MEME" },
      44,
    ),
    migratorDecoded("LpProtocolFeeShareChanged", { pos0: 4_000n }, 45),
  ].reduce(reduceLaunchpadProductInput, pinned);

  assert.equal(projection.migrators.lpFeePolicy.protocolFeeShareBps, 4_000n);
  assert.deepEqual(
    projection.migrators.lpFeePolicy.projectProtocolFeeShareBps,
    { [normalizedType("0xb::partner::PARTNER")]: 1_000n },
  );
  assert.equal(projection.launchpad.config.protocolFeeShareBps, null);
  assert.equal(
    projection.migrators.eventCounts.ProjectLpProtocolFeeShareSet,
    3,
  );
  assert.equal(
    projection.migrators.eventCounts.ProjectLpProtocolFeeShareCleared,
    1,
  );
  assert.equal(projection.migrators.eventCounts.LpProtocolFeeShareChanged, 2);
});

test("requires migrator event positions and current/original identities", () => {
  const valid = migratorSuiEvent("VaultCreated", {}, 0);
  assert.throws(
    () => decodeMigratorEvent({ ...valid, checkpoint: null }, migratorPackages),
    /checkpoint metadata/,
  );
  assert.throws(
    () =>
      decodeMigratorEvent({ ...valid, packageId: "0x999" }, migratorPackages),
    /unexpected emitter package/,
  );
  assert.throws(
    () =>
      decodeMigratorEvent(
        { ...valid, eventType: "0x999::events::VaultCreated" },
        migratorPackages,
      ),
    /unexpected event package/,
  );
});

test("uses transaction digest and event index as migrator replay identity", () => {
  const first = decodeMigratorEvent(
    migratorSuiEvent("VaultCreated", {}, 0),
    migratorPackages,
  );
  const correctedCheckpoint = decodeMigratorEvent(
    { ...migratorSuiEvent("VaultCreated", {}, 0), checkpoint: "10" },
    migratorPackages,
  );
  const projection = reduceLaunchpadProductInput(
    createLaunchpadProductProjection(),
    first,
  );

  assert.equal(
    reduceLaunchpadProductInput(projection, correctedCheckpoint),
    projection,
  );
});

test("keeps transaction-effects and ownership facts separate from events", () => {
  const nativeInputs = [
    {
      source: "transactionEffects" as const,
      kind: "packagePublication" as const,
      position: { checkpoint: 10n, transactionDigest: "publish-tx" },
      packageId: "0x321",
      createdObjectIds: ["0x40", "0x41"],
    },
    {
      source: "objectOwnership" as const,
      kind: "creatorCapOwnership" as const,
      checkpoint: 11n,
      creatorCapId: "0x50",
      owner: "0x51",
    },
    {
      source: "transactionEffects" as const,
      kind: "returnedCoinRecipients" as const,
      position: { checkpoint: 12n, transactionDigest: "claim-tx" },
      claim: "lpCreatorFees" as const,
      memeCoin: { objectId: "0x60", recipient: "0x61" },
      quoteCoin: { objectId: "0x62", recipient: "0x63" },
    },
    {
      source: "transactionEffects" as const,
      kind: "returnedCoinRecipients" as const,
      position: { checkpoint: 12n, transactionDigest: "claim-tx" },
      claim: "lpCreatorFees" as const,
      memeCoin: { objectId: "0x64", recipient: "0x65" },
      quoteCoin: { objectId: "0x66", recipient: "0x67" },
    },
  ];

  const projection = nativeInputs.reduce(
    reduceLaunchpadProductInput,
    createLaunchpadProductProjection(),
  );

  assert.equal(
    projection.native.packagePublications[normalizeSuiObjectId("0x321")]
      ?.source,
    "transactionEffects",
  );
  assert.equal(
    projection.native.creatorCapOwners[normalizeSuiObjectId("0x50")]?.owner,
    normalizeSuiObjectId("0x51"),
  );
  const returnedClaims = Object.values(
    projection.native.returnedCoinRecipients,
  );
  assert.equal(returnedClaims.length, 2);
  assert.deepEqual(
    returnedClaims.map((fact) => fact.quoteCoin.recipient).sort(),
    [normalizeSuiObjectId("0x63"), normalizeSuiObjectId("0x67")].sort(),
  );
  assert.equal("creatorCapOwners" in projection.launchpad, false);
  assert.equal("returnedCoinRecipients" in projection.migrators, false);
});

function launchpadDecoded(
  kind: LaunchpadEventKind,
  overrides: Record<string, unknown>,
  eventIndex: number,
) {
  const original = normalizeSuiObjectId(launchpadPackages.originalPackageId);
  return decodeLaunchpadEvent(
    {
      packageId: launchpadPackages.packageId,
      module: "events_wrapper",
      sender: "0xa",
      eventType: `${original}::events_wrapper::Event<${original}::events::${kind}>`,
      bcs: encode(kind, launchpadEventSpecs, launchpadEventBcs, overrides),
      json: null,
      checkpoint: "9",
      transactionDigest: `launchpad-${eventIndex}`,
      eventIndex,
    },
    launchpadPackages,
  );
}

function migratorDecoded(
  kind: MigratorEventKind,
  overrides: Record<string, unknown>,
  eventIndex: number,
) {
  return decodeMigratorEvent(
    migratorSuiEvent(kind, overrides, eventIndex),
    migratorPackages,
  );
}

function migratorSuiEvent(
  kind: MigratorEventKind,
  overrides: Record<string, unknown>,
  eventIndex: number,
): SuiClientTypes.EventEntry {
  const original = normalizeSuiObjectId(migratorPackages.originalPackageId);
  return {
    packageId: migratorPackages.packageId,
    module: "events",
    sender: "0xa",
    eventType: `${original}::events::${kind}`,
    bcs: encode(kind, migratorEventSpecs, migratorEventBcs, overrides),
    json: null,
    checkpoint: "9",
    transactionDigest: `migrator-${eventIndex}`,
    eventIndex,
  };
}

function encode(
  kind: string,
  specs: Record<string, Record<string, string>>,
  schemas: object,
  overrides: Record<string, unknown>,
): Uint8Array {
  const spec = specs[kind];
  const schema = (schemas as Record<string, unknown>)[kind] as BcsType<
    unknown,
    Record<string, unknown>
  >;
  if (!spec || !schema) throw new TypeError(`unknown event: ${kind}`);
  const payload = Object.fromEntries(
    Object.entries(spec).map(([field, descriptor]) => [
      field,
      Object.hasOwn(overrides, field)
        ? overrides[field]
        : sampleValue(descriptor),
    ]),
  );
  return schema.serialize(payload).toBytes();
}

function sampleValue(descriptor: string): unknown {
  switch (descriptor) {
    case "id":
      return "0xc";
    case "typeName":
      return "0xa::meme::MEME";
    case "address":
      return "0xb";
    case "u64":
    case "u128":
      return 1n;
    case "u8":
    case "u16":
    case "u32":
      return 1;
    case "bool":
      return false;
    case "bytes":
      return new Uint8Array([1]);
    case "optionAddress":
    case "optionBytes":
    case "optionId":
    case "optionU64":
      return null;
    default:
      throw new TypeError(`unknown descriptor: ${descriptor}`);
  }
}

function readFrozenMigratorEventSpecs(): Record<
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
      migrators: {
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
    artifact.packages.migrators.modules.events.events.map((event) => [
      event.name,
      Object.fromEntries(
        event.fields.map((field) => [field.name, abiDescriptor(field.type)]),
      ),
    ]),
  );
}

function abiDescriptor(type: unknown): string {
  if (
    ["u64", "u128", "u32", "u16", "u8", "bool", "address"].includes(
      String(type),
    )
  ) {
    return String(type);
  }
  if (!isRecord(type)) throw new TypeError("unsupported ABI event field");
  if (type.vector === "u8") return "bytes";
  const datatype = type.Datatype;
  if (!isRecord(datatype)) throw new TypeError("unsupported ABI datatype");
  if (datatype.name === "ID") return "id";
  if (datatype.name === "TypeName") return "typeName";
  const argument = Array.isArray(datatype.type_arguments)
    ? datatype.type_arguments[0]
    : undefined;
  if (
    datatype.name === "Option" &&
    isRecord(argument) &&
    isRecord(argument.argument) &&
    isRecord(argument.argument.Datatype) &&
    argument.argument.Datatype.name === "ID"
  ) {
    return "optionId";
  }
  throw new TypeError("unsupported ABI event datatype");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizedType(type: string): string {
  return type.replace(
    /^0x([0-9a-f]+)::/,
    (_match, address: string) => `0x${address.padStart(64, "0")}::`,
  );
}
