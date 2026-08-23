/**
 * BEP-5 DHT `get_peers`, built from scratch — neither sibling project has any DHT code, only a
 * `skipDht` flag wired permanently to true.
 *
 * This is the source that decides whether magnet-only resolution actually works. A magnet's
 * tracker list ages badly (the PoC's own sample magnet lists rarbg, coppersurfer and
 * leechers-paradise, all long dead), so a tracker-only client is unreliable by construction while
 * the DHT keeps working as long as the swarm does.
 *
 * The walk is the standard iterative one: keep the closest nodes seen to the infohash by XOR
 * distance, query ALPHA of them at a time, emit peers the moment a `values` reply arrives rather
 * than at the end, and stop on the first of budget exhausted, node cap reached, or no closer nodes
 * left to ask.
 */

import { asBytes, asDict, asList, asText, decode } from "../bencode/decode.ts";
import { encode } from "../bencode/encode.ts";
import { log } from "../log.ts";
import type { PeerHint } from "../magnet.ts";
import { isRoutable, isUsablePort } from "../net/addr.ts";
import { parseCompactNodes, parseCompactPeers4 } from "../net/compact.ts";
import type { UdpSocket } from "../net/udp.ts";
import { toHex } from "../bytes.ts";

interface BootstrapNode {
  readonly host: string;
  readonly port: number;
}

const BOOTSTRAP: readonly BootstrapNode[] = [
  { host: "router.bittorrent.com", port: 6881 },
  { host: "dht.transmissionbt.com", port: 6881 },
  { host: "router.utorrent.com", port: 6881 },
  { host: "dht.libtorrent.org", port: 25401 },
];

/** Nodes queried per round. The BEP-5 convention. */
const ALPHA = 8;
const QUERY_TIMEOUT_MS = 2_000;
/** Bound on the working set, independent of the node-query cap. */
const MAX_SHORTLIST = 512;

interface Candidate {
  readonly host: string;
  readonly port: number;
  /** XOR distance to the infohash; bootstrap nodes have no id and sort last. */
  readonly distance: Uint8Array;
}

const FARTHEST = new Uint8Array(20).fill(0xff);

function xorDistance(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

function compareDistance(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 20; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

export function generateNodeId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(20));
}

function buildGetPeers(
  transactionId: Uint8Array,
  nodeId: Uint8Array,
  infoHash: Uint8Array,
): Uint8Array {
  return encode({
    t: transactionId,
    y: "q",
    q: "get_peers",
    a: { id: nodeId, info_hash: infoHash },
  });
}

/** KRPC replies are correlated by the opaque `t` echoed back from the query. */
function matchesTransaction(transactionId: Uint8Array) {
  const wanted = toHex(transactionId);
  return (data: Uint8Array): boolean => {
    const dict = asDict(decode(data));
    if (!dict) return false;
    const echoed = asBytes(dict["t"]);
    return echoed !== null && toHex(echoed) === wanted;
  };
}

export interface DhtOptions {
  readonly socket: UdpSocket;
  readonly infoHash: Uint8Array;
  readonly nodeId: Uint8Array;
  readonly budgetMs: number;
  readonly maxNodes: number;
  readonly signal: AbortSignal;
  readonly onPeers: (peers: PeerHint[]) => void;
  /** Called when enough peers have been found that the walk can stop early. */
  readonly shouldStop?: () => boolean;
}

export async function findPeersViaDht(options: DhtOptions): Promise<void> {
  const deadline = Date.now() + options.budgetMs;
  const shortlist: Candidate[] = BOOTSTRAP.map((node) => ({
    host: node.host,
    port: node.port,
    distance: FARTHEST,
  }));
  const queried = new Set<string>();
  let queryCount = 0;
  let peerCount = 0;

  const query = async (candidate: Candidate): Promise<void> => {
    const transactionId = crypto.getRandomValues(new Uint8Array(2));
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;

    await options.socket.send(
      buildGetPeers(transactionId, options.nodeId, options.infoHash),
      candidate.host,
      candidate.port,
    );
    const reply = await options.socket.receive(
      matchesTransaction(transactionId),
      Math.min(QUERY_TIMEOUT_MS, remaining),
      options.signal,
    );

    const message = asDict(decode(reply.data));
    if (!message) return;
    if (asText(message["y"]) === "e") {
      log.debug("dht.error_reply", { host: candidate.host });
      return;
    }
    const response = asDict(message["r"]);
    if (!response) return;

    // `values` is the answer: a list of compact peer entries for this infohash.
    const values = asList(response["values"]);
    if (values) {
      const peers: PeerHint[] = [];
      for (const entry of values) {
        const bytes = asBytes(entry);
        if (bytes) peers.push(...parseCompactPeers4(bytes));
      }
      if (peers.length > 0) {
        peerCount += peers.length;
        options.onPeers(peers);
      }
    }

    // `nodes` is the referral: closer nodes to ask next.
    const nodes = asBytes(response["nodes"]);
    if (!nodes) return;
    for (const node of parseCompactNodes(nodes)) {
      if (shortlist.length >= MAX_SHORTLIST) break;
      if (!isRoutable(node.ip) || !isUsablePort(node.port)) continue;
      const key = `${node.ip}:${node.port}`;
      if (queried.has(key)) continue;
      if (shortlist.some((entry) => `${entry.host}:${entry.port}` === key)) continue;
      shortlist.push({
        host: node.ip,
        port: node.port,
        distance: xorDistance(node.id, options.infoHash),
      });
    }
  };

  while (Date.now() < deadline && queryCount < options.maxNodes && !options.signal.aborted) {
    if (options.shouldStop?.()) break;

    shortlist.sort((a, b) => compareDistance(a.distance, b.distance));
    const batch: Candidate[] = [];
    for (const candidate of shortlist) {
      if (batch.length >= ALPHA) break;
      const key = `${candidate.host}:${candidate.port}`;
      if (queried.has(key)) continue;
      queried.add(key);
      batch.push(candidate);
    }
    if (batch.length === 0) break;
    queryCount += batch.length;

    // allSettled, not all: a dead node in the batch must not abort the round.
    await Promise.allSettled(batch.map(query));
  }

  log.debug("dht.finished", { queried: queryCount, peers: peerCount });
}
