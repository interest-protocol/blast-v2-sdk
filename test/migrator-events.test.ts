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

const launchpadPackages = { originalPackageId: "0x122" };
const migratorPackages: MigratorEventPackageIdentity = {
  originalPackageId: "0x320",
};
const sampleSplit = {
  creatorBps: 10_000n,
  autoLpBps: 0n,
  rewardsBps: 0n,
  burnBps: 0n,
  recipients: [],
};
const samplePlan = {
  curveMemeBps: 8_000n,
  lpMemeBps: 2_000n,
  lpQuoteBps: 10_000n,
  protocolMemeBps: 0n,
  protocolQuoteBps: 0n,
  recipients: [],
};

test("decodes and idempotently reduces every frozen migrator event", () => {
  assert.deepEqual(migratorEventSpecs, readFrozenMigratorEventSpecs());
  const kinds = Object.keys(migratorEventSpecs) as MigratorEventKind[];
  assert.equal(kinds.length, 13);

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

test("replays vault custody, collections, auto-LP, split updates, and claims", () => {
  const split = {
    creatorBps: 5_000n,
    autoLpBps: 2_000n,
    rewardsBps: 1_000n,
    burnBps: 1_000n,
    recipients: [
      {
        destination: normalizeSuiObjectId("0xf"),
        bps: 1_000n,
      },
    ],
  };
  const nextSplit = { ...split, creatorBps: 6_000n, autoLpBps: 1_000n };
  const inputs = [
    launchpadDecoded("LaunchTicketCreated", { ticket_id: "0xb" }, 0),
    launchpadDecoded(
      "LaunchCreated",
      { launch_id: "0xc", ticket_id: "0xb", quote: "0x2::sui::SUI" },
      1,
    ),
    launchpadDecoded("Migrated", { launch_id: "0xc" }, 2),
    migratorDecoded(
      "VaultCreated",
      {
        vault_id: "0x40",
        pool_id: "0x41",
        position_id: "0x42",
        venue: "0x320::cetus::Venue",
        meme: "0xa::meme::MEME",
        quote: "0x2::sui::SUI",
        residual_meme: 3n,
        residual_quote: 4n,
        liquidity: 5n,
        fee_split: split,
      },
      3,
    ),
    migratorDecoded(
      "FeesCollected",
      {
        vault_id: "0x40",
        generation: 0n,
        gross_meme: 110n,
        gross_quote: 220n,
        protocol_meme: 10n,
        protocol_quote: 20n,
        creator_meme: 50n,
        creator_quote: 100n,
        auto_lp_meme: 20n,
        auto_lp_quote: 40n,
        rewards_meme: 10n,
        rewards_quote: 20n,
        burn_meme: 10n,
        burn_quote: 20n,
        recipient_meme: [10n],
        recipient_quote: [20n],
      },
      4,
    ),
    migratorDecoded(
      "AutoLpPositionOpened",
      { vault_id: "0x40", position_id: "0x43" },
      5,
    ),
    migratorDecoded(
      "AutoLiquidityAdded",
      {
        vault_id: "0x40",
        meme_amount: 18n,
        quote_amount: 40n,
        meme_pending: 2n,
        quote_pending: 0n,
      },
      6,
    ),
    migratorDecoded(
      "FeeSplitChanged",
      {
        vault_id: "0x40",
        old_generation: 0n,
        new_generation: 1n,
        old_fee_split: split,
        new_fee_split: nextSplit,
      },
      7,
    ),
    migratorDecoded(
      "CreatorFeesClaimed",
      { vault_id: "0x40", meme_amount: 50n, quote_amount: 100n },
      8,
    ),
    migratorDecoded(
      "RoundPublished",
      {
        vault_id: "0x40",
        round_id: "0x50",
        number: 0n,
        start_checkpoint: 10n,
        end_checkpoint: 20n,
        root: new Uint8Array(32).fill(1),
        manifest_digest: new Uint8Array(32).fill(2),
        leaf_count: 2n,
        meme_amount: 15n,
        quote_amount: 30n,
        meme_unallocated: 5n,
        quote_unallocated: 10n,
      },
      9,
    ),
    migratorDecoded(
      "RewardPaid",
      {
        round_id: "0x50",
        index: 1n,
        beneficiary: "0xa",
        meme_amount: 5n,
        quote_amount: 10n,
        meme_remaining: 10n,
        quote_remaining: 20n,
      },
      10,
    ),
    migratorDecoded(
      "ProtocolFeesClaimed",
      { vault_id: "0x40", meme_amount: 3n, quote_amount: 4n },
      11,
    ),
    migratorDecoded(
      "BuybackBurned",
      {
        vault_id: "0x40",
        quote_spent: 15n,
        meme_burned: 7n,
        quote_pending: 5n,
      },
      12,
    ),
  ];

  const states = inputs.map((_, index) =>
    inputs
      .slice(0, index + 1)
      .reduce(reduceLaunchpadProductInput, createLaunchpadProductProjection()),
  );
  const vaultId = normalizeSuiObjectId("0x40");
  const migrated = states[3]?.migrators.vaults[vaultId];
  assert.equal(migrated?.launchId, normalizeSuiObjectId("0xc"));
  assert.equal(migrated?.protocolMemeResidual, 3n);
  assert.equal(migrated?.protocolQuoteResidual, 4n);
  assert.equal(migrated?.liquidity, 5n);
  const collected = states[4]?.migrators.vaults[vaultId];
  assert.equal(collected?.creatorMeme, 50n);
  assert.equal(collected?.autoLpQuote, 40n);
  assert.equal(collected?.burnQuote, 20n);
  assert.equal(collected?.protocolMemePaid, 10n);

  const vault = states.at(-1)?.migrators.vaults[vaultId];
  assert.ok(vault);
  assert.equal(vault.autoLpPositionId, normalizeSuiObjectId("0x43"));
  assert.equal(vault.autoLpMeme, 2n);
  assert.equal(vault.autoLpQuote, 0n);
  assert.equal(vault.generation, 1n);
  assert.deepEqual(vault.feeSplit, nextSplit);
  assert.equal(vault.creatorMeme, 0n);
  assert.equal(vault.creatorQuote, 0n);
  assert.equal(vault.rewardsMeme, 5n);
  assert.equal(vault.rewardsQuote, 10n);
  assert.equal(vault.burnQuote, 5n);
  assert.equal(vault.nextRound, 1n);
  assert.equal(vault.lastCheckpoint, 20n);
  assert.equal(vault.protocolMemeResidual, 0n);
  assert.equal(vault.protocolQuoteResidual, 0n);
  const round = states.at(-1)?.migrators.rounds[normalizeSuiObjectId("0x50")];
  assert.equal(round?.memeRemaining, 10n);
  assert.equal(round?.quoteRemaining, 20n);
  assert.deepEqual(round?.paidIndexes, { "1": true });
  assert.equal(round?.root, "01".repeat(32));
});

test("replays LP-fee policy defaults, coin pairs, destination, and Cetus reservations", () => {
  const meme = normalizedType("0xa::meme::MEME");
  const projection = [
    migratorDecoded(
      "LpFeePolicyChanged",
      {
        meme: null,
        old_meme_bps: 0n,
        old_quote_bps: 0n,
        new_meme_bps: 1_000n,
        new_quote_bps: 2_000n,
      },
      0,
    ),
    migratorDecoded(
      "LpFeePolicyChanged",
      {
        meme: "0xa::meme::MEME",
        old_meme_bps: null,
        old_quote_bps: null,
        new_meme_bps: 500n,
        new_quote_bps: 600n,
      },
      1,
    ),
    migratorDecoded(
      "LpFeePolicyChanged",
      {
        meme: "0xb::meme::MEME",
        old_meme_bps: null,
        old_quote_bps: null,
        new_meme_bps: 1n,
        new_quote_bps: 1n,
      },
      2,
    ),
    migratorDecoded(
      "LpFeePolicyChanged",
      {
        meme: "0xb::meme::MEME",
        old_meme_bps: 1n,
        old_quote_bps: 1n,
        new_meme_bps: null,
        new_quote_bps: null,
      },
      3,
    ),
    migratorDecoded(
      "LpFeeDestinationChanged",
      { old_destination: "0x1", new_destination: "0xb1a57" },
      4,
    ),
    migratorDecoded(
      "CetusPoolReserved",
      {
        meme: "0xa::meme::MEME",
        quote: "0x2::sui::SUI",
        pool_creation_cap_id: "0x60",
        tick_spacing: 200,
      },
      5,
    ),
  ].reduce(reduceLaunchpadProductInput, createLaunchpadProductProjection());

  assert.deepEqual(projection.migrators.lpFeePolicy, {
    defaultShares: { memeBps: 1_000n, quoteBps: 2_000n },
    coinShares: { [meme]: { memeBps: 500n, quoteBps: 600n } },
    protocolDestination: normalizeSuiObjectId("0xb1a57"),
  });
  assert.deepEqual(projection.migrators.cetusPoolReservations[meme], {
    memeType: meme,
    quoteType: normalizedType("0x2::sui::SUI"),
    poolCreationCapId: normalizeSuiObjectId("0x60"),
    tickSpacing: 200,
  });
});

test("authenticates migrator events by their blast_events type", () => {
  const valid = migratorSuiEvent("VaultCreated", {}, 0);
  assert.throws(
    () => decodeMigratorEvent({ ...valid, checkpoint: null }, migratorPackages),
    /checkpoint metadata/,
  );
  assert.equal(
    decodeMigratorEvent({ ...valid, packageId: "0x999" }, migratorPackages)
      .kind,
    "VaultCreated",
  );
  assert.throws(
    () =>
      decodeMigratorEvent(
        { ...valid, eventType: "0x999::blast_events::VaultCreated" },
        migratorPackages,
      ),
    /unexpected event package/,
  );
  assert.throws(
    () =>
      decodeMigratorEvent(
        {
          ...valid,
          eventType: `${normalizeSuiObjectId("0x320")}::events::VaultCreated`,
        },
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
    {
      source: "transactionEffects" as const,
      kind: "returnedCoinRecipients" as const,
      position: { checkpoint: 12n, transactionDigest: "claim-tx" },
      claim: "launchProtocolFees" as const,
      memeCoin: { objectId: "0x68", recipient: "0x69" },
      quoteCoin: { objectId: "0x6a", recipient: "0x69" },
      suiCoin: { objectId: "0x6b", recipient: "0x69" },
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
  assert.equal(returnedClaims.length, 3);
  assert.deepEqual(
    returnedClaims.map((fact) => fact.quoteCoin.recipient).sort(),
    [
      normalizeSuiObjectId("0x63"),
      normalizeSuiObjectId("0x67"),
      normalizeSuiObjectId("0x69"),
    ].sort(),
  );
  assert.deepEqual(
    returnedClaims.find((fact) => fact.claim === "launchProtocolFees")?.suiCoin,
    {
      objectId: normalizeSuiObjectId("0x6b"),
      recipient: normalizeSuiObjectId("0x69"),
    },
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
      packageId: "0x321",
      module: "cetus",
      sender: "0xa",
      eventType: `${original}::blast_events::Event<${original}::events::${kind}>`,
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
    packageId: "0x321",
    module: "cetus",
    sender: "0xa",
    eventType: `${original}::blast_events::${kind}`,
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
    case "u32":
      return 1;
    case "bool":
      return false;
    case "bytes":
      return new Uint8Array([1]);
    case "string":
      return "meme";
    case "u64Vector":
      return [1n];
    case "feeSplit":
      return sampleSplit;
    case "creatorRecipient":
      return { kind: "address", address: "0xe" };
    case "allocationPlan":
      return samplePlan;
    case "optionAddress":
    case "optionBytes":
    case "optionId":
    case "optionU64":
    case "optionTypeName":
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
          blast_events: {
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
    artifact.packages.migrators.modules.blast_events.events.map((event) => [
      event.name,
      Object.fromEntries(
        event.fields.map((field) => [field.name, abiDescriptor(field.type)]),
      ),
    ]),
  );
}

const SCALAR_DESCRIPTORS = ["u64", "u128", "u32", "u8", "bool", "address"];
const DATATYPE_DESCRIPTORS: Record<string, string> = {
  ID: "id",
  TypeName: "typeName",
  FeeSplit: "feeSplit",
};

function abiDescriptor(type: unknown): string {
  if (SCALAR_DESCRIPTORS.includes(String(type))) return String(type);
  if (!isRecord(type)) throw new TypeError("unsupported ABI event field");
  if (type.vector === "u8") return "bytes";
  if (type.vector === "u64") return "u64Vector";
  const datatype = type.Datatype;
  if (!isRecord(datatype)) throw new TypeError("unsupported ABI datatype");
  const name = String(datatype.name);
  if (name === "Option") return optionDescriptor(datatype.type_arguments);
  const descriptor = DATATYPE_DESCRIPTORS[name];
  if (!descriptor) throw new TypeError("unsupported ABI event datatype");
  return descriptor;
}

function optionDescriptor(typeArguments: unknown): string {
  const argument = Array.isArray(typeArguments) ? typeArguments[0] : undefined;
  const inner = isRecord(argument) ? argument.argument : undefined;
  if (inner === "u64") return "optionU64";
  const name =
    isRecord(inner) && isRecord(inner.Datatype) ? inner.Datatype.name : null;
  if (name === "ID") return "optionId";
  if (name === "TypeName") return "optionTypeName";
  throw new TypeError("unsupported ABI Option event field");
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
