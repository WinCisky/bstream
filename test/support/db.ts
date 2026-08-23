/**
 * A migrated database for a test file to own.
 *
 * Each test file makes one and closes it in its teardown. That mirrors the single shared `Deno.Kv`
 * handle these suites used before, keeps the files independent, and costs about a second — PGlite
 * boots and applies the schema in roughly that.
 *
 * `banPeer` and `clearPeerHealth` are here rather than in `src/db/store.ts` on purpose. sl-stream
 * owns the contents of `peer_health`; ma-stream only ever reads it, and the production store should
 * keep saying so. These are the executable copy of the write half of that contract, which is also
 * documented in the README — if they drift from what sl-stream does, the ban test stops meaning
 * anything.
 */

import { applyMigrations } from "../../src/db/migrate.ts";
import type { Database, Executor } from "../../src/db/sql.ts";
import { createPglite } from "./pglite.ts";

export async function testDatabase(): Promise<Database> {
  const db = await createPglite();
  await applyMigrations(db);
  return db;
}

/**
 * A real Postgres, when one is configured, for the handful of properties PGlite cannot show.
 *
 * Returns null when `MA_TEST_DATABASE_URL` is unset, so those tests skip rather than fail — the
 * same shape `contract_test.ts` uses for the absent sl-stream checkout.
 */
export async function realDatabase(): Promise<Database | null> {
  const url = Deno.env.get("MA_TEST_DATABASE_URL");
  if (!url || url.length === 0) return null;
  const { createDatabase } = await import("../../src/db/postgres.ts");
  const db = createDatabase(url);
  await db.exec(
    "drop table if exists peer_health, peer_records, chunk_records, magnets, schema_migrations",
  );
  await applyMigrations(db);
  return db;
}

/** sl-stream's write, in the shape the README documents. */
export async function banPeer(
  db: Executor,
  id: string,
  peerKey: string,
  bannedUntil: number,
): Promise<void> {
  await db.query(
    `insert into peer_health (id, peer_key, banned_until, ok, fails, updated_at)
     values ($1, $2, $3, 0, 1, $4)
     on conflict (id, peer_key) do update set
       banned_until = excluded.banned_until,
       fails        = peer_health.fails + excluded.fails,
       updated_at   = excluded.updated_at`,
    [id, peerKey, bannedUntil, Date.now()],
  );
}

export async function clearPeerHealth(db: Executor, id: string): Promise<void> {
  await db.query("delete from peer_health where id = $1", [id]);
}
