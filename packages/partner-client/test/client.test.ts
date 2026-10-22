import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import test from "node:test";
import {
  BlastPartnerError,
  createBlastPartnerClient,
  unavailableOperations,
} from "../src/index.ts";
import type {
  BlastPartnerClient,
  PartnerClientOptions,
  PricesResponse,
  PresaleListPage,
} from "../src/index.ts";

const examples = JSON.parse(readFileSync(new URL("./examples.json", import.meta.url), "utf8"));
// Ephemeral synthetic credentials never appear in fixtures, snapshots, or test output.
const key = `blast_pk_${randomBytes(32).toString("base64url")}`;
const id = `0x${"a".repeat(64)}`;
const coin = `${id}::coin::COIN`;
const emptyPage = { ...examples.presales, presales: [], next_cursor: null };

function client(
  fetcher: typeof fetch,
  options: Partial<PartnerClientOptions> = {},
): BlastPartnerClient {
  return createBlastPartnerClient({ partnerKey: key, fetch: fetcher, ...options });
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function failure(
  promise: Promise<unknown>,
  kind: string,
  status: number | null = null,
): Promise<BlastPartnerError> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof BlastPartnerError);
    assert.equal(error.kind, kind);
    assert.equal(error.status, status);
    assert(
      ![String(error), error.stack, JSON.stringify(error), inspect(error)].some((value) =>
        value?.includes(key),
      ),
      "Credential escaped in an error",
    );
    return error;
  }
  assert.fail("Expected a sanitized failure");
}

test("six fixed paths round-trip all documented response shapes without modification", async () => {
  const calls: string[] = [];
  const sdk = client(async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(url.origin, "https://www.blast.fun");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.referrerPolicy, "no-referrer");
    const headers = new Headers(init?.headers);
    assert(headers.get("x-blast-partner-key") === key, "Missing authentication header");
    assert.deepEqual([...headers.keys()].sort(), ["accept", "x-blast-partner-key"]);
    assert(!String(input).includes(key), "Credential escaped into a URL");
    const operation = url.pathname.endsWith("featured")
      ? "featured"
      : url.pathname.endsWith(id)
        ? "presale"
        : url.pathname.endsWith("status")
          ? "status"
          : url.pathname.split("/").at(-1);
    return json(examples[operation ?? ""]);
  });
  assert.deepEqual(await sdk.listPresales(), examples.presales);
  assert.deepEqual(await sdk.featuredPresales(), examples.featured);
  assert.deepEqual(await sdk.presale(id), examples.presale);
  assert.deepEqual(await sdk.prices({ coin: [coin] }), examples.prices);
  assert.deepEqual(await sdk.search({ q: "coin", group: "coins" }), examples.search);
  assert.deepEqual(await sdk.marketStatus(), examples.status);
  assert.deepEqual(calls, [
    "/api/v1/presales",
    "/api/v1/presales/featured",
    `/api/v1/presales/${id}`,
    "/api/v1/prices",
    "/api/v1/search",
    "/api/v1/market/status",
  ]);
  assert.equal(Object.keys(sdk).length, 6);
  assert.equal(unavailableOperations.length, 6);
  assert(
    !inspect(sdk).includes(key) && !JSON.stringify(sdk).includes(key),
    "Credential escaped in the client",
  );
});

test("opaque cursors, search text and repeated price parameters are encoded as values", async () => {
  const token = "https://evil.example/x?key=a&limit=500# /%+☃";
  let next = 0;
  const sdk = client(async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://www.blast.fun");
    if (next++ < 2) {
      assert.equal(url.searchParams.get("cursor"), token);
      assert.equal(url.searchParams.getAll("limit").length, 1);
      if (url.pathname.endsWith("search")) {
        assert.equal(url.searchParams.get("q"), "A&B /%+☃?q=bad");
        return json(examples.search);
      }
      assert.equal(url.searchParams.get("audited"), "true");
      return json(emptyPage);
    }
    assert.deepEqual(url.searchParams.getAll("presale"), [id, id]);
    assert.deepEqual(url.searchParams.getAll("coin"), [coin, coin]);
    return json(examples.prices);
  });
  await sdk.listPresales({ cursor: token, limit: 20, audited: "true", partner_id: id });
  await sdk.search({ q: "A&B /%+☃?q=bad", cursor: token, group: "coins", limit: 5 });
  await sdk.prices({ presale: [id, id], coin: [coin, coin], points: 2, window: "24h" });
});

