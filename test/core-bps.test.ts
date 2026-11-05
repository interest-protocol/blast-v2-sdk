import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_ABORTS,
  coreAbortName,
} from "@interest-protocol/blast-core/aborts";
import {
  applyBpsUp,
  apportionBps,
  bpsBcs,
  requireBps,
} from "@interest-protocol/blast-core/bps";
import { merkleLeaf } from "@interest-protocol/blast-core/merkle";
import {
  isSeedablePrice,
  sqrtPriceX64,
} from "@interest-protocol/blast-core/migration-math";
import { toHex } from "@mysten/sui/utils";

// Literal outputs printed by test/fixtures/core-vectors.move at contracts a1a8f6c9.

test("apportionBps mirrors bps::apportion, rounded-up part included", () => {
  const U64_MAX = 18_446_744_073_709_551_615n;
  const cases: [bigint[], bigint, number | null, bigint[]][] = [
    [[3333n, 3333n, 3334n], 100n, null, [33n, 33n, 34n]],
    [[5000n, 5000n], 7n, 1, [3n, 4n]],
    [[1n, 9999n], 1n, null, [0n, 1n]],
    [[2500n, 2500n, 2500n, 2500n], 3n, 3, [1n, 1n, 0n, 1n]],
    [[7000n, 2000n, 1000n], 999_999n, 0, [700_000n, 199_999n, 100_000n]],
    [
      [1234n, 4321n, 4445n],
      U64_MAX,
      2,
      [2276328218695758669n, 7970838114249897253n, 8199577740763895693n],
    ],
  ];
  for (const [rates, total, roundedUp, expected] of cases) {
    const amounts = apportionBps(rates, total, roundedUp);
    assert.deepEqual(amounts, expected, `${rates} over ${total}`);
    assert.equal(
      amounts.reduce((sum, amount) => sum + amount, 0n),
      total,
    );
  }
});

test("apportionBps throws where bps::apportion aborts", () => {
  assert.throws(() => apportionBps([5000n, 4999n], 10n, null), RangeError);
  assert.throws(() => apportionBps([10_000n], 10n, 1), RangeError);
  assert.throws(() => apportionBps([10_000n], 10n, -1), RangeError);
  assert.throws(() => apportionBps([10_001n, -1n], 10n, null), RangeError);
});

test("applyBpsUp mirrors bps::apply_up", () => {
  assert.equal(applyBpsUp(1n, 1n), 1n);
  assert.equal(applyBpsUp(10_000n, 3333n), 3333n);
  assert.equal(applyBpsUp(7n, 5000n), 4n);
  assert.equal(applyBpsUp(0n, 9999n), 0n);
  assert.equal(applyBpsUp(3n, 10_000n), 3n);
});

test("Bps is one u64 and accepts 0 through 10,000", () => {
  assert.deepEqual(
    Array.from(bpsBcs.serialize(1500n).toBytes()),
    [0xdc, 0x05, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(bpsBcs.parse(bpsBcs.serialize(10_000n).toBytes()), 10_000n);
  assert.equal(requireBps(0n), 0n);
  assert.throws(() => requireBps(10_001n), RangeError);
});

test("sqrtPriceX64 and isSeedablePrice mirror blast_core::migration", () => {
  assert.equal(sqrtPriceX64(1000n, 4000n, true), 36893488147419103232n);
  assert.equal(sqrtPriceX64(4000n, 1000n, true), 9223372036854775808n);
  assert.equal(sqrtPriceX64(1000n, 4000n, false), 9223372036854775808n);
  assert.equal(
    sqrtPriceX64(1n, 18_446_744_073_709_551_615n, true),
    79228162514264337591396466687n,
  );
  assert.equal(isSeedablePrice(8590096031n), false);
  assert.equal(isSeedablePrice(8590096032n), true);
  assert.equal(isSeedablePrice(39613336757700639996223789527n), true);
  assert.equal(isSeedablePrice(39613336757700639996223789528n), false);
});

test("merkleLeaf mirrors merkle::leaf", () => {
  assert.equal(
    toHex(merkleLeaf("blast-holder-rewards-v2", Uint8Array.from([1, 2]))),
    "1bada6112b21bca4fea82fecd160ee70508625223378166399e2ffc69d3579fb",
  );
});

test("core aborts name blast_core's numeric codes", () => {
  assert.equal(CORE_ABORTS.length, 14);
  assert.equal(coreAbortName(0), "EInvalidBps");
  assert.equal(coreAbortName(10), "EWrongPackageWitness");
  assert.equal(coreAbortName(13), "ELedgerNotEmpty");
  assert.equal(coreAbortName(14), null);
  assert.equal(coreAbortName(1.5), null);
});
