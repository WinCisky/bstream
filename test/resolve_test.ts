/**
 * End-to-end: magnet in, id out, records in the database.
 *
 * Discovery is switched off and the peer is supplied through the magnet's own `x.pe` hint, so this
 * exercises the whole orchestrator — dial pool, metadata, verification, layout, the write — against
 * an in-process Postgres and a local peer, with no network and nothing flaky.
 *
 * Tuning and the database are passed in explicitly rather than set through the environment, so
 * these tests do not depend on evaluating before any module that reads `config`.
 */

import { assert, assertEquals } from "@std/assert";
import { toHex } from "../src/bytes.ts";
import { isBtEntry } from "../src/db/records.ts";
import { readChunks, readIndex, readPeers } from "../src/db/store.ts";
import { resolveMagnet, type ResolveTuning } from "../src/resolve.ts";
import { testDatabase } from "./support/db.ts";
import { type FakePeer, startFakePeer } from "./support/fake_peer.ts";
import { makeTorrent } from "./support/torrent.ts";

const MiB = 1024 * 1024;

/** Discovery off; the only peer arrives via the magnet's `x.pe` hint, on loopback. */
const TUNING: Partial<ResolveTuning> = {
  enableUdpTrackers: false,
  enableHttpTrackers: false,
  enableDht: false,
  enablePex: false,
  allowPrivatePeers: true,
  minPeers: 1,
  peerGraceMs: 0,
  resolveDeadlineMs: 8_000,
  sessionTimeoutMs: 3_000,
  connectTimeoutMs: 1_000,
};

const db = await testDatabase();

interface Fixture {
  readonly magnet: string;
  readonly peer: FakePeer;
  readonly torrent: Awaited<ReturnType<typeof makeTorrent>>;
}

/** The database outlives each test, so every fixture needs its own infohash to stay isolated. */
let fixtureCounter = 0;

async function withPeer<T>(fn: (fixture: Fixture) => Promise<T>): Promise<T> {
  const torrent = await makeTorrent(
    [
      { path: ["Sample", "sample.mkv"], length: 3 * MiB },
      { path: [".pad", "1048576"], length: 1 * MiB, padding: true },
      { path: ["Feature.2001.1080p.mkv"], length: 700 * MiB },
    ],
    1 * MiB,
    `Feature.2001.1080p.fixture-${++fixtureCounter}`,
  );

  const peer = startFakePeer({ infoHash: torrent.infoHash, infoBytes: torrent.infoBytes });
  const magnet = `magnet:?xt=urn:btih:${toHex(torrent.infoHash)}` +
    "&dn=Feature.2001.1080p" +
    `&x.pe=${encodeURIComponent(`127.0.0.1:${peer.port}`)}` +
    `&ws=${encodeURIComponent("https://cdn.example/Feature.mkv")}`;
  try {
    return await fn({ magnet, peer, torrent });
  } finally {
    peer.close();
  }
}