test("pagination is explicit and preserves the exact continuation token", async () => {
  const token = "opaque/+==";
  let calls = 0;
  const sdk = client(async (input) => {
    const cursor = new URL(String(input)).searchParams.get("cursor");
    assert.equal(cursor, calls++ === 0 ? null : token);
    return json({ ...emptyPage, next_cursor: cursor === null ? token : null });
  });
  const page = await sdk.listPresales({ status: "live" });
  assert.equal(calls, 1);
  assert.equal(page.next_cursor, token);
  assert.equal(
    (await sdk.listPresales({ status: "live", cursor: page.next_cursor ?? "" })).next_cursor,
    null,
  );
  assert.equal(calls, 2);
});

test("financial strings, large atoms, nullable prices and missing entries stay exact", async () => {
  const body = structuredClone(examples.presales);
  body.presales[0].target_atoms = "999999999999999999999999999999999999";
  body.presales[0].price_usd = "0.000000000000000000000000001";
  body.presales[0].target_usd = null;
  const sdk = client(async () => json(body));
  const sale = (await sdk.listPresales()).presales[0];
  assert.equal(sale?.target_atoms, body.presales[0].target_atoms);
  assert.equal(sale?.price_usd, body.presales[0].price_usd);
  assert.equal(sale?.target_usd, null);
  const prices = structuredClone(examples.prices);
  prices.prices[0].price_usd = null;
  prices.prices[0].points[0][1] = "0.000000000000000000001";
  assert.deepEqual(await client(async () => json(prices)).prices({ coin: [coin] }), prices);
  prices.prices = [];
  assert.deepEqual((await client(async () => json(prices)).prices({ coin: [coin] })).prices, []);
});

test("unavailable, empty, stale and nullable market states remain distinguishable", async () => {
  const body = {
    groups: [
      {
        group: "coins",
        section: { state: "unavailable", reason: "not_indexed", retryAfterSeconds: 60 },
      },
      { group: "profiles", section: { state: "unavailable", reason: "no_source" } },
    ],
  };
  assert.deepEqual(await client(async () => json(body)).search({ q: "COIN" }), body);
  const provenance = examples.search.groups[0].section.provenance;
  for (const section of [
    { state: "empty", provenance },
    { ...examples.search.groups[0].section, state: "stale", reason: "index_lag" },
  ]) {
    const response = { groups: [{ group: "coins", section }] };
    assert.deepEqual(await client(async () => json(response)).search({ q: "COIN" }), response);
  }
  const status = {
    ...examples.status,
    checkpoint: null,
    timestamp_ms: null,
    lag_ms: null,
    cursor: null,
  };
  assert.deepEqual(await client(async () => json(status)).marketStatus(), status);
});

test("origin validation rejects credentials, insecure hosts, paths, queries and protocols", () => {
  for (const origin of [
    "https://user:pass@evil.example",
    "https://@evil.example",
    "http://evil.example",
    "http://localhost.evil",
    "ftp://localhost",
    "//evil.example",
    "https://example.com/api/v1",
    "https://example.com/?q=x",
    "https://example.com/#hash",
    "garbage",
  ]) {
    assert.throws(
      () => client(fetch, { origin }),
      (error) =>
        error instanceof BlastPartnerError &&
        error.kind === "invalid_configuration" &&
        !String(error).includes(origin),
    );
  }
  for (const value of [0, -1, NaN, Infinity, 1.5, 60001]) {
    assert.throws(() => client(fetch, { timeoutMs: value }), BlastPartnerError);
  }
  assert.throws(() => client(fetch, { maxResponseBytes: 8 * 1024 * 1024 + 1 }), BlastPartnerError);
});

test("validated origin and credential are copied once; loopback HTTP is permitted", async () => {
  for (const origin of [
    "http://localhost:3000",
    "http://127.0.0.1:4000",
    "http://[::1]:5000",
    "https://partner.example/",
  ]) {
    const options = {
      partnerKey: key,
      origin,
      fetch: async (input: Parameters<typeof fetch>[0]) => {
        assert.equal(new URL(String(input)).origin, new URL(origin).origin);
        return json(emptyPage);
      },
    };
    const sdk = createBlastPartnerClient(options);
    options.origin = "https://evil.example";
    options.partnerKey = "invalid";
    await sdk.listPresales();
  }
});

test("path injection and invalid query combinations never reach transport", async () => {
  let calls = 0;
  const sdk = client(async () => {
    calls++;
    return json(emptyPage);
  });
  for (const path of [
    "https://evil.example",
    "//evil.example",
    "../prices",
    "%2e%2e%2fprices",
    `${id}/../featured`,
    `${id}?x=1`,
    "0xAA",
  ]) {
    await failure(sdk.presale(path), "invalid_query");
  }
  for (const query of [
    { limit: 51 },
    { status: "live", sort: "opening" },
    { audited: false },
    { partner_id: "//evil" },
    { extra: "secret" },
  ]) {
    await failure(sdk.listPresales(query as never), "invalid_query");
  }
  await failure(sdk.prices({}), "invalid_query");
  await failure(sdk.prices({ coin: [coin], window: "launch" }), "invalid_query");
  await failure(sdk.search({ q: "x", cursor: "token" }), "invalid_query");
  assert.equal(calls, 0);
});

