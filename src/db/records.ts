/**
 * The records sl-stream reads, and the rules that keep them readable.
 *
 * `peer_records` and `chunk_records` are sl-stream's contract; both are point-read by id, never
 * scanned. `magnets` is ours — it holds the magnet an id was first resolved from, which is what
 * lets `/refresh` take an id and nothing else.
 *
 * **sl-stream's `validateLayout` is strict.** `pieceCount` must equal
 * `ceil(totalLength / pieceLength)` exactly or every request for the id becomes a 500. And the
 * torrent length is read from the alias list `totalLength|length|size|totalSize`, so a top-level
 * `length` field meaning the *file* length would be silently misread as the whole torrent. There
 * is no `length` key here, deliberately. Both rules are now also enforced by the database: see the
 * `chunk_records_geometry` constraint in `sql/001_init.sql`.
 *
 * What used to be the other half of this file is gone. Deno KV capped a value at 64 KiB, so
 * `buildChunksRecord` shrank the record in defined steps — piece hashes to a `chunkhashes` overflow
 * namespace first, then the file list — and callers had to report which rung had fired. Postgres
 * stores the hashes in a `bytea` that TOASTs without being asked, so the record is always complete
 * and `pieces` and `files` are required rather than optional.
 */

import { config, RECORD_VERSION } from "../config.ts";
import type { DiscoveredPeer } from "../discovery/queue.ts";
import type { TorrentInfo } from "../meta/info.ts";
import { type FileSelection, mimeForPath } from "../select.ts";

/**
 * sl-stream's per-peer liveness, keyed by `host:port` for BitTorrent peers and by hostname for
 * webseeds. Written by sl-stream, read here so a refresh does not hand back peers it has already
 * banned.
 *
 * KV held one map per id, which made two concurrent bans in sl-stream a read-modify-write race
 * that lost one of them. It is a row per peer now, so the "which peers are banned" question is a
 * `where banned_until > $2` clause in `readBannedPeers` rather than a filter over a whole map —
 * which is why the old `bannedPeerKeys` helper no longer exists.
 */
export interface PeerHealthEntry {
  readonly peerKey: string;
  readonly bannedUntil: number | null;
  readonly ok: number;
  readonly fails: number;
}

export interface MagnetIndexRecord {
  readonly version: number;
  readonly id: string;
  readonly magnet: string;
  readonly infoHash: string;
  readonly name: string;
  readonly trackers: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly peerCount: number;
}

export interface PeerRecordEntry {
  readonly ip: string;
  readonly port: number;
  readonly source: string;
  /** True when a BitTorrent handshake with this peer completed during the resolve. */
  readonly verified: boolean;
}

/**
 * One entry of the `peers` array: either a BitTorrent endpoint or a webseed URL.
 *
 * sl-stream classifies these structurally (`sl-stream/src/kv/adapter.ts:118`) — a string containing
 * `://` is a webseed, an `{ip, port}` object with no path is a socket to dial — so a single array
 * feeds both of its transports. Webseeds must live *in here*, not in a sibling field: `adaptPeers`
 * only ever reads the `peers` array, so anything outside it is invisible to the reader.
 */
export type PeerRecordItem = PeerRecordEntry | string;

/** Narrow a stored entry to a BitTorrent endpoint. Strings in this array are webseed URLs. */
export function isBtEntry(item: PeerRecordItem): item is PeerRecordEntry {
  return typeof item === "object" && item !== null && typeof (item as PeerRecordEntry).ip ===
      "string";
}

export interface PeersRecord {
  readonly version: number;
  readonly infoHash: string;
  readonly resolvedAt: number;
  /** BitTorrent endpoints only; `peers` also carries the webseeds. */
  readonly count: number;
  readonly peers: PeerRecordItem[];
  /** BEP-19 webseeds from the magnet's `ws=`, repeated here for ma-stream's own use. */
  readonly webseeds: string[];
}

export interface ChunkFileEntry {
  readonly path: string;
  readonly length: number;
  readonly offset: number;
  /** BEP-47 alignment padding. Present only when true, so the common entry stays three fields. */
  readonly padding?: boolean;
  /** Content type when this file is one sl-stream can serve; absent for everything else. */
  readonly mime?: string;
}

export interface ChunksRecord {
  readonly version: number;
  readonly infoHash: string;
  readonly name: string;
  readonly pieceLength: number;
  readonly pieceCount: number;
  /** Whole torrent payload across every file. Never named `length`; see the file header. */
  readonly totalLength: number;
  /** `pieceCount * 20` raw bytes. Required: `parseInfo` guarantees it and `pieces` is `not null`. */
  readonly pieces: Uint8Array;
  /** Positional — the index into this array is sl-stream's `?file=`. Padding entries included. */
  readonly files: ChunkFileEntry[];
  readonly fileIndex: number;
  /** Path of the selected file inside the torrent. Kept even when `files` is dropped for size. */
  readonly filePath: string;
  readonly fileOffset: number;
  readonly fileLength: number;
  readonly mime: string;
  readonly resolvedAt: number;
}

export function buildPeersRecord(
  infoHashHex: string,
  peers: readonly DiscoveredPeer[],
  webseeds: readonly string[],
  now: number,
  maxPeers: number = config.maxPeers,
): PeersRecord {
  const capped: PeerRecordEntry[] = peers.slice(0, maxPeers).map((peer) => ({
    ip: peer.ip,
    port: peer.port,
    source: peer.source,
    verified: peer.verified,
  }));
  return {
    version: RECORD_VERSION,
    infoHash: infoHashHex,
    resolvedAt: now,
    count: capped.length,
    // Webseeds lead. They are HTTP range endpoints for the file itself, so they serve bytes from
    // the first request while the swarm is still handshaking — and they keep working at all on a
    // platform that turns out to forbid outbound TCP.
    peers: [...webseeds, ...capped],
    webseeds: [...webseeds],
  };
}

/**
 * Build the chunk record.
 *
 * This used to shrink in defined steps to fit a 64 KiB KV value — piece hashes offloaded to a
 * `chunkhashes` namespace first, the file list dropped second — and the ordering between those two
 * was load-bearing: `?file=` addresses a file by its position in the list, so losing the list took
 * every file except the default out of reach, a worse outcome than losing verification. Postgres
 * has no per-value ceiling, so nothing is dropped at any size and that ordering no longer has to
 * be argued about. The largest record this can produce is a 120 000-piece torrent's 2.4 MB of
 * hashes, which is an ordinary TOASTed column.
 */
export function buildChunksRecord(
  infoHashHex: string,
  info: TorrentInfo,
  selection: FileSelection,
  now: number,
): ChunksRecord {
  const files: ChunkFileEntry[] = info.files.map((file) => {
    const mime = mimeForPath(file.path);
    return {
      path: file.path,
      length: file.length,
      offset: file.offset,
      ...(file.padding ? { padding: true } : {}),
      ...(mime ? { mime } : {}),
    };
  });

  return {
    version: RECORD_VERSION,
    infoHash: infoHashHex,
    name: info.name,
    pieceLength: info.pieceLength,
    pieceCount: info.pieceCount,
    totalLength: info.totalLength,
    pieces: info.pieceHashes,
    files,
    fileIndex: selection.index,
    filePath: selection.path,
    fileOffset: selection.offset,
    fileLength: selection.length,
    mime: selection.mime,
    resolvedAt: now,
  };
}
