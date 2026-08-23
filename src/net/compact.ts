/**
 * Compact peer and node encodings, shared by trackers, PEX and the DHT.
 *
 * Every parser here tolerates a trailing partial entry rather than throwing: a truncated tracker
 * response should cost us the last peer, not the whole announce.
 */

import type { PeerHint } from "../magnet.ts";

export const COMPACT_PEER4_BYTES = 6;
export const COMPACT_PEER6_BYTES = 18;
export const COMPACT_NODE4_BYTES = 26;

function readPort(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

export function formatIPv6(bytes: Uint8Array, offset: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((bytes[offset + i]! << 8) | bytes[offset + i + 1]!) >>> 0).toString(16));
  }
  return groups.join(":");
}

export function parseCompactPeers4(bytes: Uint8Array): PeerHint[] {
  const out: PeerHint[] = [];
  for (let i = 0; i + COMPACT_PEER4_BYTES <= bytes.length; i += COMPACT_PEER4_BYTES) {
    const ip = `${bytes[i]}.${bytes[i + 1]}.${bytes[i + 2]}.${bytes[i + 3]}`;
    out.push({ ip, port: readPort(bytes, i + 4) });
  }
  return out;
}

export function parseCompactPeers6(bytes: Uint8Array): PeerHint[] {
  const out: PeerHint[] = [];
  for (let i = 0; i + COMPACT_PEER6_BYTES <= bytes.length; i += COMPACT_PEER6_BYTES) {
    out.push({ ip: formatIPv6(bytes, i), port: readPort(bytes, i + 16) });
  }
  return out;
}

export interface CompactNode {
  readonly id: Uint8Array;
  readonly ip: string;
  readonly port: number;
}

/** DHT `nodes`: 20-byte node id followed by a 6-byte compact IPv4 endpoint. */
export function parseCompactNodes(bytes: Uint8Array): CompactNode[] {
  const out: CompactNode[] = [];
  for (let i = 0; i + COMPACT_NODE4_BYTES <= bytes.length; i += COMPACT_NODE4_BYTES) {
    out.push({
      id: bytes.subarray(i, i + 20),
      ip: `${bytes[i + 20]}.${bytes[i + 21]}.${bytes[i + 22]}.${bytes[i + 23]}`,
      port: readPort(bytes, i + 24),
    });
  }
  return out;
}
