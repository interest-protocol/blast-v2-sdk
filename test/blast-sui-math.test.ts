import assert from "node:assert/strict";
import test from "node:test";
import type { BasisPoints } from "@interest-protocol/blast-core/integers";
import {
  requireBasisPoints,
  U64_MAX,
} from "@interest-protocol/blast-core/integers";
import {
  blastGrossSuiOutDown,
  blastRedeemFeeUp,
  blastRedemptionQuote,
  blastSharesOutDown,
  funConversionLossBoundUp,
  poolTokensAtRateDown,
  poolTokensForSuiUp,
  suiAtRateDown,
} from "@interest-protocol/blast-sui-sdk/math";
import {
  blastSuiDepositReceiptType,
  blastSuiType,
  funSuiType,
  normalizeBlastSuiDeployment,
} from "@interest-protocol/blast-sui-sdk/types";

test("uses original package IDs for blast Sui type identities", () => {
  const originalPackageId = "0x422";
  const normalized =
    "0x0000000000000000000000000000000000000000000000000000000000000422";
  assert.equal(
    funSuiType(originalPackageId),
    `${normalized}::fun_sui::FUN_SUI`,
  );
  assert.equal(
    blastSuiType(originalPackageId),
    `${normalized}::blast_sui::BLAST_SUI`,
  );
  assert.equal(
    blastSuiDepositReceiptType(originalPackageId),
    `${normalized}::deposit_receipt::BlastSuiDepositReceipt`,
  );
});

test("normalizes blast Sui deployment references with exact mutability", () => {
  assert.deepEqual(
    normalizeBlastSuiDeployment({
      packageId: "0x423",
      originalPackageId: "0x422",
      packageVersion: {
        objectId: "0x8",
        initialSharedVersion: "16",
      },
      vault: {
        objectId: "0x9",
        initialSharedVersion: "17",
      },
      admin: {
        packageId: "0xad",
        acl: { objectId: "0xac", initialSharedVersion: "3" },
      },
    }),
    {
      packageId:
        "0x0000000000000000000000000000000000000000000000000000000000000423",
      originalPackageId:
        "0x0000000000000000000000000000000000000000000000000000000000000422",
      packageVersion: {
        objectId:
          "0x0000000000000000000000000000000000000000000000000000000000000008",
        initialSharedVersion: "16",
      },
      vault: {
        objectId:
          "0x0000000000000000000000000000000000000000000000000000000000000009",
        initialSharedVersion: "17",
      },
      admin: {
        packageId:
          "0x00000000000000000000000000000000000000000000000000000000000000ad",
        acl: {
          objectId:
            "0x00000000000000000000000000000000000000000000000000000000000000ac",
          initialSharedVersion: "3",
        },
      },
    },
  );
});

test("quotes blast shares and redemptions with Move rounding", () => {
  assert.equal(blastSharesOutDown(100n, 333n, 200n), 60n);
  assert.equal(blastGrossSuiOutDown(60n, 333n, 200n), 99n);
  assert.equal(blastRedeemFeeUp(99n, requireBasisPoints("fee", 30n)), 1n);
  assert.deepEqual(
    blastRedemptionQuote(60n, 333n, 200n, requireBasisPoints("fee", 30n)),
    { grossSui: 99n, feeSui: 1n, netSui: 98n },
  );
});

test("mirrors native empty-rate and ceiling behavior", () => {
  assert.equal(suiAtRateDown(7n, 0n, 0n), 7n);
  assert.equal(poolTokensAtRateDown(7n, 0n, 0n), 7n);
  assert.equal(funConversionLossBoundUp(3n, 2n), 2n);
  assert.equal(poolTokensForSuiUp(7n, 10n, 9n), 8n);
  assert.equal(poolTokensForSuiUp(20n, 10n, 9n), 10n);
});

test("aborts before capping an overflowing pool-token quote", () => {
  assert.throws(
    () => poolTokensForSuiUp(U64_MAX, U64_MAX, 1n),
    /poolTokens must be a u64/,
  );
});

test("validates a forged fee rate again at runtime", () => {
  assert.throws(
    () => blastRedeemFeeUp(99n, 10_001n as BasisPoints),
    /basis points/,
  );
});

test("rejects a forged quote rate before returning an invalid net u64", () => {
  assert.throws(
    () => blastRedemptionQuote(1n, 100n, 1n, 20_000n as BasisPoints),
    /redeemFeeBps must be between 0 and 10,000 basis points/,
  );
});
