import {
  BlastPartnerError,
  createBlastPartnerClient,
} from "@interest-protocol/blast-partner-client";

// Server entry point only. Load your existing partner credential from your secret store.
const partnerKey = process.env.BLAST_PARTNER_KEY;
if (!partnerKey) {
  throw new Error("Configure BLAST_PARTNER_KEY on the server.");
}
const blast = createBlastPartnerClient({ partnerKey });

/** Mount behind your server's own authentication and rate limits. */
export async function partnerPresales(request: Request): Promise<Response> {
  try {
    const page = await blast.listPresales(
      { status: "live", limit: 20 },
      { signal: request.signal },
    );
    return Response.json(page, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (!(error instanceof BlastPartnerError)) {
      throw error;
    }
    // Explicit safe fields only. Do not log requests, configuration or transport exceptions.
    return Response.json(
      { error: { code: error.code ?? error.kind } },
      {
        status: error.status === 429 ? 429 : 502,
        headers: {
          "Cache-Control": "private, no-store",
          ...(error.retryAfter ? { "Retry-After": error.retryAfter } : {}),
        },
      },
    );
  }
}
