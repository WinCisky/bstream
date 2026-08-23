/**
 * Magnet in, id out.
 *
 * The shape that matters is that discovery and metadata fetching run **concurrently**. The PoC
 * awaits every tracker and only then starts dialling, so the slowest dead tracker in the magnet
 * sets the floor on time-to-first-byte. Here trackers, the DHT and PEX all write into one live
 * `PeerQueue` while a dial pool reads from it, so the first peer from the fastest source is already
 * being asked for metadata while the DHT is still walking.
 *
 * The two completion conditions are deliberately different, because their failures mean different
 * things:
 *
 *  - **Metadata is required.** Without an info dict there is no chunk record, and sl-stream 404s.
 *    Missing it by the deadline is a hard failure and nothing is written.
 *  - **Peers are best-effort.** Collection continues while metadata is fetched and for a short
 *    grace window afterwards; whatever exists then is what gets written.
 *
 * Teardown is unconditional: one `AbortController` owns every socket, every discovery task and
 * every session, so no path out of this function leaves anything running.
 */

import { config, RECORD_VERSION } from "./config.ts";
import { errFields, log } from "./log.ts";
import { type ParsedMagnet, parseMagnet } from "./magnet.ts";
import { type DiscoveredPeer, PeerQueue } from "./discovery/queue.ts";
import { announceHttpTrackers } from "./discovery/tracker_http.ts";
import { announceUdpTrackers } from "./discovery/tracker_udp.ts";
import { findPeersViaDht, generateNodeId } from "./discovery/dht.ts";
import { UdpSocket } from "./net/udp.ts";
import { MetadataAssembler } from "./meta/assembler.ts";
import { parseInfo, type TorrentInfo } from "./meta/info.ts";
import { type FileSelection, selectVideoFile } from "./select.ts";
import { generatePeerId } from "./wire/handshake.ts";
import { runSession, type SessionContext } from "./wire/session.ts";
import { outstandingConnects, type WireConn } from "./wire/conn.ts";
import { openDb } from "./db/postgres.ts";
import type { Database } from "./db/sql.ts";
import {
  persist,
  persistPeers,
  readBannedPeers,
  readChunks,
  readIndex,
  readPeers,
} from "./db/store.ts";
import {
  buildChunksRecord,
  buildPeersRecord,
  type ChunkFileEntry,
  isBtEntry,
  type MagnetIndexRecord,
} from "./db/records.ts";
import { SingleFlight, sleep, whenAborted } from "./util/async.ts";

export class ResolveError extends Error {
  override readonly name = "ResolveError";
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

/** One row of the torrent's contents, as the caller sees it. */
export interface ResolveFileEntry {
  /** Position in the torrent's file list — what sl-stream's `?file=` takes. */
  readonly index: number;
  readonly path: string;
  readonly length: number;
  readonly offset: number;
  /** Present only for files sl-stream can serve; its absence is what makes a row unplayable. */
  readonly mime?: string;
  readonly padding?: boolean;
}

/** More files than any video release has. Past this the response is a listing, not a torrent. */
const MAX_LISTED_FILES = 5_000;

export interface ResolveResult {
  readonly id: string;
  /** False when this magnet already had a correlation and we returned it untouched. */
  readonly created: boolean;
  readonly name: string;
  readonly peerCount: number;
  readonly verifiedPeerCount: number;
  readonly pieceCount: number;
  readonly pieceLength: number;
  readonly totalLength: number;
  /** The file that will play when nobody chooses: the largest playable one. */
  readonly file: FileSelection;
  /**
   * Everything in the torrent, in the order `?file=` indexes it.
   *
   * The deployed page has no database access, so this response is the only place it can learn what
   * else is in the torrent. Truncated rather than unbounded — see `filesTruncated`.
   */
  readonly files: ResolveFileEntry[];
  readonly filesTruncated: boolean;
  readonly elapsedMs: number;
}

function listFiles(files: readonly ChunkFileEntry[] | undefined): {
  listed: ResolveFileEntry[];
  truncated: boolean;
} {
  const all = files ?? [];
  const listed = all.slice(0, MAX_LISTED_FILES).map((file, index) => ({
    index,
    path: file.path,
    length: file.length,
    offset: file.offset,
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.padding ? { padding: true } : {}),
  }));
  return { listed, truncated: all.length > listed.length };
}

/**
 * The port we advertise to trackers and the DHT. Nothing listens on it — this service never
 * accepts inbound connections — but announces must carry a port, and 6881 is the conventional one.
 */
const ADVERTISED_PORT = 6881;

const inFlight = new SingleFlight<ResolveResult>();
const refreshInFlight = new SingleFlight<RefreshResult>();