test("malformed JSON, wrong content type, invalid UTF-8 and schema violations fail closed", async () => {
  const wrongFinancial = structuredClone(examples.presales);
  wrongFinancial.presales[0].target_atoms = 9007199254740992;
  const unsafeNumber = { ...examples.status, checkpoint: 9007199254740992 };
  const invalidTuple = structuredClone(examples.prices);
  invalidTuple.prices[0].points[0].push("unexpected");
  for (const response of [
    new Response("{", { headers: { "content-type": "application/json" } }),
    new Response("null", { headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify(emptyPage), { headers: { "content-type": "text/html" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    json({ ...emptyPage, surprise: true }),
    json({ presales: [] }),
    json(wrongFinancial),
  ]) {
    await failure(client(async () => response).listPresales(), "invalid_response", 200);
  }
  await failure(client(async () => json(unsafeNumber)).marketStatus(), "invalid_response", 200);
  await failure(
    client(async () => json(invalidTuple)).prices({ coin: [coin] }),
    "invalid_response",
    200,
  );
});

test("declared and streamed byte limits cancel the body, including errors", async () => {
  for (const status of [200, 503]) {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(64));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
    await failure(
      client(async () => response, { maxResponseBytes: 32 }).listPresales(),
      "response_too_large",
      status,
    );
    assert(canceled);
  }
  await failure(
    client(async () => new Response("{}", { headers: { "content-length": "999999999" } }), {
      maxResponseBytes: 32,
    }).listPresales(),
    "response_too_large",
    200,
  );
  // The limit counts UTF-8 bytes, rather than UTF-16 string length.
  await failure(
    client(async () => new Response('"☃☃"'), { maxResponseBytes: 6 }).listPresales(),
    "response_too_large",
    200,
  );
});

test("401, 403, 429 and 503 expose safe metadata, never retry or reflect response data", async () => {
  for (const [status, code] of [
    [401, "partner_key_invalid"],
    [403, "partner_origin_forbidden"],
    [429, "partner_rate_limited"],
    [503, "partner_api_unavailable"],
    [503, "service_unavailable"],
  ] as const) {
    let calls = 0;
    const sdk = client(async () => {
      calls++;
      return json(
        { error: { code, message: key, request: { headers: { "x-blast-partner-key": key } } } },
        status,
        { "retry-after": "30" },
      );
    });
    const error = await failure(sdk.listPresales(), "http", status);
    assert.equal(error.code, code);
    assert.equal(error.retryAfter, "30");
    assert.equal(calls, 1);
  }
  const error = await failure(
    client(async () =>
      json({ error: { code: key, message: key } }, 401, { "retry-after": key }),
    ).listPresales(),
    "http",
    401,
  );
  assert.equal(error.code, null);
  assert.equal(error.retryAfter, null);
  const malformed = await failure(
    client(
      async () =>
        new Response(key, {
          status: 503,
          headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
        }),
    ).listPresales(),
    "http",
    503,
  );
  assert.equal(malformed.retryAfter, "Wed, 21 Oct 2026 07:28:00 GMT");
  assert.equal(malformed.code, null);
});

test("redirects are forbidden and native redirect/network errors are sanitized", async () => {
  for (const status of [301, 302, 307, 308]) {
    await failure(
      client(async (_url, init) => {
        assert.equal(init?.redirect, "error");
        return new Response(null, { status, headers: { location: `https://evil.example/${key}` } });
      }).listPresales(),
      "redirect",
      status,
    );
  }
  const followed = json(emptyPage);
  Object.defineProperties(followed, {
    redirected: { value: true },
    url: { value: "https://evil.example" },
  });
  await failure(client(async () => followed).listPresales(), "redirect", 200);
  await failure(
    client(async () => {
      throw new TypeError(`redirect ${key}`);
    }).listPresales(),
    "network",
  );
});

test("transport and stream exceptions cannot impersonate sanitized SDK errors", async () => {
  const unsafe = new BlastPartnerError("http", 401, key, key);
  unsafe.message = key;
  Object.assign(unsafe, { request: { headers: { "X-Blast-Partner-Key": key } } });
  const transportError = await failure(
    client(async () => {
      throw unsafe;
    }).listPresales(),
    "network",
  );
  assert.equal(transportError.code, null);
  assert.equal(transportError.retryAfter, null);
  assert(!("request" in transportError));

  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(unsafe);
      },
    }),
    { status: 503, headers: { "retry-after": "15" } },
  );
  const streamError = await failure(
    client(async () => response).listPresales(),
    "invalid_response",
    503,
  );
  assert.equal(streamError.code, null);
  assert.equal(streamError.retryAfter, "15");
  assert(!("request" in streamError));
});

