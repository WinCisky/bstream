/**
 * The production database handle.
 *
 * This service runs outside Deno Deploy — it needs raw TCP for the peer wire protocol and UDP for
 * trackers and the DHT, neither of which Deploy provides — and reaches the same Postgres sl-stream
 * reads over `MA_DATABASE_URL`. A Supabase pooler URL and a plain Postgres URL differ only in that
 * string, which is the whole reason for connecting over the wire protocol rather than through a
 * vendor SDK.
 *
 * Unlike sl-stream's wrapper, a database failure here is fatal rather than degraded: sl-stream
 * treats its store as an accelerator, but for this service writing those records *is* the job.
 */

import postgres from "postgres";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { type Database, DbUnavailableError, type Executor, type SqlParam } from "./sql.ts";

export { DbUnavailableError };

/**
 * postgres.js error codes that mean "the database is not reachable", as opposed to "the database
 * refused that statement".
 *
 * Only these become a 503. A constraint violation is a bug in this service and has earned its 500 —
 * folding the two together would let a broken chunk record masquerade as an outage and get retried
 * forever.
 */
const UNREACHABLE = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECTION_REFUSED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

/** SQLSTATE class 08 is "connection exception"; 57P01 is the server shutting down under us. */
function unreachable(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code !== "string") return false;
  return UNREACHABLE.has(code) || code.startsWith("08") || code === "57P01";
}

function rethrow(err: unknown): never {
  if (unreachable(err)) {
    throw new DbUnavailableError(err instanceof Error ? err.message : String(err));
  }
  throw err;
}

/**
 * Wrap a postgres.js handle — the pool itself, or one transaction's connection — as an `Executor`.
 *
 * `unsafe` rather than the tagged template because the SQL is written as text with `$n`
 * placeholders, so the same strings run unmodified under PGlite in the tests. Passing parameters
 * still binds them; nothing here interpolates a value into SQL.
 */
function executor(sql: postgres.Sql | postgres.TransactionSql): Executor {
  return {
    async query(text: string, params: readonly SqlParam[] = []) {
      try {
        const rows = await sql.unsafe(text, params as never[]);
        return { rows: rows as unknown as never[] };
      } catch (err) {
        rethrow(err);
      }
    },
    async exec(text: string) {
      try {
        // No parameters, so this is the simple query protocol and the whole script runs in one
        // round trip. With parameters postgres.js switches to the extended protocol, which accepts
        // exactly one statement — hence the split between `exec` and `query`.
        await sql.unsafe(text);
      } catch (err) {
        rethrow(err);
      }
    },
  };
}

export function createDatabase(url: string): Database {
  const sql = postgres(url, {
    max: config.dbPoolSize,
    // Named prepared statements are off by default because Supabase's transaction-mode pooler
    // (:6543) hands each statement a different server connection and they vanish between the parse
    // and the bind. This service issues a handful of queries per resolve, so the saving they buy is
    // invisible next to a swarm walk. MA_DB_PREPARE=1 turns them on for a direct connection.
    prepare: config.dbPrepare,
    connect_timeout: Math.max(1, Math.ceil(config.dbConnectTimeoutMs / 1000)),
    ...(config.dbIdleTimeoutMs > 0
      ? { idle_timeout: Math.ceil(config.dbIdleTimeoutMs / 1000) }
      : {}),
    // NOTICEs are the server's log stream, not ours; left on they print raw objects to stdout and
    // corrupt the structured JSON every other line of output is.
    onnotice: () => {},
    connection: { application_name: "ma-stream" },
  });

  const base = executor(sql);
  return {
    ...base,
    async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
      try {
        return await sql.begin((tx) => fn(executor(tx))) as T;
      } catch (err) {
        rethrow(err);
      }
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

let handle: Database | null = null;
let opening: Promise<Database> | null = null;

/**
 * The process-wide handle, opened once.
 *
 * `MA_DATABASE_URL` is required, but the check lives here rather than in `config.ts`: a config read
 * must never be able to kill a boot, so an unset variable has to surface as a 503 on the first
 * request rather than a crash at import. `main.ts` warns about it at startup so an operator does
 * not have to send a request to find out.
 */
export function openDb(): Promise<Database> {
  if (handle) return Promise.resolve(handle);
  if (!opening) {
    opening = (async () => {
      if (config.databaseUrl.length === 0) {
        throw new DbUnavailableError(
          "MA_DATABASE_URL is not set; there is nowhere to write the records",
        );
      }
      const db = createDatabase(config.databaseUrl);
      try {
        // Fail here rather than inside the first resolve, so the error names the database instead
        // of arriving forty seconds into a swarm walk.
        await db.query("select 1");
      } catch (err) {
        await db.close().catch(() => {});
        if (err instanceof DbUnavailableError) throw err;
        throw new DbUnavailableError(
          `could not reach the database: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      handle = db;
      log.info("db.opened", { host: safeHost(config.databaseUrl), pool: config.dbPoolSize });
      return db;
    })();
    opening = opening.finally(() => {
      opening = null;
    });
  }
  return opening;
}

export async function closeDb(): Promise<void> {
  const open = handle;
  handle = null;
  opening = null;
  try {
    await open?.close();
  } catch {
    // Already closed.
  }
}

/** Host and database only. A connection string carries a password and this goes to the log. */
function safeHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable)";
  }
}
