/**
 * Central tunables.
 *
 * Every value is overridable by an environment variable, and every read is wrapped: if
 * `--allow-env` is missing the defaults apply instead of throwing, because a config read must
 * never be able to kill a boot.
 *
 * That property is why `MA_DATABASE_URL` defaults to empty rather than throwing here even though
 * it is required. An unset database has to surface as a 503 from `openDb()` on the first request,
 * not as a crash at import.
 */

export const KiB = 1024;
export const MiB = 1024 * KiB;

function envRaw(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function envInt(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = envRaw(name);
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const value = Math.trunc(parsed);
  return value >= min && value <= max ? value : fallback;
}

function envStr(name: string, fallback: string): string {
  const raw = envRaw(name);
  return raw === undefined || raw === "" ? fallback : raw;
}

/** Comma-separated list, blanks dropped so a trailing comma is not a distinct empty entry. */
function envList(name: string, fallback: string): readonly string[] {
  return envStr(name, fallback)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = envRaw(name);
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export const config = Object.freeze({
  /**
   * Hard ceiling on one resolve. Everything below is a sub-budget of this; when it expires we
   * write whatever we have if metadata landed, and fail cleanly if it did not.
   */
  resolveDeadlineMs: envInt("MA_RESOLVE_DEADLINE_MS", 45_000),
  /** Once metadata is verified, stop early at this many peers rather than burning the deadline. */
  minPeers: envInt("MA_MIN_PEERS", 40, 1),
  /**
   * Ceiling on peers persisted. Postgres has no per-value limit, so this is no longer about
   * fitting a record: it bounds one JSON response and the size of a peer list worth handing to a
   * reader, given swarm peers rot within minutes anyway.
   */
  maxPeers: envInt("MA_MAX_PEERS", 500, 1, 5_000),
  /** How long discovery keeps running after metadata lands, if `minPeers` was not reached. */
  peerGraceMs: envInt("MA_PEER_GRACE_MS", 3_000, 0),

  /** Concurrent outbound peer sessions. */
  maxDials: envInt("MA_MAX_DIALS", 50, 1, 500),
  connectTimeoutMs: envInt("MA_CONNECT_TIMEOUT_MS", 3_000),
  /** Whole-session budget: handshake, extended handshake, metadata, PEX harvest. */
  sessionTimeoutMs: envInt("MA_SESSION_TIMEOUT_MS", 6_000),

  /**
   * Peer refresh, called by sl-stream when a swarm goes stale. Cheaper than a resolve because the
   * infohash pins the metadata forever, so there is no BEP-9 round to wait for.
   */
  refreshDeadlineMs: envInt("MA_REFRESH_DEADLINE_MS", 15_000),
  refreshMinPeers: envInt("MA_REFRESH_MIN_PEERS", 20, 1),
  /**
   * Shared secret for `POST /refresh`. **Unset means the route refuses every request**: it is a
   * public endpoint that does uncapped swarm work, so failing closed is the only safe default.
   */
  refreshToken: envStr("MA_REFRESH_TOKEN", ""),

  /**
   * How old a peer record may be before `GET /peers/:id` calls it stale. Swarm membership turns
   * over in minutes, so this is a "worth re-walking" threshold and not an expiry: a stale record is
   * still returned, just flagged, and `?refresh=auto` is what acts on the flag.
   */
  peersStaleMs: envInt("MA_PEERS_STALE_MS", 10 * 60_000, 0),

  trackerTimeoutMs: envInt("MA_TRACKER_TIMEOUT_MS", 3_000),
  dhtBudgetMs: envInt("MA_DHT_BUDGET_MS", 20_000),
  dhtMaxNodes: envInt("MA_DHT_MAX_NODES", 200, 8, 5_000),

  /** BEP-9 refuses anything larger; also the cap on a single assembled info dict. */
  maxMetadataBytes: envInt("MA_MAX_METADATA_BYTES", 8 * MiB),

  /**
   * Allow loopback, RFC 1918 and link-local peer addresses.
   *
   * Off by default: trackers and DHT nodes are unauthenticated, and a hostile one that returns
   * `10.0.0.5:22` turns this service into a port scanner inside its own network. Turn it on only
   * for a LAN seedbox or a private tracker where those addresses are the real peers.
   */
  allowPrivatePeers: envBool("MA_ALLOW_PRIVATE_PEERS", false),

  /** Individual discovery sources, switchable so a broken one can be cut without a deploy. */
  enableUdpTrackers: envBool("MA_ENABLE_UDP", true),
  enableHttpTrackers: envBool("MA_ENABLE_HTTP", true),
  enableDht: envBool("MA_ENABLE_DHT", true),
  enablePex: envBool("MA_ENABLE_PEX", true),

  /**
   * Postgres connection string, e.g.
   * `postgresql://user:pass@host:6543/postgres?sslmode=require`.
   *
   * A Supabase pooler URL and a plain Postgres URL differ only here, which is the point of talking
   * the wire protocol rather than a vendor SDK. Required — but empty by default, because the
   * failure belongs in `openDb()` and not in this file. Set it in `.env`; every task loads that
   * via `--env-file`.
   */
  databaseUrl: envStr("MA_DATABASE_URL", ""),
  dbPoolSize: envInt("MA_DB_POOL_SIZE", 5, 1, 100),
  /**
   * Named prepared statements.
   *
   * Off by default because Supabase's transaction-mode pooler (:6543) gives each statement a
   * different server connection, so a prepared statement is gone by the time it is used. A resolve
   * issues a handful of queries against seconds of swarm work, so the saving is invisible; turn it
   * on for a direct or session-mode connection (:5432) if you want it.
   */
  dbPrepare: envBool("MA_DB_PREPARE", false),
  dbConnectTimeoutMs: envInt("MA_DB_CONNECT_TIMEOUT_MS", 10_000),
  /** 0 keeps connections open indefinitely. Set ~30s behind a pooler that charges per connection. */
  dbIdleTimeoutMs: envInt("MA_DB_IDLE_TIMEOUT_MS", 0, 0),

  /**
   * Origins allowed to call this service from a browser, or empty for none.
   *
   * Comma-separated, because more than one page can front the same service (a deployed site plus a
   * GitHub Pages build, say) and `Access-Control-Allow-Origin` only ever carries one value — the
   * handler picks the entry matching the request. Empty by default because nothing in the normal
   * deployment is browser-facing — sl-stream calls `/refresh` server-side. Set it (`*` locally)
   * only when a page needs to reach these routes directly, as the dev stack does.
   */
  corsOrigins: envList("MA_CORS_ORIGIN", ""),

  logLevel: envStr("MA_LOG_LEVEL", "info"),
});

/** Stamped into every record written; bump to invalidate what is already in KV. */
export const RECORD_VERSION = 1;
