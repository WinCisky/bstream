/**
 * A local BitTorrent peer that speaks just enough of the protocol to serve metadata.
 *
 * It deliberately advertises `ut_metadata` under id **3**, not 1. BEP-10 ids are per-recipient:
 * what we send must use the id the peer advertised, what we receive arrives under the id we
 * advertised. A client that hardcodes 1 in either direction fails against this server, which is
 * exactly the bug the PoC carries.
 */

import { asDict, asInt, decodePrefix } from "../../src/bencode/decode.ts";
import { encode } from "../../src/bencode/encode.ts";
import { METADATA_PIECE_BYTES } from "../../src/meta/assembler.ts";

const OUR_UT_METADATA_ID = 3;
const HANDSHAKE_BYTES = 68;

export type PeerBehaviour =
  /** Serves every metadata piece correctly. */
  | { readonly kind: "honest" }
  /** Serves a different info dict: the SHA-1 gate must reject the result. */
  | { readonly kind: "poison"; readonly infoBytes: Uint8Array }
  /** Serves only pieces where `index % modulus === residue`, and rejects the rest. */
  | { readonly kind: "partial"; readonly modulus: number; readonly residue: number }
  /** Completes the handshake and then says nothing. */
  | { readonly kind: "silent" };

export interface FakePeerOptions {
  readonly infoHash: Uint8Array;
  readonly infoBytes: Uint8Array;
  readonly behaviour?: PeerBehaviour;
}

export interface FakePeer {
  readonly port: number;
  readonly connections: () => number;
  close(): void;
}

export function startFakePeer(options: FakePeerOptions): FakePeer {
  const behaviour = options.behaviour ?? { kind: "honest" };
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  let connections = 0;
  let closed = false;

  const served = behaviour.kind === "poison" ? behaviour.infoBytes : options.infoBytes;

  (async () => {
    for await (const conn of listener) {
      connections++;
      handle(conn, served, behaviour).catch(() => {}).finally(() => {
        try {
          conn.close();
        } catch {
          // Already gone.
        }
      });
      if (closed) break;
    }
  })().catch(() => {});

  return {
    port,
    connections: () => connections,
    close() {
      if (closed) return;
      closed = true;
      try {
        listener.close();
      } catch {
        // Already closed.
      }
    },
  };
}

async function readExact(conn: Deno.Conn, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  let filled = 0;
  while (filled < n) {
    const read = await conn.read(out.subarray(filled));
    if (read === null || read === 0) throw new Error("eof");
    filled += read;
  }
  return out;
}

function frame(id: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, 1 + payload.length);
  out[4] = id;
  out.set(payload, 5);
  return out;
}

function extendedFrame(extendedId: number, payload: Uint8Array): Uint8Array {
  const body = new Uint8Array(1 + payload.length);
  body[0] = extendedId;
  body.set(payload, 1);
  return frame(20, body);
}

async function handle(
  conn: Deno.Conn,
  infoBytes: Uint8Array,
  behaviour: PeerBehaviour,
): Promise<void> {
  const handshake = await readExact(conn, HANDSHAKE_BYTES);
  const reply = new Uint8Array(HANDSHAKE_BYTES);
  reply[0] = 19;
  reply.set(new TextEncoder().encode("BitTorrent protocol"), 1);
  reply[20 + 5] = 0x10; // BEP-10 extension bit
  reply.set(handshake.subarray(28, 48), 28); // echo the requested infohash
  reply.set(crypto.getRandomValues(new Uint8Array(20)), 48);
  await conn.write(reply);

  if (behaviour.kind === "silent") {
    // Read and discard, never answer. Blocking on the socket rather than on a timer means this
    // ends the moment the client gives up, instead of pinning the event loop open.
    const scratch = new Uint8Array(1024);
    while (await conn.read(scratch) !== null) {
      // Discard.
    }
    return;
  }

  // The size we advertise must be the size of what we actually serve, or the client's assembler
  // will never fill its buffer.
  const metadataSize = infoBytes.length;
  let clientUtMetadataId: number | null = null;

  while (true) {
    const header = await readExact(conn, 4);
    const length = new DataView(header.buffer).getUint32(0);
    if (length === 0) continue; // keep-alive
    if (length > 1024 * 1024) throw new Error("oversized message");
    const body = await readExact(conn, length);
    if (body[0] !== 20) continue; // only extended messages matter here

    const extendedId = body[1]!;
    const payload = body.subarray(2);

    if (extendedId === 0) {
      const dict = asDict(decodePrefix(payload, 0).value);
      const m = dict ? asDict(dict["m"]) : null;
      clientUtMetadataId = m ? asInt(m["ut_metadata"]) : null;
      await conn.write(
        extendedFrame(
          0,
          encode({ m: { ut_metadata: OUR_UT_METADATA_ID }, metadata_size: metadataSize }),
        ),
      );
      continue;
    }

    // A request must arrive under the id we advertised.
    if (extendedId !== OUR_UT_METADATA_ID || clientUtMetadataId === null) continue;

    const decoded = decodePrefix(payload, 0);
    const request = asDict(decoded.value);
    if (!request || asInt(request["msg_type"]) !== 0) continue;
    const index = asInt(request["piece"]);
    if (index === null) continue;

    if (behaviour.kind === "partial" && index % behaviour.modulus !== behaviour.residue) {
      await conn.write(
        extendedFrame(clientUtMetadataId, encode({ msg_type: 2, piece: index })),
      );
      continue;
    }

    const start = index * METADATA_PIECE_BYTES;
    const chunk = infoBytes.subarray(start, Math.min(start + METADATA_PIECE_BYTES, metadataSize));
    const head = encode({ msg_type: 1, piece: index, total_size: metadataSize });
    const message = new Uint8Array(head.length + chunk.length);
    message.set(head, 0);
    message.set(chunk, head.length);
    await conn.write(extendedFrame(clientUtMetadataId, message));
  }
}
