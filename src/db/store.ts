/**
 * Every statement this service runs. Nothing outside this file writes SQL.
 *
 * The write that matters is `persist`. Three rows land in one transaction, so sl-stream can never
 * observe a peer record without its chunk record — `loadSource` treats that combination as a 404
 * rather than a partial mode. What used to be `kv.atomic().check({ versionstamp: null })` is now
 * `insert … on conflict (id) do nothing returning id`: two processes resolving the same magnet at
 * once produce one write and one no-op, not a torn interleaving.
 *
 * That translation is exact, and better defined than the thing it replaces. Under READ COMMITTED
 * the loser blocks on the winner's row lock, then — once the winner commits — inserts nothing and
 * returns zero rows. It never raises `23505`, so there is no retry loop and no duplicate-key error
 * to misread as a failure. Verified against a real Postgres with two concurrent connections, not
 * inferred from the manual.
 *
 * The hash shards that used to be written after the transaction, outside it, best-effort, are
 * gone: `pieces` is a `bytea` column in the same row as everything else, so `persist` is now
 * genuinely all-or-nothing rather than only claiming to be.
 */

import { log } from "../log.ts";
import type { Database, Executor } from "./sql.ts";
import type { ChunksRecord, MagnetIndexRecord, PeersRecord } from "./records.ts";
import {
  type ChunksRow,
  type MagnetRow,
  type PeersRow,
  toChunksRecord,
  toMagnetIndex,
  toPeersRecord,
} from "./rows.ts";

const MAGNET_COLUMNS = "id, version, magnet, name, trackers, created_at, updated_at, peer_count";

const INSERT_MAGNET_IF_ABSENT = `
  insert into magnets (${MAGNET_COLUMNS})
  values ($1, $2, $3, $4, $5, $6, $7, $8)
  on conflict (id) do nothing
  returning id`;

/**
 * The forced variant. `created_at` is deliberately absent from the SET list: a forced re-resolve
 * replaces the correlation, not the fact of when it was first made.
 */
const UPSERT_MAGNET = `
  insert into magnets (${MAGNET_COLUMNS})
  values ($1, $2, $3, $4, $5, $6, $7, $8)
  on conflict (id) do update set
    version    = excluded.version,
    magnet     = excluded.magnet,
    name       = excluded.name,
    trackers   = excluded.trackers,
    updated_at = excluded.updated_at,
    peer_count = excluded.peer_count
  returning id`;

const UPSERT_PEERS = `
  insert into peer_records (id, version, resolved_at, peer_count, peers, webseeds)
  values ($1, $2, $3, $4, $5, $6)
  on conflict (id) do update set
    version = excluded.version, resolved_at = excluded.resolved_at,
    peer_count = excluded.peer_count, peers = excluded.peers, webseeds = excluded.webseeds`;

const UPSERT_CHUNKS = `
  insert into chunk_records (id, version, name, piece_length, piece_count, total_length,
                             pieces, files, file_index, file_path, file_offset, file_length,
                             mime, resolved_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  on conflict (id) do update set
    version = excluded.version, name = excluded.name, piece_length = excluded.piece_length,
    piece_count = excluded.piece_count, total_length = excluded.total_length,
    pieces = excluded.pieces, files = excluded.files, file_index = excluded.file_index,
    file_path = excluded.file_path, file_offset = excluded.file_offset,
    file_length = excluded.file_length, mime = excluded.mime, resolved_at = excluded.resolved_at`;

/**
 * Objects and arrays are bound as values, never pre-stringified.
 *
 * postgres.js JSON-encodes an object bound to a `jsonb` column correctly but double-encodes a
 * string bound to `$n::jsonb`, storing the JSON *text* as a JSON string. PGlite accepts both, so
 * getting this backwards passes the suite and corrupts production. See `sql.ts`.
 */
function magnetParams(index: MagnetIndexRecord) {
  return [
    index.id,
    index.version,
    index.magnet,
    index.name,
    index.trackers,
    index.createdAt,
    index.updatedAt,
    index.peerCount,
  ] as const;
}

function peerParams(id: string, peers: PeersRecord) {
  return [id, peers.version, peers.resolvedAt, peers.count, peers.peers, peers.webseeds] as const;
}

