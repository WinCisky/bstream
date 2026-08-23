/**
 * A `Database` backed by PGlite: real Postgres compiled to WebAssembly, in this process.
 *
 * This is what keeps `deno task verify` hermetic. The suite runs the *same* SQL and the *same*
 * migration files as production, with no daemon, no container and no network — so a schema change
 * that breaks a query fails in CI rather than on a VPS.
 *
 * It lives under `test/` deliberately: `main.ts`'s module graph must never mention PGlite, or
 * `deno task start` would pull a WebAssembly build it has no use for.
 *
 * One thing it cannot do: PGlite has a single backend and serialises everything, so two
 * "concurrent" transactions are not concurrent. The sequential first-writer-wins proof lives here;
 * the genuinely concurrent one needs a real Postgres and is gated behind `MA_TEST_DATABASE_URL`.
 */

import { PGlite } from "@electric-sql/pglite";
import type { Database, Executor, SqlParam } from "../../src/db/sql.ts";

interface PgliteHandle {
  query<Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  exec(text: string): Promise<unknown>;
}

function executor(handle: PgliteHandle): Executor {
  return {
    async query(text: string, params: readonly SqlParam[] = []) {
      const result = await handle.query(text, params as unknown[]);
      return { rows: result.rows as never[] };
    },
    async exec(text: string) {
      await handle.exec(text);
    },
  };
}

/** An empty in-memory database. The caller applies the migrations. */
export async function createPglite(): Promise<Database> {
  const pg = await PGlite.create();
  const base = executor(pg as unknown as PgliteHandle);
  return {
    ...base,
    transaction: <T>(fn: (tx: Executor) => Promise<T>) =>
      pg.transaction((tx) => fn(executor(tx as unknown as PgliteHandle))) as Promise<T>,
    close: () => pg.close(),
  };
}
