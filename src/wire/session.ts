/**
 * One peer, from TCP connect to close.
 *
 * A session does three jobs at once, which is why it is worth holding a connection open rather
 * than treating peers as one-shot metadata lookups like the PoC does:
 *
 *  1. Completing a handshake **proves the peer is live**, which is the only quality signal we can
 *     record about it. Tracker and DHT output is full of stale endpoints.
 *  2. It contributes whatever metadata pieces are still missing, to a buffer shared with every
 *     other session.
 *  3. It hands back more peers over PEX for free.
 *
 * BEP-10 detail that the PoC gets wrong and that silently breaks against strict peers: extended
 * message ids are **per-recipient**. Messages we send must use the id from the peer's handshake;
 * messages we receive arrive under the id *we* advertised. The PoC reads `extId` and then ignores
 * it, so it accepts a PEX message as though it were metadata.
 */

import { asDict, asInt, decodePrefix } from "../bencode/decode.ts";
import { encode } from "../bencode/encode.ts";
import { errFields, log } from "../log.ts";
import { parsePexMessage } from "../discovery/pex.ts";
import { type DiscoveredPeer, peerKey, type PeerQueue } from "../discovery/queue.ts";
import { METADATA_PIECE_BYTES, MetadataAssembler } from "../meta/assembler.ts";
import { WireConn } from "./conn.ts";
import { performHandshake } from "./handshake.ts";
import {
  extendedFrame,
  frame,
  MSG_EXTENDED,
  MSG_INTERESTED,
  readMessage,
  splitExtended,
} from "./messages.ts";

/** The extended ids we advertise, and therefore the ids incoming messages arrive under. */
const OUR_UT_METADATA_ID = 1;
const OUR_UT_PEX_ID = 2;

/** BEP-9 message types. */
const META_REQUEST = 0;
const META_DATA = 1;
const META_REJECT = 2;

/** Outstanding metadata requests per peer. The PoC asks for every piece at once. */
const MAX_OUTSTANDING = 4;

/** Once metadata is done, linger only briefly to collect a PEX message. */
const PEX_LINGER_MS = 1_500;

export interface SessionContext {
  readonly infoHash: Uint8Array;
  readonly peerId: Uint8Array;
  readonly assembler: MetadataAssembler;
  readonly queue: PeerQueue;
  readonly signal: AbortSignal;
  readonly connectTimeoutMs: number;
  readonly sessionTimeoutMs: number;
  readonly enablePex: boolean;
  /**
   * Whether to ask this peer for metadata at all.
   *
   * False during a peer refresh: the infohash already pins the metadata, so the only things worth
   * having from a peer are the handshake — which proves it is alive — and its PEX. Skipping BEP-9
   * is what makes a refresh seconds rather than a full resolve.
   */
  readonly wantMetadata: boolean;
  /** Every live socket, so an aborted resolve can tear all of them down at once. */
  readonly sockets: Set<WireConn>;
}

interface PeerCapabilities {
  utMetadataId: number | null;
  utPexId: number | null;
  metadataSize: number | null;
}

function buildExtendedHandshake(): Uint8Array {
  return encode({
    m: { ut_metadata: OUR_UT_METADATA_ID, ut_pex: OUR_UT_PEX_ID },
    v: "ma-stream/1",
    // Advertise a small request queue rather than leaving peers to guess.
    reqq: MAX_OUTSTANDING,
  });
}

function parseExtendedHandshake(body: Uint8Array): PeerCapabilities {
  const empty: PeerCapabilities = { utMetadataId: null, utPexId: null, metadataSize: null };
  let dict;
  try {
    dict = asDict(decodePrefix(body, 0).value);
  } catch {
    return empty;
  }
  if (!dict) return empty;
  const m = asDict(dict["m"]);
  const utMetadataId = m ? asInt(m["ut_metadata"]) : null;
  const utPexId = m ? asInt(m["ut_pex"]) : null;
  return {
    // A peer signals "I dropped this extension" with id 0, which is not a usable id.
    utMetadataId: utMetadataId && utMetadataId > 0 ? utMetadataId : null,
    utPexId: utPexId && utPexId > 0 ? utPexId : null,
    metadataSize: asInt(dict["metadata_size"]),
  };
}

/**
 * Runs one peer to completion. Never throws: a failed peer is the normal case, not an error, and
 * this is called from a detached dial pool where a rejection would surface as an unhandled one.
 */
