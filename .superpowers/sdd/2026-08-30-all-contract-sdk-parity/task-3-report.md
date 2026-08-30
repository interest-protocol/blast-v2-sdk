# Task 3 report: Freeze vesting and `blast_sui` ABI parity

## Scope

- Extended the ABI checker from one hard-coded artifact to three package
  declarations covering all five production Move packages.
- Added focused ABI artifacts for vesting and `blast_sui` at contracts baseline
  `a5ed34ad49c6c001af2db5b9cbcb206075704412`.
- Added package-specific function classifiers and direct/wrapped event
  detection without changing production contracts.
- Preserved `abi/production-launchpad-v1.json` byte-for-byte.

The `ponytail` skill kept this change at the existing summary/normalization seam.
No dependency, production SDK API, or contract change was added.

## RED evidence

Command:

```bash
node --test test/abi-parity.test.ts
```

Result: 1 passed and 1 failed. The new inventory test failed with `ENOENT` for
`abi/production-vesting-v1.json`, before checker implementation or artifact
generation.

## GREEN evidence

Artifact generation and launchpad parity:

```bash
sha256sum abi/production-launchpad-v1.json
npm run check:abi:write
sha256sum abi/production-launchpad-v1.json
git diff --exit-code -- abi/production-launchpad-v1.json
```

Result: passed. The launchpad artifact hash was
`9cd4b622c17a6a49014ef5af62fcb66e994c5ddf482615d10168b5525fd41ad9`
before and after generation, and it has no diff.

Required gates:

```bash
npm run check:abi
node --test test/abi-parity.test.ts
npm run lint
npm run typecheck
```

Result: all passed. The focused test had 2 passed and 0 failed. Biome reported
only the existing configuration deprecation and non-null assertion warnings in
unrelated files.

Full suite, run once after the final gates:

```bash
npm test
```

Result: 96 passed and 0 failed.

Additional review:

```bash
npm run format:check
git diff --check
```

Result: both passed.

## Artifacts and inventory

- `production-vesting-v1.json`: one package, 14 public functions, eight direct
  events, and six non-event structs. All 14 functions are builders.
- `production-blast-sui-v1.json`: one package, 22 public functions, 20 wrapped
  event payloads, and 15 non-event structs. Classifications are nine builders,
  11 intentional admin exclusions, and two intentional deployment exclusions.
- `events_wrapper::Event<T>` remains in the `blast_sui` struct inventory with
  its type parameter, abilities, positional field, and field type intact.
- Event totals are 30 launchpad, six migrator, eight vesting, and 20
  `blast_sui` payloads.
- Test-only functions and vendored migrator interface stubs remain absent from
  the production public-function inventory.

## Files

- Updated: `scripts/check-contract-abi.mjs`.
- Updated: `test/abi-parity.test.ts`.
- Added: `abi/production-vesting-v1.json`.
- Added: `abi/production-blast-sui-v1.json`.
- Added: this report.

## Self-review

- Package declarations preserve the original launchpad package order and
  serialized metadata.
- Every frozen public function has a nonempty SDK classification. Unknown
  packages and functions fail closed.
- Vesting events are detected directly in both `linear` and `checkpoints`.
- `blast_sui` freezes only the 20 wrapped payloads as events; nested
  `PoolCustody`, `ExchangeRate`, and `VaultCustody` values remain structs.
- Reference mutability, return types, type parameters, structs, and enums use
  the existing normalization path.
- Biome lint reported no cognitive-complexity error for the checker; every
  checker function remains below the configured limit of 16.
- The sibling contracts worktree still contains only the two stated
  pre-existing changes. Neither file was touched or staged.

## Concerns

No Task 3 defect is known. The repository-wide lint command still reports its
pre-existing Biome configuration deprecation and non-null assertion warnings;
it exits successfully.

## Fix round: fail-closed `blast_sui` classification

Review found that broad `math`, `acl`, and `package_admin` module matches could
classify a future unreviewed public function instead of rejecting it.

### RED evidence

Command:

```bash
node --test test/abi-parity.test.ts
```

Result: 2 passed and 1 failed. The new regression could not find
`unclassified function blast_sui::math::future_operation`; the checker entered
normal artifact generation because no focused classification probe existed.

### GREEN evidence

Focused command:

```bash
node --test test/abi-parity.test.ts
```

Result: 3 passed and 0 failed. Unknown keys in `math`, `acl`, and
`package_admin` now reach the unclassified error.

Final gates and full suite:

```bash
npm run format:check
npm run check:abi
npm run lint
npm run typecheck
npm test
```

Result: all passed; the full suite had 97 passed and 0 failed. Biome reported
only the same pre-existing configuration and non-null assertion warnings.

Artifact verification:

```bash
sha256sum abi/production-launchpad-v1.json \
  abi/production-vesting-v1.json \
  abi/production-blast-sui-v1.json
git diff --exit-code -- abi/production-launchpad-v1.json \
  abi/production-vesting-v1.json \
  abi/production-blast-sui-v1.json
```

Result: all three artifacts are unchanged. Their SHA-256 hashes are
`9cd4b622c17a6a49014ef5af62fcb66e994c5ddf482615d10168b5525fd41ad9`,
`f1136c11d2dfd3ce3eeb1f234d0f771221922e32635534063e544bc6d804e5f2`,
and `8dfb84fc7c5634cbfb0155ef5c18a785014e6487314c551a576bf949f876add2`.

### Fix self-review

- The 11 current admin exclusions are exact fully qualified keys.
- The unused module-wide math classification was removed because the frozen
  production artifact has no public math functions.
- The classification probe invokes the same production classifier and does
  not run Move summaries or change artifacts.
- Builder and deployment-exclusion sets remain exact and fail closed.
- `git diff --check` passed. The sibling contracts tree still contains only
  the two stated pre-existing user changes.
