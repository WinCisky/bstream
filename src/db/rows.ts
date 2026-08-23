/**
 * Row shapes, and the mappers between them and the records.
 *
 * Two rules hold everywhere in this file, both of them measured rather than assumed:
 *
 *  - **Every numeric column goes through `num()`.** Postgres returns `bigint` as a string under
 *    postgres.js and a number under PGlite. A raw `resolvedAt` would therefore be a string in
 *    production and a number in the tests, and `Date.now() - resolvedAt` would quietly do string
 *    arithmetic on exactly the deployment that matters.
 *  - **Every `bytea` column goes through `bytes()`.** postgres.js hands back a `Buffer` and PGlite
 *    a `Uint8Array`; both work, but `assertEquals` calls them unequal, so a round-trip assertion
 *    would pass in CI and fail against a real database.
 *
 * `jsonb` needs neither: both drivers return it already parsed, so parsing again would turn an
 * array into a crash.
 *
 * `id` and `infoHash` are the same value — the lowercase v1 infohash — and the schema stores it
 * once. The mappers put it back under both names, because that is the shape sl-stream's adapter
 * reads.
 */

import { bytes, num } from "./sql.ts";
import type {
  ChunkFileEntry,
  ChunksRecord,
  MagnetIndexRecord,
  PeerRecordItem,
  PeersRecord,
} from "./records.ts";

export interface MagnetRow extends Record<string, unknown> {
  id: string;
  version: number;
  magnet: string;
  name: string;
  trackers: string[];
  created_at: unknown;
  updated_at: unknown;
  peer_count: unknown;
}

export interface PeersRow extends Record<string, unknown> {
  id: string;
  version: number;
  resolved_at: unknown;
  peer_count: unknown;
  peers: PeerRecordItem[];
  webseeds: string[];
}

export interface ChunksRow extends Record<string, unknown> {
  id: string;
  version: number;
  name: string;
  piece_length: unknown;
  piece_count: unknown;
  total_length: unknown;
  pieces: unknown;
  files: ChunkFileEntry[];
  file_index: unknown;
  file_path: string;
  file_offset: unknown;
  file_length: unknown;
  mime: string;
  resolved_at: unknown;
}

export function toMagnetIndex(row: MagnetRow): MagnetIndexRecord {
  return {
    version: num(row.version),
    id: row.id,
    magnet: row.magnet,
    infoHash: row.id,
    name: row.name,
    trackers: row.trackers,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    peerCount: num(row.peer_count),
  };
}

export function toPeersRecord(row: PeersRow): PeersRecord {
  return {
    version: num(row.version),
    infoHash: row.id,
    resolvedAt: num(row.resolved_at),
    count: num(row.peer_count),
    peers: row.peers,
    webseeds: row.webseeds,
  };
}

export function toChunksRecord(row: ChunksRow): ChunksRecord {
  return {
    version: num(row.version),
    infoHash: row.id,
    name: row.name,
    pieceLength: num(row.piece_length),
    pieceCount: num(row.piece_count),
    totalLength: num(row.total_length),
    pieces: bytes(row.pieces),
    files: row.files,
    fileIndex: num(row.file_index),
    filePath: row.file_path,
    fileOffset: num(row.file_offset),
    fileLength: num(row.file_length),
    mime: row.mime,
    resolvedAt: num(row.resolved_at),
  };
}
