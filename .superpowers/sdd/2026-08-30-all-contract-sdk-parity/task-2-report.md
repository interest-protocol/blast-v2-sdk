# Task 2 report: Shared BCS and native event primitives

## Scope

- Added shared Sui BCS layouts in `src/lib/bcs.ts`.
- Added shared Sui event and native transaction position helpers in `src/lib/events.ts`.
- Replaced duplicate BCS layouts in launchpad, migrators, and vesting state decoders.
- Replaced duplicate event metadata validation and replay-ID construction.
- Re-exported `NativeTransactionPosition` from the migrator reducer for compatibility.

## RED evidence

Command:

```bash
node --test test/common-bcs.test.ts test/common-events.test.ts
```

Result: failed as expected before implementation. Node reported missing
`src/lib/bcs.ts` and `src/lib/events.ts` modules. Both new test files failed
to load.

## GREEN evidence

Focused regression command:

```bash
node --test test/common-bcs.test.ts test/common-events.test.ts \
  test/launchpad-events.test.ts test/migrator-events.test.ts \
  test/state.test.ts test/migrators-state.test.ts test/vesting-state.test.ts
```

Result: 26 passed, 0 failed.

Static checks:

```bash
npm run typecheck
npm run lint
npm run format:check
```

Result: all passed. Biome reported existing configuration and non-null
assertion warnings only.

Full suite:

```bash
npm test
```

Result: 96 passed, 0 failed.

## Files

- Added: `src/lib/bcs.ts`, `src/lib/events.ts`.
- Added: `test/common-bcs.test.ts`, `test/common-events.test.ts`.
- Updated: launchpad, migrator, and vesting state/event consumers and their
  BCS serializer fixtures.

## Self-review

- Shared IDs and type names preserve their existing BCS bytes and normalize
  decoded Sui identifiers and struct tags.
- Launchpad and migrator event IDs remain `transactionDigest:eventIndex`.
- Existing launchpad and migrator event type aliases remain exported.
- Native fact validation keeps its prior `native fact` error wording through
  the shared helper's label argument.
- `git diff --check` passed before commit.

## Concern

The brief's TypeName test expects `0x2::sui::SUI`, but the specified
`normalizeStructTag` function in the installed `@mysten/sui` version returns
the canonical 64-hex-digit Sui address. The test locks that actual normalized
result, preserving the prior decoder behavior.
