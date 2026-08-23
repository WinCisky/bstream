/**
 * Bencode decoder, written to be safe on bytes a stranger sent us.
 *
 * Everything this service decodes — extended handshakes, metadata pieces, tracker responses, DHT
 * replies — arrives from an unauthenticated peer. The PoC decoder this replaces scans for the `e`
 * terminator with no bound (`while (buf[pos] !== 0x65) pos++`), so a truncated message walks off
 * the end of the buffer and spins forever on `undefined`, and its string reader trusts an
 * unvalidated length prefix. Both are remote hangs.
 *
 * So: every read is bounded by an explicit end, every length is checked against the bytes actually
 * remaining, recursion is depth-capped, and the only thing thrown is `BencodeError`.
 *
 * Byte strings are returned as `Uint8Array`, never text. `pieces` is a concatenation of raw SHA-1
 * digests and path components are arbitrary bytes; decoding either as UTF-8 destroys it.
 */

import { toText } from "../bytes.ts";

export class BencodeError extends Error {
  override readonly name = "BencodeError";
}

export type BencodeValue = Uint8Array | number | BencodeValue[] | BencodeDict;

export interface BencodeDict {
  [key: string]: BencodeValue;
}

export interface DecodeOptions {
  /** Nesting limit. Real torrents never exceed four or five levels. */
  readonly maxDepth?: number;
  /** Ceiling on decoded nodes, as a second line of defence behind the buffer length. */
  readonly maxItems?: number;
}

const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_ITEMS = 1_000_000;

const CHAR_I = 0x69; // 'i'
const CHAR_L = 0x6c; // 'l'
const CHAR_D = 0x64; // 'd'
const CHAR_E = 0x65; // 'e'
const CHAR_COLON = 0x3a; // ':'
const CHAR_MINUS = 0x2d; // '-'
const CHAR_0 = 0x30;
const CHAR_9 = 0x39;

class Reader {
  private pos: number;
  private items = 0;
  private readonly end: number;
  private readonly maxDepth: number;
  private readonly maxItems: number;

  constructor(private readonly buf: Uint8Array, start: number, options: DecodeOptions) {
    this.pos = start;
    this.end = buf.length;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    if (start < 0 || start > this.end) throw new BencodeError(`start ${start} out of range`);
  }

  get consumed(): number {
    return this.pos;
  }

  private byteAt(index: number): number {
    if (index >= this.end) throw new BencodeError("unexpected end of input");
    return this.buf[index]!;
  }

  private count(): void {
    if (++this.items > this.maxItems) throw new BencodeError("too many elements");
  }

  /** Scan forward to `terminator`, bounded by the buffer end. Returns its index. */
  private findBounded(terminator: number, from: number): number {
    for (let i = from; i < this.end; i++) {
      if (this.buf[i] === terminator) return i;
    }
    throw new BencodeError("unterminated token");
  }

  /**
   * Bencode integers are canonical: no leading zeros, no `-0`, no `+`. Enforcing that is not
   * pedantry — it is what stops two encodings of the same number from producing two info hashes.
   */
  private parseInteger(text: string): number {
    if (!/^-?(0|[1-9][0-9]*)$/.test(text)) throw new BencodeError(`bad integer "${text}"`);
    if (text === "-0") throw new BencodeError("negative zero");
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new BencodeError(`integer out of range "${text}"`);
    return value;
  }

  private readInteger(): number {
    const terminator = this.findBounded(CHAR_E, this.pos + 1);
    const text = toText(this.buf.subarray(this.pos + 1, terminator));
    this.pos = terminator + 1;
    return this.parseInteger(text);
  }

  private readBytes(): Uint8Array {
    const colon = this.findBounded(CHAR_COLON, this.pos);
    const lengthText = toText(this.buf.subarray(this.pos, colon));
    if (!/^(0|[1-9][0-9]*)$/.test(lengthText)) {
      throw new BencodeError(`bad string length "${lengthText}"`);
    }
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length)) throw new BencodeError("string length out of range");
    const start = colon + 1;
    // The check that the PoC omits. Without it a hostile length yields a silently truncated
    // subarray, which downstream reads as a valid-but-wrong value.
    if (length > this.end - start) {
      throw new BencodeError(`string length ${length} exceeds ${this.end - start} remaining`);
    }
    this.pos = start + length;
    return this.buf.subarray(start, start + length);
  }

  private readList(depth: number): BencodeValue[] {
    this.pos++; // 'l'
    const out: BencodeValue[] = [];
    while (this.byteAt(this.pos) !== CHAR_E) {
      out.push(this.readAny(depth + 1));
    }
    this.pos++; // 'e'
    return out;
  }

  private readDict(depth: number): BencodeDict {
    this.pos++; // 'd'
    const out: BencodeDict = Object.create(null) as BencodeDict;
    while (this.byteAt(this.pos) !== CHAR_E) {
      const marker = this.byteAt(this.pos);
      if (marker < CHAR_0 || marker > CHAR_9) throw new BencodeError("dict key is not a string");
      const key = toText(this.readBytes());
      out[key] = this.readAny(depth + 1);
    }
    this.pos++; // 'e'
    return out;
  }

  readAny(depth = 0): BencodeValue {
    if (depth > this.maxDepth) throw new BencodeError(`nesting deeper than ${this.maxDepth}`);
    this.count();
    const marker = this.byteAt(this.pos);
    if (marker === CHAR_I) return this.readInteger();
    if (marker === CHAR_L) return this.readList(depth);
    if (marker === CHAR_D) return this.readDict(depth);
    if (marker >= CHAR_0 && marker <= CHAR_9) return this.readBytes();
    if (marker === CHAR_MINUS) throw new BencodeError("negative string length");
    throw new BencodeError(`unexpected byte 0x${marker.toString(16)} at ${this.pos}`);
  }
}

/** Decode one value and how many bytes it took. Trailing bytes are allowed and left alone. */
export function decodePrefix(
  buf: Uint8Array,
  start = 0,
  options: DecodeOptions = {},
): { value: BencodeValue; consumed: number } {
  const reader = new Reader(buf, start, options);
  const value = reader.readAny();
  return { value, consumed: reader.consumed - start };
}

/** Decode a buffer that must contain exactly one value and nothing else. */
export function decode(buf: Uint8Array, options: DecodeOptions = {}): BencodeValue {
  const { value, consumed } = decodePrefix(buf, 0, options);
  if (consumed !== buf.length) {
    throw new BencodeError(`${buf.length - consumed} trailing bytes`);
  }
  return value;
}

// --- typed field access ------------------------------------------------------------------------
// Callers deal with dicts a stranger built, so "missing" and "wrong type" have to be the same
// cheap check at every use site. These return null rather than throwing.

export function asDict(value: BencodeValue | undefined): BencodeDict | null {
  return value !== undefined && typeof value === "object" && !Array.isArray(value) &&
      !(value instanceof Uint8Array)
    ? value
    : null;
}

export function asList(value: BencodeValue | undefined): BencodeValue[] | null {
  return Array.isArray(value) ? value : null;
}

export function asBytes(value: BencodeValue | undefined): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

export function asInt(value: BencodeValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

export function asText(value: BencodeValue | undefined): string | null {
  const bytes = asBytes(value);
  return bytes ? toText(bytes) : null;
}
