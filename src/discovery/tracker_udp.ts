/**
 * BEP-15 UDP tracker announce.
 *
 * Every correctness fix here is a bug the PoC ships:
 *
 *  - It sends **20 zero bytes as the peer id** — `peerId as unknown as Uint8Array` followed by
 *    `.set()` on a string coerces every character to `NaN`, which writes 0. Some trackers reject
 *    that outright.
 *  - It generates transaction ids and never compares them to the response, so any packet arriving
 *    on the socket is accepted as the answer.
 *  - Its announce parser never checks `action`, so an `action=3` error packet is parsed as a peer
 *    list and yields garbage addresses.
 *  - It announces `left=0`, i.e. "I am a seeder", which makes many trackers return few peers.
 *
 * Retries are two attempts at 2s and 4s rather than the spec's 15·2ⁿ backoff, which would blow the
 * resolve deadline on the first retry.
 */

import { log } from "../log.ts";
import type { PeerHint } from "../magnet.ts";
import { parseCompactPeers4 } from "../net/compact.ts";
import { UdpError, UdpSocket } from "../net/udp.ts";

const PROTOCOL_ID = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const ACTION_ERROR = 3;

const CONNECT_RESPONSE_BYTES = 16;
const ANNOUNCE_HEADER_BYTES = 20;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function randomTransactionId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

/** Matches a reply carrying this transaction id at the canonical offset. */
function matchesTransaction(transactionId: number, minBytes: number) {
  return (data: Uint8Array): boolean => {
    if (data.length < minBytes) return false;
    return view(data).getUint32(4) === transactionId;
  };
}

function buildConnect(transactionId: number): Uint8Array {
  const out = new Uint8Array(16);
  const dv = view(out);
  dv.setBigUint64(0, PROTOCOL_ID);
  dv.setUint32(8, ACTION_CONNECT);
  dv.setUint32(12, transactionId);
  return out;
}

function buildAnnounce(
  connectionId: bigint,
  transactionId: number,
  infoHash: Uint8Array,
  peerId: Uint8Array,
  port: number,
): Uint8Array {
  const out = new Uint8Array(98);
  const dv = view(out);
  let offset = 0;

  dv.setBigUint64(offset, connectionId);
  offset += 8;
  dv.setUint32(offset, ACTION_ANNOUNCE);
  offset += 4;
  dv.setUint32(offset, transactionId);
  offset += 4;

  out.set(infoHash, offset);
  offset += 20;
  out.set(peerId, offset);
  offset += 20;

  dv.setBigUint64(offset, 0n); // downloaded
  offset += 8;
  // "left" unknown, and deliberately not zero: announcing as a seeder gets us fewer peers back.
  dv.setBigUint64(offset, 0xffffffffffffffffn);
  offset += 8;
  dv.setBigUint64(offset, 0n); // uploaded
  offset += 8;

  dv.setUint32(offset, 2); // event: started
  offset += 4;
  dv.setUint32(offset, 0); // IP: let the tracker use the source address
  offset += 4;
  dv.setUint32(offset, randomTransactionId()); // key
  offset += 4;
  dv.setInt32(offset, -1); // num_want: as many as you have
  offset += 4;
  dv.setUint16(offset, port);
  return out;
}

/** Decodes an `action=3` error packet so a tracker refusal is logged, not parsed as peers. */
function errorMessage(data: Uint8Array): string {
  return new TextDecoder().decode(data.subarray(8)).slice(0, 200);
}

async function announceOne(
  socket: UdpSocket,
  trackerUrl: string,
  infoHash: Uint8Array,
  peerId: Uint8Array,
  listenPort: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PeerHint[]> {
  const url = new URL(trackerUrl);
  const hostname = url.hostname;
  const port = url.port ? Number(url.port) : 6969;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return [];

  const connectId = randomTransactionId();
  await socket.send(buildConnect(connectId), hostname, port);
  const connectReply = await socket.receive(
    matchesTransaction(connectId, CONNECT_RESPONSE_BYTES),
    timeoutMs,
    signal,
  );

  const connectView = view(connectReply.data);
  const connectAction = connectView.getUint32(0);
  if (connectAction === ACTION_ERROR) {
    throw new UdpError(`tracker error: ${errorMessage(connectReply.data)}`);
  }
  if (connectAction !== ACTION_CONNECT) {
    throw new UdpError(`unexpected connect action ${connectAction}`);
  }
  const connectionId = connectView.getBigUint64(8);

  const announceId = randomTransactionId();
  await socket.send(
    buildAnnounce(connectionId, announceId, infoHash, peerId, listenPort),
    hostname,
    port,
  );
  const announceReply = await socket.receive(
    matchesTransaction(announceId, ANNOUNCE_HEADER_BYTES),
    timeoutMs,
    signal,
  );

  const announceView = view(announceReply.data);
  const announceAction = announceView.getUint32(0);
  if (announceAction === ACTION_ERROR) {
    throw new UdpError(`tracker error: ${errorMessage(announceReply.data)}`);
  }
  if (announceAction !== ACTION_ANNOUNCE) {
    throw new UdpError(`unexpected announce action ${announceAction}`);
  }

  return parseCompactPeers4(announceReply.data.subarray(ANNOUNCE_HEADER_BYTES));
}

export interface UdpAnnounceOptions {
  readonly socket: UdpSocket;
  readonly trackers: readonly string[];
  readonly infoHash: Uint8Array;
  readonly peerId: Uint8Array;
  readonly listenPort: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly onPeers: (peers: PeerHint[], tracker: string) => void;
}

/** Announces to every `udp://` tracker in parallel, emitting peers as each one replies. */
export async function announceUdpTrackers(options: UdpAnnounceOptions): Promise<void> {
  const trackers = options.trackers.filter((tracker) => tracker.startsWith("udp://"));
  if (trackers.length === 0) return;

  await Promise.allSettled(trackers.map(async (tracker) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (options.signal.aborted) return;
      try {
        const peers = await announceOne(
          options.socket,
          tracker,
          options.infoHash,
          options.peerId,
          options.listenPort,
          options.timeoutMs * (attempt + 1),
          options.signal,
        );
        if (peers.length > 0) options.onPeers(peers, tracker);
        log.debug("tracker.udp_ok", { tracker, peers: peers.length });
        return;
      } catch (err) {
        log.debug("tracker.udp_failed", { tracker, attempt, msg: String(err) });
      }
    }
  }));
}
