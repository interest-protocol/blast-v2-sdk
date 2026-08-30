# All-Contract SDK Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete frontend-ready SDK parity for all five production Blast V2 Sui packages without deploying contracts or building downstream services.

**Architecture:** Follow the existing contract-shaped call/transaction/client pattern. Add one focused `blast-sui` module, add event/replay support beside vesting, and centralize only the BCS and native-event helpers already duplicated across existing modules.

**Tech Stack:** Node.js 22.18+, TypeScript 7.0.2, Biome 2.5.11, `@mysten/sui` 2.26.2, Node test runner, Sui CLI 1.77.2.

**Spec:** `docs/superpowers/specs/2026-08-30-all-contract-sdk-parity-design.md`

## Global Constraints

- Apply the repository `ponytail` skill throughout: reuse established patterns and make the smallest correct change.
- Use test-driven development for every behavior change: red, green, then refactor.
- Preserve all existing launchpad, Meme-template, migrator, and vesting behavior.
- Use `bigint` for atomic protocol values and never use floating point for protocol arithmetic.
- Move call targets use current package IDs; type identity, BCS identity, and event identity use original package IDs.
- Do not publish, deploy, upgrade, configure, or add placeholder IDs for a contract.
- Do not touch or stage `../contracts/sui/meme_template/Move.lock` or `../contracts/docs/research/sui-deepbook-indexer-architecture-2026.md`.
- Do not add routine administration or package-upgrade transaction builders.
- Do not add an indexer, database, API, backend, frontend wiring, or Move contract convenience changes.
- Keep every required check green before claiming completion.

---

## File Map

### Shared SDK and tooling

- Create `biome.json`: formatting, import, and cognitive-complexity gates.
- Modify `package.json` and `package-lock.json`: TypeScript 7, Biome, and scripts.
- Modify `src/lib/integers.ts`: distinct `BasisPoints` brand.
- Create `src/lib/bcs.ts`: canonical repeated Sui BCS primitives.
- Create `src/lib/events.ts`: native event position normalization and identity.
- Mechanically modify existing state/event modules to consume those two proven common helpers.

### ABI parity

- Modify `scripts/check-contract-abi.mjs`: package-configured extraction and low-complexity classification.
- Add `abi/production-vesting-v1.json` and `abi/production-blast-sui-v1.json`.
- Modify `test/abi-parity.test.ts`: validate all three artifacts and event inventories.

### `blast_sui`

- Create `src/blast-sui/types.ts`: deployment and original-ID type helpers.
- Create `src/blast-sui/math.ts`: exact integer formula mirrors.
- Create `src/blast-sui/state.ts`: vault/receipt BCS decoding and Core API reads.
- Create `src/blast-sui/transactions.ts`: composable calls and frontend-ready transactions.
- Create `src/blast-sui/client.ts`: Core API extension.
- Create `src/blast-sui/events.ts`: all 20 wrapped payload decoders.
- Create `src/blast-sui/reducer.ts`: deterministic event and native-fact replay.
- Create `src/blast-sui/index.ts`: public subpath exports.
- Modify deployment registry/types and root exports.

### Vesting

- Create `src/vesting/events.ts`: eight direct event decoders.
- Create `src/vesting/reducer.ts`: deterministic event and native-fact replay.
- Modify `src/vesting/index.ts`: additive exports.

### Tests and coverage

- Modify `test/integers.test.ts`, `test/deployments.test.ts`, and `test/abi-parity.test.ts`.
- Add `test/common-bcs.test.ts`, `test/common-events.test.ts`,
  `test/blast-sui-math.test.ts`, `test/blast-sui-state.test.ts`,
  `test/blast-sui-transactions.test.ts`, `test/blast-sui-client.test.ts`,
  `test/blast-sui-events.test.ts`, `test/blast-sui-reducer.test.ts`,
  `test/vesting-events.test.ts`, and `test/vesting-reducer.test.ts`.
- Modify `docs/launchpad-abi-coverage.md` into the all-contract coverage matrix while preserving the launchpad baseline history.

---

### Task 1: TypeScript 7, Biome, and `BasisPoints`

**Files:**
- Create: `biome.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/lib/integers.ts`
- Modify: `test/integers.test.ts`
- Mechanically format: `src/**/*.ts`, `test/**/*.ts`, `scripts/**/*.mjs`

**Interfaces:**
- Produces: `BasisPoints`, `requireBasisPoints(name, value): BasisPoints`
- Produces: `npm run format`, `format:check`, `lint`, and aggregate `check`
- Constraint: `U64` must not be assignable to `BasisPoints`

- [ ] **Step 1: Write the failing brand tests**

Add runtime boundaries and a TypeScript-only negative assignment to
`test/integers.test.ts`:

```ts
import type { BasisPoints, U64 } from "../src/lib/integers.ts";
import {
  BASIS_POINTS_DENOMINATOR,
  requireBasisPoints,
  requireU64,
} from "../src/lib/integers.ts";

test("brands validated basis points separately from general u64 values", () => {
  const basisPoints: BasisPoints = requireBasisPoints("fee", 100n);
  const generalU64: U64 = requireU64("amount", 100n);
  assert.equal(basisPoints, 100n);
  assert.equal(generalU64, 100n);
  // @ts-expect-error A range-checked u64 is not automatically basis points.
  const invalidRate: BasisPoints = generalU64;
  assert.equal(invalidRate, 100n);
});

test("accepts only the inclusive basis-point range", () => {
  assert.equal(requireBasisPoints("fee", 0n), 0n);
  assert.equal(
    requireBasisPoints("fee", BASIS_POINTS_DENOMINATOR),
    10_000n,
  );
  assert.throws(() => requireBasisPoints("fee", -1n), RangeError);
  assert.throws(() => requireBasisPoints("fee", 10_001n), RangeError);
});
```

- [ ] **Step 2: Verify the type test fails**

Run: `npm run typecheck`

