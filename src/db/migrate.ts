/**
 * Schema migrations.
 *
 * Deliberately about seventy lines and no more. This project has no ORM and should not gain one to
 * run four `create table`s; what it does need is that the *same* files reach a real Postgres, the
 * dev stack and the test suite, so CI executes the production DDL rather than a hand-maintained
 * copy of it that drifts.
 *
 * Rules, which the files themselves have to respect:
 *
 *  - **One file, one transaction.** Anything that cannot run inside one — `create index
 *    concurrently`, `vacuum` — must not appear. Nothing here needs to.
 *  - **A file is immutable once applied.** A change is a new file, never an edit.
 *  - **Plain `create table`, not `if not exists`.** `schema_migrations` is the idempotency
 *    mechanism and the transaction rules out a half-applied file, so `if not exists` could only
 *    ever hide a mistake.
 *
 * This is not run at boot. A service that mutates its own schema on start is a service that can
 * rewrite a database during a rollback.
 */

import { log } from "../log.ts";
import type { Database } from "./sql.ts";

const DIRECTORY = new URL("../../sql/", import.meta.url);

/** Numeric prefix, zero-padded, so lexical order is numeric order: `001_init.sql`. */
function migrationFiles(dir: URL): string[] {
  return [...Deno.readDirSync(dir)]
    .filter((entry) => entry.isFile && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Apply every migration not yet recorded, and return the names of the ones applied.
 *
 * Idempotent: a second call against the same database applies nothing.
 */
export async function applyMigrations(db: Database, dir: URL = DIRECTORY): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const recorded = new Set(
    (await db.query<{ version: string }>("select version from schema_migrations"))
      .rows.map((row) => row.version),
  );

  const applied: string[] = [];
  for (const name of migrationFiles(dir)) {
    if (recorded.has(name)) continue;
    const text = await Deno.readTextFile(new URL(name, dir));

    const ran = await db.transaction(async (tx) => {
      // Two boots racing — a compose restart, two deploys — must not both apply the same file.
      // Transaction-scoped rather than session-scoped, so it also holds on Supabase's transaction
      // pooler, where a session lock would be taken on a connection we do not keep.
      await tx.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
        "ma-stream.migrations",
      ]);
      const already = await tx.query(
        "select 1 from schema_migrations where version = $1",
        [name],
      );
      if (already.rows.length > 0) return false;

      await tx.exec(text);
      await tx.query("insert into schema_migrations (version) values ($1)", [name]);
      return true;
    });

    if (ran) {
      applied.push(name);
      log.info("migrate.applied", { version: name });
    }
  }
  return applied;
}

/**
 * Block until the database answers, or the budget runs out.
 *
 * The dev stack needs this because `docker run` has no `depends_on`, and it is cheaper than putting
 * a Postgres client in the image just to call `pg_isready`.
 */
export async function waitForDatabase(db: Database, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await db.query("select 1");
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `database did not answer within ${budgetMs}ms: ` +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}
