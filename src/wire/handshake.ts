/**
 * The 68-byte BitTorrent handshake.
 *
 * Unlike the PoC this keeps what the peer sends back: its reserved bits say whether it speaks the
 * extension protocol at all, which decides whether asking it for metadata is worth a round trip.
 */

import { bytesEqual, encoder } from "../bytes.ts";
import { WireConn, WireError } from "./conn.ts";

const PROTOCOL = encoder.encode("BitTorrent protocol");
const HANDSHAKE_BYTES = 68;

/** BEP-10 extension protocol. */
const RESERVED_EXTENDED_BYTE = 5;
const RESERVED_EXTENDED_BIT = 0x10;
/** BEP-5 DHT. */
const RESERVED_DHT_BYTE = 7;
const RESERVED_DHT_BIT = 0x01;

export interface HandshakeResult {
  readonly peerId: Uint8Array;
  readonly supportsExtended: boolean;
  readonly supportsDht: boolean;
}

export function generatePeerId(): Uint8Array {
  // Azureus-style client id, then 12 random printable bytes, for exactly 20.
  const prefix = encoder.encode("-MA0001-");
  const out = new Uint8Array(20);
  out.set(prefix, 0);
  const random = crypto.getRandomValues(new Uint8Array(12));
  for (let i = 0; i < 12; i++) out[8 + i] = 0x30 + (random[i]! % 62);
  return out;
}

export function buildHandshake(infoHash: Uint8Array, peerId: Uint8Array): Uint8Array {
  if (infoHash.length !== 20) throw new WireError("infohash must be 20 bytes");
  if (peerId.length !== 20) throw new WireError("peer id must be 20 bytes");
  const out = new Uint8Array(HANDSHAKE_BYTES);
  out[0] = PROTOCOL.length;
  out.set(PROTOCOL, 1);
  // The buffer starts zeroed and the two bits live in different reserved bytes, so a plain
  // assignment is exact here.
  out[20 + RESERVED_EXTENDED_BYTE] = RESERVED_EXTENDED_BIT;
  out[20 + RESERVED_DHT_BYTE] = RESERVED_DHT_BIT;
  out.set(infoHash, 28);
  out.set(peerId, 48);
  return out;
}

export async function performHandshake(
  conn: WireConn,
  infoHash: Uint8Array,
  peerId: Uint8Array,
): Promise<HandshakeResult> {
  await conn.write(buildHandshake(infoHash, peerId));
  const response = await conn.readExact(HANDSHAKE_BYTES);

  if (response[0] !== PROTOCOL.length || !bytesEqual(response.subarray(1, 20), PROTOCOL)) {
    throw new WireError("peer did not speak the BitTorrent protocol");
  }
  if (!bytesEqual(response.subarray(28, 48), infoHash)) {
    // A peer serving a different torrent on this port. Nothing it says is relevant to us.
    throw new WireError("peer returned a different infohash");
  }

  const reserved = response.subarray(20, 28);
  return {
    peerId: response.subarray(48, 68),
    supportsExtended: (reserved[RESERVED_EXTENDED_BYTE]! & RESERVED_EXTENDED_BIT) !== 0,
    supportsDht: (reserved[RESERVED_DHT_BYTE]! & RESERVED_DHT_BIT) !== 0,
  };
}
