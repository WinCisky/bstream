/**
 * `GET /peers/:id`, from the database up.
 *
 * The route exists to answer "who do I dial now", so the properties worth pinning are the three
 * things it does that a raw read of `peer_records` does not: it drops peers the consumer has
 * banned, it puts the entries worth dialling first, and it says out loud how old the answer is.
 * The refresh modes are covered in `resolve` and `handler` terms elsewhere; nothing here walks a
 * swarm.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { ChunksRecord, MagnetIndexRecord, PeersRecord } from "../src/db/records.ts";
import { isBtEntry } from "../src/db/records.ts";
import { config } from "../src/config.ts";
import { persist, type PersistInput } from "../src/db/store.ts";
import { parseRefreshMode, readPeersView } from "../src/peers_view.ts";
import { ResolveError } from "../src/resolve.ts";
import { banPeer, testDatabase } from "./support/db.ts";

const db = await testDatabase();
const MiB = 1024 * 1024;
const RESOLVED_AT = 1_700_000_000_000;
let counter = 0;

function fixture(id: string): PersistInput {
  const index: MagnetIndexRecord = {
    version: 1,
    id,
    magnet: `magnet:?xt=urn:btih:${id}`,
    infoHash: id,
    name: "Peers.1080p",
    trackers: ["udp://tracker.example:1337"],
    createdAt: RESOLVED_AT,
    updatedAt: RESOLVED_AT,
    peerCount: 3,
  };

  const peers: PeersRecord = {
    version: 1,
    infoHash: id,
    resolvedAt: RESOLVED_AT,
    count: 3,
    peers: [
      "https://cdn.example/Peers.mkv",
      { ip: "1.2.3.4", port: 6881, source: "dht", verified: false },
      { ip: "5.6.7.8", port: 51413, source: "udp", verified: true },
      { ip: "9.9.9.9", port: 6889, source: "http", verified: false },
    ],
    webseeds: ["https://cdn.example/Peers.mkv"],
  };

  const chunks: ChunksRecord = {
    version: 1,
    infoHash: id,
    name: "Peers.1080p",
    pieceLength: 1 * MiB,
    pieceCount: 2,
    totalLength: 2 * MiB,
    pieces: new Uint8Array(40),
    files: [{ path: "Peers.mkv", length: 2 * MiB, offset: 0, mime: "video/x-matroska" }],
    fileIndex: 0,
    filePath: "Peers.mkv",
    fileOffset: 0,
    fileLength: 2 * MiB,
    mime: "video/x-matroska",
    resolvedAt: RESOLVED_AT,
  };

  return { id, index, peers, chunks, force: false };
}

async function seed(): Promise<PersistInput> {
  const input = fixture((++counter).toString(16).padStart(40, "0"));
  await persist(db, input);
  return input;
}

Deno.test("webseeds lead, then verified peers, then the rest", async () => {
  const input = await seed();
  const view = await readPeersView(input.id, { db, now: RESOLVED_AT });

  assertEquals(view.peers.map((p) => (isBtEntry(p) ? `${p.ip}:${p.port}` : p)), [
    "https://cdn.example/Peers.mkv",
    "5.6.7.8:51413",
    "1.2.3.4:6881",
    "9.9.9.9:6889",
  ]);
  // Discovery order is kept inside a group: both unverified peers stayed as stored.
  assertEquals(view.webseeds, ["https://cdn.example/Peers.mkv"]);
});

Deno.test("count is BitTorrent endpoints only, webseeds excluded", async () => {
  const input = await seed();
  const view = await readPeersView(input.id, { db, now: RESOLVED_AT });
  assertEquals(view.count, 3);
  assertEquals(view.peers.length, 4);
});

Deno.test("a live ban removes the peer and is counted", async () => {
  const input = await seed();
  await banPeer(db, input.id, "5.6.7.8:51413", RESOLVED_AT + 60_000);

  const view = await readPeersView(input.id, { db, now: RESOLVED_AT });
  assertEquals(view.count, 2);
  assertEquals(view.bannedCount, 1);
  assertEquals(view.peers.some((p) => isBtEntry(p) && p.ip === "5.6.7.8"), false);
});

Deno.test("an expired ban does not remove the peer", async () => {
  const input = await seed();
  await banPeer(db, input.id, "5.6.7.8:51413", RESOLVED_AT - 1);

  const view = await readPeersView(input.id, { db, now: RESOLVED_AT });
  assertEquals(view.count, 3);
  assertEquals(view.bannedCount, 0);
});

Deno.test("a banned webseed is dropped too, by its URL", async () => {
  const input = await seed();
  await banPeer(db, input.id, "https://cdn.example/Peers.mkv", RESOLVED_AT + 60_000);

  const view = await readPeersView(input.id, { db, now: RESOLVED_AT });
  assertEquals(view.peers.length, 3);
  assertEquals(view.count, 3);
  // Still reported in `webseeds`: that field is what the record holds, not what to dial.
  assertEquals(view.webseeds, ["https://cdn.example/Peers.mkv"]);
});

Deno.test("age and staleness are reported against the record's own timestamp", async () => {
  const input = await seed();

  const fresh = await readPeersView(input.id, { db, now: RESOLVED_AT + 1_000 });
  assertEquals(fresh.resolvedAt, RESOLVED_AT);
  assertEquals(fresh.ageMs, 1_000);
  assertEquals(fresh.stale, false);

  const old = await readPeersView(input.id, { db, now: RESOLVED_AT + config.peersStaleMs + 1 });
  assertEquals(old.stale, true);
  assertEquals(old.refreshed, false);
});

Deno.test("every peer banned is an empty 200, not a 404", async () => {
  const input = await seed();
  for (const key of ["1.2.3.4:6881", "5.6.7.8:51413", "9.9.9.9:6889"]) {
    await banPeer(db, input.id, key, RESOLVED_AT + 60_000);
  }
  await banPeer(db, input.id, "https://cdn.example/Peers.mkv", RESOLVED_AT + 60_000);

  const view = await readPeersView(input.id, { db, now: RESOLVED_AT });
  assertEquals(view.peers, []);
  assertEquals(view.count, 0);
  assertEquals(view.bannedCount, 4);
});

Deno.test("an unresolved id is 404", async () => {
  const error = await assertRejects(() => readPeersView("f".repeat(40), { db }), ResolveError);
  assertEquals(error.status, 404);
  assertEquals(error.code, "unknown_id");
});

Deno.test("a malformed id is 400 and never reaches the database", async () => {
  for (const bad of ["nope", "", "ZZ" + "0".repeat(38), "0".repeat(39)]) {
    const error = await assertRejects(() => readPeersView(bad, { db }), ResolveError);
    assertEquals(error.status, 400);
    assertEquals(error.code, "bad_id");
  }
});

Deno.test("an uppercase id reads the same record", async () => {
  const input = await seed();
  const view = await readPeersView(input.id.toUpperCase(), { db, now: RESOLVED_AT });
  assertEquals(view.id, input.id);
});

Deno.test("refresh modes parse, and an unknown one is 400", () => {
  assertEquals(parseRefreshMode(null), "never");
  assertEquals(parseRefreshMode(""), "never");
  assertEquals(parseRefreshMode("0"), "never");
  assertEquals(parseRefreshMode("auto"), "auto");
  assertEquals(parseRefreshMode("1"), "always");
  assertEquals(parseRefreshMode("always"), "always");

  const error = assertThrowsResolve(() => parseRefreshMode("yes"));
  assertEquals(error.status, 400);
  assertEquals(error.code, "bad_refresh_mode");
});

function assertThrowsResolve(fn: () => unknown): ResolveError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ResolveError) return err;
    throw err;
  }
  throw new Error("expected a ResolveError");
}

Deno.test("teardown", async () => {
  await db.close();
});
