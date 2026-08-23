/**
 * CLI wrapper around the resolver, for testing a magnet without standing the service up.
 *
 *   deno task resolve "magnet:?xt=urn:btih:..." [--force]
 *
 * Prints the id on stdout and a summary on stderr, so the id can be piped.
 */

import { resolveMagnet } from "../src/resolve.ts";
import { closeDb } from "../src/db/postgres.ts";

const args = [...Deno.args];
const force = args.includes("--force");
const magnet = args.find((arg) => !arg.startsWith("--"));

if (!magnet) {
  console.error('usage: deno task resolve "magnet:?xt=urn:btih:..." [--force]');
  Deno.exit(2);
}

try {
  const result = await resolveMagnet(magnet, { force });
  console.error(JSON.stringify(result, null, 2));
  console.log(result.id);
} catch (err) {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  await closeDb();
  Deno.exit(1);
}

await closeDb();
// Exit rather than fall off the end. `Deno.connect` cannot be cancelled, so every peer we stopped
// waiting for still holds a pending connect until the OS abandons the SYN — minutes, on Linux.
// The records are written and the id is printed; there is nothing left to wait for.
Deno.exit(0);
