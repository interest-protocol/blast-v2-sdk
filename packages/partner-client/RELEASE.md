# Partner REST SDK release runbook

Release target: `@interest-protocol/blast-partner-client@0.1.0` on
`https://registry.npmjs.org/`, with public access and the `latest` dist-tag.
This is the standalone REST package; never publish from the repository root.
The package is MIT licensed. This runbook prepares a release and does not
constitute authorization to publish, change npm ownership, or change production.

## Current release status

The initial client merged in PR #71 as
`a35b44ac34cdf388e670ce04750a05f3bddf976f`. The release preparation changes still
need review and merge before publication. Select the merged release revision
and rebuild/recheck the artifact from that exact revision before publishing. No version has
been published by this task. The changelog intentionally says unreleased.

The package is ESM only. Its core uses standard Web APIs and has no runtime or
peer dependencies. Node 22.18+ is required by development tooling only, expressed
through `devEngines`; no Node installation constraint is imposed on consumers.
Node 24.18 and Bun 1.4.2 are verified. Deno/edge/browser execution remains an
integration check, not a supported-runtime test claim. Keep keys on servers.

## Checks before selecting an artifact

1. Use a clean, owned checkout of the reviewed release revision. Inspect Git
   status/remotes and dependency ownership first. On the shared VPS, acquire the
   shared memory guard before installs or the full suite; budget 2 GiB plus the
   required 4 GiB reserve and use one test worker.
2. From the repository root, run `npm ci --ignore-scripts --no-audit
   --no-fund`, then `npm run check --workspace
   @interest-protocol/blast-partner-client`. From `packages/partner-client`, run
   `bun test --max-concurrency=1 test/client.test.ts` when Bun is available. The suite checks generated types,
   source/test/example types, formatting, lint, mocked transport regressions,
   declaration resolution, package contents and an isolated tarball consumer.
   `prepublishOnly` also runs the full suite for directory-based publication.
3. Download the public OpenAPI without credentials and run
   `node scripts/verify-contract.mjs /tmp/openapi.json /path/to/release-gate/contract.json /path/to/partner-api/v1/paths.ts`.
   Inspect current ownership/status of the source checkouts; do not modify them.
   Contract drift requires review and regeneration, not an automatic refresh.
4. Recheck `npm view @interest-protocol/blast-partner-client versions --json
   --registry=https://registry.npmjs.org/`. An anonymous 404 indicates no public
   package was found; it does not prove ownership, publishing rights, or that
   the name is unreserved. Never overwrite or reuse a published version.
5. `npm pack --pack-destination /absolute/path/to/release-artifacts` builds a clean
   `dist` before packing. Record the source commit, package version, SHA-256,
   npm SHA-512 integrity, file list and check log alongside the artifact.
   Verify LICENSE and CHANGELOG are present; environment files, tests, private
   handoffs, release notes, build tooling and dependencies must be absent.
6. Run `npm publish /absolute/path/to/the-reviewed.tgz --dry-run --ignore-scripts
   --access=public --tag=latest --registry=https://registry.npmjs.org/`.
   A dry run does not verify publish authorization, 2FA, name availability or
   npm organization permissions. Compare the artifact hash again before release.

## Publisher setup and actual release

A maintainer must authenticate through their approved npm publishing process
and verify permission to create packages under `@interest-protocol`, including
any organization 2FA policy. Do not paste tokens into chat, source, environment
examples, logs or command arguments. This checkout was not authenticated to npm
at preparation time (`npm whoami` returned ENEEDAUTH). No login, credential
creation or npm settings change was attempted.

After the release revision and exact artifact are approved and publication is
explicitly authorized, the authorized publisher can publish that tarball:

```sh
npm publish /absolute/path/to/the-reviewed.tgz --ignore-scripts --access=public --tag=latest --registry=https://registry.npmjs.org/
```

The tarball path is deliberate: publish the same bytes that passed review and
digest verification. Its checks/build must already have passed; archive publishing
with `--ignore-scripts` does not run `prepublishOnly`. Do not rebuild an approved
artifact between review and publish. A changed source revision needs a new pack,
new checks and a new recorded digest. After publication, verify registry version,
`dist.integrity`, access and `latest`, then install the exact public version in a
fresh consumer. Record the final release commit and update the changelog/release
record. Never put partner credentials in a release test.

For later CI releases, npm trusted publishing is an option that requires npm-side
configuration for the exact repository/workflow and a GitHub-hosted runner with
`id-token: write`. No publishing workflow, npm trusted publisher, environment,
token or tag trigger is configured by this preparation task. Set those up in a
separately authorized infrastructure change, if chosen.

## Open items and constraints

- GitHub Actions jobs currently cannot start because of account payment or
  spending-limit restrictions. Resolve that issue and rerun package CI before
  release; passing local checks are recorded independently.
- The publisher's npm identity, scope ownership/create permission and 2FA must
  be verified in the publishing environment. No public package was found during
  preparation; a registry lookup is not a name reservation.
- The GitHub repository is private. A public npm package can be distributed
  separately, but partners cannot follow its private repository/source links.
  npm provenance is unavailable from private repositories. If public source or
  provenance is a release requirement, an owner must choose and authorize a
  public source arrangement first; do not change repository visibility here.
- Authenticated live API smoke checks were not run: no real partner key was
  created, loaded or sent. An integrator may verify with an existing server-side
  credential through their normal process. Other Web API runtimes remain
  unverified. These limits must remain clear in consumer documentation.

References: [scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/),
[npm trusted publishing and provenance limitations](https://docs.npmjs.com/trusted-publishers/).
