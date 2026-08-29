/**
 * `GET /peers/:id` — the peers to dial to recover an id's chunks, and nothing else.
 *
 * `GET /records/:id` already carries a peer record, but it carries it the way the database stores
 * it: every peer discovery ever saw, banned ones included, alongside 2.4 MB of piece hashes a
 * caller that only wants somewhere to fetch from has no use for. A client that has the chunk record
 * and has run out of live peers wants one small answer to one question — *who do I dial now* — and
 * paying for the hashes to get it is the wrong trade.
 *
 * So this route answers that question directly. Three things happen here that `/records/:id` leaves
 * to the caller:
 *
 *  - **Banned peers are dropped.** `peer_health` is the consumer's own bookkeeping; a peer it
 *    banned after failing to stream from it outranks anything discovery believed. This is the same
 *    filter `/refresh` applies before writing, applied on the way out so a ban recorded since the
 *    last write is honoured too.
 *  - **The list is ordered by what it is worth dialling.** Webseeds first — HTTP range endpoints
 *    serve bytes on the first request while the swarm is still handshaking — then peers that
 *    completed a BitTorrent handshake during the walk that found them, then the rest, which are
 *    tracker hearsay until something answers.
 *  - **Staleness is stated, not implied.** `ageMs` and `stale` come back on every response, so a
 *    caller decides whether to spend a refresh instead of inferring rot from a timestamp.
 *
 * `?refresh=auto` walks the swarm first when the answer would be stale or empty, `?refresh=1`
 * always does. Both are opt-in: the plain read is three point queries and no swarm, and a route
 * that silently dialled the internet would make that impossible to rely on.
 */

import { config } from "./config.ts";
import { isBtEntry, type PeerRecordItem, type PeersRecord } from "./db/records.ts";
import { openDb } from "./db/postgres.ts";
import type { Database } from "./db/sql.ts";
import { readBannedPeers, readPeers } from "./db/store.ts";
import { refreshPeers, ResolveError } from "./resolve.ts";

/** What `?refresh=` asked for. `"auto"` only pays for a walk when the stored answer is unusable. */
export type RefreshMode = "never" | "auto" | "always";

export interface PeersView {
  readonly id: string;
  /** When the returned record was written, and how old that makes it. */
  readonly resolvedAt: number;
  readonly ageMs: number;
  /** True when `ageMs` is past `MA_PEERS_STALE_MS`; swarm peers rot within minutes. */
  readonly stale: boolean;
  /** BitTorrent endpoints in `peers`, after the ban filter. Webseeds are not counted. */
  readonly count: number;
  /** Webseeds first, then verified peers, then unverified — see the file header. */
  readonly peers: PeerRecordItem[];
  readonly webseeds: string[];
  /** How many stored peers the ban filter removed. Zero unless the consumer has streamed this id. */
  readonly bannedCount: number;
  /** True when a swarm walk ran for this request *and* rewrote the record. */
  readonly refreshed: boolean;
}

export interface ReadPeersOptions {
  readonly refresh?: RefreshMode;
  readonly db?: Database;
  /** Overrides `Date.now()` for the age and ban-expiry clocks. */
  readonly now?: number;
}

/** `?refresh=` to a mode. Anything unrecognised is a 400, not a silent "never". */
export function parseRefreshMode(raw: string | null): RefreshMode {
  if (raw === null || raw === "" || raw === "0" || raw === "never") return "never";
  if (raw === "auto") return "auto";
  if (raw === "1" || raw === "always") return "always";
  throw new ResolveError(
    `"${raw}" is not a refresh mode; use "auto", "1" or omit`,
    400,
    "bad_refresh_mode",
  );
}

/** Webseeds, then handshake-verified peers, then the rest. Stable within each group. */
function rank(item: PeerRecordItem): number {
  if (!isBtEntry(item)) return 0;
  return item.verified ? 1 : 2;
}

function usablePeers(record: PeersRecord, banned: ReadonlySet<string>): PeerRecordItem[] {
  const kept = record.peers.filter((item) =>
    isBtEntry(item) ? !banned.has(`${item.ip}:${item.port}`) : !banned.has(item)
  );
  // A stable sort by rank, which `Array.prototype.sort` has been required to be since ES2019, so
  // peers keep the order discovery found them in inside each group.
  return kept.sort((a, b) => rank(a) - rank(b));
}

/**
 * Read the peers for an id.
 *
 * A record that exists but whose every peer is banned still answers 200 with an empty list: the id
 * is known and the honest answer is "none of the peers we have are worth dialling", which is a
 * different thing from the 404 an unresolved id gets. `?refresh=auto` is the way to ask for that
 * case to be fixed rather than reported.
 */
export async function readPeersView(
  id: string,
  options: ReadPeersOptions = {},
): Promise<PeersView> {
  if (!/^[0-9a-f]{40}$/i.test(id)) {
    throw new ResolveError(`"${id}" is not a 40-character info hash`, 400, "bad_id");
  }
  const normalised = id.toLowerCase();
  const db = options.db ?? await openDb();
  const mode = options.refresh ?? "never";
  const now = options.now ?? Date.now();

  let refreshed = false;
  if (mode === "always") {
    // `refreshPeers` 404s on an id with no magnet row, which is the same answer this route would
    // give anyway, so the error is left to propagate rather than falling back to a stored read.
    refreshed = (await refreshPeers(normalised, { db })).updated;
  }

  let record = await readPeers(db, normalised);
  if (!record) {
    throw new ResolveError(`${normalised} has no stored peer record`, 404, "unknown_id");
  }
  let clock = now;
  let banned = await readBannedPeers(db, normalised, clock);
  let peers = usablePeers(record, banned);

  if (mode === "auto" && (clock - record.resolvedAt > config.peersStaleMs || peers.length === 0)) {
    refreshed = (await refreshPeers(normalised, { db })).updated;
    if (refreshed) {
      // Re-read both: the walk rewrote `peer_records`, and a ban can have expired while it ran.
      clock = Date.now();
      const rewritten = await readPeers(db, normalised);
      banned = await readBannedPeers(db, normalised, clock);
      if (rewritten) record = rewritten;
      peers = usablePeers(record, banned);
    }
  }

  const ageMs = Math.max(0, clock - record.resolvedAt);
  return {
    id: normalised,
    resolvedAt: record.resolvedAt,
    ageMs,
    stale: ageMs > config.peersStaleMs,
    count: peers.filter(isBtEntry).length,
    peers,
    webseeds: [...record.webseeds],
    bannedCount: record.peers.length - peers.length,
    refreshed,
  };
}
