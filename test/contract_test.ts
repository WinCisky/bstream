/**
 * The records we write, fed to the code that reads them.
 *
 * This imports sl-stream's **actual** adapter rather than a copy of its rules, so the constraints
 * that matter — `pieceCount === ceil(totalLength / pieceLength)`, the `length` alias trap, the
 * hash-blob length check — are verified against their real implementation. A copy would drift.
 *
 * Skipped when the sibling checkout is not present.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { buildChunksRecord, buildPeersRecord, isBtEntry } from "../src/db/records.ts";
import { parseInfo } from "../src/meta/info.ts";
import { selectVideoFile } from "../src/select.ts";
import type { DiscoveredPeer } from "../src/discovery/queue.ts";
import { makeTorrent } from "./support/torrent.ts";

const MiB = 1024 * 1024;
const ID = "08ada5a7a6183aae1e09d831df6748d566095a10";
/** `makeTorrent`'s default name, which is also the directory a webseed URL has to include. */
const NAME = "Test.Release.1080p";

interface SlLayout {
  pieceLength: number;
  pieceCount: number;
  torrentLength: number;
  fileOffset: number;
  fileLength: number;
  pieceHashes: Uint8Array | null;
}

interface SlAdapter {
  /** `wanted` is sl-stream's `?file=`: the position of a file in the list we wrote. */
  adaptLayout(raw: unknown, wanted?: number): {
    layout: SlLayout;
    fileIndex: number;
    filePath: string;
    torrentName: string;
    isDefaultFile: boolean;
  };
  webseedUrlFor(url: string, chunks: unknown): string | null;
  /** Since sl-stream gained the peer wire, this splits by transport instead of returning URLs. */
  adaptPeers(raw: unknown): {
    http: { id: string; url: string }[];
    bt: { host: string; port: number }[];
  };
  infoHashFromId(id: string): Uint8Array | null;
}

const adapterUrl = new URL("../../sl-stream/src/kv/adapter.ts", import.meta.url);
let sl: SlAdapter | null = null;
try {
  sl = await import(adapterUrl.href) as SlAdapter;
} catch {
  sl = null;
}

const skip = sl === null;

async function buildRecords() {
  const torrent = await makeTorrent([
    { path: ["Sample", "sample.mkv"], length: 3 * MiB },
    { path: [".pad", "1048576"], length: 1 * MiB, padding: true },
    { path: ["Feature.2001.1080p.mkv"], length: 700 * MiB },
    { path: ["poster.jpg"], length: 512 * 1024 },
  ], 1 * MiB);

  const info = parseInfo(torrent.infoBytes);
  const selection = selectVideoFile(info);
  const chunks = buildChunksRecord(ID, info, selection, Date.now());
  return { info, selection, chunks };
}

Deno.test({
  name: "sl-stream's adaptLayout accepts our chunk record",
  ignore: skip,
  async fn() {
    const { info, selection, chunks } = await buildRecords();
    const { layout, fileIndex } = sl!.adaptLayout(chunks);

    assertEquals(layout.pieceLength, info.pieceLength);
    assertEquals(layout.pieceCount, info.pieceCount);
    assertEquals(layout.torrentLength, info.totalLength);
    // The offsets it derives must be the ones we chose, not ones it guessed from `files`.
    assertEquals(layout.fileOffset, selection.offset);
    assertEquals(layout.fileLength, selection.length);
    assertEquals(fileIndex, selection.index);
    // Raw Uint8Array hashes survive: this is the encoding decodePieceHashes wants natively.
    assertEquals(layout.pieceHashes?.length, info.pieceCount * 20);
  },
});

Deno.test({
  name: "sl-stream can address every file in our list by index",
  ignore: skip,
  async fn() {
    // The fixture is deliberately awkward: a sample, a padding file, the feature, and a poster.
    // `?file=` counts *all* of them, so an off-by-one anywhere in either project shows up here.
    const { info, chunks } = await buildRecords();

    for (let index = 0; index < info.files.length; index++) {
      const file = info.files[index]!;
      if (file.padding) {
        assertThrows(
          () => sl!.adaptLayout(chunks, index),
          Error,
          "padding",
          "a padding file occupies an index but must never be streamable",
        );
        continue;
      }
      const { layout, filePath } = sl!.adaptLayout(chunks, index);
      assertEquals(filePath, file.path);
      assertEquals(layout.fileOffset, file.offset);
      assertEquals(layout.fileLength, file.length);
    }
  },
});

Deno.test({
  name: "an out-of-range file index is refused rather than falling back",
  ignore: skip,
  async fn() {
    const { info, chunks } = await buildRecords();
    assertThrows(
      () => sl!.adaptLayout(chunks, info.files.length),
      Error,
      "out of range",
    );
  },
});

Deno.test({
  name: "a directory webseed is resolved per file, a single-file one only for the default",
  ignore: skip,
  async fn() {
    // BEP-19: the trailing slash is the whole difference. Ours come straight from the magnet's
    // `ws=`, so both forms reach sl-stream and it has to tell them apart.
    const { chunks, selection } = await buildRecords();
    const other = sl!.adaptLayout(chunks, 0);
    const dflt = sl!.adaptLayout(chunks);

    assertEquals(
      sl!.webseedUrlFor("https://cdn.example/seed/", other),
      `https://cdn.example/seed/${encodeURIComponent(NAME)}/Sample/sample.mkv`,
    );
    // No slash: the URL names one file, and it is not the one asked for.
    assertEquals(sl!.webseedUrlFor("https://cdn.example/movie.mkv", other), null);
    assertEquals(
      sl!.webseedUrlFor("https://cdn.example/movie.mkv", dflt),
      "https://cdn.example/movie.mkv",
    );
    assert(selection.path.endsWith(".mkv"));
  },
});

