import assert from "node:assert/strict";
import test from "node:test";

import {
  blastSuiDepositReceiptType,
  blastSuiType,
  funSuiType,
  normalizeBlastSuiDeployment,
} from "../src/blast-sui/types.ts";
import {
  blastGrossSuiOutDown,
  blastRedeemFeeUp,
  blastRedemptionQuote,
  blastSharesOutDown,
  funConversionLossBoundUp,
  poolTokensAtRateDown,
  poolTokensForSuiUp,
  suiAtRateDown,
} from "../src/blast-sui/math.ts";
import { requireBasisPoints } from "../src/lib/integers.ts";

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
        mutable: false,
      },
      vault: {
        objectId: "0x9",
        initialSharedVersion: "17",
        mutable: true,
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
        mutable: false,
      },
      vault: {
        objectId:
          "0x0000000000000000000000000000000000000000000000000000000000000009",
        initialSharedVersion: "17",
        mutable: true,
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
