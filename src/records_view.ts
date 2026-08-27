/**
 * `GET /records/:id` — the stored records, over HTTP, in one read.
 *
 * sl-stream has two ways to obtain a chunk record and a peer record: two PostgREST point reads at
 * the start of a session, or the same records inlined in its own `start` frame. The first costs it
 * two of a Cloudflare Worker's fifty subrequests and needs a database credential handed to the
 * edge; the second costs none and needs nothing, provided whoever opens the WebSocket already has
 * the records to inline. This route is how that caller gets them.
 *
 * It is a pure read — three point queries, no swarm, no writes — which is what makes it worth
 * having next to `/refresh`. `/refresh` exists to *change* the peer record and pays a swarm walk to
 * do it; this only reports what is already stored.
 *
 * The response is exactly sl-stream's `start.records`: `{chunks, peers, health}`, keys and all,
 * so a caller forwards it verbatim rather than reshaping it. Two representation notes, both forced
 * by JSON:
 *
 *  - `pieces` is `pieceCount * 20` raw bytes in the record and base64 in the response.
 *    sl-stream's `normalizeChunks` accepts base64, `\\x`-hex bytea or a JSON `Buffer`; base64 is
 *    the compact one, and at 120 000 pieces the difference is 3.2 MB against 4.8 MB.
 *  - `health` is an array, and an id nobody has streamed yet has an empty one. That is not a
 *    missing record — `peer_health` is sl-stream's table and starts empty for every id.
 */

import { toBase64 } from "./bytes.ts";
import type { ChunksRecord, PeerHealthEntry, PeersRecord } from "./db/records.ts";
import { openDb } from "./db/postgres.ts";
import type { Database } from "./db/sql.ts";
import { readChunks, readPeerHealth, readPeers } from "./db/store.ts";
import { ResolveError } from "./resolve.ts";

/** `chunks`, with `pieces` in the only form JSON can carry. */
export type ChunksView = Omit<ChunksRecord, "pieces"> & { readonly pieces: string };

export interface RecordsView {
  readonly chunks: ChunksView;
  readonly peers: PeersRecord;
  readonly health: PeerHealthEntry[];
}

export interface ReadRecordsOptions {
  readonly db?: Database;
}

export function toChunksView(chunks: ChunksRecord): ChunksView {
  const { pieces, ...rest } = chunks;
  return { ...rest, pieces: toBase64(pieces) };
}

/**
 * Read the records for an id.
 *
 * Missing either record is a 404 and not a partial answer. `persist` writes both in one
 * transaction, so "chunks but no peers" is not a state this service produces; a caller that got
 * one of the two would have to invent a policy for the other half, and the honest answer is that
 * the id is not usable.
 */
export async function readRecords(
  id: string,
  options: ReadRecordsOptions = {},
): Promise<RecordsView> {
  if (!/^[0-9a-f]{40}$/i.test(id)) {
    throw new ResolveError(`"${id}" is not a 40-character info hash`, 400, "bad_id");
  }
  const normalised = id.toLowerCase();
  const db = options.db ?? await openDb();

  const [chunks, peers, health] = await Promise.all([
    readChunks(db, normalised),
    readPeers(db, normalised),
    readPeerHealth(db, normalised),
  ]);

  if (!chunks || !peers) {
    throw new ResolveError(`${normalised} has no stored records`, 404, "unknown_id");
  }
  return { chunks: toChunksView(chunks), peers, health };
}