Expected: FAIL because `BasisPoints` is not exported and
`requireBasisPoints` still returns `U64`.

- [ ] **Step 3: Implement the distinct brand**

In `src/lib/integers.ts`, add the brand and change the validator return:

```ts
declare const BASIS_POINTS_BRAND: unique symbol;

export type BasisPoints = U64 & {
  readonly [BASIS_POINTS_BRAND]: true;
};

export function requireBasisPoints(
  name: string,
  value: bigint,
): BasisPoints {
  if (value < 0n || value > BASIS_POINTS_DENOMINATOR) {
    throw new RangeError(`${name} must be between 0 and 10,000 basis points`);
  }
  return value as BasisPoints;
}
```

- [ ] **Step 4: Install exact tooling versions**

Run:

```bash
npm install --save-dev typescript@7.0.2 @biomejs/biome@2.5.11
```

Update scripts in `package.json` to:

```json
{
  "check": "npm run check:abi && npm run format:check && npm run lint && npm run typecheck && npm test",
  "format": "biome format --write . && biome check --write --only=assist/source/organizeImports .",
  "format:check": "biome format .",
  "lint": "biome lint .",
  "typecheck": "tsc"
}
```

- [ ] **Step 5: Add the Biome configuration**

Create `biome.json` with only the approved rules:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.11/schema.json",
  "files": {
    "includes": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.mjs"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 80
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always",
      "trailingCommas": "all"
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "complexity": {
        "noExcessiveCognitiveComplexity": {
          "level": "error",
          "options": { "maxAllowedComplexity": 15 }
        }
      },
      "correctness": {
        "noUndeclaredDependencies": "error",
        "noUnresolvedImports": "error",
        "noUnusedImports": "error"
      },
      "style": {
        "useImportType": {
          "level": "error",
          "options": { "style": "separatedType" }
        }
      },
      "suspicious": {
        "noImportCycles": "error"
      }
    }
  },
  "assist": {
    "enabled": true,
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    }
  }
}
```

- [ ] **Step 6: Apply the one-time mechanical formatting pass**

Run: `npm run format`

Review with: `git diff --stat && git diff --check`

Only formatting and import organization may appear outside the integer and
tooling files.

- [ ] **Step 7: Run the ticket gates**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

Expected: all PASS. If recommended Biome warnings exist, fix only warnings in
touched code unless the command exits nonzero.

- [ ] **Step 8: Commit the tooling and brand ticket**

```bash
git add biome.json package.json package-lock.json src test scripts
git commit -m "build: adopt TypeScript 7 and Biome"
```

---

### Task 2: Shared BCS and Native Event Primitives

**Files:**
- Create: `src/lib/bcs.ts`
- Create: `src/lib/events.ts`
- Create: `test/common-bcs.test.ts`
- Create: `test/common-events.test.ts`
- Modify: `src/launchpad/state.ts`
- Modify: `src/launchpad/events.ts`
- Modify: `src/migrators/state.ts`
- Modify: `src/migrators/events.ts`
- Modify: `src/vesting/state.ts`

**Interfaces:**
- Produces: `suiIdBcs`, `suiUidBcs`, `suiBalanceBcs`, `moveTypeNameBcs`
- Produces: `SuiEventPosition`, `normalizeSuiEventPosition`, `suiEventId`
- Preserves: `LaunchpadEventPosition`, `launchpadEventId`, and `migratorEventId`

- [ ] **Step 1: Write failing common-helper tests**

Create `test/common-bcs.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  moveTypeNameBcs,
  suiBalanceBcs,
  suiIdBcs,
  suiUidBcs,
} from "../src/lib/bcs.ts";

test("round-trips canonical Sui BCS primitives", () => {
  assert.match(suiIdBcs.parse(suiIdBcs.serialize("0xc").toBytes()), /0c$/);
  assert.match(
    suiUidBcs.parse(suiUidBcs.serialize({ id: "0xd" }).toBytes()).id,
    /0d$/,
  );
  assert.equal(
    suiBalanceBcs.parse(suiBalanceBcs.serialize({ value: 7n }).toBytes()).value,
    7n,
  );
  assert.equal(
    moveTypeNameBcs.parse(
      moveTypeNameBcs.serialize("0x2::sui::SUI").toBytes(),
    ),
    "0x2::sui::SUI",
  );
});
```

Create `test/common-events.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSuiEventPosition,
  suiEventId,
} from "../src/lib/events.ts";

test("normalizes one native Sui event position", () => {
  const position = normalizeSuiEventPosition({
    checkpoint: "42",
    transactionDigest: "digest",
    eventIndex: 3,
  });
  assert.deepEqual(position, {
    checkpoint: 42n,
    transactionDigest: "digest",
    eventIndex: 3,
  });
  assert.equal(suiEventId(position), "digest:3");
});