test("body failures preserve status and safe Retry-After without parsing an API code", async () => {
  for (const status of [429, 503]) {
    for (const [response, kind] of [
      [
        new Response("{}", { status, headers: { "content-length": "999", "retry-after": "30" } }),
        "response_too_large",
      ],
      [
        new Response(new Uint8Array(65), { status, headers: { "retry-after": "30" } }),
        "response_too_large",
      ],
      [
        new Response(new Uint8Array([0xff]), { status, headers: { "retry-after": "30" } }),
        "invalid_response",
      ],
    ] as const) {
      const error = await failure(
        client(async () => response, { maxResponseBytes: 64 }).listPresales(),
        kind,
        status,
      );
      assert.equal(error.code, null);
      assert.equal(error.retryAfter, "30");
    }
  }
});

test("pre-abort, in-flight cancellation and timeouts sanitize reasons and abort transport", async () => {
  let calls = 0;
  const preAborted = new AbortController();
  preAborted.abort(key);
  await failure(
    client(async () => {
      calls++;
      return json(emptyPage);
    }).listPresales({}, { signal: preAborted.signal }),
    "aborted",
  );
  assert.equal(calls, 0);
  for (const timeout of [false, true]) {
    const controller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    const sdk = client(
      async (_input, init) => {
        transportSignal = init?.signal;
        if (!timeout) {
          queueMicrotask(() => controller.abort(key));
        }
        // A broken injected transport cannot make the public promise hang forever.
        return await new Promise<Response>(() => {});
      },
      { timeoutMs: 10 },
    );
    await failure(
      sdk.listPresales({}, { signal: controller.signal }),
      timeout ? "timeout" : "aborted",
    );
    assert(transportSignal?.aborted);
    assert(!String(transportSignal.reason).includes(key), "Caller reason escaped into transport");
  }
});

test("deadline covers stalled response bodies and releases stream resources", async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  await failure(client(async () => response, { timeoutMs: 10 }).listPresales(), "timeout");
  assert(canceled);
});

test("successful calls remove caller listeners and do not memoize responses", async () => {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  controller.signal.addEventListener = new Proxy(controller.signal.addEventListener, {
    apply(target, receiver, args) {
      added++;
      return Reflect.apply(target, receiver, args);
    },
  });
  controller.signal.removeEventListener = new Proxy(controller.signal.removeEventListener, {
    apply(target, receiver, args) {
      removed++;
      return Reflect.apply(target, receiver, args);
    },
  });
  let calls = 0;
  const sdk = client(async () =>
    ++calls === 1
      ? json(emptyPage)
      : json({ error: { code: "partner_key_invalid", message: "revoked" } }, 401),
  );
  await sdk.listPresales({}, { signal: controller.signal });
  await failure(sdk.listPresales({}, { signal: controller.signal }), "http", 401);
  assert.equal(calls, 2);
  assert.equal(added, removed);
});

// Compile-time contract checks: no numeric financial values or invented non-null guarantees.
type Atom = PresaleListPage["presales"][number]["target_atoms"];
type Price = PricesResponse["prices"][number]["price_usd"];
const atom: Atom = "900719925474099300000";
const price: Price = null;
// @ts-expect-error Atomic values remain strings.
const numericAtom: Atom = 1;
// @ts-expect-error Price values remain nullable decimal strings.
const numericPrice: Price = 1.25;
void [atom, price, numericAtom, numericPrice];

test("credential-like caller values cannot place the configured key in a URL", async () => {
  let calls = 0;
  await failure(
    client(async () => {
      calls++;
      return json(examples.search);
    }).search({ q: key, group: "coins" }),
    "invalid_query",
  );
  assert.equal(calls, 0);
});

test("a browser-like global environment uses the same injected Web API transport", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  try {
    assert.deepEqual(await client(async () => json(emptyPage)).listPresales(), emptyPage);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("caller cancellation during a body read cancels its stream", async () => {
  let canceled = false;
  const controller = new AbortController();
  const response = new Response(
    new ReadableStream({
      start() {
        setTimeout(() => controller.abort(key), 5);
      },
      cancel() {
        canceled = true;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  await failure(
    client(async () => response).listPresales({}, { signal: controller.signal }),
    "aborted",
  );
  assert(canceled);
});
