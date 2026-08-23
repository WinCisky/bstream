import { assert, assertEquals } from "@std/assert";
import { MetadataAssembler } from "../src/meta/assembler.ts";
import { parseInfo } from "../src/meta/info.ts";
import { PeerQueue } from "../src/discovery/queue.ts";
import { generatePeerId } from "../src/wire/handshake.ts";
import { runSession, type SessionContext } from "../src/wire/session.ts";
import type { WireConn } from "../src/wire/conn.ts";
import { bytesEqual, sha1 } from "../src/bytes.ts";
import { startFakePeer } from "./support/fake_peer.ts";
import { makeTorrent } from "./support/torrent.ts";

const MiB = 1024 * 1024;

function makeContext(infoHash: Uint8Array, signal: AbortSignal): {
  context: SessionContext;
  assembler: MetadataAssembler;
  queue: PeerQueue;
} {
  const assembler = new MetadataAssembler(infoHash, 8 * MiB);
  // The fake peers listen on loopback, which the address filter drops by default.
  const queue = new PeerQueue(100, { allowPrivate: true });
  const context: SessionContext = {
    infoHash,
    peerId: generatePeerId(),
    assembler,
    queue,
    signal,
    connectTimeoutMs: 2_000,
    sessionTimeoutMs: 5_000,
    enablePex: true,
    wantMetadata: true,
    sockets: new Set<WireConn>(),
  };
  return { context, assembler, queue };
}

/** 300 files ⇒ an info dict of ~40 KiB ⇒ three BEP-9 pieces, so assembly is really exercised. */
function manyFiles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    path: [`extras`, `clip-${i}.bin`],
    length: 64 * 1024,
  }));
}

Deno.test("fetches and verifies metadata from a peer", async () => {
  const torrent = await makeTorrent([
    { path: ["Feature.mkv"], length: 40 * MiB },
    ...manyFiles(300),
  ]);
  assert(torrent.infoBytes.length > 16 * 1024, "fixture must span several metadata pieces");

  const peer = startFakePeer({ infoHash: torrent.infoHash, infoBytes: torrent.infoBytes });
  const controller = new AbortController();
  const { context, assembler, queue } = makeContext(torrent.infoHash, controller.signal);

  try {
    queue.add({ ip: "127.0.0.1", port: peer.port }, "magnet");
    await runSession(
      { ip: "127.0.0.1", port: peer.port, source: "magnet", verified: false },
      context,
    );

    assert(assembler.done, "metadata should be complete");
    const bytes = await assembler.verified;
    assert(bytesEqual(await sha1(bytes), torrent.infoHash));

    const info = parseInfo(bytes);
    assertEquals(info.pieceCount, torrent.pieceCount);
    assertEquals(info.totalLength, torrent.totalLength);

    // The handshake completed, so this peer is recorded as proven live.
    assertEquals(queue.verifiedCount, 1);
  } finally {
    controller.abort();
    peer.close();
  }
});

Deno.test("rejects an info dict that does not hash to the infohash", async () => {
  const real = await makeTorrent([{ path: ["Real.mkv"], length: 8 * MiB }]);
  const fake = await makeTorrent([{ path: ["Fake.mkv"], length: 99 * MiB }]);

  const peer = startFakePeer({
    infoHash: real.infoHash,
    infoBytes: real.infoBytes,
    behaviour: { kind: "poison", infoBytes: fake.infoBytes },
  });
  const controller = new AbortController();
  const { context, assembler } = makeContext(real.infoHash, controller.signal);

  try {
    await runSession(
      { ip: "127.0.0.1", port: peer.port, source: "magnet", verified: false },
      context,
    );
    // The poisoned buffer is discarded rather than parsed, and the liar is banned.
    assert(!assembler.done, "a mismatched info dict must not be accepted");
    assert(assembler.isBanned(`127.0.0.1:${peer.port}`), "the poisoning peer must be banned");
  } finally {
    controller.abort();
    peer.close();
  }
});

Deno.test("merges metadata pieces across two peers that each hold half", async () => {
  const torrent = await makeTorrent([
    { path: ["Feature.mkv"], length: 40 * MiB },
    ...manyFiles(300),
  ]);

  // Neither peer can complete the metadata alone; the PoC would discard both.
  const even = startFakePeer({
    infoHash: torrent.infoHash,
    infoBytes: torrent.infoBytes,
    behaviour: { kind: "partial", modulus: 2, residue: 0 },
  });
  const odd = startFakePeer({
    infoHash: torrent.infoHash,
    infoBytes: torrent.infoBytes,
    behaviour: { kind: "partial", modulus: 2, residue: 1 },
  });
  const controller = new AbortController();
  const { context, assembler } = makeContext(torrent.infoHash, controller.signal);

  try {
    await Promise.all([
      runSession({ ip: "127.0.0.1", port: even.port, source: "udp", verified: false }, context),
      runSession({ ip: "127.0.0.1", port: odd.port, source: "dht", verified: false }, context),
    ]);
    assert(assembler.done, "the two halves should combine into complete metadata");
    assert(bytesEqual(await assembler.verified, torrent.infoBytes));
  } finally {
    controller.abort();
    even.close();
    odd.close();
  }
});

Deno.test("a silent peer costs only its session budget", async () => {
  const torrent = await makeTorrent([{ path: ["Feature.mkv"], length: 8 * MiB }]);
  const peer = startFakePeer({
    infoHash: torrent.infoHash,
    infoBytes: torrent.infoBytes,
    behaviour: { kind: "silent" },
  });
  const controller = new AbortController();
  const { context, assembler, queue } = makeContext(torrent.infoHash, controller.signal);
  const bounded: SessionContext = { ...context, sessionTimeoutMs: 700 };

  const startedAt = Date.now();
  try {
    await runSession(
      { ip: "127.0.0.1", port: peer.port, source: "magnet", verified: false },
      bounded,
    );
    const elapsed = Date.now() - startedAt;
    assert(elapsed < 3_000, `session should end near its budget, took ${elapsed}ms`);
    assert(!assembler.done);
    // It answered the handshake, so it is still a real peer worth recording.
    assertEquals(queue.verifiedCount, 0);
  } finally {
    controller.abort();
    peer.close();
  }
});

Deno.test("a refused connection fails without throwing", async () => {
  const torrent = await makeTorrent([{ path: ["Feature.mkv"], length: 8 * MiB }]);
  // Bind and immediately release, so the port is almost certainly closed.
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const deadPort = (probe.addr as Deno.NetAddr).port;
  probe.close();

  const controller = new AbortController();
  const { context, assembler } = makeContext(torrent.infoHash, controller.signal);
  await runSession(
    { ip: "127.0.0.1", port: deadPort, source: "udp", verified: false },
    context,
  );
  assert(!assembler.done);
  controller.abort();
});
