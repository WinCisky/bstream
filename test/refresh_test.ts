/**
 * Peer refresh: the path sl-stream calls when the peers it was handed have gone stale.
 *
 * The properties that matter are not "it finds peers" — that is the resolver's job, already tested.
 * They are the safety ones: the chunk record is never touched, a bad walk never destroys a good
 * record, sl-stream's bans are honoured, and the route is closed by default.
 */

import { assert, assertEquals } from "@std/assert";
import { toHex } from "../src/bytes.ts";
import { isBtEntry } from "../src/db/records.ts";
import { readChunks, readPeers } from "../src/db/store.ts";
import { refreshPeers, resolveMagnet, type ResolveTuning } from "../src/resolve.ts";
import { banPeer, clearPeerHealth, testDatabase } from "./support/db.ts";
import { type FakePeer, startFakePeer } from "./support/fake_peer.ts";
import { makeTorrent } from "./support/torrent.ts";

const MiB = 1024 * 1024;

const TUNING: Partial<ResolveTuning> = {
  enableUdpTrackers: false,
  enableHttpTrackers: false,
  enableDht: false,
  enablePex: false,
  allowPrivatePeers: true,
  minPeers: 1,
  peerGraceMs: 200,
  resolveDeadlineMs: 6_000,
  sessionTimeoutMs: 2_000,
  connectTimeoutMs: 1_000,
};

const db = await testDatabase();

let fixtureCounter = 0;

interface Fixture {
  readonly id: string;
  readonly peer: FakePeer;
  readonly magnet: string;
}

/** Resolve a magnet against a local peer, leaving a complete record set behind. */
async function seed(): Promise<Fixture> {
  const torrent = await makeTorrent(
    [
      { path: ["Sample", "sample.mkv"], length: 3 * MiB },
      { path: ["Feature.mkv"], length: 700 * MiB },
    ],
    1 * MiB,
    `Refresh.fixture-${++fixtureCounter}`,
  );
  const peer = startFakePeer({ infoHash: torrent.infoHash, infoBytes: torrent.infoBytes });
  const magnet = `magnet:?xt=urn:btih:${toHex(torrent.infoHash)}` +
    `&x.pe=${encodeURIComponent(`127.0.0.1:${peer.port}`)}`;
  const result = await resolveMagnet(magnet, { db, tuning: TUNING });
  return { id: result.id, peer, magnet };
}

Deno.test("refresh rewrites the peers and leaves the chunk record untouched", async () => {
  const { id, peer } = await seed();
  try {
    const before = (await readChunks(db, id))!;
    const peersBefore = (await readPeers(db, id))!;

    const result = await refreshPeers(id, { db, tuning: TUNING });
    assertEquals(result.id, id);
    assertEquals(result.updated, true);
    assert(result.peerCount >= 1);
    assertEquals(result.verifiedPeerCount, 1, "the local peer answers a handshake");

    const after = (await readChunks(db, id))!;
    // The infohash pins the metadata, so a refresh has no business rewriting this.
    assertEquals(after.resolvedAt, before.resolvedAt);
    assertEquals(after.pieceCount, before.pieceCount);
    assertEquals(after.pieces.length, before.pieces.length);

    const peersAfter = (await readPeers(db, id))!;
    assert(
      peersAfter.resolvedAt >= peersBefore.resolvedAt,
      "the peer record should carry a fresh timestamp",
    );
  } finally {
    peer.close();
  }
});

Deno.test("refresh skips metadata entirely", async () => {
  const { id, peer } = await seed();
  try {
    // A resolve costs one connection. A refresh costs one more, and must not re-fetch the info
    // dict: the fake peer counts connections, and the elapsed time is the visible proof.
    const connectionsAfterResolve = peer.connections();
    const result = await refreshPeers(id, { db, tuning: TUNING });

    assertEquals(peer.connections(), connectionsAfterResolve + 1);
    assert(result.elapsedMs < 6_000, `refresh took ${result.elapsedMs}ms`);
  } finally {
    peer.close();
  }
});

Deno.test("peers sl-stream has banned are dropped", async () => {
  const { id, peer } = await seed();
  try {
    // sl-stream writes this table; ma-stream only reads it. A peer it has banned has actually
    // been dialled and failed, which is better evidence than anything discovery can offer.
    await banPeer(db, id, `127.0.0.1:${peer.port}`, Date.now() + 60_000);

    const result = await refreshPeers(id, { db, tuning: TUNING });

    // Only peer was banned, so there is nothing better to write: the old record survives.
    assertEquals(result.updated, false);
    const stored = (await readPeers(db, id))!;
    const bt = stored.peers.filter(isBtEntry);
    assertEquals(bt.length, 1, "the previous record is left in place, not emptied");
  } finally {
    await clearPeerHealth(db, id);
    peer.close();
  }
});

Deno.test("a refresh that finds nothing keeps the existing record", async () => {
  const { id, peer } = await seed();
  const stored = (await readPeers(db, id))!;
  // Kill the only peer, so discovery has nowhere to go.
  peer.close();

  const result = await refreshPeers(id, { db, tuning: TUNING });
  assertEquals(result.updated, false);
  assertEquals(result.peerCount, stored.count);

  const after = (await readPeers(db, id))!;
  assertEquals(after.peers.length, stored.peers.length, "a stale record beats an empty one");
});

Deno.test("refreshing an id we never resolved is a 404", async () => {
  const unknown = "0".repeat(40);
  let status = 0;
  let code = "";
  try {
    await refreshPeers(unknown, { db, tuning: TUNING });
  } catch (err) {
    status = (err as { status?: number }).status ?? 0;
    code = (err as { code?: string }).code ?? "";
  }
  assertEquals(status, 404);
  assertEquals(code, "unknown_id");
  assertEquals(await readPeers(db, unknown), null);
});

Deno.test("a non-infohash id is rejected before any work", async () => {
  let code = "";
  try {
    await refreshPeers("not-a-hash", { db, tuning: TUNING });
  } catch (err) {
    code = (err as { code?: string }).code ?? "";
  }
  assertEquals(code, "bad_id");
});

Deno.test("concurrent refreshes of one id collapse to a single swarm walk", async () => {
  const { id, peer } = await seed();
  try {
    const connectionsAfterResolve = peer.connections();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => refreshPeers(id, { db, tuning: TUNING })),
    );

    assertEquals(new Set(results.map((r) => r.refreshedAt)).size, 1, "one walk, one answer");
    assertEquals(
      peer.connections(),
      connectionsAfterResolve + 1,
      "six callers must not open six sessions",
    );
  } finally {
    peer.close();
  }
});

Deno.test("teardown", async () => {
  await db.close();
});
