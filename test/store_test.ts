/**
 * The storage layer on its own, with no swarm anywhere near it.
 *
 * These are the properties the move off Deno KV either preserved or newly bought, and they are
 * cheap to check here and expensive to debug anywhere else:
 *
 *  - first-writer-wins, which used to be `check({ versionstamp: null })`;
 *  - a chunk record that is never shrunk, which is the whole argument for the migration;
 *  - round-trip fidelity through `jsonb` and `bytea`, where the two drivers disagree about types;
 *  - the geometry constraint, which is new — the database now refuses a record that would make
 *    sl-stream 500 for that id forever.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { applyMigrations } from "../src/db/migrate.ts";
import type { Database } from "../src/db/sql.ts";
import {
  persist,
  type PersistInput,
  persistPeers,
  readBannedPeers,
  readChunks,
  readIndex,
  readPeers,
} from "../src/db/store.ts";
import type { ChunksRecord, MagnetIndexRecord, PeersRecord } from "../src/db/records.ts";
import { isBtEntry } from "../src/db/records.ts";
import { banPeer, realDatabase, testDatabase } from "./support/db.ts";

const db = await testDatabase();

const MiB = 1024 * 1024;
let counter = 0;

function idFor(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function fixture(id: string, pieceCount = 4): PersistInput {
  const pieceLength = 1 * MiB;
  const totalLength = pieceCount * pieceLength;
  const pieces = new Uint8Array(pieceCount * 20);
  for (let i = 0; i < pieces.length; i++) pieces[i] = i % 256;

  const index: MagnetIndexRecord = {
    version: 1,
    id,
    magnet: `magnet:?xt=urn:btih:${id}`,
    infoHash: id,
    name: "Fixture.1080p",
    trackers: ["udp://tracker.example:1337", "http://tracker.example/announce"],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    peerCount: 2,
  };

  const peers: PeersRecord = {
    version: 1,
    infoHash: id,
    resolvedAt: 1_700_000_000_000,
    count: 2,
    // Webseeds first, then BitTorrent endpoints, in one array: sl-stream classifies structurally
    // and reads nothing else.
    peers: [
      "https://cdn.example/Fixture.mkv",
      { ip: "1.2.3.4", port: 6881, source: "dht", verified: true },
      { ip: "5.6.7.8", port: 51413, source: "udp", verified: false },
    ],
    webseeds: ["https://cdn.example/Fixture.mkv"],
  };

  const chunks: ChunksRecord = {
    version: 1,
    infoHash: id,
    name: "Fixture.1080p",
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

  return { id, index, peers, chunks, force: false };
}

function fresh(pieceCount = 4): PersistInput {
  return fixture(idFor(++counter), pieceCount);
}

Deno.test("a record survives the round trip unchanged", async () => {
  const input = fresh();
  assertEquals((await persist(db, input)).created, true);

  const index = await readIndex(db, input.id);
  const peers = await readPeers(db, input.id);
  const chunks = await readChunks(db, input.id);
  assert(index && peers && chunks, "all three records must exist");

  // Not a field-by-field spot check: the whole record, because the failures worth catching here
  // are a bigint that came back as a string and a bytea that came back as a Buffer.
  assertEquals(index, input.index);
  assertEquals(peers, input.peers);
  assertEquals(chunks, input.chunks);
});

Deno.test("the mixed peers array keeps its order and its two shapes", async () => {
  const input = fresh();
  await persist(db, input);
  const peers = (await readPeers(db, input.id))!;

  assertEquals(peers.peers[0], "https://cdn.example/Fixture.mkv", "webseeds lead");
  const bt = peers.peers.filter(isBtEntry);
  assertEquals(bt.length, 2);
  assertEquals(bt[0]!.verified, true, "verified peers stay first");
  assertEquals(peers.count, 2, "count is BitTorrent peers, not webseeds");
});

Deno.test("every file keeps its position, padding included", async () => {
  const input = fresh();
  await persist(db, input);
  const chunks = (await readChunks(db, input.id))!;

  // A reader that skipped unusable entries would shift every later index by one, and `?file=3`
  // would silently stream file 4.
  assertEquals(chunks.files.map((file) => file.path), [
    "Sample/sample.mkv",
    ".pad/1048576",
    "Feature.mkv",
  ]);
  assertEquals(chunks.files[1]!.padding, true);
});

Deno.test("a second persist without force defers to the first", async () => {
  const input = fresh();
  await persist(db, input);

  const second: PersistInput = {
    ...input,
    index: { ...input.index, name: "Overwritten", magnet: "magnet:?xt=urn:btih:other" },
  };
  assertEquals((await persist(db, second)).created, false);

  const index = (await readIndex(db, input.id))!;
  assertEquals(index.name, "Fixture.1080p", "the first writer's record is left alone");
  assertEquals(index.magnet, input.index.magnet);
});

Deno.test("force overwrites, but keeps the original createdAt", async () => {
  const input = fresh();
  await persist(db, input);

  const forced: PersistInput = {
    ...input,
    force: true,
    index: {
      ...input.index,
      name: "Renamed",
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    },
  };
  assertEquals((await persist(db, forced)).created, true);

  const index = (await readIndex(db, input.id))!;
  assertEquals(index.name, "Renamed");
  assertEquals(index.updatedAt, 1_800_000_000_000);
  // A forced re-resolve replaces the correlation, not the fact of when it was first made.
  assertEquals(index.createdAt, 1_700_000_000_000);
});

Deno.test("a 120k-piece record is stored whole", async () => {
  // 2.4 MB of piece hashes. Under Deno KV this blew past the 64 KiB value cap and the writer
  // degraded in defined steps — hashes to an overflow namespace, then the file list. That ladder
  // is the thing this migration deleted, so the property to pin is that nothing is dropped.
  const pieceCount = 120_000;
  const input = fresh(pieceCount);
  await persist(db, input);

  const chunks = (await readChunks(db, input.id))!;
  assertEquals(chunks.pieces.length, pieceCount * 20);
  assertEquals(chunks.files.length, 3, "the file list survives at any size");
  assertEquals(chunks.pieceCount, pieceCount);
});

Deno.test("the database refuses geometry sl-stream would 500 over", async () => {
  const input = fresh();
  // pieceCount must equal ceil(totalLength / pieceLength) exactly. Under KV only parseInfo stood
  // between a bad record and an id that 500s forever; here the write itself fails.
  const broken: PersistInput = {
    ...input,
    chunks: { ...input.chunks, pieceCount: input.chunks.pieceCount + 1 },
  };
  await assertRejects(() => persist(db, broken));

  // And the transaction took the magnet row with it.
  assertEquals(await readIndex(db, input.id), null);
});

Deno.test("the database refuses a hash blob of the wrong length", async () => {
  const input = fresh();
  const broken: PersistInput = {
    ...input,
    chunks: { ...input.chunks, pieces: new Uint8Array(input.chunks.pieces.length - 20) },
  };
  await assertRejects(() => persist(db, broken));
});

Deno.test("persistPeers rewrites the peers and never touches the chunks", async () => {
  const input = fresh();
  await persist(db, input);
  const before = (await readChunks(db, input.id))!;

  const rewritten: PeersRecord = {
    ...input.peers,
    resolvedAt: 1_800_000_000_000,
    count: 1,
    peers: [{ ip: "9.9.9.9", port: 6881, source: "pex", verified: true }],
    webseeds: [],
  };
  await persistPeers(db, input.id, rewritten, 1_800_000_000_000);

  assertEquals(await readPeers(db, input.id), rewritten);
  assertEquals(await readChunks(db, input.id), before, "the infohash pins the metadata");

  const index = (await readIndex(db, input.id))!;
  assertEquals(index.updatedAt, 1_800_000_000_000);
  assertEquals(index.peerCount, 1);
  // The targeted UPDATE must not have written the rest of the row back from a stale copy.
  assertEquals(index.magnet, input.index.magnet);
});

Deno.test("only unexpired bans are returned", async () => {
  const input = fresh();
  await persist(db, input);
  const now = Date.now();

  await banPeer(db, input.id, "1.2.3.4:6881", now + 60_000);
  await banPeer(db, input.id, "5.6.7.8:51413", now - 60_000);

  const banned = await readBannedPeers(db, input.id, now);
  assertEquals([...banned], ["1.2.3.4:6881"]);
});

Deno.test("peer health survives an id with no magnet row", async () => {
  // sl-stream can ban a peer for an id this service has never resolved — a race against a first
  // resolve, or a magnet deleted since. A foreign key here would turn its telemetry write into an
  // error path, so there deliberately is not one.
  const orphan = idFor(9_000_000);
  const now = Date.now();
  await banPeer(db, orphan, "1.1.1.1:1", now + 60_000);
  assertEquals([...(await readBannedPeers(db, orphan, now))], ["1.1.1.1:1"]);
});

Deno.test("deleting a magnet takes its records with it", async () => {
  const input = fresh();
  await persist(db, input);
  await db.query("delete from magnets where id = $1", [input.id]);

  assertEquals(await readPeers(db, input.id), null);
  assertEquals(await readChunks(db, input.id), null);
});

Deno.test("reads of an unknown id are null, not an error", async () => {
  const unknown = idFor(9_999_999);
  assertEquals(await readIndex(db, unknown), null);
  assertEquals(await readPeers(db, unknown), null);
  assertEquals(await readChunks(db, unknown), null);
});

Deno.test("applying the migrations twice is a no-op", async () => {
  assertEquals(await applyMigrations(db), [], "everything is already recorded");
});

Deno.test({
  name: "concurrent persists of one id produce exactly one winner",
  // PGlite has a single backend and serialises everything, so it cannot express this. Needs a real
  // Postgres; skipped rather than faked when MA_TEST_DATABASE_URL is unset.
  ignore: !Deno.env.get("MA_TEST_DATABASE_URL"),
  async fn() {
    const real = (await realDatabase()) as Database;
    try {
      const input = fixture(idFor(1));
      const results = await Promise.all(
        Array.from({ length: 8 }, () => persist(real, input)),
      );
      assertEquals(results.filter((r) => r.created).length, 1, "one writer wins, seven defer");

      const rows = await real.query("select count(*)::int as n from magnets where id = $1", [
        input.id,
      ]);
      assertEquals(rows.rows[0]!.n, 1);
      assert(await readChunks(real, input.id), "the winner wrote a complete record set");
    } finally {
      await real.close();
    }
  },
});

Deno.test("teardown", async () => {
  await db.close();
});
