/**
 * The channel every discovery source writes into and the dial pool reads from.
 *
 * Making this a live channel rather than a list is the whole latency argument. The PoC awaits
 * every tracker, then starts dialling, so the slowest dead tracker in the magnet sets the floor on
 * time-to-first-peer. Here a peer from the fastest source is dialled while the DHT is still
 * walking, and PEX feeds discoveries back in from connections that are already open.
 *
 * Dedupe is on the `ip:port` string. The PoC uses `new Set<{ip, port}>` of freshly allocated
 * objects, which dedupes object identity and therefore nothing at all.
 */

import type { PeerHint } from "../magnet.ts";
import { isRoutable, isUsablePort } from "../net/addr.ts";

export type PeerSource = "magnet" | "udp" | "http" | "dht" | "pex";

export interface DiscoveredPeer {
  readonly ip: string;
  readonly port: number;
  readonly source: PeerSource;
  /** True once a BitTorrent handshake with this peer completed: proof it is real and live. */
  verified: boolean;
}

export function peerKey(hint: PeerHint): string {
  return `${hint.ip}:${hint.port}`;
}

export interface PeerQueueOptions {
  /** Accept non-routable addresses. Only for LAN swarms; see `config.allowPrivatePeers`. */
  readonly allowPrivate?: boolean;
}

export class PeerQueue {
  readonly #peers = new Map<string, DiscoveredPeer>();
  readonly #pending: DiscoveredPeer[] = [];
  readonly #allowPrivate: boolean;
  #waiter: ((value: IteratorResult<DiscoveredPeer>) => void) | null = null;
  #closed = false;

  constructor(private readonly maxPeers: number, options: PeerQueueOptions = {}) {
    this.#allowPrivate = options.allowPrivate ?? false;
  }

  get size(): number {
    return this.#peers.size;
  }

  get verifiedCount(): number {
    let count = 0;
    for (const peer of this.#peers.values()) {
      if (peer.verified) count++;
    }
    return count;
  }

  /** Returns true when this is a new, usable, routable peer. */
  add(hint: PeerHint, source: PeerSource): boolean {
    if (this.#closed) return false;
    if (!isUsablePort(hint.port)) return false;
    if (!this.#allowPrivate && !isRoutable(hint.ip)) return false;
    const key = peerKey(hint);
    if (this.#peers.has(key)) return false;
    // The cap bounds memory and the eventual KV record; sources keep running, they just stop
    // contributing once we have plenty.
    if (this.#peers.size >= this.maxPeers) return false;

    const peer: DiscoveredPeer = { ip: hint.ip, port: hint.port, source, verified: false };
    this.#peers.set(key, peer);

    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter({ value: peer, done: false });
    } else {
      this.#pending.push(peer);
    }
    return true;
  }

  addMany(hints: readonly PeerHint[], source: PeerSource): number {
    let added = 0;
    for (const hint of hints) {
      if (this.add(hint, source)) added++;
    }
    return added;
  }

  markVerified(key: string): void {
    const peer = this.#peers.get(key);
    if (peer) peer.verified = true;
  }

  /** Everything found so far, peers that completed a handshake first. */
  snapshot(): DiscoveredPeer[] {
    const all = [...this.#peers.values()];
    all.sort((a, b) => Number(b.verified) - Number(a.verified));
    return all;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<DiscoveredPeer> {
    while (true) {
      const buffered = this.#pending.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<DiscoveredPeer>>((resolve) => {
        this.#waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