test("rejects missing or unsafe native metadata", () => {
  assert.throws(
    () =>
      normalizeSuiEventPosition({
        checkpoint: null,
        transactionDigest: "digest",
        eventIndex: 0,
      }),
    /checkpoint/,
  );
  assert.throws(
    () =>
      normalizeSuiEventPosition({
        checkpoint: "1",
        transactionDigest: "",
        eventIndex: 0,
      }),
    /transaction digest/,
  );
});
```

- [ ] **Step 2: Verify the helper tests fail**

Run:

```bash
node --test test/common-bcs.test.ts test/common-events.test.ts
```

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement the common BCS layouts**

Create `src/lib/bcs.ts` with transformed, normalized layouts:

```ts
import { bcs } from "@mysten/sui/bcs";
import {
  normalizeStructTag,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

export const suiIdBcs = bcs.struct("ID", { bytes: bcs.Address }).transform({
  input: (value: string) => ({ bytes: normalizeSuiObjectId(value) }),
  output: (value) => normalizeSuiObjectId(value.bytes),
});

export const suiUidBcs = bcs.struct("UID", { id: suiIdBcs });
export const suiBalanceBcs = bcs.struct("Balance", { value: bcs.u64() });

const asciiStringBcs = bcs.struct("AsciiString", {
  bytes: bcs.vector(bcs.u8()),
});

export const moveTypeNameBcs = bcs
  .struct("TypeName", { name: asciiStringBcs })
  .transform({
    input: (value: string) => ({
      name: { bytes: Array.from(new TextEncoder().encode(value)) },
    }),
    output: (value) =>
      normalizeStructTag(
        new TextDecoder().decode(Uint8Array.from(value.name.bytes)),
      ),
  });
```

- [ ] **Step 4: Implement event metadata normalization**

Create `src/lib/events.ts`:

```ts
import { requireU64 } from "./integers.ts";

export type SuiEventPosition = {
  checkpoint: bigint;
  transactionDigest: string;
  eventIndex: number;
};

export function normalizeSuiEventPosition(input: {
  checkpoint: number | string | null;
  transactionDigest: string;
  eventIndex: number;
}): SuiEventPosition {
  if (input.checkpoint === null) {
    throw new TypeError("event requires checkpoint metadata");
  }
  let checkpoint: bigint;
  try {
    checkpoint = BigInt(input.checkpoint);
  } catch {
    throw new TypeError("event checkpoint must be a u64");
  }
  requireU64("event checkpoint", checkpoint);
  if (!input.transactionDigest) {
    throw new TypeError("event transaction digest is required");
  }
  if (!Number.isSafeInteger(input.eventIndex) || input.eventIndex < 0) {
    throw new RangeError("event index must be a non-negative integer");
  }
  return { checkpoint, transactionDigest: input.transactionDigest, eventIndex: input.eventIndex };
}

export function suiEventId(position: SuiEventPosition): string {
  return `${position.transactionDigest}:${position.eventIndex}`;
}
```

- [ ] **Step 5: Mechanically adopt the helpers**

Replace local `ID`, `UID`, `Balance`, and `TypeName` definitions only where the
layout is identical. Alias existing event positions:

```ts
export type LaunchpadEventPosition = SuiEventPosition;

export function launchpadEventId(event: DecodedLaunchpadEvent): string {
  return suiEventId(event.position);
}
```

Use `normalizeSuiEventPosition(event)` inside both existing decoders. Keep all
existing public names and error-boundary tests.

- [ ] **Step 6: Run focused and regression tests**

```bash
node --test test/common-bcs.test.ts test/common-events.test.ts \
  test/launchpad-events.test.ts test/migrator-events.test.ts \
  test/state.test.ts test/migrators-state.test.ts test/vesting-state.test.ts
npm run typecheck
npm run lint
```

Expected: all PASS.

- [ ] **Step 7: Commit the shared primitive ticket**

```bash
git add src/lib src/launchpad src/migrators src/vesting test
git commit -m "refactor: share Sui BCS and event primitives"
```

---

### Task 3: Freeze Vesting and `blast_sui` ABI Parity

**Files:**
- Modify: `scripts/check-contract-abi.mjs`
- Modify: `test/abi-parity.test.ts`
- Create: `abi/production-vesting-v1.json`
- Create: `abi/production-blast-sui-v1.json`

**Interfaces:**
- Produces: normalized ABI artifacts for all five production packages
- Preserves: byte-for-byte generation of `production-launchpad-v1.json`
- Detects: functions, references/mutability, returns, type parameters, structs, enums, direct events, and wrapped events

- [ ] **Step 1: Write failing artifact inventory tests**

Extend `test/abi-parity.test.ts` to load all three artifacts and assert:

```ts
const expectedEvents = {
  launchpad: 30,
  migrators: 6,
  vesting: 8,
  blastSui: 20,
};

test("freezes every production package and event", () => {
  const launchpad = readArtifact("production-launchpad-v1.json");
  const vesting = readArtifact("production-vesting-v1.json");
  const blastSui = readArtifact("production-blast-sui-v1.json");
  assert.deepEqual(Object.keys(launchpad.packages).sort(), [
    "launchpad",
    "memeTemplate",
    "migrators",
  ]);
  assert.deepEqual(Object.keys(vesting.packages), ["vesting"]);
  assert.deepEqual(Object.keys(blastSui.packages), ["blastSui"]);
  assert.equal(countEvents(launchpad, "launchpad"), expectedEvents.launchpad);
  assert.equal(countEvents(launchpad, "migrators"), expectedEvents.migrators);
  assert.equal(countEvents(vesting, "vesting"), expectedEvents.vesting);
  assert.equal(countEvents(blastSui, "blastSui"), expectedEvents.blastSui);
});
```

Also assert that every public function has a nonempty `sdk` classification and
that `blast_sui::events_wrapper::Event<T>` remains in the struct inventory.

- [ ] **Step 2: Verify the artifact tests fail**

Run: `node --test test/abi-parity.test.ts`

Expected: FAIL because the two artifacts do not exist.

- [ ] **Step 3: Refactor the checker around package declarations**

Replace the single hard-coded artifact with declarations shaped as:

```js
const artifactDeclarations = [
  {
    path: "production-launchpad-v1.json",
    packages: [
      ["launchpad", "launchpad", "blast_fun"],
      ["memeTemplate", "meme_template", "meme_template"],
      ["migrators", "migrators", "blast_fun_migrators"],
    ],
  },
  {
    path: "production-vesting-v1.json",
    packages: [["vesting", "vesting", "blast_fun_vesting"]],
  },
  {
    path: "production-blast-sui-v1.json",
    packages: [["blastSui", "blast_sui", "blast_sui"]],
  },
];
```

Use small classifiers selected by package name:

```js
function classifyFunction(packageName, moduleName, functionName) {
  const classifier = functionClassifiers[packageName];
  if (!classifier) throw new Error(`unknown package ${packageName}`);
  return classifier(moduleName, functionName);
}
```

The `blast_fun_vesting` classifier labels create/share/claim/cancel/close and
checkpoint schedule calls as `builder`. The `blast_sui` classifier labels the
nine approved user operations as `builder`, math as `sdk-arithmetic`, event
field helpers as excluded when test-only summaries omit them, `vault::create`
and `deposit_receipt::create_display` as `intentional-deployment-exclusion`,
and ACL/package-admin/fee-setting functions as `intentional-admin-exclusion`.

Split direct-event detection from module naming:

```js
const directEventNames = new Set([
  "VestingCreated",
  "VestingClaimed",
  "VestingCanceled",
  "VestingClosed",
]);

function isEventStruct(packageName, moduleName, structName) {
  if (moduleName === "events") return true;
  return packageName === "blast_fun_vesting" && directEventNames.has(structName);
}
```

This split must reduce every checker function below cognitive complexity 16.

- [ ] **Step 4: Generate only the approved new artifacts**

Run: `npm run check:abi:write`

Review:

```bash
git diff -- abi/production-launchpad-v1.json
git diff --stat abi scripts/check-contract-abi.mjs
```

Expected: the existing launchpad artifact has no diff; two new artifacts are
present and record baseline `a5ed34ad49c6c001af2db5b9cbcb206075704412`.

- [ ] **Step 5: Run ABI and tooling gates**

```bash
npm run check:abi
node --test test/abi-parity.test.ts
npm run lint
npm run typecheck
```

Expected: all PASS, with 20 `blast_sui` and eight vesting events classified.

- [ ] **Step 6: Commit the ABI ticket**

```bash
git add scripts/check-contract-abi.mjs test/abi-parity.test.ts abi
git commit -m "test: freeze vesting and blast Sui ABI"
```

---

### Task 4: `blast_sui` Types, Deployment Helpers, and Math

**Files:**
- Create: `src/blast-sui/types.ts`
- Create: `src/blast-sui/math.ts`
- Create: `test/blast-sui-math.test.ts`
- Modify: `src/deployments/types.ts`
- Modify: `src/deployments/registry.ts`
- Modify: `test/deployments.test.ts`

**Interfaces:**
- Produces: `BlastSuiDeployment`, `normalizeBlastSuiDeployment`
- Produces: `funSuiType`, `blastSuiType`, `blastSuiDepositReceiptType`
- Produces: `blastSuiDeployment(deployment)` without chain mutation
- Produces: eight exact math helpers

- [ ] **Step 1: Write failing deployment and type-helper tests**

Extend the deployment fixture with:

```ts
packages: {
  launchpad: { packageId: "0x123", originalPackageId: "0x122" },
  blastSui: { packageId: "0x423", originalPackageId: "0x422" },
},
sharedObjects: {
  packageVersion: { objectId: "0x2", initialSharedVersion: "10" },
  launchConfig: { objectId: "0x3", initialSharedVersion: "11" },
  runtimeConfig: { objectId: "0x4", initialSharedVersion: "12" },
  protocolAuthority: { objectId: "0x5", initialSharedVersion: "13" },
  blastSuiPackageVersion: { objectId: "0x8", initialSharedVersion: "16" },
  blastSuiVault: { objectId: "0x9", initialSharedVersion: "17" },
},
```

Assert `blastSuiDeployment()` returns current/original package IDs,
`packageVersion.mutable === false`, and `vault.mutable === true`. Assert missing
optional values throw only when the helper is requested. Assert
`BLAST_DEPLOYMENTS` remains `{}`.

- [ ] **Step 2: Write failing math parity tests**

Create table-driven tests covering exact formulas and boundaries:

```ts
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
```

- [ ] **Step 3: Verify the tests fail**

Run:

```bash
node --test test/deployments.test.ts test/blast-sui-math.test.ts
```

Expected: FAIL because the exports do not exist.

- [ ] **Step 4: Implement deployment and original-ID type helpers**

Create `src/blast-sui/types.ts` with:

```ts
export type BlastSuiDeployment = {
  packageId: string;
  originalPackageId?: string;
  packageVersion: SharedObjectReference<false>;
  vault: SharedObjectReference<true>;
};

export function funSuiType(originalPackageId: string): string {
  return `${normalizeSuiObjectId(originalPackageId)}::fun_sui::FUN_SUI`;
}

export function blastSuiType(originalPackageId: string): string {
  return `${normalizeSuiObjectId(originalPackageId)}::blast_sui::BLAST_SUI`;
}

export function blastSuiDepositReceiptType(originalPackageId: string): string {
  return `${normalizeSuiObjectId(originalPackageId)}::deposit_receipt::BlastSuiDepositReceipt`;
}
```

Normalize both shared references with their exact mutability. Extend deployment
registry types with optional, distinctly named `blastSui` entries and implement
`blastSuiDeployment()` without populating the registry.

- [ ] **Step 5: Implement the eight exact math helpers**

Use `requirePositiveU64`, `requireU64`, `mulDivDown`, `mulDivUp`, and
`BasisPoints`. Export:

```ts
blastSharesOutDown(deposit, blastAssets, blastSupply): bigint
blastGrossSuiOutDown(shares, blastAssets, blastSupply): bigint
blastRedeemFeeUp(grossSui, redeemFeeBps): bigint
blastRedemptionQuote(shares, blastAssets, blastSupply, redeemFeeBps): {
  grossSui: bigint;
  feeSui: bigint;
  netSui: bigint;
}
suiAtRateDown(poolTokens, rateSui, ratePoolTokens): bigint
poolTokensAtRateDown(suiAmount, rateSui, ratePoolTokens): bigint
funConversionLossBoundUp(rateSui, ratePoolTokens): bigint
poolTokensForSuiUp(suiAmount, held, activeSui): bigint
```

Match the Move zero and abort conditions. Document units, rounding, and
remainder ownership above each helper.

- [ ] **Step 6: Run focused and regression gates**

```bash
node --test test/deployments.test.ts test/blast-sui-math.test.ts test/integers.test.ts
npm run lint
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 7: Commit the types and math ticket**

```bash
git add src/blast-sui src/deployments test/deployments.test.ts test/blast-sui-math.test.ts
git commit -m "feat: add blast Sui types and math"
```

---

### Task 5: `blast_sui` State Decoding and Frontend Reads

**Files:**
- Create: `src/blast-sui/state.ts`
- Create: `test/blast-sui-state.test.ts`

**Interfaces:**
- Produces: `blastSuiVaultBcs`, `blastSuiDepositReceiptBcs`
- Produces: `decodeBlastSuiVaultObject`, `decodeBlastSuiDepositReceiptObject`
- Produces: `getBlastSuiVault`, `getBlastSuiDepositReceipt`
- Consumes: shared BCS primitives and original-ID type helpers

- [ ] **Step 1: Write failing vault-decoder tests**

Construct a complete BCS fixture with both custody ledgers:

```ts
const custody = {
  liquid_sui: { value: 11n },
  pending_stakes: [
    {
      id: { id: "0xa1" },
      pool_id: "0x55",
      stake_activation_epoch: 9n,
      principal: { value: 13n },
    },
  ],
  active_stake: {
    id: { id: "0xa2" },
    pool_id: "0x55",
    value: 17n,
  },
  active_sui: 19n,
};
```

Serialize a vault with treasury supplies 100 and 200, decode it, and assert
`funCustody.assets === 43n`, `blastSupply === 200n`, the pool ID, rate tuple,
fee brand value, and `unwindOnly`.

Add negative tests for wrong module/name, wrong original package, mismatched
UID, non-shared owner input, and invalid mutability.

- [ ] **Step 2: Write failing receipt and Core API read tests**

Serialize `BlastSuiDepositReceipt` with vault ID, pool ID, activation epoch, and
principal. Assert the decoder returns the normalized receipt ID and owner.
Stub `ClientWithCoreApi.core.getObject` for one shared vault and one
address-owned receipt and assert both read helpers call it with
`include: { content: true }`.

- [ ] **Step 3: Verify state tests fail**

Run: `node --test test/blast-sui-state.test.ts`

Expected: FAIL because `state.ts` is absent.

- [ ] **Step 4: Implement pinned framework BCS layouts**

Define the exact pinned layouts:

```ts
const supplyBcs = bcs.struct("Supply", { value: bcs.u64() });
const treasuryCapBcs = bcs.struct("TreasuryCap", {
  id: suiUidBcs,
  total_supply: supplyBcs,
});
const stakedSuiBcs = bcs.struct("StakedSui", {
  id: suiUidBcs,
  pool_id: suiIdBcs,
  stake_activation_epoch: bcs.u64(),
  principal: suiBalanceBcs,
});
const fungibleStakedSuiBcs = bcs.struct("FungibleStakedSui", {
  id: suiUidBcs,
  pool_id: suiIdBcs,
  value: bcs.u64(),
});
const custodyBcs = bcs.struct("Custody", {
  liquid_sui: suiBalanceBcs,
  pending_stakes: bcs.vector(stakedSuiBcs),
  active_stake: bcs.option(fungibleStakedSuiBcs),
  active_sui: bcs.u64(),
});
```

Then define the field order from `vault::Vault` and
`deposit_receipt::BlastSuiDepositReceipt` exactly.

- [ ] **Step 5: Implement typed projections and reads**

Return normalized public shapes:

```ts
export type BlastSuiCustodyState = {
  liquidSui: bigint;
  pendingStakes: readonly BlastSuiPendingStake[];
  activeStake: BlastSuiActiveStake | null;
  activeSui: bigint;
  assets: bigint;
};

export type BlastSuiVaultState = SharedObjectReference<true> & {
  originalPackageId: string;
  poolId: string;
  funSupply: bigint;
  blastSupply: bigint;
  funCustody: BlastSuiCustodyState;
  blastCustody: BlastSuiCustodyState;
  exchangeRate: { epoch: bigint; suiAmount: bigint; poolTokenAmount: bigint };
  redeemFeeBps: BasisPoints;
  unwindOnly: boolean;
};
```

Receipt state includes `owner`, `vaultId`, `poolId`, `principalSui`, and
`activationEpoch`. Validate `AddressOwner` and reject other owner shapes for the
frontend-owned receipt read.

- [ ] **Step 6: Run state gates**

```bash
node --test test/blast-sui-state.test.ts test/vesting-state.test.ts \
  test/state.test.ts test/migrators-state.test.ts
npm run lint
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 7: Commit the state ticket**

```bash
git add src/blast-sui/state.ts test/blast-sui-state.test.ts
git commit -m "feat: decode blast Sui vault state"
```

---

### Task 6: `blast_sui` Calls, Transactions, Client, and Exports

**Files:**
- Create: `src/blast-sui/transactions.ts`
- Create: `src/blast-sui/client.ts`
- Create: `src/blast-sui/index.ts`
- Create: `test/blast-sui-transactions.test.ts`
- Create: `test/blast-sui-client.test.ts`
- Modify: `src/index.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `BlastSuiCalls`, `BlastSuiTransactions`, `BlastSuiClient`, `blastSui`
- Consumes: `BlastSuiDeployment`, state reads, `tx.object.system({ mutable: true })`

- [ ] **Step 1: Write failing composable-call tests**

For all nine operations, inspect `Transaction.getData()` and assert this exact
function sequence:

```ts
[
  "vault::mint_fun_sui",
  "vault::redeem_fun_sui",
  "vault::request_blast_sui",
  "deposit_receipt::keep",
  "vault::claim_blast_sui",
  "deposit_receipt::cancel",
  "vault::donate_sui",
  "vault::redeem_blast_sui",
  "vault::sync",
]
```

Assert the vault reference is mutable, package version is immutable, and every
system-state reference is `SUI_SYSTEM_STATE_OBJECT_ID`, initial shared version
1, mutable `true`. Assert call targets use current package ID.

- [ ] **Step 2: Write failing frontend routing tests**

Assert these high-level builders:

- mint, redeem fun, claim blast, cancel receipt, and redeem blast end in
  `TransferObjects` to the required recipient;
- request ends with `deposit_receipt::keep` and no generic transfer;
- donate and sync do not add transfers;
- coin selection uses `0x2::sui::SUI` or the original-package FUN/BLAST type;
- every min-output and amount is validated as `u64`.

Use explicit methods:

```ts
mintFunSui({ amount, recipient })
redeemFunSui({ amount, recipient })
requestBlastSui({ amount })
claimBlastSui({ receiptId, minBlastOut, recipient })
cancelDepositReceipt({ receiptId, recipient })
donateSui({ amount })
redeemBlastSui({ amount, minSuiOut, recipient })
syncVault()
```

- [ ] **Step 3: Verify transaction tests fail**

Run: `node --test test/blast-sui-transactions.test.ts`

Expected: FAIL because the transaction module is absent.

- [ ] **Step 4: Implement composable calls**

Follow `LaunchpadCalls`: constructor-normalize the deployment, return transaction
thunks, use `tx.sharedObjectRef` for deployment objects, and use
`tx.object.system({ mutable: true })` for `SuiSystemState`.

The request call must return `TransactionObjectArgument`; claim and redemption
calls return their coin result. `keepDepositReceipt`, donation, and sync return
`void`. No call transfers results.

- [ ] **Step 5: Implement frontend-ready transactions**

Use `tx.coin({ type, balance })` for fungible inputs. Transfer each returned
coin to `normalizeSuiAddress(options.recipient)`. Compose request as:

```ts
const receipt = tx.add(this.call.requestBlastSui({ suiCoin }));
tx.add(this.call.keepDepositReceipt({ receipt }));
```

Do not expose a receipt recipient because `keep` always sends to `ctx.sender()`.

- [ ] **Step 6: Write and implement the client extension**

First add a failing test that stubs Core API object reads and verifies:

```ts
client.call instanceof BlastSuiCalls
client.tx instanceof BlastSuiTransactions
await client.getVault()
await client.getDepositReceipt("0xa")
```

Then implement `BlastSuiClient` and registration helper `blastSui`, following
`VestingClient`. `getVault()` reads the deployment vault ID; receipt reads accept
an object ID.

- [ ] **Step 7: Add package exports**

Export all `blast-sui` files from `src/blast-sui/index.ts`, export that index
from `src/index.ts`, and add:

```json
"./blast-sui": "./src/blast-sui/index.ts"
```

to `package.json` exports.

- [ ] **Step 8: Run focused and regression gates**

```bash
node --test test/blast-sui-transactions.test.ts test/blast-sui-client.test.ts \
  test/deployments.test.ts
npm run lint
npm run typecheck
npm test
```

Expected: all PASS.

- [ ] **Step 9: Commit the product-call ticket**

```bash
git add src/blast-sui src/index.ts package.json package-lock.json test
git commit -m "feat: add blast Sui product transactions"
```

---

### Task 7: Decode All `blast_sui` Events

**Files:**
- Create: `src/blast-sui/events.ts`
- Create: `test/blast-sui-events.test.ts`

**Interfaces:**
- Produces: `blastSuiEventSpecs`, `blastSuiEventBcs`, `decodeBlastSuiEvent`, `blastSuiEventId`
- Consumes: shared BCS layouts and native event position
- Covers: all 20 `events_wrapper::Event<events::T>` payloads

- [ ] **Step 1: Write the failing complete-inventory test**

Assert the decoder spec names exactly equal:

```ts
[
  "BlastSuiDepositCancelled",
  "BlastSuiDepositClaimed",
  "BlastSuiDepositRequested",
  "BlastSuiDonated",
  "BlastSuiRedeemed",
  "FunSuiMinted",
  "FunSuiRedeemed",
  "FunYieldSwept",
  "NativeStakeUnwound",
  "PackageAdminCreated",
  "PackageVersionAdvanced",
  "RedeemFeeChanged",
  "SuperAdminTransferCancelled",
  "SuperAdminTransferStarted",
  "SuperAdminTransferred",
  "UpgradeAuthorized",
  "UpgradeCommitted",
  "UpgradePolicyRestricted",
  "VaultCreated",
  "VaultSynced",
]
```

Compare each field name and normalized Move type against
`abi/production-blast-sui-v1.json`.

- [ ] **Step 2: Write one decoding test per payload**

Build BCS with `blastSuiEventBcs[kind]`, wrap the type as
`original::events_wrapper::Event<original::events::Kind>`, decode, and assert
kind, sender, emitter, payload, checkpoint, digest, and event index. Use one
table with 20 fixtures so every decoder path executes.

Add negative tests for wrong current emitter, wrong wrapper module, wrong
original wrapper address, wrong payload module/address, malformed BCS, missing
checkpoint, empty digest, and negative/unsafe event index.

- [ ] **Step 3: Verify event tests fail**

Run: `node --test test/blast-sui-events.test.ts`

Expected: FAIL because `events.ts` is absent.

- [ ] **Step 4: Implement nested custody BCS once**

Export typed `poolCustodyEventBcs`, `exchangeRateEventBcs`, and
`vaultCustodyEventBcs` matching Move field order. The event descriptor system
may refer to these three BCS types, but must not introduce a generator or class.

- [ ] **Step 5: Implement the exact event specs and decoder**

Use the existing launchpad decoder shape. Validate current emitter package
separately from original envelope/payload addresses. Parse only known payload
names. Attach:

```ts
{
  source: "blastSui",
  kind,
  payload,
  emitterPackageId,
  sender,
  position: normalizeSuiEventPosition(event),
}
```

All Move `u64` fields decode to `bigint`; `u8` fields decode to `number`; IDs
and addresses normalize; byte vectors decode to `Uint8Array`.

- [ ] **Step 6: Run event gates**

```bash
node --test test/blast-sui-events.test.ts test/launchpad-events.test.ts \
  test/migrator-events.test.ts
npm run check:abi
npm run lint
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 7: Commit the decoder ticket**

```bash
git add src/blast-sui/events.ts test/blast-sui-events.test.ts
git commit -m "feat: decode blast Sui events"
```

---

### Task 8: Replay `blast_sui` Events and Native Facts

**Files:**
- Create: `src/blast-sui/reducer.ts`
- Create: `test/blast-sui-reducer.test.ts`

**Interfaces:**
- Produces: `createBlastSuiProjection`, `reduceBlastSuiInput`
- Consumes: `DecodedBlastSuiEvent` and explicit native facts
- Guarantees: deterministic, idempotent replay by digest plus event index

- [ ] **Step 1: Write the failing ordered lifecycle replay test**

Replay an ordered sequence containing vault creation, fun mint/redeem, blast
request/claim/cancel, donation, blast redemption, yield sweep, fee change, sync,
and unwind. Assert:

- the latest custody snapshot and both supplies equal the final event;
- cumulative fun minted/redeemed totals;
- deposit principal, contributed SUI, claimed shares, canceled returned SUI;
- donated SUI, redemption gross/fee/net totals, and swept yield;
- requested receipt status becomes `claimed` or `cancelled`;
- redeem fee changes to the new `BasisPoints`; and
- `unwindOnly` becomes true.

- [ ] **Step 2: Write failing administration, duplicate, and native-fact tests**

Replay all eight administration payloads and assert pending transfer, active cap
ID, package version, package-admin identity, and last upgrade facts. Apply every
event twice and assert strict object identity on duplicate reduction.

Define and test explicit facts:

```ts
export type BlastSuiNativeFact =
  | {
      source: "objectOwnership";
      kind: "depositReceiptOwnership";
      checkpoint: bigint;
      receiptId: string;
      owner: string;
    }
  | {
      source: "transactionEffects";
      kind: "returnedCoinRecipient";
      position: NativeTransactionPosition;
      operation: "mintFunSui" | "redeemFunSui" | "claimBlastSui" |
        "cancelDepositReceipt" | "redeemBlastSui";
      coinId: string;
      recipient: string;
    };
```

Assert a request event alone does not set current receipt ownership and a
redemption event alone does not invent a returned coin ID or recipient.

- [ ] **Step 3: Verify reducer tests fail**

Run: `node --test test/blast-sui-reducer.test.ts`

Expected: FAIL because `reducer.ts` is absent.

- [ ] **Step 4: Implement the minimal projection**

Define focused records for vault state, receipt lifecycle, administration, and
native facts. Initialize all 20 event counts to zero. Use immutable record
replacement as existing reducers do; do not add a class, store, database shape,
or serialization framework.

- [ ] **Step 5: Implement event reduction**

At entry:

```ts
const eventId = blastSuiEventId(event);
if (state.appliedEventIds[eventId]) return state;
```

Increment the event count once. Replace custody with the payload's final
snapshot when present. Add deltas only to the matching cumulative total. Update
receipt status only by receipt ID. Preserve an event-derived source boundary.

- [ ] **Step 6: Implement native fact reduction**

Normalize IDs/addresses and validate checkpoint/digest. Deduplicate ownership
by checkpoint, receipt ID, and owner; deduplicate returned coins by transaction
digest and coin ID. Store these only under `projection.native`.

- [ ] **Step 7: Run reducer and regression gates**

```bash
node --test test/blast-sui-reducer.test.ts test/blast-sui-events.test.ts \
  test/migrator-events.test.ts test/launchpad-events.test.ts
npm run lint
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 8: Commit the replay ticket**

```bash
git add src/blast-sui/reducer.ts test/blast-sui-reducer.test.ts
git commit -m "feat: replay blast Sui state"
```

---

### Task 9: Decode and Replay All Vesting Events

**Files:**
- Create: `src/vesting/events.ts`
- Create: `src/vesting/reducer.ts`
- Create: `test/vesting-events.test.ts`
- Create: `test/vesting-reducer.test.ts`
- Modify: `src/vesting/index.ts`

**Interfaces:**
- Produces: `decodeVestingEvent`, `vestingEventId`
- Produces: `createVestingProjection`, `reduceVestingInput`
- Covers: four direct event names in both `linear` and `checkpoints`

- [ ] **Step 1: Write failing decoder inventory and parity tests**

Assert the discriminator pairs are exactly:

```ts
[
  ["checkpoints", "VestingCanceled"],
  ["checkpoints", "VestingClaimed"],
  ["checkpoints", "VestingClosed"],
  ["checkpoints", "VestingCreated"],
  ["linear", "VestingCanceled"],
  ["linear", "VestingClaimed"],
  ["linear", "VestingClosed"],
  ["linear", "VestingCreated"],
]
```

Compare fields and types with `production-vesting-v1.json`. Build and decode a
fixture for every pair. Assert module is part of the kind, coin `TypeName` is
normalized, and native position is attached. Reject wrong emitter/current ID,
wrong original type address, unsupported module/name, malformed BCS, and invalid
metadata.

- [ ] **Step 2: Verify decoder tests fail**

Run: `node --test test/vesting-events.test.ts`

Expected: FAIL because `events.ts` is absent.

- [ ] **Step 3: Implement the direct-event decoder**

Use a nested spec keyed by module and event name. Share common claimed,
canceled, and closed BCS shapes, but keep separate created layouts because
linear contains schedule primitives and checkpoints contains only
`checkpoint_count`. The decoded kind is:

```ts
type VestingEventKind =
  | "linear.VestingCreated"
  | "linear.VestingClaimed"
  | "linear.VestingCanceled"
  | "linear.VestingClosed"
  | "checkpoints.VestingCreated"
  | "checkpoints.VestingClaimed"
  | "checkpoints.VestingCanceled"
  | "checkpoints.VestingClosed";
```

- [ ] **Step 4: Write failing vesting replay tests**

Replay both kinds from creation through claims and terminal cancellation or
closure. Assert allocation, released total, remaining balance, beneficiary,
refund recipient, cap ID, and terminal status. Apply duplicates and assert the
same projection instance is returned.

Add native fact tests:

```ts
export type VestingNativeFact =
  | {
      source: "objectOwnership";
      kind: "cancelCapOwnership";
      checkpoint: bigint;
      cancelCapId: string;
      owner: string;
    }
  | {
      source: "objectRead";
      kind: "checkpointSchedule";
      checkpoint: bigint;
      vestingId: string;
      checkpoints: readonly VestingCheckpoint[];
    };
```

Assert checkpoint creation alone records `checkpointCount` but no schedule.
After the object-read fact, assert the exact schedule is present with source
`objectRead`. Assert cap ownership is absent until its ownership fact.

- [ ] **Step 5: Verify replay tests fail**

Run: `node --test test/vesting-reducer.test.ts`

Expected: FAIL because `reducer.ts` is absent.

- [ ] **Step 6: Implement the minimal vesting projection**

Key positions by normalized vesting ID. Store `kind`, coin type, parties,
cancel-cap ID, total allocation, schedule or checkpoint count, released total,
remaining event-known balance, and status `active | canceled | closed`.

Use digest plus event index for event idempotence. Keep object reads and
ownership facts under a separate `native` projection. Reuse existing checkpoint
schedule validation before accepting an object-read fact.

- [ ] **Step 7: Export and run vesting gates**

Export both new modules from `src/vesting/index.ts`, then run:

```bash
node --test test/vesting-events.test.ts test/vesting-reducer.test.ts \
  test/vesting-state.test.ts test/vesting-schedules.test.ts \
  test/vesting-transactions.test.ts test/vesting-client.test.ts
npm run check:abi
npm run lint
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 8: Commit the vesting replay ticket**

```bash
git add src/vesting test/vesting-events.test.ts test/vesting-reducer.test.ts
git commit -m "feat: decode and replay vesting events"
```

---

### Task 10: Coverage Matrix, Full Verification, and Code Review

**Files:**
- Modify: `docs/launchpad-abi-coverage.md`
- Modify only if verification exposes a defect: files created or changed in Tasks 1-9

**Interfaces:**
- Produces: final contract-surface-to-SDK-to-test coverage matrix
- Produces: verification evidence and remaining release work

- [ ] **Step 1: Write the all-contract coverage matrix**

Rename the document heading to “Production Sui ABI coverage” while preserving
the existing launchpad baseline. Add rows for:

- all nine `blast_sui` user operations and returned-object routing;
- vault and deposit-receipt objects;
- FUN/BLAST/receipt original-ID types;
- eight math helpers;
- all 20 wrapped `blast_sui` events and their reducer tests;
- all eight direct vesting events and their reducer tests;
- every intentional deployment/admin/upgrade exclusion; and
- native ownership/effect/object-read facts.

Add a remaining-work section stating that no contract is deployed and that
real package/shared-object identities, publication effects, live simulation,
and deployment records are required before an indexer or API begins.

- [ ] **Step 2: Run the complete SDK gate from a clean command start**

```bash
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run check:abi
npm run check
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Run launchpad contract verification**

```bash
cd ../contracts/sui/launchpad
bash scripts/check_source_boundaries.sh
sui move build
sui move lint --warnings-are-errors
sui move test --lint
```

Expected: all PASS without modifying tracked sources.

- [ ] **Step 4: Run Meme-template contract verification**

```bash
cd ../contracts/sui/meme_template
bash scripts/check_source_boundaries.sh
sui move build
sui move lint --warnings-are-errors
```

Expected: all PASS. Do not stage the pre-existing `Move.lock` change.

- [ ] **Step 5: Run migrator contract verification**

```bash
cd ../contracts/sui/migrators
node scripts/check_mainnet_abi.mjs --self-test
node scripts/check_mainnet_abi.mjs
bash scripts/check_turbos_dependency_pin.sh
bash scripts/check_fullsail_dependency_pin.sh
bash scripts/check_source_boundaries.sh
sui move build
sui move build -e mainnet
sui move lint --warnings-are-errors
sui move test --lint
```

Expected: all PASS, including the live mainnet ABI check.

- [ ] **Step 6: Run vesting contract verification**

```bash
cd ../contracts/sui/vesting
sui move build
sui move lint --warnings-are-errors
sui move test --lint
```

Expected: all PASS.

- [ ] **Step 7: Run `blast_sui` contract verification**

```bash
cd ../contracts/sui/blast_sui
bash scripts/verify.sh all
```

Expected: source boundaries, testnet/mainnet builds, strict lint, and tests all
PASS.

- [ ] **Step 8: Audit repository safety and exclusions**

Run:

```bash
git -C ../contracts status --short
git status --short
rg -n "TODO|TBD|placeholder|as any|@ts-ignore" src test docs/launchpad-abi-coverage.md
git diff --stat af06778..HEAD
```

Expected: contracts status still contains only the two preserved user files;
the SDK contains no placeholder IDs, unresolved markers, broad type escapes,
deployment records, backend, API, indexer, web, or Move changes.

- [ ] **Step 9: Run the required code-review skill**

Invoke `/code-review` or `superpowers:requesting-code-review` over the complete
SDK range from `af06778` through the implementation head. Review ABI coverage,
transaction routing, package identity, BCS layouts, arithmetic, event decoding,
replay idempotence, TypeScript/Biome gates, and exclusions. Fix every confirmed
in-scope issue with a failing regression test first.

- [ ] **Step 10: Re-run all affected gates after review fixes**

At minimum rerun `npm run check`; rerun the contract command whose boundary an
SDK or artifact fix touched. Record exact exit status and summary for the final
report.

- [ ] **Step 11: Commit documentation or review fixes**

```bash
git add docs/launchpad-abi-coverage.md src test abi scripts biome.json package.json package-lock.json
git commit -m "docs: complete all-contract SDK coverage"
```

Do not create an empty commit if review required no documentation or code
change.
