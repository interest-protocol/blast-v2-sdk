import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProtocolAccess,
  QuickPreset,
  QuickPresetValues,
} from "@interest-protocol/blast-deployments-sdk";
import {
  defineBlastDeployment,
  defineQuickPreset,
  deploymentFingerprint,
  QUICK_PRESETS,
  resolveQuickPreset,
} from "@interest-protocol/blast-deployments-sdk";
import { NON_PRODUCTION_MANIFEST } from "./fixtures/non-production-deployment.ts";

const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);
const fingerprint = deploymentFingerprint(deployment);
const venues = {
  cetus: { available: true },
  bluefin: { available: true },
} as const;
const enabled: ProtocolAccess = {
  signing: "enabled",
  deployment,
  fingerprint,
  venues,
};
const values: QuickPresetValues = {
  virtualQuote: 3_000_000_000_000n,
  graduationTarget: 12_345_678_901_237n,
  openingRoundMs: 60_000n,
  route: { venue: "bluefin", tickSpacing: 200, feeRate: "10000" },
  allocationPlan: {
    curveMemeBps: 7_000n,
    lpMemeBps: 2_000n,
    lpQuoteBps: 9_500n,
    recipients: [],
  },
  lpFeeSplit: {
    creatorBps: 10_000n,
    autoLpBps: 0n,
    rewardsBps: 0n,
    burnBps: 0n,
    recipients: [],
  },
};
const preset = (overrides: Partial<QuickPreset> = {}) =>
  defineQuickPreset({
    id: "quick-local",
    deploymentFingerprint: fingerprint,
    sdk: { minimum: "0.0.0", below: "0.1.0" },
    values,
    ...overrides,
  });

test("ships no production Quick preset values", () => {
  assert.deepEqual(QUICK_PRESETS, []);
});

test("binds a Quick preset to one deployment fingerprint and SDK range", () => {
  const resolved = resolveQuickPreset(preset(), enabled);
  assert.equal(resolved.status, "available");
  assert.equal(
    resolved.status === "available" ? resolved.values.route.venue : null,
    "bluefin",
  );

  assert.deepEqual(
    resolveQuickPreset(
      preset({ deploymentFingerprint: "0".repeat(64) }),
      enabled,
    ),
    { status: "unavailable", reason: "deployment-mismatch" },
  );
  assert.deepEqual(
    resolveQuickPreset(
      preset({ sdk: { minimum: "0.1.0", below: "0.2.0" } }),
      enabled,
    ),
    { status: "unavailable", reason: "sdk-incompatible" },
  );
  assert.deepEqual(resolveQuickPreset(preset({ values: null }), enabled), {
    status: "unavailable",
    reason: "values-absent",
  });
  assert.deepEqual(
    resolveQuickPreset(preset(), {
      signing: "disabled",
      deployment,
      fingerprint,
      reasons: [{ code: "runtime-unverified", message: "no runtime" }],
      venues,
    }),
    { status: "unavailable", reason: "signing-disabled" },
  );
});

test("rejects malformed Quick presets", () => {
  assert.throws(() => preset({ deploymentFingerprint: "abc" }), /fingerprint/);
  assert.throws(
    () => preset({ sdk: { minimum: "1.0.0", below: "1.0.0" } }),
    /SDK range/,
  );
  assert.throws(
    () =>
      preset({
        values: { ...values, route: { ...values.route, venue: "turbos" } },
      } as never),
    /unsupported route/,
  );
  assert.throws(
    () => preset({ values: { ...values, virtualQuote: 0n } }),
    /virtualQuote must be a positive u64/,
  );
});
