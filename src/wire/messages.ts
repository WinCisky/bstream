/**
 * Peer wire message framing.
 *
 * The length prefix is the one field a peer fully controls before we allocate anything, and the
 * PoC feeds it straight into `readExactly` — a claimed length of 0xFFFFFFFF asks for a 4 GiB
 * buffer. `MAX_MESSAGE_BYTES` is the cap: the largest thing we ever legitimately receive is a
 * 16 KiB metadata piece or a bitfield (one bit per piece), both orders of magnitude below it.
 */

import { WireConn, WireError } from "./conn.ts";

export const MSG_CHOKE = 0;
export const MSG_UNCHOKE = 1;
export const MSG_INTERESTED = 2;
export const MSG_BITFIELD = 5;
export const MSG_EXTENDED = 20;

/** Synthetic id for a zero-length keep-alive, which carries no id byte of its own. */
export const MSG_KEEPALIVE = -1;

export const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface WireMessage {
  readonly id: number;
  readonly payload: Uint8Array;
}

export function frame(id: number, payload?: Uint8Array): Uint8Array {
  const body = payload ?? new Uint8Array(0);
  const out = new Uint8Array(4 + 1 + body.length);
  new DataView(out.buffer).setUint32(0, 1 + body.length);
  out[4] = id;
  out.set(body, 5);
  return out;
}

/** BEP-10 envelope: `<len><20><extendedId><payload>`. */
export function extendedFrame(extendedId: number, payload: Uint8Array): Uint8Array {
  const body = new Uint8Array(1 + payload.length);
  body[0] = extendedId;
  body.set(payload, 1);
  return frame(MSG_EXTENDED, body);
}

export async function readMessage(conn: WireConn): Promise<WireMessage> {
  const header = await conn.readExact(4);
  const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
  if (length === 0) return { id: MSG_KEEPALIVE, payload: new Uint8Array(0) };
  if (length > MAX_MESSAGE_BYTES) {
    throw new WireError(`peer announced a ${length}-byte message`);
  }
  const body = await conn.readExact(length);
  return { id: body[0]!, payload: body.subarray(1) };
}

/** Split a BEP-10 message body into its extended id and payload. */
export function splitExtended(
  payload: Uint8Array,
): { extendedId: number; body: Uint8Array } | null {
  if (payload.length === 0) return null;
  return { extendedId: payload[0]!, body: payload.subarray(1) };
}