Deno.test({
  name: "the chunk record carries no `length` key that could shadow totalLength",
  ignore: skip,
  async fn() {
    // adaptLayout reads torrent length from `totalLength|length|size|totalSize`. A `length` field
    // meaning the *file* length would be read as the whole torrent and every offset would be wrong.
    const { chunks } = await buildRecords();
    const record = chunks as unknown as Record<string, unknown>;
    assertEquals(record["length"], undefined);
    assertEquals(record["size"], undefined);
    assertEquals(record["totalSize"], undefined);
  },
});

/**
 * ~120k pieces is 2.4 MB of hashes. Under Deno KV that was far past the 64 KiB value limit, so the
 * record degraded in defined steps — hashes to a `chunkhashes` overflow namespace first, then the
 * file list, in that order because `?file=` addresses a file by its position in the list and losing
 * the list was the worse outcome. Postgres has no per-value ceiling, so the property to hold is the
 * opposite one: nothing is dropped at any size, and the argument about ordering is moot.
 *
 * Not skipped with the rest — this half needs no sibling checkout.
 */
Deno.test("a 120k-piece torrent keeps its hashes and its file list", async () => {
  const torrent = await makeTorrent(
    [{ path: ["Huge.mkv"], length: 120_000 * 64 * 1024 }],
    64 * 1024,
  );
  const info = parseInfo(torrent.infoBytes);
  const chunks = buildChunksRecord(ID, info, selectVideoFile(info), Date.now());

  assertEquals(chunks.pieces.length, info.pieceCount * 20);
  assertEquals(chunks.files.length, info.files.length);
});

Deno.test({
  name: "sl-stream verifies a 120k-piece torrent rather than streaming it blind",
  ignore: skip,
  async fn() {
    const torrent = await makeTorrent(
      [{ path: ["Huge.mkv"], length: 120_000 * 64 * 1024 }],
      64 * 1024,
    );
    const info = parseInfo(torrent.infoBytes);
    const chunks = buildChunksRecord(ID, info, selectVideoFile(info), Date.now());

    // This used to assert `pieceHashes === null`: the record had shed them to fit and sl-stream
    // degraded to unverified streaming. It no longer has to.
    const { layout } = sl!.adaptLayout(chunks);
    assertEquals(layout.pieceCount, info.pieceCount);
    assertEquals(layout.pieceHashes?.length, info.pieceCount * 20);
  },
});

Deno.test({
  name: "sl-stream routes our peer record to both transports",
  ignore: skip,
  fn() {
    // sl-stream now speaks the peer wire, so `{ip, port}` entries are dialled rather than turned
    // into unusable HTTP URLs. This asserts the split against its real classifier.
    const peers: DiscoveredPeer[] = [
      { ip: "1.2.3.4", port: 6881, source: "dht", verified: true },
      { ip: "5.6.7.8", port: 51413, source: "udp", verified: false },
    ];
    const record = buildPeersRecord(ID, peers, ["https://cdn.example/file.mkv"], Date.now());

    const adapted = sl!.adaptPeers(record);

    // The webseed has to reach the HTTP tier, which only happens because it is inside `peers`.
    assertEquals(adapted.http.length, 1);
    assertEquals(adapted.http[0]!.url, "https://cdn.example/file.mkv");

    assertEquals(adapted.bt, [
      { host: "1.2.3.4", port: 6881 },
      { host: "5.6.7.8", port: 51413 },
    ]);
  },
});

Deno.test({
  name: "a webseed left outside the peers array would be dropped",
  ignore: skip,
  fn() {
    // Why buildPeersRecord merges rather than relying on the sibling field: `adaptPeers` reads the
    // `peers` array and nothing else. This pins the reason so the merge is not "tidied" away.
    const orphaned = { peers: [], webseeds: ["https://cdn.example/file.mkv"] };
    assertEquals(sl!.adaptPeers(orphaned).http.length, 0);
  },
});

Deno.test({
  name: "our id enables sl-stream's BitTorrent tier",
  ignore: skip,
  fn() {
    // The tier is switched off unless the route id is a 40-hex info hash. Ours always is.
    const infoHash = sl!.infoHashFromId(ID);
    assert(infoHash !== null);
    assertEquals(infoHash.length, 20);
  },
});

Deno.test({
  name: "verified peers are written first",
  fn() {
    const peers: DiscoveredPeer[] = [
      { ip: "1.1.1.1", port: 1, source: "dht", verified: false },
      { ip: "2.2.2.2", port: 2, source: "udp", verified: true },
    ];
    // buildPeersRecord preserves the order the queue snapshot gives it, which is verified-first.
    const record = buildPeersRecord(ID, [peers[1]!, peers[0]!], [], Date.now());
    const bt = record.peers.filter(isBtEntry);
    assertEquals(bt[0]!.verified, true);
    assertEquals(record.count, 2);
  },
});
