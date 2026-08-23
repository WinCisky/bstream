import { assertEquals, assertThrows } from "@std/assert";
import { encode } from "../src/bencode/encode.ts";
import { InfoError, parseInfo } from "../src/meta/info.ts";
import { SelectError, selectVideoFile } from "../src/select.ts";
import { makeTorrent } from "./support/torrent.ts";

const MiB = 1024 * 1024;

function hashesFor(count: number): Uint8Array {
  return new Uint8Array(count * 20);
}

Deno.test("parses a single-file torrent", async () => {
  const torrent = await makeTorrent([{ path: ["Movie.mkv"], length: 5 * MiB }], 256 * 1024);
  const info = parseInfo(torrent.infoBytes);

  assertEquals(info.files.length, 1);
  assertEquals(info.files[0]!.path, "Movie.mkv");
  assertEquals(info.files[0]!.offset, 0);
  assertEquals(info.totalLength, 5 * MiB);
  assertEquals(info.pieceCount, Math.ceil(5 * MiB / (256 * 1024)));
});

Deno.test("computes running offsets across a multi-file torrent", async () => {
  const torrent = await makeTorrent([
    { path: ["Sample", "sample.mkv"], length: 3 * MiB },
    { path: ["Feature.mkv"], length: 40 * MiB },
    { path: ["poster.jpg"], length: 512 * 1024 },
  ], 512 * 1024);
  const info = parseInfo(torrent.infoBytes);

  assertEquals(info.files.map((file) => file.offset), [0, 3 * MiB, 43 * MiB]);
  assertEquals(info.totalLength, 43 * MiB + 512 * 1024);
});

Deno.test("padding files occupy byte ranges but are never selected", async () => {
  // Dropping a padding file would shift every later offset and corrupt playback silently.
  const torrent = await makeTorrent([
    { path: ["Feature.mkv"], length: 40 * MiB },
    { path: [".pad", "1048576"], length: 1 * MiB, padding: true },
    { path: ["Extras.mkv"], length: 8 * MiB },
  ], 512 * 1024);
  const info = parseInfo(torrent.infoBytes);

  assertEquals(info.files[1]!.padding, true);
  assertEquals(info.files[2]!.offset, 41 * MiB, "padding must still advance the cursor");
  assertEquals(info.totalLength, 49 * MiB, "padding counts toward the torrent length");

  const selection = selectVideoFile(info);
  assertEquals(selection.path, "Feature.mkv");
});

Deno.test("selects the largest video file and its mime type", async () => {
  const torrent = await makeTorrent([
    { path: ["Sample.mkv"], length: 2 * MiB },
    { path: ["Feature.mp4"], length: 60 * MiB },
    { path: ["Bigger.txt"], length: 90 * MiB },
    { path: ["Trailer.m4v"], length: 5 * MiB },
  ], 1024 * 1024);
  const selection = selectVideoFile(parseInfo(torrent.infoBytes));

  assertEquals(selection.path, "Feature.mp4");
  assertEquals(selection.mime, "video/mp4");
  assertEquals(selection.length, 60 * MiB);
});

Deno.test("mkv gets the matroska mime type", async () => {
  const torrent = await makeTorrent([{ path: ["Feature.mkv"], length: 9 * MiB }], 512 * 1024);
  assertEquals(selectVideoFile(parseInfo(torrent.infoBytes)).mime, "video/x-matroska");
});

Deno.test("a torrent with no video file is rejected, not guessed at", async () => {
  const torrent = await makeTorrent([
    { path: ["album", "01.flac"], length: 30 * MiB },
    { path: ["cover.jpg"], length: 1 * MiB },
  ], 512 * 1024);
  assertThrows(() => selectVideoFile(parseInfo(torrent.infoBytes)), SelectError, "no ");
});

Deno.test("rejects an info dict whose piece count disagrees with its own numbers", () => {
  // sl-stream's validateLayout re-derives this and 500s the id forever; catch it here instead.
  const bytes = encode({
    name: "Broken",
    "piece length": 1024,
    pieces: hashesFor(3), // claims 3 pieces
    length: 10 * 1024, // but 10 KiB at 1 KiB pieces needs 10
  });
  assertThrows(() => parseInfo(bytes), InfoError, "hashes");
});

Deno.test("rejects malformed info dicts", () => {
  assertThrows(
    () => parseInfo(encode({ name: "x", pieces: hashesFor(1), length: 100 })),
    InfoError,
    "piece length",
  );
  assertThrows(
    () => parseInfo(encode({ name: "x", "piece length": 1024, length: 100 })),
    InfoError,
    "missing pieces",
  );
  assertThrows(
    () =>
      parseInfo(encode({ name: "x", "piece length": 1024, pieces: new Uint8Array(19), length: 5 })),
    InfoError,
    "multiple of 20",
  );
  assertThrows(
    () => parseInfo(encode({ name: "x", "piece length": 1024, pieces: hashesFor(1) })),
    InfoError,
    "not a valid length",
  );
});

Deno.test("rejects path traversal in a file entry", () => {
  const bytes = encode({
    name: "Evil",
    "piece length": 1024,
    pieces: hashesFor(1),
    files: [{ length: 1000, path: ["..", "..", "etc", "passwd"] }],
  });
  assertThrows(() => parseInfo(bytes), InfoError, "unsafe path");
});

Deno.test("rejects a separator smuggled into a path component", () => {
  const bytes = encode({
    name: "Evil",
    "piece length": 1024,
    pieces: hashesFor(1),
    files: [{ length: 1000, path: ["a/../../b"] }],
  });
  assertThrows(() => parseInfo(bytes), InfoError, "illegal character");
});
