/**
 * HTTP surface: `POST /resolve`, `POST /refresh`, `GET /records/:id` and `GET /healthz`.
 *
 * Every error path maps to a status the caller can act on — a bad magnet is the caller's problem
 * (400), a torrent with no video file is the torrent's (422), a swarm that would not answer is
 * transient (504) — rather than the PoC's single unhandled-rejection 500.
 */

import { config } from "../config.ts";
import { encoder } from "../bytes.ts";
import { errFields, log } from "../log.ts";
import { MagnetError } from "../magnet.ts";
import { DbUnavailableError } from "../db/sql.ts";
import { refreshPeers, ResolveError, resolveMagnet } from "../resolve.ts";
import { readRecords } from "../records_view.ts";

/** A magnet URI longer than this is not a magnet URI. */
const MAX_BODY_BYTES = 16 * 1024;

interface ResolveBody {
  readonly magnet?: unknown;
  readonly force?: unknown;
}

interface RefreshBody {
  readonly id?: unknown;
}

/**
 * The value to echo in `Access-Control-Allow-Origin`, or null for no CORS on this request.
 *
 * The header takes a single origin, so with several allowed origins configured the request's own
 * `Origin` is echoed back when it is one of them. A configured `*` still answers `*` — the wildcard
 * is the dev-stack case and never carries credentials.
 */
export function pickAllowedOrigin(
  origin: string | null,
  allowed: readonly string[],
): string | null {
  if (allowed.length === 0) return null;
  if (allowed.includes("*")) return "*";
  if (origin !== null && allowed.includes(origin)) return origin;
  return null;
}

function allowedOrigin(request: Request): string | null {
  return pickAllowedOrigin(request.headers.get("origin"), config.corsOrigins);
}

/**
 * CORS, only when an origin is configured.
 *
 * `authorization` has to be an allowed request header or a browser will not send the bearer token
 * on `/refresh`, and the preflight has to be answered before the auth check — a browser never
 * attaches credentials to an OPTIONS. `vary: origin` keeps a cache from serving one allowed
 * origin's response to another.
 */
function corsHeaders(request: Request): Record<string, string> {
  const origin = allowedOrigin(request);
  if (origin === null) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function json(request: Request, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(request),
    },
  });
}

function problem(request: Request, status: number, code: string, message: string): Response {
  return json(request, { error: code, message }, status);
}

/**
 * Constant-time comparison of the presented bearer token against the configured one.
 *
 * Constant time because a length-or-prefix leak on a shared secret is worth avoiding for the cost
 * of a loop, and this endpoint is reachable from the public internet.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = encoder.encode(presented);
  const b = encoder.encode(expected);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Gate for `/refresh`.
 *
 * An unset `MA_REFRESH_TOKEN` refuses every request rather than running open. This route does
 * uncapped swarm work on a public VPS, so "unconfigured" has to mean closed — the opposite default
 * turns a missing environment variable into an open relay for outbound traffic.
 */
function authorised(request: Request): boolean {
  if (config.refreshToken.length === 0) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return tokenMatches(match[1]!.trim(), config.refreshToken);
}

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS" && allowedOrigin(request) !== null) {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    return json(request, { ok: true }, 200);
  }

  if (url.pathname === "/refresh") {
    if (request.method !== "POST") {
      return problem(request, 405, "method_not_allowed", "POST /refresh");
    }
    return await handleRefresh(request);
  }

  const records = /^\/records\/([^/]*)$/.exec(url.pathname);
  if (records) {
    if (request.method !== "GET") {
      return problem(request, 405, "method_not_allowed", "GET /records/:id");
    }
    return await handleRecords(request, decodeURIComponent(records[1]!));
  }

  if (url.pathname !== "/resolve") {
    return problem(request, 404, "not_found", `no route for ${request.method} ${url.pathname}`);
  }
  if (request.method !== "POST") {
    return problem(request, 405, "method_not_allowed", "POST /resolve");
  }

  let body: ResolveBody;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return problem(request, 413, "body_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    body = JSON.parse(text) as ResolveBody;
  } catch {
    return problem(request, 400, "bad_json", "body must be JSON");
  }

  if (typeof body.magnet !== "string" || body.magnet.trim().length === 0) {
    return problem(request, 400, "missing_magnet", 'body must contain a "magnet" string');
  }
  const force = body.force === true || url.searchParams.get("force") === "1";

  try {
    const result = await resolveMagnet(body.magnet, { force });
    return json(request, result, 200);
  } catch (err) {
    return errorResponse(request, err);
  }
}

/**
 * `POST /refresh {"id": "<40 hex>"}` — re-discover peers for an already-resolved id.
 *
 * sl-stream calls this when the peers it was given have gone stale. It never sends a magnet: the
 * id is the infohash, and ma-stream's own index holds the magnet it was first resolved from.
 */
async function handleRefresh(request: Request): Promise<Response> {
  if (!authorised(request)) {
    // Deliberately uniform: a caller cannot distinguish "no token configured here" from
    // "your token is wrong".
    return problem(request, 401, "unauthorized", "a valid bearer token is required");
  }

  let body: RefreshBody;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return problem(request, 413, "body_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    body = JSON.parse(text) as RefreshBody;
  } catch {
    return problem(request, 400, "bad_json", "body must be JSON");
  }

  if (typeof body.id !== "string" || body.id.trim().length === 0) {
    return problem(request, 400, "missing_id", 'body must contain an "id" string');
  }

  try {
    return json(request, await refreshPeers(body.id.trim()), 200);
  } catch (err) {
    return errorResponse(request, err);
  }
}

/**
 * `GET /records/<40 hex>` — the stored chunk and peer records, plus sl-stream's own peer health.
 *
 * Behind the same bearer token as `/refresh`, for a different reason. `/refresh` is gated because
 * it *costs*: an unauthenticated caller could aim uncapped outbound swarm work at a public VPS.
 * This one is cheap and gated because of what it *discloses* — a peer record is a list of IP
 * addresses of people in a swarm, and the database that holds it is otherwise reachable only with a
 * credential. Putting that list behind an open GET would widen the service's exposure well past
 * what adding a convenience read should.
 *
 * The body is `{chunks, peers, health}` — sl-stream's `start.records`, verbatim.
 */
async function handleRecords(request: Request, id: string): Promise<Response> {
  if (!authorised(request)) {
    return problem(request, 401, "unauthorized", "a valid bearer token is required");
  }
  try {
    return json(request, await readRecords(id), 200);
  } catch (err) {
    return errorResponse(request, err);
  }
}

function errorResponse(request: Request, err: unknown): Response {
  if (err instanceof ResolveError) {
    log.warn("resolve.failed", { code: err.code, msg: err.message });
    return problem(request, err.status, err.code, err.message);
  }
  if (err instanceof MagnetError) {
    return problem(request, 400, "bad_magnet", err.message);
  }
  if (err instanceof DbUnavailableError) {
    log.error("db.unavailable", errFields(err));
    return problem(request, 503, "db_unavailable", err.message);
  }
  log.error("resolve.unexpected", errFields(err));
  return problem(request, 500, "internal_error", "resolve failed");
}
