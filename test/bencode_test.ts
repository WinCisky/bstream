import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  asBytes,
  asDict,
  asInt,
  asList,
  BencodeError,
  decode,
  decodePrefix,
} from "../src/bencode/decode.ts";
import { encode } from "../src/bencode/encode.ts";
import { encoder, toText } from "../src/bytes.ts";

const b = (text: string) => encoder.encode(text);

Deno.test("decodes the four bencode types", () => {
  assertEquals(decode(b("i42e")), 42);
  assertEquals(decode(b("i-7e")), -7);
  assertEquals(decode(b("i0e")), 0);
  assertEquals(toText(asBytes(decode(b("5:hello")))!), "hello");
  assertEquals(asList(decode(b("li1ei2ee")))!.length, 2);
  assertEquals(asInt(asDict(decode(b("d3:fooi9ee")))!["foo"]), 9);
});

Deno.test("byte strings stay bytes", () => {
  // `pieces` is a concatenation of raw SHA-1 digests; UTF-8 decoding would corrupt it.
  const raw = new Uint8Array([0x80, 0x00, 0xff, 0xfe]);
  const message = new Uint8Array(2 + raw.length);
  message.set(b("4:"), 0);
  message.set(raw, 2);
  assertEquals(asBytes(decode(message)), raw);
});

Deno.test("decodePrefix reports consumed bytes and tolerates a trailing payload", () => {
  const message = b("d8:msg_typei1e5:piecei0eePAYLOAD");
  const { value, consumed } = decodePrefix(message, 0);
  assertEquals(consumed, message.length - "PAYLOAD".length);
  assertEquals(asInt(asDict(value)!["msg_type"]), 1);
});

Deno.test("decode rejects trailing bytes", () => {
  assertThrows(() => decode(b("i1eXX")), BencodeError, "trailing");
});

// Each of these hangs the PoC decoder rather than throwing.
Deno.test("hostile input throws instead of hanging", async (t) => {
  const cases: Record<string, string> = {
    "unterminated integer": "i123",
    "unterminated list": "li1e",
    "unterminated dict": "d3:foo",
    "empty input": "",
    "bare terminator": "e",
    "length longer than buffer": "99:short",
    "length longer than buffer inside a list": "l99:shorte",
    "no colon in string": "12345",
    "non-numeric length": "abc:x",
    "negative string length": "-1:x",
    "dict key is not a string": "di1ei2ee",
    "leading zero integer": "i007e",
    "negative zero": "i-0e",
    "empty integer": "ie",
    "integer beyond 2^53": "i9007199254740993e",
    "unknown marker": "x",
  };

  for (const [name, input] of Object.entries(cases)) {
    await t.step(name, () => {
      assertThrows(() => decode(b(input)), BencodeError);
    });
  }
});

Deno.test("nesting deeper than the cap throws", () => {
  const deep = "l".repeat(100) + "e".repeat(100);
  assertThrows(() => decode(b(deep)), BencodeError, "nesting");
  // Just inside the default cap of 16 is fine.
  const shallow = "l".repeat(16) + "e".repeat(16);
  assert(asList(decode(b(shallow))) !== null);
});

Deno.test("a truncated 8 MiB claim does not allocate or hang", () => {
  const start = performance.now();
  assertThrows(() => decode(b("8388608:tiny")), BencodeError, "exceeds");
  assert(performance.now() - start < 1_000);
});

Deno.test("encoder sorts dict keys and round-trips", () => {
  const bytes = encode({ zeta: 1, alpha: "x", m: { ut_metadata: 1, ut_pex: 2 } });
  assertEquals(toText(bytes), "d5:alpha1:x1:md11:ut_metadatai1e6:ut_pexi2ee4:zetai1ee");
  const back = asDict(decode(bytes))!;
  assertEquals(asInt(back["zeta"]), 1);
  assertEquals(asInt(asDict(back["m"])!["ut_pex"]), 2);
});

Deno.test("encoder handles raw byte values", () => {
  const raw = new Uint8Array([0, 1, 2, 255]);
  const round = asDict(decode(encode({ id: raw })))!;
  assertEquals(asBytes(round["id"]), raw);
});
