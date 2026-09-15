# Blast V2 SDK rules

These rules apply to this repository. The seam below is self-contained so this
repository remains valid when cloned independently of the Blast V2 workspace.

## Shared skill routing

- For coding, configuration, refactoring, fixing, or code review, load
  `../.agents/skills/ponytail/SKILL.md`.
- For a stress-test or grill request, load
  `../.agents/skills/grilling/SKILL.md`; for batch grilling, also load
  `../.agents/skills/batch-grill-me/SKILL.md`.
- When the user asks for brief or token-minimal replies, load
  `../.agents/skills/caveman/SKILL.md`.
- For ASD-STE100 writing or review, load
  `../.agents/skills/asd-ste100/SKILL.md`.

## Contract/SDK seam

Contract state and completed events are authoritative. This SDK derives
deterministic previews, projections, and conveniences from those canonical
facts; its output never authorizes a contract transition and is never an input
to contract execution.

The SDK owns:

- deterministic previews and derived economics (valuations, expected curve
  release, graduation outcomes);
- formatting, aggregation, and display conversions;
- transaction construction and convenient reads; and
- reconstruction from canonical object state and replayable events.

The SDK must not:

- ask contracts to add storage, events, or functions merely to expose a value
  that is reproducible from existing canonical primitives;
- use floating point on atomic units — all protocol arithmetic is `bigint`
  integer arithmetic with documented rounding directions; or
- convert protocol amounts through a USD price or oracle. Valuations are
  denominated in the launch's selected Quote asset.

A preview may differ from an executed balance by atomic rounding dust or
intervening transaction history. When they disagree, the executed balance and
emitted event win; the SDK never instructs a contract to reconcile toward a
preview.

## Working rules

- Every derivation documents input/output units, rounding direction, and who
  receives the rounding remainder.
- Mirror contract formulas exactly, including rounding, when previewing a value
  the contract also computes to enforce an invariant.
- Validate inputs only enough to reject impossible canonical states; do not
  duplicate contract admission policy that may legitimately change.
- Run `npm run typecheck` and `npm test` before committing.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `interest-protocol/blast-v2-sdk`.
See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default Matt triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context domain layout. See `docs/agents/domain.md`.
