import { operations, querySchemas, schemas } from "./generated.ts";
import type {
  FeaturedPresalesResponse,
  MarketStatusResponse,
  PresaleResponse,
  PresalesQuery,
  PresalesResponse,
  PricesQuery,
  PricesReadResponse,
  SearchQuery,
  SearchReadResponse,
} from "./generated.ts";
import { matchesSchema } from "./schema.ts";
import type { Schema } from "./schema.ts";

export type * from "./generated.ts";

export type PartnerErrorKind =
  | "invalid_configuration"
  | "invalid_query"
  | "http"
  | "network"
  | "aborted"
  | "timeout"
  | "invalid_response"
  | "response_too_large"
  | "redirect";

/** Contains no request, URL, headers, raw body, cause, or caller abort reason. */
export class BlastPartnerError extends Error {
  readonly kind: PartnerErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly retryAfter: string | null;

  constructor(
    kind: PartnerErrorKind,
    status: number | null = null,
    code: string | null = null,
    retryAfter: string | null = null,
  ) {
    super(`BLAST partner request failed: ${kind}${status === null ? "" : ` (${status})`}.`);
    this.name = "BlastPartnerError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export interface PartnerClientOptions {
  partnerKey: string;
  /** Origin only, without /api/v1. HTTPS or loopback HTTP. */
  origin?: string;
  fetch?: typeof globalThis.fetch;
  /** 1–60,000 ms, including body consumption; default 10,000. */
  timeoutMs?: number;
  /** 1 byte–8 MiB decoded response bytes; default 2 MiB. */
  maxResponseBytes?: number;
}

export interface ReadOptions {
  signal?: AbortSignal;
}

export interface BlastPartnerClient {
  listPresales(query?: PresalesQuery, options?: ReadOptions): Promise<PresalesResponse>;
  featuredPresales(options?: ReadOptions): Promise<FeaturedPresalesResponse>;
  presale(presaleId: string, options?: ReadOptions): Promise<PresaleResponse>;
  prices(query: PricesQuery, options?: ReadOptions): Promise<PricesReadResponse>;
  search(query: SearchQuery, options?: ReadOptions): Promise<SearchReadResponse>;
  marketStatus(options?: ReadOptions): Promise<MarketStatusResponse>;
}

/** Documentation-only inventory: no transport methods exist for these operations. */
export const unavailableOperations = Object.freeze([
  "discovery",
  "holders",
  "activity",
  "pool",
  "candles",
  "trades",
] as const);

export function createBlastPartnerClient(options: PartnerClientOptions): BlastPartnerClient {
  if (!/^blast_pk_[A-Za-z0-9_-]{43}$/.test(options.partnerKey)) {
    throw new BlastPartnerError("invalid_configuration");
  }
  const origin = requireOrigin(options.origin ?? "https://www.blast.fun");
  const timeoutMs = requireBoundedInteger(options.timeoutMs ?? 10_000, 60_000);
  const maxResponseBytes = requireBoundedInteger(
    options.maxResponseBytes ?? 2 * 1024 * 1024,
    8 * 1024 * 1024,
  );

  // Copy all configuration once; mutation of the caller's options cannot redirect credentials.
  const partnerKey = options.partnerKey;
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new BlastPartnerError("invalid_configuration");
  }

  async function read<T>(
    operation: string,
    query: object,
    request: ReadOptions = {},
    presaleId?: string,
  ): Promise<T> {
    const definition = operations[operation];
    const querySchema = querySchemas[operation];
    if (!definition || !querySchema || !matchesSchema(query, querySchema, schemas)) {
      throw new BlastPartnerError("invalid_query");
    }
    validateQueryCombination(operation, query);

    let path = definition.path;
    if (operation === "presale") {
      if (typeof presaleId !== "string" || !/^0x[0-9a-f]{64}$/.test(presaleId)) {
        throw new BlastPartnerError("invalid_query");
      }
      path = path.replace("{presaleId}", encodeURIComponent(presaleId));
    }
    const url = new URL(path, origin);
    for (const [name, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(name, String(item));
      }
    }
    if (url.toString().includes(partnerKey)) {
      throw new BlastPartnerError("invalid_query");
    }

    return await withDeadline(request.signal, timeoutMs, async (signal) => {
      let response: Response;
      try {
        response = await fetcher(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json", "X-Blast-Partner-Key": partnerKey },
          signal,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
      } catch {
        // Adapters may throw our exported error class with unsafe fields attached.
        throw new BlastPartnerError("network");
      }

      if (signal.aborted) {
        discardBody(response);
        throw new BlastPartnerError("aborted");
      }
      // Defend against a custom fetch that incorrectly follows or returns redirects.
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400) ||
        (response.url !== "" && response.url !== url.toString())
      ) {
        discardBody(response);
        throw new BlastPartnerError("redirect", response.status);
      }

      const retryAfter = safeRetryAfter(response.headers.get("retry-after"));
      const text = await readBody(response, maxResponseBytes, signal, retryAfter);
      return parseResponse<T>(response, text, definition.schema, retryAfter);
    });
  }

  return Object.freeze<BlastPartnerClient>({
    listPresales: (query = {}, request) => read("presales", query, request),
    featuredPresales: (request) => read("featured", {}, request),
    presale: (id, request) => read("presale", {}, request, id),
    prices: (query, request) => read("prices", query, request),
    search: (query, request) => read("search", query, request),
    marketStatus: (request) => read("status", {}, request),
  });
}

function requireOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
    if (
      value.includes("@") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new BlastPartnerError("invalid_configuration");
  }
}

function requireBoundedInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new BlastPartnerError("invalid_configuration");
  }
  return value;
}

function validateQueryCombination(operation: string, query: object): void {
  if (operation === "presales") {
    const { status = "live", sort } = query as PresalesQuery;
    const sorts = {
      live: ["ending", "fastest", "backed"],
      upcoming: ["opening", "interest"],
      ended: ["recent", "best", "backed"],
    };
    if (sort !== undefined && !sorts[status].includes(sort)) {
      throw new BlastPartnerError("invalid_query");
    }
  }

  if (operation === "prices") {
    const { presale = [], coin = [], window } = query as PricesQuery;
    if (presale.length + coin.length === 0 || (window === "launch" && coin.length > 0)) {
      throw new BlastPartnerError("invalid_query");
    }
  }

  if (operation === "search") {
    const { cursor, group } = query as SearchQuery;
    if (cursor !== undefined && group === undefined) {
      throw new BlastPartnerError("invalid_query");
    }
  }
}

function parseResponse<T>(
  response: Response,
  text: string,
  schema: Schema,
  retryAfter: string | null,
): T {
  if (!response.ok) {
    throw new BlastPartnerError("http", response.status, safeErrorCode(text), retryAfter);
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BlastPartnerError("invalid_response", response.status, null, retryAfter);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BlastPartnerError("invalid_response", response.status, null, retryAfter);
  }

  if (!matchesSchema(body, schema, schemas)) {
    throw new BlastPartnerError("invalid_response", response.status, null, retryAfter);
  }

  return body as T;
}

async function withDeadline<T>(
  caller: AbortSignal | undefined,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (caller?.aborted) {
    throw new BlastPartnerError("aborted");
  }
  caller?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new BlastPartnerError(timedOut ? "timeout" : "aborted"));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    return await Promise.race([work(controller.signal), aborted]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new BlastPartnerError(timedOut ? "timeout" : "aborted");
    }
    if (error instanceof BlastPartnerError) {
      throw error;
    }
    throw new BlastPartnerError("network");
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  retryAfter: string | null,
): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
    discardBody(response);
    throw new BlastPartnerError("response_too_large", response.status, null, retryAfter);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  let oversized = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        oversized = true;
        throw new Error();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    cancel();
    // Stream errors are external too; never propagate their objects or metadata.
    throw new BlastPartnerError(
      oversized ? "response_too_large" : "invalid_response",
      response.status,
      null,
      retryAfter,
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

const SAFE_CODES = new Set([
  "partner_key_invalid",
  "partner_origin_forbidden",
  "partner_read_forbidden",
  "partner_read_only",
  "partner_rate_limited",
  "partner_api_unavailable",
  "invalid_parameter",
  "invalid_cursor",
  "not_found",
  "rate_limited",
  "unavailable",
  "service_unavailable",
  "unreachable",
  "unconfigured",
  "not_ready",
  "SOCIAL_QUERY_INVALID",
  "SOCIAL_NOT_FOUND",
  "SOCIAL_RATE_LIMITED",
  "SOCIAL_READ_UNAVAILABLE",
  "LAUNCHPAD_QUERY_INVALID",
  "LAUNCHPAD_RATE_LIMITED",
  "LAUNCHPAD_READ_UNAVAILABLE",
]);

function safeErrorCode(text: string): string | null {
  try {
    const body: unknown = JSON.parse(text);
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "code" in body.error &&
      typeof body.error.code === "string" &&
      SAFE_CODES.has(body.error.code)
    ) {
      return body.error.code;
    }
  } catch {
    // Non-JSON refusals still expose only status and a safe Retry-After value.
  }
  return null;
}

function safeRetryAfter(value: string | null): string | null {
  if (value !== null && /^\d{1,10}$/.test(value)) {
    return String(Number(value));
  }
  if (
    value !== null &&
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  ) {
    return new Date(value).toUTCString();
  }
  return null;
}