Deno.test("resolves a magnet to an id and writes both records", async () => {
  await withPeer(async ({ magnet, peer, torrent }) => {
    const result = await resolveMagnet(magnet, { db, tuning: TUNING });

    assertEquals(result.id, toHex(torrent.infoHash), "the id is the v1 infohash");
    assertEquals(result.created, true);
    assertEquals(result.pieceCount, torrent.pieceCount);
    assertEquals(result.totalLength, torrent.totalLength);
    assertEquals(result.file.path, "Feature.2001.1080p.mkv");
    assertEquals(result.file.mime, "video/x-matroska");
    assertEquals(result.verifiedPeerCount, 1, "the peer that served metadata is proven live");

    const peers = await readPeers(db, result.id);
    const chunks = await readChunks(db, result.id);
    const index = await readIndex(db, result.id);

    assert(peers && chunks && index, "all three records must exist");

    // The array carries both transports: webseed URLs first, then BitTorrent endpoints. sl-stream
    // classifies them structurally, so they have to share one array to both be seen.
    assertEquals(peers.peers[0], "https://cdn.example/Feature.mkv");
    const bt = peers.peers.filter(isBtEntry);
    assertEquals(bt.length, 1);
    assertEquals(bt[0]!.port, peer.port);
    assertEquals(bt[0]!.source, "magnet");
    assertEquals(bt[0]!.verified, true);
    assertEquals(peers.count, 1, "count is BitTorrent peers, not webseeds");
    assertEquals(peers.webseeds, ["https://cdn.example/Feature.mkv"]);

    // The invariant sl-stream re-derives, and 500s the id over if it disagrees.
    assertEquals(chunks.pieceCount, Math.ceil(chunks.totalLength / chunks.pieceLength));
    assertEquals(chunks.fileOffset, 4 * MiB, "the padding file must count toward the offset");
    assertEquals(chunks.fileLength, 700 * MiB);
    assertEquals(chunks.pieces.length, torrent.pieceCount * 20);

    assertEquals(index.magnet, magnet);
    assertEquals(index.id, result.id);
  });
});

Deno.test("a second resolve returns the existing id without touching the swarm", async () => {
  await withPeer(async ({ magnet, peer }) => {
    const first = await resolveMagnet(magnet, { db, tuning: TUNING });
    assertEquals(first.created, true);
    const connectionsAfterFirst = peer.connections();

    const second = await resolveMagnet(magnet, { db, tuning: TUNING });
    assertEquals(second.id, first.id);
    assertEquals(second.created, false);
    assertEquals(peer.connections(), connectionsAfterFirst, "no new dial for a cached magnet");
  });
});

Deno.test("concurrent resolves of one magnet collapse to a single swarm", async () => {
  await withPeer(async ({ magnet, peer }) => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolveMagnet(magnet, { db, tuning: TUNING, force: true })),
    );

    assertEquals(new Set(results.map((result) => result.id)).size, 1);
    // Singleflight: eight callers, one swarm, therefore one connection to the peer.
    assertEquals(peer.connections(), 1, "eight callers must not open eight sessions");
  });
});

Deno.test("a torrent with no video file fails cleanly and writes nothing", async () => {
  const torrent = await makeTorrent([{ path: ["album", "01.flac"], length: 30 * MiB }], 1 * MiB);
  const peer = startFakePeer({ infoHash: torrent.infoHash, infoBytes: torrent.infoBytes });
  const magnet = `magnet:?xt=urn:btih:${toHex(torrent.infoHash)}` +
    `&x.pe=${encodeURIComponent(`127.0.0.1:${peer.port}`)}`;

  try {
    let status = 0;
    try {
      await resolveMagnet(magnet, { db, tuning: TUNING });
    } catch (err) {
      status = (err as { status?: number }).status ?? 0;
    }
    assertEquals(status, 422);

    assertEquals(
      await readIndex(db, toHex(torrent.infoHash)),
      null,
      "a failed resolve must leave no correlation behind",
    );
  } finally {
    peer.close();
  }
});

Deno.test("an unreachable swarm times out instead of writing a broken record", async () => {
  const torrent = await makeTorrent([{ path: ["Feature.mkv"], length: 8 * MiB }], 1 * MiB);
  // Bind then release, so the port is almost certainly refusing connections.
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const deadPort = (probe.addr as Deno.NetAddr).port;
  probe.close();

  const magnet = `magnet:?xt=urn:btih:${toHex(torrent.infoHash)}` +
    `&x.pe=${encodeURIComponent(`127.0.0.1:${deadPort}`)}`;

  let code = "";
  try {
    await resolveMagnet(magnet, { db, tuning: TUNING });
  } catch (err) {
    code = (err as { code?: string }).code ?? "";
  }
  assertEquals(code, "metadata_timeout");

  assertEquals(await readChunks(db, toHex(torrent.infoHash)), null);
});

Deno.test("teardown", async () => {
  await db.close();
});
