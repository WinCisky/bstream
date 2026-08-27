/**
 * `GET /records/:id`, from the database up.
 *
 * The route exists so a caller can inline the records into sl-stream's `start` frame instead of
 * paying two PostgREST subrequests for them, which means the only property that matters is that the
 * body is *exactly* what sl-stream would have read itself. So the assertions are about faithfulness
 * — base64 that decodes back to the same hash blob, a positional file list that stayed positional,
 * a peers array that kept both of its shapes — and not about the three point queries working.
 *
 * `contract_test.ts` proves the records satisfy sl-stream's adapter. This proves the JSON does not
 * lose anything on the way out.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { toBase64 } from "../src/bytes.ts";
import type { ChunksRecord, MagnetIndexRecord, PeersRecord } from "../src/db/records.ts";
import { persist, type PersistInput } from "../src/db/store.ts";
import { readRecords } from "../src/records_view.ts";
import { ResolveError } from "../src/resolve.ts";
import { banPeer, testDatabase } from "./support/db.ts";

const db = await testDatabase();
const MiB = 1024 * 1024;
let counter = 0;

function fixture(id: string): PersistInput {
  const pieceLength = 1 * MiB;
  const pieceCount = 4;
  const totalLength = pieceCount * pieceLength;
  const pieces = new Uint8Array(pieceCount * 20);
  for (let i = 0; i < pieces.length; i++) pieces[i] = (i * 7) % 256;

  const index: MagnetIndexRecord = {
    version: 1,
    id,
    magnet: `magnet:?xt=urn:btih:${id}`,
    infoHash: id,
    name: "Records.1080p",
    trackers: ["udp://tracker.example:1337"],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    peerCount: 2,
  };

  const peers: PeersRecord = {
    version: 1,
    infoHash: id,
    resolvedAt: 1_700_000_000_000,
    count: 2,
    peers: [
      "https://cdn.example/Records.mkv",
      { ip: "1.2.3.4", port: 6881, source: "dht", verified: true },
      { ip: "5.6.7.8", port: 51413, source: "udp", verified: false },
    ],
    webseeds: ["https://cdn.example/Records.mkv"],
  };

  const chunks: ChunksRecord = {
    version: 1,
    infoHash: id,
    name: "Records.1080p",
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

async function seed(): Promise<PersistInput> {
  const input = fixture((++counter).toString(16).padStart(40, "0"));
  await persist(db, input);
  return input;
}

/** Round-trip through JSON, because that is what the route actually hands the caller. */
function overTheWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

Deno.test("the body is sl-stream's start.records, key for key", async () => {
  const input = await seed();
  const body = overTheWire(await readRecords(input.id, { db }));

  assertEquals(Object.keys(body).sort(), ["chunks", "health", "peers"]);
  assertEquals(body.peers, input.peers as unknown as typeof body.peers);
  assertEquals(body.health, []);
});

Deno.test("pieces survives as base64 of exactly the stored blob", async () => {
  const input = await seed();
  const body = overTheWire(await readRecords(input.id, { db }));

  assertEquals(body.chunks.pieces, toBase64(input.chunks.pieces));
  const decoded = Uint8Array.from(atob(body.chunks.pieces), (c) => c.charCodeAt(0));
  assertEquals(decoded, input.chunks.pieces);
  assertEquals(decoded.length, input.chunks.pieceCount * 20);
});

Deno.test("every chunk field except pieces is untouched", async () => {
  const input = await seed();
  const body = overTheWire(await readRecords(input.id, { db }));

  const { pieces: _dropped, ...rest } = body.chunks;
  const { pieces: _stored, ...expected } = input.chunks;
  // Whole-object, not a spot check: a bigint that came back as a string would pass any single
  // field assertion that used Number() on it first.
  assertEquals(rest, expected as unknown as typeof rest);
});

Deno.test("the file list stays positional, padding entries included", async () => {
  const input = await seed();
  const body = overTheWire(await readRecords(input.id, { db }));

  assertEquals(body.chunks.files.map((f) => f.path), [
    "Sample/sample.mkv",
    ".pad/1048576",
    "Feature.mkv",
  ]);
  assertEquals(body.chunks.files[1]!.padding, true);
  // fileIndex addresses this array; a reordered list would point at the wrong file.
  assertEquals(body.chunks.files[body.chunks.fileIndex]!.path, body.chunks.filePath);
});

Deno.test("health carries sl-stream's own bookkeeping, expiry included", async () => {
  const input = await seed();
  const bannedUntil = Date.now() + 60_000;
  await banPeer(db, input.id, "1.2.3.4:6881", bannedUntil);

  const body = overTheWire(await readRecords(input.id, { db }));
  assertEquals(body.health.length, 1);
  assertEquals(body.health[0]!.peerKey, "1.2.3.4:6881");
  assertEquals(body.health[0]!.bannedUntil, bannedUntil);
  assertEquals(body.health[0]!.fails, 1);
});

Deno.test("an expired ban is still reported, with its instant intact", async () => {
  const input = await seed();
  // Not filtered here: sl-stream re-derives the ban set against its own clock, so dropping rows
  // that this process considers stale would hide a peer with a failure history from it.
  await banPeer(db, input.id, "5.6.7.8:51413", Date.now() - 60_000);

  const body = overTheWire(await readRecords(input.id, { db }));
  assertEquals(body.health.length, 1);
  assert(body.health[0]!.bannedUntil! < Date.now());
});

Deno.test("a peer that was never banned keeps a null bannedUntil, not a zero", async () => {
  const input = await seed();
  await db.query(
    `insert into peer_health (id, peer_key, banned_until, ok, fails, updated_at)
     values ($1, $2, null, 12, 0, $3)`,
    [input.id, "1.2.3.4:6881", Date.now()],
  );

  const body = overTheWire(await readRecords(input.id, { db }));
  assertEquals(body.health[0]!.bannedUntil, null);
  assertEquals(body.health[0]!.ok, 12);
});

Deno.test("an unresolved id is 404, not an empty record set", async () => {
  const error = await assertRejects(
    () => readRecords("f".repeat(40), { db }),
    ResolveError,
  );
  assertEquals(error.status, 404);
  assertEquals(error.code, "unknown_id");
});

Deno.test("a malformed id is 400 and never reaches the database", async () => {
  for (const bad of ["nope", "", "ZZ" + "0".repeat(38), "0".repeat(39)]) {
    const error = await assertRejects(() => readRecords(bad, { db }), ResolveError);
    assertEquals(error.status, 400);
    assertEquals(error.code, "bad_id");
  }
});

Deno.test("an uppercase id reads the same record", async () => {
  const input = await seed();
  const body = await readRecords(input.id.toUpperCase(), { db });
  assertEquals(body.chunks.infoHash, input.id);
});

Deno.test("teardown", async () => {
  await db.close();
});
