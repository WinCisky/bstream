/**
 * Dev stack web server.
 *
 * Serves the test page and a handful of endpoints that exist only so the page can show what was
 * stored. **This is not part of either service** — it reaches straight into the database and has no
 * authentication at all, which is fine inside a local container and would be indefensible anywhere
 * else.
 *
 * The page talks to ma-stream and sl-stream directly rather than through a proxy here, so what it
 * exercises is the real CORS, the real auth and the real range handling.
 */

import { createDatabase } from "../src/db/postgres.ts";
import type { Database } from "../src/db/sql.ts";

const PORT = Number(Deno.env.get("DEVSTACK_PORT") ?? 8080);
const DATABASE_URL = Deno.env.get("DEVSTACK_DATABASE_URL") ?? Deno.env.get("MA_DATABASE_URL") ?? "";
const PUBLIC_DIR = new URL("./public/", import.meta.url).pathname;

const CONFIG = {
  maUrl: Deno.env.get("DEVSTACK_MA_URL") ?? "http://localhost:8201",
  slUrl: Deno.env.get("DEVSTACK_SL_URL") ?? "http://localhost:8202",
  // The page needs it to call /refresh. A dev container's whole point is that this is safe here.
  refreshToken: Deno.env.get("MA_REFRESH_TOKEN") ?? "",
  defaultMagnet: Deno.env.get("DEVSTACK_DEFAULT_MAGNET") ?? "",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  // Not cosmetic: `WebAssembly.instantiateStreaming` rejects anything else.
  ".wasm": "application/wasm",
  ".map": "application/json",
};

/**
 * Cross-origin isolation, which is what makes `SharedArrayBuffer` available — libmedia decodes on
 * worker threads when it is there and on the main thread when it is not.
 *
 * The cost is that cross-origin subresources must opt in: sl-stream sends
 * `cross-origin-resource-policy: cross-origin` for exactly this reason, and the page loads the
 * video with `crossorigin="anonymous"` so the request is a CORS one either way.
 */
const ISOLATION_HEADERS: Record<string, string> = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};

// Its own handle, like it had its own KV handle: this is not part of either service and should
// not share their connection pool.
let database: Database | null = null;
function getDb(): Database {
  if (!database) database = createDatabase(DATABASE_URL);
  return database;
}

/** Epoch millis come back as strings from postgres.js; the page does arithmetic on them. */
function ms(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...ISOLATION_HEADERS },
  });
}

/**
 * Everything the page shows about one id.
 *
 * Three point reads, mirroring the three the page used to make against KV. Note what the chunk
 * query does *not* select: `pieces` can be megabytes and the page only ever wants its size, so the
 * length is computed server-side. Under KV the endpoint had to read the whole value to measure it.
 */
async function state(id: string): Promise<Response> {
  const db = getDb();
  const [index, peers, chunks] = await Promise.all([
    db.query<Record<string, unknown>>(
      `select name, magnet, created_at, updated_at, coalesce(array_length(trackers, 1), 0) as trackers
         from magnets where id = $1`,
      [id],
    ),
    db.query<Record<string, unknown>>(
      `select peer_count, resolved_at, peers from peer_records where id = $1`,
      [id],
    ),
    db.query<Record<string, unknown>>(
      `select name, piece_length, piece_count, total_length, file_path, file_index,
              file_offset, file_length, mime, files, resolved_at,
              octet_length(pieces) as hash_bytes
         from chunk_records where id = $1`,
      [id],
    ),
  ]);

  const indexRow = index.rows[0] ?? null;
  const peersRow = peers.rows[0] ?? null;
  const chunksRow = chunks.rows[0] ?? null;

  const peerList = (peersRow?.peers ?? []) as unknown[];
  const bt = peerList.filter((entry) => typeof entry === "object" && entry !== null);
  const webseeds = peerList.filter((entry) => typeof entry === "string");

  return json({
    id,
    index: indexRow
      ? {
        name: indexRow.name,
        magnet: indexRow.magnet,
        createdAt: ms(indexRow.created_at),
        updatedAt: ms(indexRow.updated_at),
        trackers: Number(indexRow.trackers),
      }
      : null,
    peers: peersRow
      ? {
        count: Number(peersRow.peer_count),
        resolvedAt: ms(peersRow.resolved_at),
        bt: bt.length,
        verified: bt.filter((entry) => (entry as { verified?: boolean }).verified).length,
        webseeds: webseeds.length,
        sample: bt.slice(0, 8),
      }
      : null,
    chunks: chunksRow
      ? {
        name: chunksRow.name,
        pieceLength: Number(chunksRow.piece_length),
        pieceCount: Number(chunksRow.piece_count),
        totalLength: Number(chunksRow.total_length),
        filePath: chunksRow.file_path,
        fileIndex: Number(chunksRow.file_index),
        fileOffset: Number(chunksRow.file_offset),
        fileLength: Number(chunksRow.file_length),
        mime: chunksRow.mime,
        // The whole list, so the page's tree is built from what sl-stream's `?file=` indexes.
        files: chunksRow.files ?? null,
        resolvedAt: ms(chunksRow.resolved_at),
        hashBytes: Number(chunksRow.hash_bytes),
      }
      : null,
  });
}