/**
 * Every knob a resolve needs, defaulted from `config` but passed explicitly.
 *
 * `config` is read once at module import, which makes anything that depends on it a hostage to
 * import order. Threading the values through instead means a caller — a test, or a future
 * per-request override — can state them outright.
 */
export interface ResolveTuning {
  readonly resolveDeadlineMs: number;
  readonly minPeers: number;
  readonly maxPeers: number;
  readonly peerGraceMs: number;
  readonly maxDials: number;
  readonly connectTimeoutMs: number;
  readonly sessionTimeoutMs: number;
  readonly trackerTimeoutMs: number;
  readonly dhtBudgetMs: number;
  readonly dhtMaxNodes: number;
  readonly maxMetadataBytes: number;
  readonly allowPrivatePeers: boolean;
  readonly enableUdpTrackers: boolean;
  readonly enableHttpTrackers: boolean;
  readonly enableDht: boolean;
  readonly enablePex: boolean;
}

export function defaultTuning(): ResolveTuning {
  return {
    resolveDeadlineMs: config.resolveDeadlineMs,
    minPeers: config.minPeers,
    maxPeers: config.maxPeers,
    peerGraceMs: config.peerGraceMs,
    maxDials: config.maxDials,
    connectTimeoutMs: config.connectTimeoutMs,
    sessionTimeoutMs: config.sessionTimeoutMs,
    trackerTimeoutMs: config.trackerTimeoutMs,
    dhtBudgetMs: config.dhtBudgetMs,
    dhtMaxNodes: config.dhtMaxNodes,
    maxMetadataBytes: config.maxMetadataBytes,
    allowPrivatePeers: config.allowPrivatePeers,
    enableUdpTrackers: config.enableUdpTrackers,
    enableHttpTrackers: config.enableHttpTrackers,
    enableDht: config.enableDht,
    enablePex: config.enablePex,
  };
}

export interface ResolveOptions {
  /** Re-resolve and overwrite even when a correlation already exists. */
  readonly force?: boolean;
  /** Overrides for individual tunables; anything omitted falls back to `config`. */
  readonly tuning?: Partial<ResolveTuning>;
  /** An explicit database, instead of the process-wide one. */
  readonly db?: Database;
}

export async function resolveMagnet(
  magnet: string,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  const parsed = parseMagnet(magnet);
  const db = options.db ?? await openDb();
  const tuning: ResolveTuning = { ...defaultTuning(), ...options.tuning };

  if (!options.force) {
    const existing = await readIndex(db, parsed.infoHashHex);
    if (existing) {
      log.info("resolve.cached", { id: existing.id });
      return await cachedResult(db, existing);
    }
  }

  // Concurrent callers asking for the same magnet join one swarm and one write.
  return await inFlight.run(
    parsed.infoHashHex,
    () => resolveUncached(db, magnet, parsed, options, tuning),
  );
}

export interface RefreshResult {
  readonly id: string;
  readonly peerCount: number;
  readonly verifiedPeerCount: number;
  readonly refreshedAt: number;
  readonly elapsedMs: number;
  /** False when the walk found nothing better and the stored record was left alone. */
  readonly updated: boolean;
}

export interface RefreshOptions {
  readonly tuning?: Partial<ResolveTuning>;
  readonly db?: Database;
}

/**
 * Re-discover peers for an id that has already been resolved.
 *
 * Swarm peers rot within minutes, so a peer record written once is worth little an hour later.
 * This exists so sl-stream can say "the peers you gave me are dead" and get a fresh set without
 * knowing the magnet — the `["magnet", id]` index holds it.
 *
 * Deliberately narrower than a resolve in three ways:
 *
 *  - **No metadata.** The id is the infohash, which pins the info dict for all time, so
 *    `["chunks", id]` can never need rewriting. Skipping BEP-9 is most of the speedup.
 *  - **sl-stream's verdict is honoured.** Peers it has banned are dropped from the result; it has
 *    tried to stream from them and we have not.
 *  - **It never makes things worse.** A walk that comes back with nothing keeps the old record.
 *    A stale peer list beats an empty one.
 */
