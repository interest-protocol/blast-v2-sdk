# Partner REST client handoff — 2026-10-23

## Review location and ownership

- Owned checkout: `/home/ubuntu/blast-v2/worktrees/partner-rest-client`
- Branch: `codex/partner-rest-client`, based on SDK `origin/main`
  `11b8129ebbb83a5379dfde918a43f278a210581c`.
- Owner: chat `01a165ec-eaa2-7b52-b417-95f928c3ebcc`.
- Review fixes are included and the user authorized a commit and draft PR.
  npm publication, deployment, production configuration changes, transactions
  and credential provisioning remain outside this task.
- Implementation is under `packages/partner-client/`; `.github/workflows/check.yml`
  adds an independent CI job for its checks. The root package,
  existing SDK exports (including on-chain `./partners`), and other checkouts
  were not modified. Existing canonical SDK dirty files were not imported.

## Package decision and implementation

At the initial merge, an independent private package
`@interest-protocol/blast-partner-client@0.1.0` with
zero runtime/peer dependencies. A root SDK subpath would still impose the root
package's Sui peers and transaction dependencies on REST consumers. No root npm
workspace/lockfile changes are needed; run package commands from this directory.

Six one-request methods: `listPresales`, `featuredPresales`, `presale`, `prices`,
`search` (use `group: "coins"` for coin search), and `marketStatus`.
Coming-soon discovery/holders/activity/pool/candles/trades have no client methods
and are listed in `unavailableOperations`. Exact generated wire/query types,
runtime schema checks, opaque cursors, decimal/integer strings, nulls and section
states are preserved. No financial number conversion or guessed price fallback.

The core uses Web APIs, no Node imports, runtime detection, process/environment
access, framework dependency, persistence, cache, retry, polling, or background
work. Inject native-compatible fetch. Node/Bun are verified; other Web API
runtimes remain an integration check. Keep keys on servers/proxies even though
the core is portable. No credential is provisioned or distributed by this SDK.

Origin validation, fixed paths, query encoding, header-only credentials,
`redirect: error`, `credentials: omit`, `no-store`, bounded streamed bytes,
full-request deadlines and caller cancellation all have regression coverage.
Errors contain kind/status, an allowlisted code and sanitized Retry-After;
never upstream body/message, request/configuration, headers or transport causes.

## Exact source revisions

| Source | Commit / evidence |
| --- | --- |
| SDK task base | `11b8129ebbb83a5379dfde918a43f278a210581c` |
| Canonical SDK inspected (dirty, behind origin/main) | `82b4f0f1e7fe6ce54a6008d50ad1f9301c1d2791` |
| Backend hardening reference HEAD (dirty, read-only) | `858a70cc57868ef84f8c16af9c3ae3cce1b301ee` |
| Release-gate contract's pinned sourceCommit | `1767a1685ef07b19f58a1eb71591843120d26d46` |
| Canonical docs inspected (clean, older checkout) | `268040a1e34ec2bc5b65f8c57fb896cc051fd5d6` |
| Partner docs reference checkout (clean) | `352bac64b59c30d541ca04a109c03fb8ee6499f5` |
| Docs vendored web schema source | `8480d05ed41dd5fe377a21abc917907ac87c3a4d` |
| Docs vendored infra schema source | `e02cbdfbc136940bc284f6f527ad536dc5643b75` |

The backend source includes uncommitted work, so HEAD alone is insufficient.
Exact registry and gate SHA-256 hashes are in `contracts/provenance.json`.
Deployed OpenAPI fetched without credentials from
`https://docs.blast.fun/openapi/partner-api-v1.json`, SHA-256:
`98ef0c52fdb6a9eafcbc1994be30005caddde85c5e346c1a4d808975b80a8e23`.
The requested endpoint reference page was also fetched and confirmed to load
this versioned specification. No authenticated production reads were attempted.

## Contract differences and policy choices

- No wire/query mismatch for the six implemented operations: deployed schemas
  and the pinned gate agree after removing documentation annotations. The
  verifier preserves schema property names while ignoring annotation text.
- The versioned route registry also includes coming-soon routes; current public
  availability documentation limits this SDK to six live reads. Search remains
  partial; do not infer that every returned group has indexed data.
- Public docs describe direct browser-key use. This SDK documents server/proxy
  integration to satisfy the requested key-confinement policy, while keeping the
  core environment agnostic.
- Price prose describes limits on unique IDs/types, while published OpenAPI
  `maxItems` limits submitted array length. The client follows OpenAPI's cap on
  raw arrays (duplicates count). Within that cap repeated parameters are sent
  unchanged and server deduplication is preserved.
- Strict `additionalProperties: false` contracts can reject future additive
  fields until a reviewed SDK contract update. No silent regeneration/fetching
  during build. See README for compatibility/versioning and refresh workflow.

## Changed files (all new, relative to this package)