export async function runSession(peer: DiscoveredPeer, ctx: SessionContext): Promise<void> {
  const key = peerKey(peer);
  if (ctx.assembler.isBanned(key)) return;

  const budget = AbortSignal.timeout(ctx.sessionTimeoutMs);
  const signal = AbortSignal.any([ctx.signal, budget]);

  let conn: WireConn | null = null;
  try {
    conn = await WireConn.connect(peer.ip, peer.port, signal, ctx.connectTimeoutMs);
    ctx.sockets.add(conn);

    const handshake = await performHandshake(conn, ctx.infoHash, ctx.peerId);
    // Reached only by a peer that answered with our infohash: it exists, it is up, and it is in
    // this swarm. That is the strongest statement we can make about any peer we record.
    ctx.queue.markVerified(key);

    if (!handshake.supportsExtended) return;

    await conn.write(extendedFrame(0, buildExtendedHandshake()));
    // Some peers withhold metadata until they see interest, so declare it before asking.
    await conn.write(frame(MSG_INTERESTED));

    await pump(conn, key, ctx, signal);
  } catch (err) {
    // Dead peers, refused connections and timeouts are the overwhelming majority of outcomes here.
    log.debug("session.failed", { peer: key, ...errFields(err) });
  } finally {
    if (conn) {
      ctx.sockets.delete(conn);
      conn.close();
    }
  }
}

async function pump(
  conn: WireConn,
  key: string,
  ctx: SessionContext,
  signal: AbortSignal,
): Promise<void> {
  const capabilities: PeerCapabilities = {
    utMetadataId: null,
    utPexId: null,
    metadataSize: null,
  };
  const requested = new Set<number>();
  let sawPex = false;
  let doneAt: number | null = null;

  /** Top the peer up to MAX_OUTSTANDING requests, skipping pieces already asked of it. */
  const refill = async (): Promise<void> => {
    if (!ctx.wantMetadata) return;
    if (capabilities.utMetadataId === null || ctx.assembler.done) return;
    for (const index of ctx.assembler.missing()) {
      if (requested.size >= MAX_OUTSTANDING) break;
      if (requested.has(index)) continue;
      requested.add(index);
      await conn.write(
        extendedFrame(
          capabilities.utMetadataId,
          encode({ msg_type: META_REQUEST, piece: index }),
        ),
      );
    }
  };

  // On a peers-only session there is nothing to fetch, so the objective is met the moment the
  // handshake lands. What is left is PEX, which costs nothing on a connection already open.
  const objectiveMet = () => !ctx.wantMetadata || ctx.assembler.done;
  let sawExtendedHandshake = false;

  while (!signal.aborted) {
    if (objectiveMet()) {
      doneAt ??= Date.now();
      // Do not conclude PEX is unavailable before the peer has told us what it speaks — on a
      // peers-only session that decision would otherwise be made against an empty capability set.
      const pexPossible = ctx.enablePex && !sawPex &&
        (!sawExtendedHandshake || capabilities.utPexId !== null);
      if (!pexPossible || Date.now() - doneAt > PEX_LINGER_MS) return;
    }

    const message = await readMessage(conn);
    if (message.id !== MSG_EXTENDED) continue;

    const extended = splitExtended(message.payload);
    if (!extended) continue;

    if (extended.extendedId === 0) {
      const parsed = parseExtendedHandshake(extended.body);
      sawExtendedHandshake = true;
      capabilities.utMetadataId = parsed.utMetadataId;
      capabilities.utPexId = parsed.utPexId;
      capabilities.metadataSize = parsed.metadataSize;

      if (
        ctx.wantMetadata && capabilities.utMetadataId !== null && parsed.metadataSize !== null &&
        !ctx.assembler.done
      ) {
        // A peer whose declared size contradicts the buffer in flight cannot contribute to it.
        if (ctx.assembler.declareSize(parsed.metadataSize, key)) await refill();
        else capabilities.utMetadataId = null;
      }
      continue;
    }

    if (extended.extendedId === OUR_UT_METADATA_ID) {
      await handleMetadata(extended.body, key, ctx, requested, refill);
      continue;
    }

    if (extended.extendedId === OUR_UT_PEX_ID && ctx.enablePex) {
      sawPex = true;
      const found = ctx.queue.addMany(parsePexMessage(extended.body), "pex");
      if (found > 0) log.debug("pex.peers", { peer: key, found });
      continue;
    }
  }
}

async function handleMetadata(
  body: Uint8Array,
  key: string,
  ctx: SessionContext,
  requested: Set<number>,
  refill: () => Promise<void>,
): Promise<void> {
  let header;
  let consumed: number;
  try {
    const decoded = decodePrefix(body, 0);
    header = asDict(decoded.value);
    consumed = decoded.consumed;
  } catch {
    return;
  }
  if (!header) return;

  const messageType = asInt(header["msg_type"]);
  const index = asInt(header["piece"]);
  if (index === null) return;

  if (messageType === META_REJECT) {
    // This peer will not serve that piece. Release it so another peer is asked for it.
    requested.delete(index);
    await refill();
    return;
  }
  if (messageType !== META_DATA) return;

  const data = body.subarray(consumed);
  if (data.length > METADATA_PIECE_BYTES) return;
  await ctx.assembler.offer(index, data, key);
  requested.delete(index);
  await refill();
}
