import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePoolCreationObject,
  findPoolCreation,
} from "@interest-protocol/blast-presale-sdk/aftermath-dao";
import {
  creationPolicyBcs,
  decodePresaleCreationPolicyObject,
  decodePresaleFeePolicyObject,
  decodePresaleObject,
  feePolicyBcs,
  getPresaleCommitment,
  presaleId,
  presaleVaultId,
} from "@interest-protocol/blast-presale-sdk/state";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";
import { DERIVED_ID_FIXTURE as derived } from "./fixtures/derived-ids.ts";
import { PRESALE_FIXTURE as fixture } from "./fixtures/presale-a1a8f6c.ts";

// The Move fixture's presale and vendor test packages are published at 0x0.
const pkg = "0x0";
const zero = (name: string) =>
  normalizeStructTag(`0x0::blast_presale_tests::${name}`);
const saleToken = zero("BLAST_PRESALE_TESTS");
const quote = zero("QUOTE");
const presaleType = `0x0::blast_presale::Presale<${saleToken}, ${quote}>`;
const id = `0x${fixture.presaleId}`;
const partner = `0x${fixture.partnerId}`;
const venue = normalizeStructTag(
  new TextDecoder().decode(fromHex(fixture.venue)),
);
const witness = normalizeStructTag(
  "0x0::blast_presale_package::PackageWitness",
);
const address = (value: string) => normalizeSuiAddress(value);

function presaleObject(hex: string) {
  return decodePresaleObject(
    {
      objectId: id,
      initialSharedVersion: "7",
      type: presaleType,
      content: fromHex(hex),
    },
    pkg,
  );
}

test("decodes the Move-printed partnered sale through its lifecycle", () => {
  const open = presaleObject(fixture.presaleOpenObject);
  assert.equal(open.objectId, id);
  assert.equal(open.initialSharedVersion, "7");
  assert.equal(open.saleTokenType, saleToken);
  assert.equal(open.quoteType, quote);
  assert.equal(open.lifecycle, "Open");
  assert.equal(open.venue, venue);
  assert.equal(open.raiseTarget, 1_000n);
  assert.deepEqual(open.eligibility, {
    kind: "open",
    walletCap: 5_000n,
    maxParticipants: 2n,
    minCommitment: 500n,
  });
  assert.deepEqual(
    [open.startMs, open.endMs, open.durationMs],
    [1_000n, 1_100n, 100n],
  );
  assert.equal(open.liquidityDeadlineMs, 1_100n + 7n * 86_400_000n);
  assert.deepEqual(open.feeSplit, {
    routes: [
      {
        destination: { kind: "Address", address: address("0xc0ffee") },
        bps: 5_000n,
      },
      {
        destination: { kind: "Address", address: address("0xfee") },
        bps: 2_000n,
      },
      { destination: { kind: "HolderRewards" }, bps: 3_000n },
    ],
  });
  // 20,001 tokens over [5,000, 1,000, 500, 2,500, 1,000] BPS: the sale's
  // half-unit remainder takes the leftover atom.
  assert.deepEqual(
    [open.tokenAllocation, open.liquidityTokens, open.protocolTokens],
    [10_001n, 2_000n, 1_000n],
  );
  assert.deepEqual(open.recipientPayouts, [
    {
      recipient: { destination: address("0xa110c"), vestingTerms: null },
      amount: 5_000n,
    },
    {
      recipient: { destination: address("0xb110c"), vestingTerms: null },
      amount: 2_000n,
    },
  ]);
  assert.deepEqual(open.raisePayouts, [
    {
      recipient: { destination: address("0x5a1e"), vestingTerms: null },
      amount: 200n,
    },
  ]);
  assert.deepEqual(open.protocolFees, {
    raiseBps: 333n,
    tokenBps: 500n,
    lpFeeMemeBps: 0n,
    lpFeeQuoteBps: 0n,
  });
  assert.equal(open.protocolQuote, 33n);
  assert.equal(open.partnerId, partner);
  assert.deepEqual(open.feeLedger, {
    packageWitness: witness,
    origin: id,
    partnerId: partner,
    meme: 0n,
    quote: 0n,
    sui: 0n,
  });

  const funded = presaleObject(fixture.presaleFundedObject);
  assert.equal(funded.lifecycle, "Funded");
  assert.deepEqual(
    [funded.totalCommitments, funded.participants, funded.quote],
    [4_000n, 2n, 4_000n],
  );

  // Migration moves the raise out, Blast's share into the partner-bound ledger.
  const migrated = presaleObject(fixture.presaleMigratedObject);
  assert.equal(migrated.lifecycle, "Migrated");
  assert.deepEqual(
    [
      migrated.quote,
      migrated.liquidityTokens,
      migrated.recipientTokens,
      migrated.protocolTokens,
    ],
    [3_000n, 0n, 0n, 0n],
  );
  assert.deepEqual(
    [migrated.feeLedger.meme, migrated.feeLedger.quote],
    [1_000n, 33n],
  );
});