- `src/index.ts`: six public methods, options/errors, validation and transport.
- `src/schema.ts`: bounded, non-coercing pinned JSON Schema subset validation.
- `src/generated.ts`: generated exact response/query types and schema data.
- `contracts/partner-v1.json`: six pinned gate schemas plus OpenAPI parameters.
- `contracts/provenance.json`: source revisions/hashes and comparison result.
- `scripts/generate.mjs`: deterministic generation and stale-output check.
- `scripts/verify-contract.mjs`: explicit deployed/gate/registry drift check.
- `scripts/check-package.mjs`: tar contents/dependency checks, clean install/import.
- `test/client.test.ts`: 20 mocked-transport regressions and type-level checks.
- `test/examples.json`: public illustrative OpenAPI examples, no production captures.
- `examples/server.ts`: server/proxy handler using the public package import.
- `.env.example`: placeholder only.
- `README.md`: quickstart, transport, pagination, retry and compatibility policies.
- `HANDOFF.md`: this handoff.
- `package.json`, `package-lock.json`: independent package and dev tooling only.
- `tsconfig.json`, `tsconfig.test.json`, `biome.json`: strict portable build/checks.

Shared coordination artifact:
`/home/ubuntu/blast-v2/handoffs/partner-rest-client-2026-10-23.md`.
Verification artifact:
`/home/ubuntu/blast-v2/outputs/verification/2026-10-23-partner-rest-client/`.

## Checks

Passed under a shared heavy-job lock, with a 2 GiB expected job budget plus
4 GiB reserve and memory full PSI below 1%. Test concurrency was one.
The aggregate verification peaked at 177,920 KiB RSS (~174 MiB), no swaps.

- Task-owned `npm install --ignore-scripts --no-audit --no-fund`.
- `npm run check:generated`, formatting and lint (including no Node imports in src).
- `npm run typecheck`: strict source with no Node ambient types; tests and example.
- `npm test`: 20/20 Node 24.18.0 regressions.
- `bun test --max-concurrency=1 test/client.test.ts`: 20/20 Bun 1.4.2 regressions.
- `npm run check:package`: declaration/JS build, strict publint, Are The Types Wrong
  ESM/bundler profile, pack contents, zero runtime/peer dependency assertions,
  isolated tarball install/import. CJS require and legacy node10 resolution are
  intentionally outside this ESM package's supported profile; use dynamic import.
- `verify-contract.mjs` against downloaded public OpenAPI and the exact backend
  gate/registry: six responses/queries and registry snapshot agree.
- Final whitespace and secret-pattern checks; no complete key literals or
  internal credential configuration added. Test keys are generated in memory.

Latest review verification output: `review-checks.log` in the artifact directory.
Earlier `final-checks.log` and `checks.log`
record the initial measured full run. Tooling fixes found
and corrected during verification: TypeScript source import rewriting for native
Node tests; npm 12's object-shaped pack metadata (npm array format also supported).
No task-owned server/browser/watcher remains. Package-local ignored `node_modules`
and `dist` remain for review/retesting; temporary package consumers were removed.

## Remaining work and limits

Implementation and the requested review are complete for the six reads. The
user authorized committing and opening a draft PR; merge and npm release remain
separate steps. The subsequent release preparation removes `private: true` and
applies the user-approved MIT license. npm publication still needs explicit
authorization and a publisher with verified scope rights; see RELEASE.md.
No actual partner key was created, loaded, sent, or tested; authenticated live
smoke verification needs the integrator's existing credential in a controlled
server environment. Deno/edge/real browser execution is not directly verified.
Root on-chain SDK suites were not run because no root SDK code or metadata changed.
The existing on-chain CI job remains in place, alongside the new isolated job.

## Review fixes

- Standards review: added the missing independent CI job, using only this package
  and its lockfile, without Sui tooling or credentials.
- Spec review: replaced fetch/stream exceptions with fresh sanitized errors even
  when an adapter throws the exported error class carrying unsafe fields.
- Spec review: retained safe Retry-After metadata on oversized, malformed, and
  invalid-UTF-8 response failures; codes stay null when the body cannot be parsed.
- Added two regressions covering these error boundaries and 429/503 body failures.
  The public OpenAPI and backend gate/registry were compared again with no drift.

## Release preparation follow-up

- Owned checkout is unchanged; current preparation branch is
  `codex/partner-client-release-prep`, based on merge commit
  `a35b44ac34cdf388e670ce04750a05f3bddf976f`. The release preparation branch needs review
  and merge before selecting the final publication revision.
- User selected MIT. Added LICENSE and unreleased 0.1.0 changelog, public npm
  registry/access metadata and full prepublish checks. Removed the consumer Node
  engine constraint; development Node requirements remain in devEngines.
- Clean builds prevent stale dist files from entering the tarball. Package
  validation checks release metadata, license/changelog contents, dependency
  isolation and a mocked read through an installed tarball.
- Applied typescript-house-style to handwritten code: explicit response parsing,
  descriptive schema/generator/validation names, workflow phases and named
  package verification steps. Retained existing Biome and zero runtime dependencies.
- Release runbook: RELEASE.md. Checks, archive, digest, source patch and current
  blockers: /home/ubuntu/blast-v2/outputs/releases/2026-10-23-partner-rest-sdk/.
- No authenticated npm identity on this host; npm scope rights unverified. Public
  registry lookup returned 404 for the package, which is not a name reservation.
  GitHub CI cannot start due to account billing/spending limits. Repository is
  private, so npm provenance/public source access need an owner decision if required.
- No npm publication, npm login, credentials/settings changes or deployment.
