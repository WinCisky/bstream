/**
 * The `GET /records/:id` body, fed to the code that will consume it.
 *
 * `contract_test.ts` checks the *records* against sl-stream's adapter. This checks the *route* —
 * the JSON that leaves the wire — against torrent-ws-streamer's `normalizeRecords`, the Worker's
 * single intake point for both of its record sources. That reader is stricter than the adapter and
 * strict in different places: it re-derives `pieceCount === ceil(totalLength / pieceLength)`,
 * insists `pieces.length === pieceCount * 20` after decoding, classifies webseeds structurally out
 * of the `peers` array, and treats a null `bannedUntil` as "never banned" where `Number(null)`
 * would have said "banned until the epoch". Every one of those is a way this route could be subtly
 * wrong while looking fine.
 *
 * The import is sloppy-resolved (the Worker's own imports are extensionless) and skipped when the
 * sibling checkout is not present, the same shape the sl-stream contract test uses.
 */

import { assert, assertEquals } from "@std/assert";
import type { ChunksRecord, MagnetIndexRecord, PeersRecord } from "../src/db/records.ts";
import { persist, type PersistInput } from "../src/db/store.ts";
import { readRecords } from "../src/records_view.ts";
import { banPeer, testDatabase } from "./support/db.ts";

const MiB = 1024 * 1024;
const ID = "08ada5a7a6183aae1e09d831df6748d566095a10";

interface ConsumerChunks {
  infoHash: string;
  name: string;
  pieceLength: number;
  pieceCount: number;
  totalLength: number;
  pieces: Uint8Array;
  files: { path: string; length: number; offset: number; padding?: true; mime?: string }[];
  fileIndex: number;
  filePath: string;
  fileOffset: number;
  fileLength: number;
  mime: string;
}

interface ConsumerPeers {
  infoHash: string;
  count: number;
  webseeds: string[];
  endpoints: { ip: string; port: number; source?: string; verified?: true }[];
}

interface Consumer {
  normalizeRecords(
    chunks: unknown,
    peers: unknown,
    health: unknown,
    now: number,
  ): { chunks: ConsumerChunks; peers: ConsumerPeers; bans: Map<string, number> };
}

/**
 * The Worker is not a sibling checkout the way sl-stream is, so its location is configurable:
 * `MA_CONSUMER_RECORDS` overrides the path, and the default is where it currently lives. A wrong
 * path skips the file rather than failing it — same as an absent checkout.
 */
const consumerUrl = new URL(
  Deno.env.get("MA_CONSUMER_RECORDS") ??
    "../../../../Projects/leet-cloud-test-01/src/records.ts",
  import.meta.url,
);
let consumer: Consumer | null = null;
try {
  consumer = await import(consumerUrl.href) as Consumer;
} catch {
  consumer = null;
}

const skip = consumer === null;
const db = skip ? null : await testDatabase();

function fixture(): PersistInput {
  const pieceLength = 1 * MiB;
  const pieceCount = 4;
  const totalLength = pieceCount * pieceLength;
  const pieces = new Uint8Array(pieceCount * 20);
  for (let i = 0; i < pieces.length; i++) pieces[i] = (i * 13) % 256;

  const index: MagnetIndexRecord = {
    version: 1,
    id: ID,
    magnet: `magnet:?xt=urn:btih:${ID}`,
    infoHash: ID,
    name: "Test.Release.1080p",
    trackers: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    peerCount: 2,
  };

  const peers: PeersRecord = {
    version: 1,
    infoHash: ID,
    resolvedAt: 1_700_000_000_000,
    count: 2,
    peers: [
      "https://cdn.example/Test.Release.1080p/Feature.mkv",
      { ip: "1.2.3.4", port: 6881, source: "dht", verified: true },
      { ip: "5.6.7.8", port: 51413, source: "udp", verified: false },
    ],
    webseeds: ["https://cdn.example/Test.Release.1080p/Feature.mkv"],
  };

  const chunks: ChunksRecord = {
    version: 1,
    infoHash: ID,
    name: "Test.Release.1080p",
    pieceLength,
    pieceCount,
    totalLength,
    pieces,
    files: [
      { path: "Sample/sample.mkv", length: 1 * MiB, offset: 0, mime: "video/x-matroska" },
      { path: ".pad/1048576", length: 1 * MiB, offset: 1 * MiB, padding: true },
      { path: "Feature.mkv", length: 2 * MiB, offset: 2 * MiB, mime: "video/x-matroska" },
    ],
    fileIndex: 2,
    filePath: "Feature.mkv",
    fileOffset: 2 * MiB,
    fileLength: 2 * MiB,
    mime: "video/x-matroska",
    resolvedAt: 1_700_000_000_000,
  };

  return { id: ID, index, peers, chunks, force: false };
}

