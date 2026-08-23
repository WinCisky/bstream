/** Byte helpers shared across the wire, tracker, DHT and KV layers. */

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(text: string): Uint8Array | null {
  const clean = text.trim();
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function fromBase32(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/, "").toUpperCase();
  if (clean.length === 0) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  // Passing the view rather than `.buffer` matters: metadata is often a subarray.
  const digest = await crypto.subtle.digest("SHA-1", data as BufferSource);
  return new Uint8Array(digest);
}

/** Lossy UTF-8 decode. Torrent paths are not guaranteed to be valid UTF-8. */
const decoder = new TextDecoder("utf-8", { fatal: false });

export function toText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export const encoder = new TextEncoder();