export async function refreshPeers(
  id: string,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  if (!/^[0-9a-f]{40}$/i.test(id)) {
    throw new ResolveError(`"${id}" is not a 40-character info hash`, 400, "bad_id");
  }
  const normalised = id.toLowerCase();
  const db = options.db ?? await openDb();
  const tuning: ResolveTuning = {
    ...defaultTuning(),
    resolveDeadlineMs: config.refreshDeadlineMs,
    minPeers: config.refreshMinPeers,
    ...options.tuning,
  };

  const index = await readIndex(db, normalised);
  if (!index) {
    // Nothing to rediscover from: without the magnet there are no trackers and no starting point.
    throw new ResolveError(`no magnet is correlated with ${normalised}`, 404, "unknown_id");
  }

  // Keyed apart from resolve so a refresh cannot be answered by an in-flight full resolve, which
  // would return before the peer record it is waiting on had been rewritten.
  return await refreshInFlight.run(
    normalised,
    () => refreshUncached(db, normalised, index, tuning),
  );
}

async function refreshUncached(
  db: Database,
  id: string,
  index: MagnetIndexRecord,
  tuning: ResolveTuning,
): Promise<RefreshResult> {
  const startedAt = Date.now();

  let parsed: ParsedMagnet;
  try {
    parsed = parseMagnet(index.magnet);
  } catch (err) {
    throw new ResolveError(
      `stored magnet for ${id} is unparseable: ${err instanceof Error ? err.message : String(err)}`,
      500,
      "bad_index_record",
    );
  }

  const [banned, existing] = await Promise.all([
    readBannedPeers(db, id, startedAt),
    readPeers(db, id),
  ]);

  const swarm = await runSwarm(parsed, tuning, "peers");
  const kept = swarm.peers.filter((peer) => !banned.has(`${peer.ip}:${peer.port}`));
  const verifiedPeerCount = kept.filter((peer) => peer.verified).length;

  // Refusing to regress is the whole safety property here: a refresh that empties the record turns
  // a slow stream into a dead one, and sl-stream would then have nothing to ask us about. Quality
  // counts as well as quantity — swapping peers that answered a handshake for a list of tracker
  // hearsay is a downgrade even when the totals match.
  const storedCount = existing?.count ?? 0;
  const storedVerified =
    (existing?.peers ?? []).filter((entry) => isBtEntry(entry) && entry.verified).length;
  const regresses = verifiedPeerCount === 0 &&
    (storedVerified > 0 || kept.length < storedCount);
  if (kept.length === 0 || regresses) {
    log.warn("refresh.kept_existing", {
      id,
      found: kept.length,
      banned: banned.size,
      stored: storedCount,
    });
    return {
      id,
      peerCount: storedCount,
      verifiedPeerCount: 0,
      refreshedAt: existing?.resolvedAt ?? startedAt,
      elapsedMs: Date.now() - startedAt,
      updated: false,
    };
  }

  const now = Date.now();
  const peersRecord = buildPeersRecord(id, kept, parsed.webseeds, now, tuning.maxPeers);
  await persistPeers(db, id, peersRecord, now);

  log.info("refresh.done", {
    id,
    peers: peersRecord.count,
    verified: verifiedPeerCount,
    banned: banned.size,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    id,
    peerCount: peersRecord.count,
    verifiedPeerCount,
    refreshedAt: now,
    elapsedMs: Date.now() - startedAt,
    updated: true,
  };
}

/**
 * The response for a magnet that was already resolved.
 *
 * Read back off the chunk record rather than left zeroed: `created` is the only field that should
 * differ between a fresh resolve and a cached one, otherwise a caller cannot tell a cache hit from
 * a broken torrent.
 */
async function cachedResult(db: Database, index: MagnetIndexRecord): Promise<ResolveResult> {
  const chunks = await readChunks(db, index.id);
  const files = listFiles(chunks?.files);
  return {
    id: index.id,
    created: false,
    name: index.name,
    peerCount: index.peerCount,
    // Only a live resolve can prove a peer is up, so this is honestly zero for a cache hit.
    verifiedPeerCount: 0,
    pieceCount: chunks?.pieceCount ?? 0,
    pieceLength: chunks?.pieceLength ?? 0,
    totalLength: chunks?.totalLength ?? 0,
    file: {
      index: chunks?.fileIndex ?? 0,
      path: chunks?.filePath ?? "",
      offset: chunks?.fileOffset ?? 0,
      length: chunks?.fileLength ?? 0,
      mime: chunks?.mime ?? "",
    },
    files: files.listed,
    filesTruncated: files.truncated,
    elapsedMs: 0,
  };
}

async function resolveUncached(
  db: Database,
  magnet: string,
  parsed: ParsedMagnet,
  options: ResolveOptions,
  tuning: ResolveTuning,
): Promise<ResolveResult> {
  const startedAt = Date.now();
  const id = parsed.infoHashHex;

  const swarm = await runSwarm(parsed, tuning);
  if (!swarm.infoBytes) {
    throw new ResolveError(
      `no peer served verified metadata within ${tuning.resolveDeadlineMs}ms ` +
        `(${swarm.peers.length} peers found)`,
      504,
      "metadata_timeout",
    );
  }

  let info: TorrentInfo;
  try {
    info = parseInfo(swarm.infoBytes);
  } catch (err) {
    throw new ResolveError(
      `torrent metadata is unusable: ${err instanceof Error ? err.message : String(err)}`,
      422,
      "bad_metadata",
    );
  }

  let selection: FileSelection;
  try {
    selection = selectVideoFile(info);
  } catch (err) {
    throw new ResolveError(
      err instanceof Error ? err.message : String(err),
      422,
      "no_video_file",
    );
  }

  const now = Date.now();
  const peersRecord = buildPeersRecord(id, swarm.peers, parsed.webseeds, now, tuning.maxPeers);
  const chunks = buildChunksRecord(id, info, selection, now);

  const index: MagnetIndexRecord = {
    version: RECORD_VERSION,
    id,
    magnet,
    infoHash: id,
    name: info.name,
    trackers: parsed.trackers,
    createdAt: now,
    updatedAt: now,
    peerCount: peersRecord.count,
  };

  const persisted = await persist(db, {
    id,
    index,
    peers: peersRecord,
    chunks,
    force: options.force ?? false,
  });

  const files = listFiles(chunks.files);
  const verifiedPeerCount = swarm.peers.filter((peer) => peer.verified).length;
  log.info("resolve.done", {
    id,
    created: persisted.created,
    peers: peersRecord.count,
    verified: verifiedPeerCount,
    pieces: info.pieceCount,
    file: selection.path,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    id,
    created: persisted.created,
    name: info.name,
    peerCount: peersRecord.count,
    verifiedPeerCount,
    pieceCount: info.pieceCount,
    pieceLength: info.pieceLength,
    totalLength: info.totalLength,
    file: selection,
    files: files.listed,
    filesTruncated: files.truncated,
    elapsedMs: Date.now() - startedAt,
  };
}

interface SwarmOutcome {
  readonly infoBytes: Uint8Array | null;
  readonly peers: DiscoveredPeer[];
}

/**
 * What this swarm walk is for.
 *
 * `"metadata"` blocks on a verified info dict — the resolve path. `"peers"` skips BEP-9 entirely
 * and returns once enough peers are known, which is all a refresh needs: the id is the infohash,
 * and an infohash pins the metadata forever, so the chunk record can never go stale.
 */
export type SwarmGoal = "metadata" | "peers";

async function runSwarm(
  parsed: ParsedMagnet,
  tuning: ResolveTuning,
  goal: SwarmGoal = "metadata",
): Promise<SwarmOutcome> {
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(tuning.resolveDeadlineMs);
  const signal = AbortSignal.any([controller.signal, deadline]);

  const queue = new PeerQueue(tuning.maxPeers, { allowPrivate: tuning.allowPrivatePeers });
  const assembler = new MetadataAssembler(parsed.infoHash, tuning.maxMetadataBytes);
  const sockets = new Set<WireConn>();
  const peerId = generatePeerId();

  const needsUdp = tuning.enableUdpTrackers || tuning.enableDht;
  let udp: UdpSocket | null = null;
  if (needsUdp) {
    try {
      udp = UdpSocket.open();
    } catch (err) {
      // Missing --unstable-net or a sandbox without UDP: degrade to HTTP trackers and PEX.
      log.warn("swarm.udp_unavailable", errFields(err));
    }
  }

  // Peer hints from the magnet cost zero round trips, so they go in before anything is dialled.
  queue.addMany(parsed.peerHints, "magnet");

  const context: SessionContext = {
    infoHash: parsed.infoHash,
    peerId,
    assembler,
    queue,
    signal,
    connectTimeoutMs: tuning.connectTimeoutMs,
    sessionTimeoutMs: tuning.sessionTimeoutMs,
    enablePex: tuning.enablePex,
    wantMetadata: goal === "metadata",
    sockets,
  };

  const tasks: Promise<unknown>[] = [runDialPool(queue, context, signal, tuning)];

  if (udp && tuning.enableUdpTrackers) {
    tasks.push(
      announceUdpTrackers({
        socket: udp,
        trackers: parsed.trackers,
        infoHash: parsed.infoHash,
        peerId,
        listenPort: ADVERTISED_PORT,
        timeoutMs: tuning.trackerTimeoutMs,
        signal,
        onPeers: (peers) => queue.addMany(peers, "udp"),
      }).catch((err) => log.debug("swarm.udp_trackers_failed", errFields(err))),
    );
  }

  if (tuning.enableHttpTrackers) {
    tasks.push(
      announceHttpTrackers({
        trackers: parsed.trackers,
        infoHash: parsed.infoHash,
        peerId,
        listenPort: ADVERTISED_PORT,
        timeoutMs: tuning.trackerTimeoutMs,
        signal,
        onPeers: (peers) => queue.addMany(peers, "http"),
      }).catch((err) => log.debug("swarm.http_trackers_failed", errFields(err))),
    );
  }

  if (udp && tuning.enableDht) {
    tasks.push(
      findPeersViaDht({
        socket: udp,
        infoHash: parsed.infoHash,
        nodeId: generateNodeId(),
        budgetMs: Math.min(tuning.dhtBudgetMs, tuning.resolveDeadlineMs),
        maxNodes: tuning.dhtMaxNodes,
        signal,
        onPeers: (peers) => queue.addMany(peers, "dht"),
        shouldStop: () => queue.size >= tuning.minPeers && (goal === "peers" || assembler.done),
      }).catch((err) => log.debug("swarm.dht_failed", errFields(err))),
    );
  }

  try {
    if (goal === "peers") {
      // No metadata to wait on. Reach the peer target, then hold long enough for handshakes
      // already in flight to land: an unverified peer is a rumour from a tracker, a verified one
      // answered us seconds ago, and only the second kind is worth much to sl-stream.
      await awaitPeerTarget(queue, signal, tuning);
      await awaitVerification(queue, signal, tuning);
      return { infoBytes: null, peers: queue.snapshot() };
    }
    const infoBytes = await Promise.race([assembler.verified, whenAborted(signal)]);
    if (infoBytes) await collectPeers(queue, signal, tuning);
    return { infoBytes: infoBytes ?? null, peers: queue.snapshot() };
  } finally {
    // Unconditional teardown. Abort first so in-flight reads reject, then close every socket we
    // still hold, then wait for the detached tasks to notice.
    controller.abort();
    queue.close();
    for (const conn of sockets) conn.close();
    sockets.clear();
    udp?.close();
    await Promise.allSettled(tasks);
  }
}

/**
 * Metadata has landed. Keep discovery running until there are enough peers to be worth writing, or
 * until the grace window closes — whichever comes first.
 */
async function collectPeers(
  queue: PeerQueue,
  signal: AbortSignal,
  tuning: ResolveTuning,
  until = Date.now() + tuning.peerGraceMs,
): Promise<void> {
  while (!signal.aborted && queue.size < tuning.minPeers && Date.now() < until) {
    await sleep(100, signal);
  }
}

/** Wait until the peer target is met, or the deadline signal fires. */
async function awaitPeerTarget(
  queue: PeerQueue,
  signal: AbortSignal,
  tuning: ResolveTuning,
): Promise<void> {
  while (!signal.aborted && queue.size < tuning.minPeers) {
    await sleep(100, signal);
  }
}

/**
 * Hold the swarm open until handshakes prove some peers are alive.
 *
 * Unlike `collectPeers` this cannot be satisfied by the peer *count*, which is already met by the
 * time it is called — discovery hands back addresses instantly, and an address is only a claim.
 */
async function awaitVerification(
  queue: PeerQueue,
  signal: AbortSignal,
  tuning: ResolveTuning,
): Promise<void> {
  const until = Date.now() + tuning.peerGraceMs;
  while (
    !signal.aborted && queue.verifiedCount < tuning.minPeers && Date.now() < until
  ) {
    await sleep(50, signal);
  }
}

/** Dials peers off the queue, bounded by `maxDials`, until the queue closes or we abort. */
async function runDialPool(
  queue: PeerQueue,
  context: SessionContext,
  signal: AbortSignal,
  tuning: ResolveTuning,
): Promise<void> {
  const active = new Set<Promise<void>>();
  try {
    for await (const peer of queue) {
      if (signal.aborted) break;
      while (active.size >= tuning.maxDials) {
        await Promise.race(active);
        if (signal.aborted) break;
      }
      // A freed dial slot does not mean a freed descriptor: an abandoned `Deno.connect` keeps one
      // for as long as the OS takes to give up on the SYN. Without this the pool would happily
      // start thousands of connects a minute against a swarm full of dead endpoints.
      while (outstandingConnects() >= tuning.maxDials * 4) {
        await sleep(50, signal);
        if (signal.aborted) break;
      }
      if (signal.aborted) break;

      // `runSession` never throws, so this can only settle by fulfilling. The cleanup reaction is
      // registered before `Promise.race` adds its own, so the slot is always freed first.
      const task = runSession(peer, context);
      active.add(task);
      void task.finally(() => active.delete(task));
    }
  } finally {
    await Promise.allSettled(active);
  }
}