/** Seed once, then read the route's body back exactly as a caller would see it. */
const stored = fixture();
const body = skip ? null : await (async () => {
  await persist(db!, stored);
  await banPeer(db!, ID, "5.6.7.8:51413", Date.now() + 300_000);
  // JSON round trip: everything below is asserted against what survives the wire, not against
  // in-process objects that never had to be serialized.
  return JSON.parse(JSON.stringify(await readRecords(ID, { db: db! })));
})();

Deno.test({
  name: "the route body is accepted by the Worker's normalizeRecords",
  ignore: skip,
  fn: () => {
    const out = consumer!.normalizeRecords(body.chunks, body.peers, body.health, Date.now());
    assertEquals(out.chunks.infoHash, ID);
    assertEquals(out.chunks.name, "Test.Release.1080p");
  },
});

Deno.test({
  name: "base64 pieces decode back to the exact hash blob the Worker will verify against",
  ignore: skip,
  fn: () => {
    const out = consumer!.normalizeRecords(body.chunks, body.peers, body.health, Date.now());
    // The Worker never hashes; the browser does, against these bytes. A shifted blob would fail
    // every piece while every length check still passed.
    assertEquals(out.chunks.pieces, stored.chunks.pieces);
    assertEquals(out.chunks.pieces.length, stored.chunks.pieceCount * 20);
  },
});

Deno.test({
  name: "geometry survives the wire, so the Worker's own ceil() check agrees",
  ignore: skip,
  fn: () => {
    const { chunks } = consumer!.normalizeRecords(body.chunks, body.peers, body.health, Date.now());
    assertEquals(chunks.pieceCount, Math.ceil(chunks.totalLength / chunks.pieceLength));
    assertEquals(chunks.pieceLength, stored.chunks.pieceLength);
    assertEquals(chunks.totalLength, stored.chunks.totalLength);
  },
});

Deno.test({
  name: "the selected file resolves to the same bytes on both sides",
  ignore: skip,
  fn: () => {
    const { chunks } = consumer!.normalizeRecords(body.chunks, body.peers, body.health, Date.now());
    assertEquals(chunks.fileIndex, stored.chunks.fileIndex);
    assertEquals(chunks.filePath, stored.chunks.filePath);
    assertEquals(chunks.fileOffset, stored.chunks.fileOffset);
    assertEquals(chunks.fileLength, stored.chunks.fileLength);
    // fileIndex is a position in the list, so the list has to have kept its order.
    assertEquals(chunks.files[chunks.fileIndex]!.path, "Feature.mkv");
    assertEquals(chunks.files[1]!.padding, true);
  },
});

Deno.test({
  name: "the peers array splits into both transports",
  ignore: skip,
  fn: () => {
    const { peers } = consumer!.normalizeRecords(body.chunks, body.peers, body.health, Date.now());
    // The Worker classifies structurally over `peers` and never reads the `webseeds` column, so a
    // webseed that fell out of that array would silently disable its primary transport.
    assertEquals(peers.webseeds, ["https://cdn.example/Test.Release.1080p/Feature.mkv"]);
    assertEquals(peers.endpoints.length, 2);
    assertEquals(peers.endpoints[0]!.ip, "1.2.3.4");
    assertEquals(peers.endpoints[0]!.port, 6881);
    assertEquals(peers.endpoints[0]!.verified, true);
    assertEquals(peers.count, 2);
  },
});

Deno.test({
  name: "health reaches the Worker as a live ban",
  ignore: skip,
  fn: () => {
    const { bans } = consumer!.normalizeRecords(body.chunks, body.peers, body.health, Date.now());
    assert(bans.has("5.6.7.8:51413"), "the banned peer must arrive banned");
    assertEquals(bans.has("1.2.3.4:6881"), false);
  },
});

Deno.test({
  name: "teardown",
  ignore: skip,
  fn: async () => {
    await db!.close();
  },
});
