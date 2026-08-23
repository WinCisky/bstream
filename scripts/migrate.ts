/**
 * Apply the schema to whatever `MA_DATABASE_URL` points at.
 *
 *   deno task migrate              # apply and exit
 *   deno task migrate --wait 60    # wait up to 60s for the database first
 *
 * `--wait` exists for the dev stack, where the container may start before Postgres is accepting
 * connections and there is no `pg_isready` in a Deno image.
 */

import { config } from "../src/config.ts";
import { applyMigrations, waitForDatabase } from "../src/db/migrate.ts";
import { createDatabase } from "../src/db/postgres.ts";

const args = [...Deno.args];
const waitIndex = args.indexOf("--wait");
const waitSeconds = waitIndex >= 0 ? Number(args[waitIndex + 1] ?? "0") : 0;

if (config.databaseUrl.length === 0) {
  console.error("MA_DATABASE_URL is not set; there is nothing to migrate");
  Deno.exit(2);
}

const db = createDatabase(config.databaseUrl);
try {
  if (Number.isFinite(waitSeconds) && waitSeconds > 0) {
    await waitForDatabase(db, waitSeconds * 1000);
  }
  const applied = await applyMigrations(db);
  console.log(
    applied.length === 0
      ? "schema is up to date"
      : `applied ${applied.length}: ${applied.join(", ")}`,
  );
} catch (err) {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  await db.close().catch(() => {});
  Deno.exit(1);
}

await db.close();
