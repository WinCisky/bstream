/**
 * Turn a verified info dict into the layout the chunk record is built from.
 *
 * The one invariant everything downstream rests on is
 * `pieceCount === ceil(totalLength / pieceLength) === pieces.length / 20`. sl-stream re-derives it
 * in `validateLayout` and returns a 500 on every request for the id if it disagrees, so a torrent
 * whose own numbers do not add up is rejected here instead of being written and failing later.
 *
 * BEP-47 padding files are the subtle part: they are not real content, but they *do* occupy byte
 * ranges in the torrent. Dropping them would shift every subsequent file's offset and silently
 * corrupt playback, so they are kept in the layout and excluded only from selection.
 */

import {
  asBytes,
  asDict,
  asInt,
  asList,
  asText,
  type BencodeDict,
  decode,
} from "../bencode/decode.ts";
import { toText } from "../bytes.ts";

export class InfoError extends Error {
  override readonly name = "InfoError";
}

export interface TorrentFile {
  readonly path: string;
  readonly length: number;
  /** Byte offset of this file within the torrent payload. */
  readonly offset: number;
  readonly padding: boolean;
}

export interface TorrentInfo {
  readonly name: string;
  readonly pieceLength: number;
  readonly pieceCount: number;
  /** Concatenated 20-byte SHA-1 digests, `pieceCount * 20` bytes. */
  readonly pieceHashes: Uint8Array;
  /** Total payload across every file, padding included. */
  readonly totalLength: number;
  readonly files: TorrentFile[];
}

const PIECE_HASH_SIZE = 20;
/** A torrent with more files than this is not a video release; refuse rather than churn. */
const MAX_FILES = 20_000;

function requireLength(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InfoError(`${what} is not a valid length`);
  }
  return value;
}

/** Join a `path` list into a safe relative path. Traversal components are a hard reject. */
function joinPath(components: Uint8Array[]): string {
  const parts: string[] = [];
  for (const component of components) {
    const text = toText(component);
    if (text.length === 0 || text === "." || text === "..") {
      throw new InfoError(`unsafe path component "${text}"`);
    }
    if (text.includes("/") || text.includes("\\") || text.includes("\0")) {
      throw new InfoError(`illegal character in path component "${text}"`);
    }
    parts.push(text);
  }
  if (parts.length === 0) throw new InfoError("file has an empty path");
  return parts.join("/");
}

function pathComponents(entry: BencodeDict): Uint8Array[] {
  // `path.utf-8` is the sanitised variant some clients add alongside a legacy-encoded `path`.
  const raw = asList(entry["path.utf-8"]) ?? asList(entry["path"]);
  if (!raw) throw new InfoError("file entry has no path");
  const out: Uint8Array[] = [];
  for (const component of raw) {
    const bytes = asBytes(component);
    if (!bytes) throw new InfoError("path component is not a string");
    out.push(bytes);
  }
  return out;
}

/**
 * BEP-47 marks padding with `attr` containing `p`. Older clients that predate the attribute use a
 * naming convention instead, so both are checked.
 */
function isPadding(entry: BencodeDict, path: string): boolean {
  const attr = asBytes(entry["attr"]);
  if (attr && toText(attr).includes("p")) return true;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return path.startsWith(".pad/") || path.includes("/.pad/") || last.startsWith("_____padding");
}

export function parseInfo(bytes: Uint8Array): TorrentInfo {
  const info = asDict(decode(bytes));
  if (!info) throw new InfoError("info dict is not a dict");

  const name = asText(info["name.utf-8"]) ?? asText(info["name"]) ?? "unknown";
  // A NUL is legal in a JavaScript string and was legal in a Deno KV value; Postgres `text` and
  // `jsonb` both refuse it outright. This name reaches a column directly, and for a single-file
  // torrent it also becomes the file path, so a hostile one would turn a resolve into an
  // unhandled driver error rather than the 422 a malformed torrent deserves. `joinPath` already
  // rejects the same byte in multi-file path components.
  if (name.includes("\u0000")) throw new InfoError("torrent name contains a NUL byte");
  const pieceLength = asInt(info["piece length"]);
  if (pieceLength === null || pieceLength <= 0) throw new InfoError("missing piece length");

  const pieceHashes = asBytes(info["pieces"]);
  if (!pieceHashes) throw new InfoError("missing pieces");
  if (pieceHashes.length === 0 || pieceHashes.length % PIECE_HASH_SIZE !== 0) {
    throw new InfoError(`pieces is ${pieceHashes.length} bytes, not a multiple of 20`);
  }

  const files: TorrentFile[] = [];
  const fileList = asList(info["files"]);
  if (fileList) {
    if (fileList.length > MAX_FILES) throw new InfoError(`${fileList.length} files is too many`);
    let cursor = 0;
    for (const raw of fileList) {
      const entry = asDict(raw);
      if (!entry) throw new InfoError("file entry is not a dict");
      const length = requireLength(asInt(entry["length"]), "file length");
      const path = joinPath(pathComponents(entry));
      files.push({ path, length, offset: cursor, padding: isPadding(entry, path) });
      cursor += length;
    }
  } else {
    // Single-file torrent: `name` is the file, not a directory.
    const length = requireLength(asInt(info["length"]), "torrent length");
    files.push({ path: name, length, offset: 0, padding: false });
  }
  if (files.length === 0) throw new InfoError("torrent has no files");

  let totalLength = 0;
  for (const file of files) totalLength += file.length;
  if (totalLength <= 0) throw new InfoError("torrent payload is empty");
  if (!Number.isSafeInteger(totalLength)) throw new InfoError("torrent payload is too large");

  const pieceCount = pieceHashes.length / PIECE_HASH_SIZE;
  const expected = Math.ceil(totalLength / pieceLength);
  if (pieceCount !== expected) {
    throw new InfoError(
      `pieces carries ${pieceCount} hashes but ${totalLength} bytes at ${pieceLength} needs ` +
        `${expected}`,
    );
  }

  return { name, pieceLength, pieceCount, pieceHashes, totalLength, files };
}
