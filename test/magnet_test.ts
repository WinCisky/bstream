import { assertEquals, assertThrows } from "@std/assert";
import { MagnetError, parseEndpoint, parseMagnet } from "../src/magnet.ts";

const HEX = "08ada5a7a6183aae1e09d831df6748d566095a10";
// The same 20 bytes, base32-encoded, as older clients emit.
const BASE32 = "BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ";

Deno.test("parses a hex infohash", () => {
  const parsed = parseMagnet(`magnet:?xt=urn:btih:${HEX}&dn=Some+Movie`);
  assertEquals(parsed.infoHashHex, HEX);
  assertEquals(parsed.infoHash.length, 20);
  assertEquals(parsed.displayName, "Some Movie");
});

Deno.test("parses a base32 infohash to the same bytes", () => {
  const parsed = parseMagnet(`magnet:?xt=urn:btih:${BASE32}`);
  assertEquals(parsed.infoHashHex, HEX);
});

Deno.test("uppercase hex normalises to lowercase", () => {
  assertEquals(parseMagnet(`magnet:?xt=urn:btih:${HEX.toUpperCase()}`).infoHashHex, HEX);
});

Deno.test("rejects malformed magnets", () => {
  assertThrows(() => parseMagnet("magnet:?dn=nothing"), MagnetError, "no xt");
  assertThrows(() => parseMagnet("https://example.com"), MagnetError, "not a magnet");
  assertThrows(() => parseMagnet(`magnet:?xt=urn:btih:zzzz`), MagnetError, "not a valid btih");
  assertThrows(() => parseMagnet(""), MagnetError);
});

Deno.test("rejects BitTorrent v2 with a specific message", () => {
  assertThrows(
    () => parseMagnet("magnet:?xt=urn:btmh:1220caf1e1c30e81cb361b9ee167c4946a448b"),
    MagnetError,
    "v2",
  );
});

Deno.test("prefers the btih topic in a hybrid v1/v2 magnet", () => {
  const parsed = parseMagnet(
    `magnet:?xt=urn:btmh:1220caf1&xt=urn:btih:${HEX}`,
  );
  assertEquals(parsed.infoHashHex, HEX);
});

Deno.test("collects, filters and dedupes trackers", () => {
  const parsed = parseMagnet(
    `magnet:?xt=urn:btih:${HEX}` +
      "&tr=udp%3A%2F%2Ftracker.one%3A6969%2Fannounce" +
      "&tr=http%3A%2F%2Ftracker.two%3A80%2Fannounce" +
      "&tr=udp%3A%2F%2Ftracker.one%3A6969%2Fannounce" +
      "&tr=ftp%3A%2F%2Fnope%2Fannounce" +
      "&tr=not-a-url",
  );
  assertEquals(parsed.trackers.length, 2);
  assertEquals(parsed.trackers[0], "udp://tracker.one:6969/announce");
});

Deno.test("collects webseeds from ws and as", () => {
  const parsed = parseMagnet(
    `magnet:?xt=urn:btih:${HEX}` +
      "&ws=https%3A%2F%2Fcdn.example%2Ffile.mp4" +
      "&as=http%3A%2F%2Fmirror.example%2Ffile.mp4" +
      "&ws=ftp%3A%2F%2Fbad%2Ffile.mp4",
  );
  assertEquals(parsed.webseeds, [
    "https://cdn.example/file.mp4",
    "http://mirror.example/file.mp4",
  ]);
});

Deno.test("collects x.pe peer hints", () => {
  const parsed = parseMagnet(
    `magnet:?xt=urn:btih:${HEX}&x.pe=1.2.3.4%3A6881&x.pe=%5B2001%3Adb8%3A%3A1%5D%3A6882` +
      "&x.pe=1.2.3.4%3A6881&x.pe=garbage",
  );
  assertEquals(parsed.peerHints, [
    { ip: "1.2.3.4", port: 6881 },
    { ip: "2001:db8::1", port: 6882 },
  ]);
});

Deno.test("parseEndpoint validates ports", () => {
  assertEquals(parseEndpoint("1.2.3.4:6881"), { ip: "1.2.3.4", port: 6881 });
  assertEquals(parseEndpoint("1.2.3.4:0"), null);
  assertEquals(parseEndpoint("1.2.3.4:70000"), null);
  assertEquals(parseEndpoint("1.2.3.4"), null);
  assertEquals(parseEndpoint(":6881"), null);
  assertEquals(parseEndpoint(""), null);
});
