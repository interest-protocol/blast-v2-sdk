import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SuiClientTypes } from "@mysten/sui/client";
import type { SuiGrpcClient } from "@mysten/sui/grpc";

import {
  decodePresaleEvent,
  decodePresalePolicyEvent,
  presaleEventBcs,
} from "../src/presale/events.ts";
import {
  createPresaleEventProjection,
  reducePresaleEvent,
} from "../src/presale/reducer.ts";
import type {
  PresaleVectorCase,
  PresaleVectorEvent,
  PresaleVectorFile,
} from "../src/presale/vectors.ts";
import {
  DEFAULT_PRESALE_VECTOR_FILE,
  isPresalePolicyEvent,
  ledgerOrder,
  PRESALE_VECTOR_KINDS,
  presaleVectorCases,
  runPresaleVectors,
  vectorEventEntry,
  vectorJson,
  vectorProjection,
  writePresaleVectors,
} from "../src/presale/vectors.ts";

const file = new URL(`../${DEFAULT_PRESALE_VECTOR_FILE}`, import.meta.url);
const text = readFileSync(file, "utf8");
const pin = readFileSync(
  new URL(file.href.replace(/\.json$/, ".sha256")),
  "utf8",
);
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Checks the pin, the coverage lists, and every event; returns the events checked. */
function checkVectors(text: string, pin: string): number {
  assert.equal(
    sha256(text),
    pin.split(/\s/)[0],
    "vector file does not match its SHA-256 pin",
  );
  const vectors: PresaleVectorFile = JSON.parse(text);
  const covered = new Set(
    vectors.cases.flatMap((c) => c.events.map((e) => e.decoded.kind)),
  );
  assert.deepEqual(
    vectors.kinds,
    PRESALE_VECTOR_KINDS.filter((k) => covered.has(k)),
  );
  assert.deepEqual(
    vectors.pending_kinds,
    PRESALE_VECTOR_KINDS.filter((k) => !covered.has(k)),
  );
  let checked = 0;
  for (const vectorCase of vectors.cases) {
    const packages = { originalPackageId: vectorCase.original_package_id };
    let state = createPresaleEventProjection();
    for (const event of vectorCase.events) {
      const entry = vectorEventEntry(event);
      const at = `${vectorCase.name} ${entry.transactionDigest}:${entry.eventIndex}`;
      if (isPresalePolicyEvent(event.type)) {
        const decoded = decodePresalePolicyEvent(entry, packages);
        assert.deepEqual(vectorJson(decoded), event.decoded, at);
        assert.equal(event.projection, null, at);
      } else {
        const decoded = decodePresaleEvent(entry, packages);
        assert.deepEqual(vectorJson(decoded), event.decoded, at);
        state = reducePresaleEvent(state, decoded);
        assert.deepEqual(vectorProjection(state), event.projection, at);
      }
      checked++;
    }
  }
  return checked;
}

/** The file with one expected field changed by `edit`, re-pinned. */
function edited(edit: (vectors: PresaleVectorFile) => void): [string, string] {
  const vectors: PresaleVectorFile = JSON.parse(text);
  edit(vectors);
  const changed = `${JSON.stringify(vectors, null, 2)}\n`;
  return [changed, sha256(changed)];
}

test("the pinned presale vectors decode and reduce as recorded", () => {
  assert.ok(checkVectors(text, pin) > 0);
});

test("one changed byte breaks the SHA-256 pin", () => {
  const changed = text.replace('"Committed"', '"Commitxed"');
  assert.notEqual(changed, text);
  assert.throws(() => checkVectors(changed, pin), /SHA-256 pin/);
});

test("one changed expected field fails parity even when re-pinned", () => {
  const last = (vectors: PresaleVectorFile) => {
    const events = vectors.cases.find((c) =>
      c.events.some((e) => e.projection),
    )?.events;
    const event = events?.[events.length - 1];
    assert.ok(event);
    return event;
  };
  const payloadChanged = edited((vectors) => {
    const payload = last(vectors).decoded.payload as { presale_id: string };
    payload.presale_id = `0x${"0".repeat(64)}`;
  });
  const projectionChanged = edited((vectors) => {
    last(vectors).projection = {};
  });
  for (const [changed, changedPin] of [payloadChanged, projectionChanged]) {
    assert.throws(
      () => checkVectors(changed, changedPin),
      assert.AssertionError,
    );
  }
});

const pinned: PresaleVectorFile = JSON.parse(text);
const pinnedCase = (name: string) => {
  const found = pinned.cases.find((c) => c.name === name);
  assert.ok(found, name);
  return found;
};
const pinnedEntries = pinned.cases.flatMap((c) =>
  c.events.map(vectorEventEntry),
);
// `e010` is the mainnet run's open sale with a hard cap, the fullest single-sale case.
const saleCase = pinnedCase("e010");
const lastDigest = (vectorCase: PresaleVectorCase) =>
  vectorCase.events.at(-1)?.position.transactionDigest ?? "";