test("decodes a sale whose rates changed before it was cancelled", () => {
  const cancelled = presaleObject(fixture.presaleCancelledObject);
  assert.equal(cancelled.lifecycle, "Cancelled");
  assert.deepEqual(cancelled.protocolFees, {
    raiseBps: 500n,
    tokenBps: 250n,
    lpFeeMemeBps: 100n,
    lpFeeQuoteBps: 200n,
  });
  assert.deepEqual(
    [
      cancelled.protocolQuote,
      cancelled.protocolTokens,
      cancelled.tokenAllocation,
    ],
    [50n, 500n, 10_501n],
  );
  assert.equal(cancelled.partnerId, null);
  assert.equal(cancelled.feeLedger.partnerId, null);
  assert.deepEqual([cancelled.quote, cancelled.totalCommitments], [500n, 500n]);
});

test("rejects a look-alike presale type or a mismatched UID", () => {
  const content = fromHex(fixture.presaleOpenObject);
  assert.throws(
    () =>
      decodePresaleObject(
        { objectId: id, initialSharedVersion: 1, type: presaleType, content },
        "0x5e",
      ),
    /not a presale Presale/,
  );
  assert.throws(
    () =>
      decodePresaleObject(
        {
          objectId: "0xab",
          initialSharedVersion: 1,
          type: presaleType,
          content,
        },
        pkg,
      ),
    /mismatched UID/,
  );
});

test("decodes the fee and creation policies", () => {
  const policy = "0xf1";
  const fees = {
    raiseBps: 200n,
    tokenBps: 100n,
    lpFeeMemeBps: 1_500n,
    lpFeeQuoteBps: 1_500n,
  };
  const feePolicy = decodePresaleFeePolicyObject(
    {
      objectId: policy,
      initialSharedVersion: 3,
      type: "0x5e::fee_policy::FeePolicy",
      content: feePolicyBcs
        .serialize({
          id: { id: { bytes: address(policy) } },
          fees: {
            parent: policy,
            key: null,
            value: fees,
            delay_ms: 0n,
            pending: null,
          },
        })
        .toBytes(),
    },
    "0x5e",
  );
  assert.deepEqual(feePolicy.fees, fees);
  assert.equal(feePolicy.feesPolicy.delay_ms, 0n);

  const cetusVenue = normalizeStructTag("0x9::cetus::Venue");
  const vendorVenue = normalizeStructTag(
    "0x7::blast_aftermath_dao_presale::Venue",
  );
  const sui = normalizeStructTag("0x2::sui::SUI");
  const creation = decodePresaleCreationPolicyObject(
    {
      objectId: policy,
      initialSharedVersion: 3,
      type: "0x5e::creation_policy::CreationPolicy",
      content: creationPolicyBcs
        .serialize({
          id: { id: { bytes: address(policy) } },
          allowed_quotes: [sui],
          venues: {
            parent: policy,
            key: null,
            members: [cetusVenue],
            delay_ms: 172_800_000n,
            admissions: [
              {
                member: vendorVenue,
                deadline: { delay_ms: 0n, ready_at_ms: 9n },
              },
            ],
            pending_delay: null,
          },
          partners: {
            parent: policy,
            acceptance_ends_at_ms: { id: "0x7ab1e", size: 2n },
          },
        })
        .toBytes(),
    },
    "0x5e",
  );
  assert.deepEqual(creation.allowedQuotes, [sui]);
  assert.deepEqual(creation.venues, [cetusVenue]);
  assert.equal(creation.venueDelayMs, 172_800_000n);
  assert.deepEqual(creation.pendingVenues, {
    [vendorVenue]: { delay_ms: 0n, ready_at_ms: 9n },
  });
  assert.deepEqual(creation.partners, {
    parent: address(policy),
    acceptanceTableId: address("0x7ab1e"),
    size: 2n,
  });
});

