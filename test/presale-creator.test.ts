import assert from "node:assert/strict";
import test from "node:test";
import type { PresaleCreatorDeployment } from "@interest-protocol/blast-presale-sdk";
import {
  createPresaleCreatorClient,
  decodePresaleCreatorEvents,
  presaleCapBcs,
} from "@interest-protocol/blast-presale-sdk";
import { vaultEventBcs } from "@interest-protocol/blast-vault-sdk/events";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

const shared = (objectId: string) => ({ objectId, initialSharedVersion: "3" });
const admin = { packageId: "0xad", acl: shared("0xac1") };
const core = {
  packageId: "0xc1",
  originalPackageId: "0xc0",
  treasury: shared("0x7ea"),
};
const vault = {
  packageId: "0xb1",
  originalPackageId: "0xb0",
  registry: shared("0xb2"),
  packageVersion: shared("0xb3"),
  packageAdmin: shared("0xb4"),
  core,
  admin,
};
const identity: PresaleCreatorDeployment = {
  presale: {
    packageId: "0x5f",
    originalPackageId: "0x5e",
    packageVersion: shared("0x64"),
    packageAdmin: shared("0x65"),
    creationPolicy: shared("0x62"),
    feePolicy: shared("0x61"),
    presaleRegistry: shared("0x63"),
    core,
    admin,
    partners: { packageId: "0xa7", admin },
    vault,
    migrators: {
      packageId: "0xd1",
      originalPackageId: "0xd0",
      packageVersion: shared("0xd3"),
      packageAdmin: shared("0xd4"),
      venueConfig: shared("0xd5"),
      vault,
    },
    vestingPackageId: "0xf4",
  },
  venues: {},
};
const OWNER = normalizeSuiAddress("0xc0ffee");
const VAULT = normalizeSuiAddress("0xba");
const MEME = normalizeStructTag("0xa::sale::SALE");
const QUOTE = normalizeStructTag("0x2::sui::SUI");
const feesCollected = {
  eventType: `${normalizeSuiAddress("0xb0")}::blast_vault_events::FeesCollected<${MEME}, ${QUOTE}>`,
  bcs: vaultEventBcs.FeesCollected.serialize({
    vault_id: VAULT,
    gross_meme_amount: 100n,
    gross_quote_amount: 200n,
    protocol_meme_amount: 1n,
    protocol_quote_amount: 2n,
    route_meme_amounts: [69n, 30n],
    route_quote_amounts: [139n, 59n],
  }).toBytes(),
};

test("decodes the pinned vault's FeesCollected and ignores look-alikes", () => {
  assert.deepEqual(
    decodePresaleCreatorEvents(
      [
        feesCollected,
        {
          ...feesCollected,
          eventType: feesCollected.eventType.replace("0000b0", "0000b9"),
        },
        {
          ...feesCollected,
          eventType: feesCollected.eventType.replace(
            "blast_vault_events",
            "vault",
          ),
        },
        { ...feesCollected, bcs: new Uint8Array([0]) },
      ],
      "0xb0",
    ),
    [
      {
        kind: "collect_fees",
        vaultId: VAULT,
        grossMemeAmount: "100",
        grossQuoteAmount: "200",
        routeMemeAmounts: ["69", "30"],
        routeQuoteAmounts: ["139", "59"],
      },
    ],
  );
});

test("only a successful simulation with no emitted events proves an empty preview", async () => {
  const kind = await new Transaction().build({ onlyTransactionKind: true });
  for (const { success, eventsDigest, events, expected } of [
    { success: true, eventsDigest: null, events: [], expected: [] },
    { success: false, eventsDigest: null, events: [], expected: null },
    { success: true, eventsDigest: "digest", events: [], expected: null },
    {
      success: true,
      eventsDigest: "digest",
      events: [feesCollected],
      expected: 1,
    },
  ]) {
    const client = {
      core: {
        async simulateTransaction() {
          return {
            $kind: "Transaction",
            Transaction: {
              effects: { status: { success }, eventsDigest },
              events,
            },
          };
        },
      },
    } as unknown as ClientWithCoreApi;
    const preview = await createPresaleCreatorClient(client, identity).preview(
      kind,
      OWNER,
    );
    if (expected === 1) assert.equal(preview?.length, 1);
    else assert.deepEqual(preview, expected);
  }
});

test("owned caps are paginated with the pinned type and bounded to 200", async () => {
  let pages = 0;
  const SALE = normalizeSuiAddress("0x5a1e");
  const client = {
    core: {
      async listOwnedObjects(options: { type: string; cursor: string | null }) {
        assert.equal(options.type, "0x5e::blast_presale::PresaleCap");
        assert.equal(options.cursor, pages === 0 ? null : String(pages));
        pages += 1;
        return {
          objects: Array.from({ length: 50 }, () => ({
            content: presaleCapBcs
              .serialize({ id: { id: { bytes: "0xca" } }, presale_id: SALE })
              .toBytes(),
          })),
          hasNextPage: true,
          cursor: String(pages),
        };
      },
    },
  } as unknown as ClientWithCoreApi;
  const ids = await createPresaleCreatorClient(client, identity).ownedPresales(
    OWNER,
  );
  assert.equal(ids.length, 200);
  assert.equal(ids[0], SALE);
  assert.equal(pages, 4);
});