const capture = (
  entries: SuiClientTypes.EventEntry[],
  cases: { name: string; digests: string[] }[],
) =>
  presaleVectorCases({
    entries,
    cases,
    originalPackageId: saleCase.original_package_id,
    // The pinned file's own source: a capture stamps the chain it read
    // (`mainnet:<chain identifier>`), so hard-coding one would only ever match a localnet file.
    source: saleCase.source,
  });

/** A vault event whose `PresaleVaultCreated` the fullnode no longer retains. */
const orphanVaultEvent: SuiClientTypes.EventEntry = {
  ...vectorEventEntry(saleCase.events[0] as PresaleVectorEvent),
  module: "presale_vault",
  eventType: `${saleCase.original_package_id}::presale_vault::MigrationResidualsClaimed<0x2::sui::SUI, 0x2::sui::SUI>`,
  bcs: presaleEventBcs.MigrationResidualsClaimed.serialize({
    vault_id: `0x${"be".repeat(32)}`,
    meme: 1n,
    quote: 0n,
  }).toBytes(),
  transactionDigest: "orphan",
  eventIndex: 0,
};

test("capture rebuilds a pinned sale case from one listed digest", () => {
  assert.deepEqual(
    capture(pinnedEntries, [
      { name: "e010", digests: [lastDigest(saleCase)] },
    ]),
    [saleCase],
  );
});

test("capture refuses a sale whose history no longer starts at its creation", () => {
  const creation = saleCase.events[0]?.position.transactionDigest;
  const pruned = pinnedEntries.filter(
    (entry) => entry.transactionDigest !== creation,
  );
  assert.throws(
    () =>
      capture(pruned, [
        { name: "e010", digests: [lastDigest(saleCase)] },
      ]),
    /e010.*pruned it or it is incomplete/,
  );
});

test("capture ignores an unrelated vault event it cannot map to a sale", () => {
  assert.deepEqual(
    capture(
      [orphanVaultEvent, ...pinnedEntries],
      [{ name: "e010", digests: [lastDigest(saleCase)] }],
    ),
    [saleCase],
  );
});

test("capture refuses a listed transaction whose event maps to no sale", () => {
  assert.throws(
    () =>
      capture(
        [orphanVaultEvent, ...pinnedEntries],
        [{ name: "orphan", digests: ["orphan"] }],
      ),
    /no sale for event orphan:0/,
  );
});

const entryAt = (
  checkpoint: string,
  transactionDigest: string,
  eventIndex: number,
) =>
  ({ checkpoint, transactionDigest, eventIndex }) as SuiClientTypes.EventEntry;
const checkpointListing = (digests: string[]) =>
  ({
    ledgerService: {
      getCheckpoint: () => ({
        response: Promise.resolve({
          checkpoint: {
            contents: {
              transactions: digests.map((transaction) => ({ transaction })),
            },
          },
        }),
      }),
    },
  }) as unknown as SuiGrpcClient;

test("ledger order follows the checkpoint's transaction order", async () => {
  const ordered = await ledgerOrder(checkpointListing(["x", "B", "A"]), [
    entryAt("5", "A", 1),
    entryAt("5", "A", 0),
    entryAt("5", "B", 0),
    entryAt("4", "C", 0),
  ]);
  assert.deepEqual(
    ordered.map((e) => `${e.transactionDigest}#${e.eventIndex}`),
    ["C#0", "B#0", "A#0", "A#1"],
  );
});

test("ledger order refuses a checkpoint that does not list a transaction", async () => {
  await assert.rejects(
    ledgerOrder(checkpointListing(["x", "A"]), [
      entryAt("5", "A", 0),
      entryAt("5", "B", 0),
    ]),
    /checkpoint 5 does not list transaction B/,
  );
});

test("an --out path without .json is refused before any work", async () => {
  await assert.rejects(
    runPresaleVectors([
      "capture",
      "--digests",
      "missing-digests.json",
      "--out",
      "vectors",
    ]),
    /--out must end in \.json/,
  );
});

test("re-capturing a case keeps its position in the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presale-vectors-test-"));
  try {
    const out = join(dir, "vectors.json");
    const stub = (name: string, source: string): PresaleVectorCase => ({
      name,
      source,
      original_package_id: "0x1",
      events: [],
    });
    await writePresaleVectors(out, [stub("a", "old"), stub("b", "old")]);
    await writePresaleVectors(out, [stub("a", "new"), stub("c", "new")]);
    const written: PresaleVectorFile = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(
      written.cases.map((c) => `${c.name}:${c.source}`),
      ["a:new", "b:old", "c:new"],
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});