test("presaleId and presaleVaultId match the Move-derived IDs", () => {
  const presale = {
    originalPackageId: derived.presaleOriginalPackageId,
    presaleRegistry: {
      objectId: derived.presaleRegistryId,
      initialSharedVersion: 1,
    },
  };
  assert.equal(presaleId(presale, derived.memeType), derived.presaleId);
  assert.equal(
    presaleVaultId(
      {
        originalPackageId: derived.vaultOriginalPackageId,
        registry: {
          objectId: derived.vaultRegistryId,
          initialSharedVersion: 1,
        },
      },
      presale,
      derived.presaleOriginId,
    ),
    derived.presaleVaultId,
  );
});

test("reads a wallet's commitment, null once claimed", async () => {
  let found = true;
  const client = {
    core: {
      getDynamicField: async (options: {
        parentId: string;
        name: { type: string; bcs: Uint8Array };
      }) => {
        assert.equal(options.parentId, normalizeSuiObjectId(id));
        assert.equal(
          options.name.type,
          `${normalizeSuiAddress(pkg)}::blast_presale::CommitmentKey`,
        );
        if (!found)
          throw new ObjectError("notExists", "missing", { reason: "notFound" });
        return {
          dynamicField: {
            value: { bcs: Uint8Array.from([...le(1_000n), ...le(5_000n)]) },
          },
        };
      },
    },
  } as unknown as ClientWithCoreApi;
  assert.deepEqual(await getPresaleCommitment(client, id, "0xa11ce", pkg), {
    quote: 1_000n,
    walletCap: 5_000n,
  });
  found = false;
  assert.equal(await getPresaleCommitment(client, id, "0xa11ce", pkg), null);
});

const vendorType = (name: string) =>
  normalizeStructTag(`0x0::blast_aftermath_dao_presale_tests::${name}`);
const issuer = normalizeStructTag("0x77eb::migration::TestIssuer");

test("decodes the Move-printed vendor PoolCreation", () => {
  const objectId = `0x${fixture.poolCreationId}`;
  const decoded = decodePoolCreationObject(
    {
      objectId,
      type: `0x0::blast_aftermath_dao_presale::PoolCreation<${vendorType("LP")}, ${vendorType("SALE")}>`,
      content: fromHex(fixture.poolCreation),
    },
    { originalPackageId: "0x0" },
  );
  assert.deepEqual(decoded, {
    objectId,
    lpType: vendorType("LP"),
    saleTokenType: vendorType("SALE"),
    packageWitness: issuer,
    createPoolCapId: normalizeSuiObjectId(
      `0x${fixture.poolCreation.slice(-64)}`,
    ),
  });
});

test("finds a vendor sale's live PoolCreation from its creation transaction", async () => {
  const objectId = `0x${fixture.poolCreationId}`;
  const eventType = `0x0::blast_aftermath_dao_presale::PoolCreationReserved<${vendorType("LP")}, ${vendorType("SALE")}, ${vendorType("QUOTE")}>`;
  const client = {
    core: {
      getTransaction: async () => ({
        Transaction: {
          events: [{ eventType, bcs: fromHex(fixture.poolCreationReserved) }],
        },
      }),
      getObjects: async () => ({
        objects: [
          {
            objectId,
            type: `0x0::blast_aftermath_dao_presale::PoolCreation<${vendorType("LP")}, ${vendorType("SALE")}>`,
            owner: { $kind: "Shared", Shared: { initialSharedVersion: "12" } },
            content: fromHex(fixture.poolCreation),
          },
        ],
      }),
    },
  } as unknown as ClientWithCoreApi;
  const found = await findPoolCreation(client, {
    deployment: { originalPackageId: "0x0" },
    creationDigest: "digest",
  });
  assert.ok(found);
  assert.equal(found.poolCreationId, objectId);
  assert.equal(found.lpType, vendorType("LP"));
  assert.equal(found.quoteType, vendorType("QUOTE"));
  assert.equal(found.packageWitness, issuer);
  assert.equal(found.poolCreation?.initialSharedVersion, "12");
});

function le(value: bigint): number[] {
  return Array.from({ length: 8 }, (_, i) =>
    Number((value >> BigInt(8 * i)) & 0xffn),
  );
}