function chunkParams(id: string, chunks: ChunksRecord) {
  return [
    id,
    chunks.version,
    chunks.name,
    chunks.pieceLength,
    chunks.pieceCount,
    chunks.totalLength,
    chunks.pieces,
    chunks.files,
    chunks.fileIndex,
    chunks.filePath,
    chunks.fileOffset,
    chunks.fileLength,
    chunks.mime,
    chunks.resolvedAt,
  ] as const;
}

export interface PersistInput {
  readonly id: string;
  readonly index: MagnetIndexRecord;
  readonly peers: PeersRecord;
  readonly chunks: ChunksRecord;
  /** Overwrite an existing correlation instead of yielding to it. */
  readonly force: boolean;
}

export interface PersistResult {
  readonly id: string;
  /** False when another writer got there first and we deferred to their record. */
  readonly created: boolean;
}

export async function readIndex(
  db: Executor,
  infoHashHex: string,
): Promise<MagnetIndexRecord | null> {
  const result = await db.query<MagnetRow>(
    `select ${MAGNET_COLUMNS} from magnets where id = $1`,
    [infoHashHex],
  );
  const row = result.rows[0];
  return row ? toMagnetIndex(row) : null;
}

export async function readPeers(db: Executor, id: string): Promise<PeersRecord | null> {
  const result = await db.query<PeersRow>(
    `select id, version, resolved_at, peer_count, peers, webseeds
       from peer_records where id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toPeersRecord(row) : null;
}

export async function readChunks(db: Executor, id: string): Promise<ChunksRecord | null> {
  const result = await db.query<ChunksRow>(
    `select id, version, name, piece_length, piece_count, total_length, pieces, files,
            file_index, file_path, file_offset, file_length, mime, resolved_at
       from chunk_records where id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toChunksRecord(row) : null;
}

/**
 * The peers sl-stream currently considers dead.
 *
 * It writes that table and we only read it, which is the point: sl-stream has actually tried to
 * stream from these peers and we have not, so its verdict outranks anything discovery can offer.
 * Only the keys are fetched — the ban filter is the whole reason to look.
 */
export async function readBannedPeers(db: Executor, id: string, now: number): Promise<Set<string>> {
  const result = await db.query<{ peer_key: string }>(
    "select peer_key from peer_health where id = $1 and banned_until > $2",
    [id, now],
  );
  return new Set(result.rows.map((row) => row.peer_key));
}

export async function persist(db: Database, input: PersistInput): Promise<PersistResult> {
  const created = await db.transaction(async (tx) => {
    const claimed = await tx.query<{ id: string }>(
      input.force ? UPSERT_MAGNET : INSERT_MAGNET_IF_ABSENT,
      magnetParams(input.index),
    );

    // Not an error, and not a rollback either. Another writer correlated this magnet first, so we
    // defer to their records; the transaction has written nothing, which makes commit and rollback
    // identical in both effect and cost.
    if (claimed.rows.length === 0) return false;

    await tx.query(UPSERT_CHUNKS, chunkParams(input.id, input.chunks));
    await tx.query(UPSERT_PEERS, peerParams(input.id, input.peers));
    return true;
  });

  if (!created) {
    log.info("db.already_present", { id: input.id });
    return { id: input.id, created: false };
  }

  log.info("db.written", {
    id: input.id,
    peers: input.peers.count,
    pieces: input.chunks.pieceCount,
    files: input.chunks.files.length,
  });
  return { id: input.id, created: true };
}

/**
 * Rewrite the peer list alone, leaving the chunk record untouched.
 *
 * A refresh can never need to touch `chunk_records`: the id *is* the infohash, and an infohash pins
 * the metadata for all time. Writing both would risk replacing a good chunk record with a worse one
 * for no benefit.
 *
 * Only the two fields a refresh actually changes are updated on `magnets`. Writing the whole index
 * row back — which is what the KV version did, having read it seconds earlier — would clobber a
 * concurrent forced resolve's new magnet string with a stale one.
 */
export async function persistPeers(
  db: Database,
  id: string,
  peers: PeersRecord,
  updatedAt: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(UPSERT_PEERS, peerParams(id, peers));
    await tx.query("update magnets set updated_at = $2, peer_count = $3 where id = $1", [
      id,
      updatedAt,
      peers.count,
    ]);
  });
  log.info("db.peers_written", { id, peers: peers.count });
}
