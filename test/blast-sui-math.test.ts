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
  isUsableRate,
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
      packageAdmin: {
        objectId: "0x7",
        initialSharedVersion: "15",
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
      packageAdmin: {
        objectId:
          "0x0000000000000000000000000000000000000000000000000000000000000007",
        initialSharedVersion: "15",
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

test("mirrors native rate conversions and ceiling behavior", () => {
  assert.equal(suiAtRateDown(7n, 3n, 2n), 10n);
  assert.equal(poolTokensAtRateDown(7n, 3n, 2n), 4n);
  assert.equal(funConversionLossBoundUp(3n, 2n), 2n);
  assert.equal(funConversionLossBoundUp(4n, 2n), 2n);
  assert.equal(poolTokensForSuiUp(7n, 10n, 9n), 8n);
  assert.equal(poolTokensForSuiUp(20n, 10n, 9n), 10n);
  // No active SUI: the whole held position is requested.
  assert.equal(poolTokensForSuiUp(7n, 10n, 0n), 10n);
});

test("refuses an unusable exchange rate instead of falling back", () => {
  assert.equal(isUsableRate(1n, 1n), true);
  for (const [rateSui, ratePoolTokens] of [
    [0n, 0n],
    [0n, 5n],
    [5n, 0n],
  ] as const) {
    assert.equal(isUsableRate(rateSui, ratePoolTokens), false);
    for (const convert of [
      () => suiAtRateDown(7n, rateSui, ratePoolTokens),
      () => poolTokensAtRateDown(7n, rateSui, ratePoolTokens),
      () => funConversionLossBoundUp(rateSui, ratePoolTokens),
    ]) {
      assert.throws(
        convert,
        (error: unknown) =>
          error instanceof RangeError &&
          error.message === "exchange rate must be usable",
      );
    }
  }
  assert.throws(() => suiAtRateDown(1n, -1n, 1n), /rateSui must be a u64/);
  assert.throws(
    () => poolTokensAtRateDown(1n, 1n, 1n << 64n),
    /ratePoolTokens must be a u64/,
  );
});

test("reproduces the Move-printed fixture's conversions", () => {
  // Pool 0's rate at epoch 3 values the blast ledger's active stake.
  const rateSui = 1_333_600_113_000_000_000n;
  const ratePoolTokens = 113_000_000_000n;
  assert.equal(
    suiAtRateDown(11_666_167_218n, rateSui, ratePoolTokens),
    137_681_432_922_138_899n,
  );
  // Converting back rounds down by one pool token.
  assert.equal(
    poolTokensAtRateDown(137_681_432_922_138_899n, rateSui, ratePoolTokens),
    11_666_167_217n,
  );
  assert.equal(funConversionLossBoundUp(rateSui, ratePoolTokens), 11_801_771n);

  // The 3 SUI claim mints 2.608695652 blastSUI against 11.5 SUI of assets.
  assert.equal(
    blastSharesOutDown(3_000_000_000n, 11_500_000_000n, 10_000_000_000n),
    2_608_695_652n,
  );
  // The 1 blastSUI redemption at a 2 bps fee.
  assert.deepEqual(
    blastRedemptionQuote(
      1_000_000_000n,
      198_520_607_880_556_399n,
      12_608_695_652n,
      requireBasisPoints("fee", 2n),
    ),
    {
      grossSui: 15_744_737_866_606_124n,
      feeSui: 3_148_947_573_322n,
      netSui: 15_741_588_919_032_802n,
    },
  );
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