/**
 * The torrent's own SHA-1 for one piece, as hex.
 *
 * The page fetches a piece from sl-stream and compares against this. Doing the comparison rather
 * than printing two hashes side by side is the difference between a demo and a test: the whole
 * chain — discovery, the peer wire, the piece maths — is only correct if these match.
 */
async function pieceHash(id: string, index: number): Promise<Response> {
  if (!Number.isInteger(index) || index < 0) {
    return json({ error: `piece ${index} is out of range` }, 400);
  }
  // Sliced and hex-encoded in the database, so no bytea crosses the wire. `substring` on a bytea
  // is 1-based, and `pieces` is stored EXTERNAL so Postgres can slice it without detoasting all of
  // it — which for a 120k-piece torrent is the difference between 20 bytes and 2.4 MB.
  const result = await getDb().query<{ sha1: string; total: number }>(
    `select encode(substring(pieces from $2 for 20), 'hex') as sha1,
            octet_length(pieces) as total
       from chunk_records where id = $1`,
    [id, index * 20 + 1],
  );
  const row = result.rows[0];
  if (!row) return json({ error: "no piece hashes stored for that id" }, 404);
  if (row.sha1.length !== 40) return json({ error: `piece ${index} is out of range` }, 400);
  return json({ id, index, sha1: row.sha1 });
}

async function serveStatic(pathname: string): Promise<Response> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // Path traversal would only reach files inside the container, but there is no reason to allow it.
  if (relative.includes("..")) return new Response("nope", { status: 400 });

  try {
    const path = `${PUBLIC_DIR}${relative}`;
    const body = await Deno.readFile(path);
    const dot = relative.lastIndexOf(".");
    const type = MIME[relative.slice(dot)] ?? "application/octet-stream";
    // The page must never be cached — editing it and reloading is the whole workflow. The vendored
    // player is the opposite: 18 MiB of version-pinned wasm that would otherwise be re-read on
    // every reload.
    const cache = relative.startsWith("vendor/")
      ? "public, max-age=31536000, immutable"
      : "no-store";
    return new Response(body, {
      headers: { "content-type": type, "cache-control": cache, ...ISOLATION_HEADERS },
    });
  } catch {
    return new Response("not found", { status: 404, headers: ISOLATION_HEADERS });
  }
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (request) => {
  const url = new URL(request.url);

  try {
    if (url.pathname === "/dev/config") return json(CONFIG);

    if (url.pathname === "/dev/state") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id is required" }, 400);
      return await state(id);
    }

    if (url.pathname === "/dev/piece-hash") {
      const id = url.searchParams.get("id");
      const index = Number(url.searchParams.get("index"));
      if (!id) return json({ error: "id is required" }, 400);
      return await pieceHash(id, index);
    }

    return await serveStatic(url.pathname);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

console.log(JSON.stringify({ event: "devstack.listening", port: PORT }));
