# BLAST partner REST client

A small TypeScript SDK for the authenticated [partner read API](https://docs.blast.fun/developers/partner-api/endpoints/).
The public base is **https://www.blast.fun/api/v1**. Uses standard Web APIs:
Fetch, Streams, URL, TextDecoder and AbortController.
The ESM core is environment agnostic: no Node imports, runtime detection, process
environment access, browser storage, or framework dependencies. It can run in
Node, Bun, Deno and edge/worker runtimes providing these APIs; inject a compatible
fetch where needed. Node 22.18+ is required for this package's development tooling;
the checks here ran on Node 24.18.0 and Bun 1.4.2. Deno, browsers and edge runtimes
were not directly exercised.

This is an independent package, `@interest-protocol/blast-partner-client`, inside the
SDK repository. It has **zero runtime and peer dependencies**. Installing a subpath
of `@interest-protocol/blast-sdk` would still install its on-chain dependencies and
require Sui peers. This package leaves that SDK and its on-chain `./partners` export
intact. No transaction builders, wallet integration, gas sponsorship, or signing.
The initial `0.1.0` release is prepared under the MIT license and remains
unpublished. Use a locally built tarball until the npm release is available.

## Server quickstart

From this package directory: `npm ci`, `npm run check`, then `npm pack`.
Install the resulting tarball in your server application with `npm install /absolute/path/to/interest-protocol-blast-partner-client-0.1.0.tgz`.
Do not install the parent SDK package for REST access.

Configure your **existing** partner credential in your server's secret store as
`BLAST_PARTNER_KEY`. `.env.example` contains a placeholder only. The SDK neither
creates nor distributes credentials. Never use a public environment variable,
put the credential in a URL, source control, browser bundle, telemetry, or logs.
Do not use infrastructure credentials: `https://api.blast.fun` is a separate internal
Rust service, and its authentication is unrelated to this package.

```ts
import { createBlastPartnerClient } from "@interest-protocol/blast-partner-client";

// Server module only; do not import into a browser component.
const partnerKey = process.env.BLAST_PARTNER_KEY;
if (!partnerKey) throw new Error("Configure BLAST_PARTNER_KEY on the server.");
const blast = createBlastPartnerClient({ partnerKey });

const page = await blast.listPresales({ status: "live", limit: 20 });
// Fields retain their wire names and types. Amounts/decimal prices remain strings.
// A nullable price remains null. No fallback price is invented.
```

Your browser calls your server; your server attaches `X-Blast-Partner-Key` to a
fixed BLAST route. Protect that proxy with your application's own authorization
and quotas, and return `Cache-Control: private, no-store`. Do not offer arbitrary
upstream URL/header forwarding. See [examples/server.ts](examples/server.ts) for a
complete handler with cancellation and safe errors. The portable core does not
discover credentials or detect the host environment.
Its default integration is server-side: keep the key out of frontend source and
build inputs, including worker code that runs publicly in a user's browser.
A browser application consumes your own proxy rather than constructing a keyed
BLAST client. The Node environment read in the example belongs to the application,
not the library.

## Live methods

| Method | Route | Query / result |
| --- | --- | --- |
| `listPresales(query?, options?)` | `/presales` | `PresalesQuery` → `PresalesResponse` |
| `featuredPresales(options?)` | `/presales/featured` | no query → `FeaturedPresalesResponse` |
| `presale(id, options?)` | `/presales/{presaleId}` | canonical lowercase object ID → `PresaleResponse` |
| `prices(query, options?)` | `/prices` | `PricesQuery` → `PricesReadResponse` |
| `search(query, options?)` | `/search` | `SearchQuery` → `SearchReadResponse` |
| `marketStatus(options?)` | `/market/status` | no query → `MarketStatusResponse` |

All response types, including nested detail, price tuples, search unions and
provenance, are generated from pinned contracts. Query names and values are also
generated from the published OpenAPI. For example, `audited` and `verified_team`
use the literal string `"true"`. Query combinations are checked before transport:
status-specific sorts, at least one price target, launch-window restrictions, and
group-scoped search cursors. IDs/types and numeric bounds follow the contract.
The published array `maxItems` limits apply to submitted price query arrays,
including duplicates; stay within 50 presales and 4 coins per call.

```ts
const history = await blast.prices({ coin: [coinType], window: "24h", points: 60 });
const results = await blast.search({ q: "COIN", group: "coins", limit: 5 });
const detail = await blast.presale(presaleId, { signal: request.signal });
```

Search has partial coverage: profiles are unavailable and launchpad coins are not
yet indexed. Inspect each section's `state`: available/stale sections contain data;
empty and unavailable sections do not. Preserve `reason`, `provenance`, and nulls.
Market status reports indexed freshness, not a guarantee of current data. The
current contract encodes market checkpoint/timestamp counters as numbers; unsafe
integers are rejected rather than silently rounded. Atomic amounts and decimal
prices encoded as strings are never converted to numbers.

`unavailableOperations` lists discovery, holders, activity, pool, candles and trades.
These coming-soon operations have **no client methods**. Their documented schemas
are planning contracts; registry membership does not guarantee availability.
There is no generic request method that can reach them or private routes.

## Explicit pagination

Each method performs exactly one request. There are no iterators, polling,
background jobs, shared state, caching, or automatic retries.

```ts
const first = await blast.listPresales({ status: "live", sort: "ending", limit: 50 });
if (first.next_cursor !== null) {
  const second = await blast.listPresales({
    status: "live", sort: "ending", limit: 50, cursor: first.next_cursor,
  });
}
```

Keep filters unchanged. Stop on `next_cursor === null`. A long collection job
should deduplicate IDs and reject repeated cursors; pages are not a frozen snapshot.
For search, pass a readable section's `data.nextCursor` as `cursor`, with the same
`q` and explicit `group`. Stop on a null token or empty/unavailable section. Never
parse, normalize or reuse a cursor across resources. Price history has no cursor;
missing requested items can be absent, and returned sampling length is not fixed.

## Transport and errors

Options are copied and validated once at construction:

- `origin` defaults to `https://www.blast.fun`; supply an origin only, without
  `/api/v1`, credentials, path, query, or fragment. HTTPS required except loopback
  HTTP (`localhost`, `127.0.0.0/8`, `[::1]`) for local mocks.
- `fetch` injects a native-compatible Fetch implementation. Treat it as trusted:
  it necessarily receives the authentication header. Instrumentation must redact it.
- `timeoutMs` defaults to 10,000 and is bounded to 1–60,000 ms, covering headers
  and the full body. Every method accepts `{ signal }`. Caller abort reasons are
  discarded; abort listeners, timers, and body readers are cleaned up.
- `maxResponseBytes` defaults to 2 MiB and is bounded to 1 byte–8 MiB. The streamed
  decoded body is counted even without Content-Length. JSON and response schemas
  are validated without coercion; invalid UTF-8, malformed JSON and unsafe integer
  counters are rejected. Date-time `format` is an annotation, as in the release gate.

Requests use only allowlisted GET paths, encoded parameter values,
`redirect: "error"`, `credentials: "omit"`, `cache: "no-store"`, and no referrer.
No caller headers are forwarded. Redirects from native Fetch usually reject as a
network error; the SDK also rejects redirect responses from custom transports.
An injected fetch must honor these options to preserve credential confinement.
A transport that ignores abort cannot delay the public timeout promise, but only
its implementation can stop its own underlying I/O.

Failures throw `BlastPartnerError` with `kind`, nullable HTTP `status`, allowlisted
API `code` or null, and sanitized `retryAfter` or null (seconds or an HTTP date).
Messages never include URLs, response bodies, headers, or transport causes.
Fetch and stream exceptions are replaced with fresh errors, even if an adapter
throws the exported SDK error class with additional fields.
Unknown error codes are omitted, even if they resemble valid identifiers. No
request/response/configuration object is attached. Network/abort/timeout failures
have null status; malformed/oversized responses retain their observed HTTP status
and safe Retry-After header.
A partial search error inside a successful response remains part of its typed wire
contract; consumers must not log whole response objects indiscriminately.

There are **no automatic retries**, including on 401/403/429/503. For 401/403,
resolve the credential or authorization problem before a new request. For 429 or
transient 503, an application scheduler may honor `retryAfter` with a bounded
retry budget and jitter; avoid retry loops. A coming-soon 503 is not fixed by
retrying. Every subsequent request authenticates again: revocation is not hidden
by a cache. HTTP-error bodies larger than the configured cap are reported as
`response_too_large` rather than parsed for an API code.

## Contracts and compatibility

Authoritative sources and exact commits/hashes are in
[contracts/provenance.json](contracts/provenance.json). `contracts/partner-v1.json`
pins the six release-gate response schemas plus OpenAPI query/path parameters.
The deployed schemas and gate agree after removing documentation annotations.
The registry additionally allows coming-soon routes; only six are implemented.
Public documentation contains browser-key examples, but this package documents a server/proxy integration to keep keys private. The canonical docs
checkout is older than its clean partner-docs task checkout; neither was edited.

`src/generated.ts` contains generated wire types and schema data. Handwritten
`src/index.ts` owns transport/security and cross-field query rules;
`src/schema.ts` validates the pinned JSON Schema subset without a runtime package.
The generator rejects unsupported schema keywords. Do not edit generated output.

To check or update after a reviewed server/docs change:

1. Download the public OpenAPI to a temporary file, without credentials. Inspect
   current source checkout ownership/status and the versioned registry first.
2. Run `node scripts/verify-contract.mjs /tmp/openapi.json /path/to/release-gate/contract.json /path/to/partner-api/v1/paths.ts`.
   Query, response or registry drift fails and requires review. Builds never
   fetch remote contracts or silently rewrite the baseline.
3. For an approved compatible change, update the pinned contract and provenance
   together; update illustrative fixtures and cross-field rules if needed.
   Do not copy credentials or authenticated production captures into fixtures.
4. Run `npm run generate` and `npm run check`. The independent `partner-client`
   CI job runs this suite using only this package and its lockfile. `check:generated` fails if output
   differs; package checks build declarations, run publint/Are The Types Wrong,
   inspect pack contents, and install/import a tarball in a clean temporary consumer.

API v1 wire compatibility follows the pinned release gate. Breaking removals,
renames, type/nullability changes or changed semantics require a server adapter
or a new API version. This package does not silently switch to v2. As a 0.x SDK,
incompatible TypeScript/runtime validation changes require a minor release;
compatible bug fixes use a patch release. After 1.0, use normal semantic versioning.
New optional response fields require a reviewed compatible contract update and
client release: strict v1 validation can reject a newer additive response until
updated. Adding live operations requires verified availability, contracts and tests.
Publication is a separate authorized release step. Maintainers must follow the
repository release runbook at `packages/partner-client/RELEASE.md`;
`prepublishOnly` runs the full check suite. The package is MIT licensed; this
license applies to this package, including its generated contracts and examples.
The repository's other packages are outside the scope of this LICENSE file.
