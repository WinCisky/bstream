/**
 * Magnet URI parsing.
 *
 * Beyond the infohash, three parameters matter and the PoC parser ignores all of them:
 * `x.pe` peer hints cost zero round trips, `ws` webseeds are the only thing sl-stream can fetch
 * from as-is, and `tr` needs validating before a malformed entry reaches `new URL` inside a
 * tracker client.
 */

import { fromBase32, fromHex, toHex } from "./bytes.ts";

export class MagnetError extends Error {
  override readonly name = "MagnetError";
}

export interface PeerHint {
  readonly ip: string;
  readonly port: number;
}

export interface ParsedMagnet {
  /** 20-byte v1 infohash. */
  readonly infoHash: Uint8Array;
  /** Lowercase 40-char hex. This is the `id` everything downstream is keyed by. */
  readonly infoHashHex: string;
  readonly displayName: string | null;
  readonly trackers: string[];
  readonly webseeds: string[];
  readonly peerHints: PeerHint[];
}

/** Trackers and webseeds are attacker-influenced list lengths; both get a hard cap. */
const MAX_TRACKERS = 64;
const MAX_WEBSEEDS = 16;
const MAX_PEER_HINTS = 32;

function parseInfoHash(params: URLSearchParams): Uint8Array {
  const topics = params.getAll("xt");
  if (topics.length === 0) throw new MagnetError("magnet has no xt parameter");

  for (const topic of topics) {
    const trimmed = topic.trim();
    if (!/^urn:btih:/i.test(trimmed)) continue;
    const raw = trimmed.slice("urn:btih:".length);
    const bytes = raw.length === 40 ? fromHex(raw) : raw.length === 32 ? fromBase32(raw) : null;
    if (!bytes || bytes.length !== 20) {
      throw new MagnetError(`xt is not a valid btih infohash: "${raw}"`);
    }
    return bytes;
  }

  if (topics.some((topic) => /^urn:btmh:/i.test(topic.trim()))) {
    // A v2 torrent has a different piece layout (merkle trees, per-file piece alignment), which
    // the chunk record model cannot express. Better a clear 4xx than a wrong byte offset.
    throw new MagnetError("BitTorrent v2 magnets (urn:btmh) are not supported");
  }
  throw new MagnetError("magnet has no urn:btih topic");
}

function parseTrackers(params: URLSearchParams): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of params.getAll("tr")) {
    if (out.length >= MAX_TRACKERS) break;
    const text = raw.trim();
    if (text.length === 0) continue;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      continue;
    }
    if (!["udp:", "http:", "https:"].includes(url.protocol)) continue;
    if (url.hostname.length === 0) continue;
    const normalised = url.href;
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(normalised);
  }
  return out;
}

function parseWebseeds(params: URLSearchParams): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // `ws` is BEP-19 proper; `as` ("acceptable source") is the older sibling and carries the same
  // thing often enough to be worth reading.
  for (const raw of [...params.getAll("ws"), ...params.getAll("as")]) {
    if (out.length >= MAX_WEBSEEDS) break;
    const text = raw.trim();
    if (text.length === 0) continue;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(url.href);
  }
  return out;
}

/** `x.pe=1.2.3.4:6881` or `x.pe=[2001:db8::1]:6881`. */
export function parseEndpoint(text: string): PeerHint | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  let host: string;
  let portText: string;
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close === -1 || trimmed[close + 1] !== ":") return null;
    host = trimmed.slice(1, close);
    portText = trimmed.slice(close + 2);
  } else {
    const colon = trimmed.lastIndexOf(":");
    if (colon <= 0) return null;
    host = trimmed.slice(0, colon);
    portText = trimmed.slice(colon + 1);
  }

  if (host.length === 0 || !/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { ip: host, port };
}

function parsePeerHints(params: URLSearchParams): PeerHint[] {
  const out: PeerHint[] = [];
  const seen = new Set<string>();
  for (const raw of params.getAll("x.pe")) {
    if (out.length >= MAX_PEER_HINTS) break;
    const hint = parseEndpoint(raw);
    if (!hint) continue;
    const key = `${hint.ip}:${hint.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hint);
  }
  return out;
}

export function parseMagnet(uri: string): ParsedMagnet {
  const trimmed = uri.trim();
  if (!/^magnet:/i.test(trimmed)) throw new MagnetError("not a magnet URI");
  // The magnet is stored verbatim so `/refresh` can re-derive trackers from it, and Postgres
  // `text` cannot hold a NUL byte. Rejecting here keeps it a 400 about the caller's input rather
  // than a 500 from the driver.
  if (trimmed.includes("\u0000")) throw new MagnetError("magnet URI contains a NUL byte");

  let params: URLSearchParams;
  try {
    params = new URL(trimmed).searchParams;
  } catch {
    throw new MagnetError("magnet URI is not parseable");
  }

  const infoHash = parseInfoHash(params);
  const displayName = params.get("dn");
  return {
    infoHash,
    infoHashHex: toHex(infoHash),
    displayName: displayName && displayName.trim().length > 0 ? displayName.trim() : null,
    trackers: parseTrackers(params),
    webseeds: parseWebseeds(params),
    peerHints: parsePeerHints(params),
  };
}
