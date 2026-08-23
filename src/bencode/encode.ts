/**
 * Bencode encoder for the messages we send: BEP-10 extended handshakes, BEP-9 metadata requests,
 * and DHT KRPC queries.
 *
 * Keys are emitted in sorted byte order, which the spec requires and which strict DHT nodes
 * actually enforce. This is never used to re-encode a received info dict — that would have to be
 * byte-exact to preserve the infohash, and BEP-9 hands us the original bytes anyway.
 */

import { encoder } from "../bytes.ts";

export type Encodable =
  | Uint8Array
  | string
  | number
  | Encodable[]
  | { [key: string]: Encodable };

function push(parts: Uint8Array[], text: string): void {
  parts.push(encoder.encode(text));
}

function write(parts: Uint8Array[], value: Encodable): void {
  if (value instanceof Uint8Array) {
    push(parts, `${value.length}:`);
    parts.push(value);
    return;
  }
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    push(parts, `${bytes.length}:`);
    parts.push(bytes);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`cannot bencode ${value}`);
    push(parts, `i${value}e`);
    return;
  }
  if (Array.isArray(value)) {
    push(parts, "l");
    for (const item of value) write(parts, item);
    push(parts, "e");
    return;
  }
  push(parts, "d");
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) continue;
    write(parts, key);
    write(parts, item);
  }
  push(parts, "e");
}

export function encode(value: Encodable): Uint8Array {
  const parts: Uint8Array[] = [];
  write(parts, value);
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
