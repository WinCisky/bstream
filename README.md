# ma-stream

Turns a magnet link into an id, and writes the peer list and chunk list that
[sl-stream](../sl-stream) reads out of Postgres.

```
POST /resolve      {"magnet": "magnet:?xt=urn:btih:..."}  ->  200 {"id": "08ada5…", …}
POST /refresh      {"id": "08ada5…"}                      ->  200 {"peerCount": 186, …}
GET  /records/:id                                         ->  200 {"chunks": …, "peers": …, "health": …}
```

sl-stream runs on Deno Deploy and, given an id, point-reads one row from `peer_records` and one from
`chunk_records` to stream a video. It speaks no BitTorrent at all — no magnet parser, no trackers,
no DHT, no wire protocol. ma-stream is the producer for those two rows. It runs **outside** Deploy,
because it needs raw TCP for the peer wire protocol and UDP for trackers and the DHT, and reaches
the same database over its connection string.

## Running

```bash
deno task migrate   # apply sql/*.sql; idempotent, safe to re-run
deno task start
```

Requires `--unstable-net`, which is what provides `Deno.listenDatagram`; it is in the task
definitions. Migrations are deliberately **not** run at boot — a service that mutates its own schema
on start is a service that can rewrite a database during a rollback.

Resolve one magnet from the command line instead:

```bash
deno task resolve "magnet:?xt=urn:btih:..."
```

## Configuration

Everything is environment-driven and optional except the database location. Reads are wrapped, so a
missing `--allow-env` falls back to defaults rather than failing to boot — which is also why an
unset `MA_DATABASE_URL` is a 503 from the first request rather than a crash at import. The process
boots and logs `db.unconfigured` so an operator does not have to send a request to find out.

### Supabase

A Supabase URL and a plain Postgres URL differ only in `MA_DATABASE_URL`, but which Supabase URL
matters:

| Endpoint                                                | Port   | `MA_DB_PREPARE` | Notes                                                                                                             |
| ------------------------------------------------------- | ------ | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Transaction pooler `aws-0-<region>.pooler.supabase.com` | `6543` | **must be off** | Each statement gets a different server connection, so a named prepared statement is gone before it is used. IPv4. |
| Session pooler, same host                               | `5432` | fine either way | Behaves like a direct connection. IPv4.                                                                           |
| Direct `db.<ref>.supabase.co`                           | `5432` | fine either way | Full Postgres, but **IPv6-only** on newer projects — a real trap for a VPS.                                       |

Append `?sslmode=require`; postgres.js reads it out of the URL. The default `MA_DB_PREPARE=false` is
the only setting correct on all three rows, and this service issues a handful of queries against
seconds of swarm work, so nothing is lost by leaving it there.

| Variable                                    | Default   | Meaning                                                                 |
| ------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| `MA_DATABASE_URL`                           | _(empty)_ | Postgres connection string. **Required**; unset makes `/resolve` a 503. |
| `MA_DB_PREPARE`                             | `false`   | Named prepared statements. Must stay off on a transaction pooler.       |
| `MA_DB_POOL_SIZE`                           | `5`       | Connections held open.                                                  |
| `MA_DB_CONNECT_TIMEOUT_MS`                  | `10000`   | Per-connection budget.                                                  |
| `MA_DB_IDLE_TIMEOUT_MS`                     | `0`       | 0 keeps connections; set ~30000 behind a per-connection-priced pooler.  |
| `MA_RESOLVE_DEADLINE_MS`                    | `45000`   | Hard ceiling on one resolve.                                            |
| `MA_MIN_PEERS`                              | `40`      | Stop early once metadata is in and this many peers are known.           |
| `MA_MAX_PEERS`                              | `500`     | Cap on peers persisted.                                                 |
| `MA_PEER_GRACE_MS`                          | `3000`    | Extra collection time after metadata lands.                             |
| `MA_MAX_DIALS`                              | `50`      | Concurrent peer sessions.                                               |
| `MA_CONNECT_TIMEOUT_MS`                     | `3000`    | TCP connect budget per peer.                                            |
| `MA_SESSION_TIMEOUT_MS`                     | `6000`    | Whole-session budget per peer.                                          |
| `MA_TRACKER_TIMEOUT_MS`                     | `3000`    | Per-tracker budget.                                                     |
| `MA_DHT_BUDGET_MS`                          | `20000`   | DHT walk budget.                                                        |
| `MA_DHT_MAX_NODES`                          | `200`     | Nodes queried before the walk stops.                                    |
| `MA_ALLOW_PRIVATE_PEERS`                    | `false`   | Allow loopback/RFC 1918 peers. See "Address hygiene".                   |
| `MA_ENABLE_UDP` / `_HTTP` / `_DHT` / `_PEX` | `true`    | Individually switchable discovery sources.                              |
| `MA_REFRESH_TOKEN`                          | _(empty)_ | Bearer token for `/refresh` and `/records/:id`. Unset means both 401.   |
| `MA_LOG_LEVEL`                              | `info`    | `debug`, `info`, `warn`, `error`.                                       |

## How a resolve works

Discovery and metadata fetching run concurrently, which is the whole latency argument. A
tracker-then-dial design pays for the slowest dead tracker in the magnet before it contacts anyone;
here every source writes into one live `PeerQueue` while a dial pool reads from it.

```
magnet ─ parse ─ infohash (= the id)
                   │
                   ├── magnets row?  ─ yes ─→ return the existing id
                   ↓ no
   x.pe hints ─┐
   UDP tracker ─┤
   HTTP tracker ─┼─→ PeerQueue ─→ dial pool (≤ MA_MAX_DIALS)
   DHT get_peers ┤        ↑              │
   PEX ──────────┘        └──────────────┤ handshake, BEP-10, BEP-9, ut_pex
                                         ↓
                            metadata assembler (pieces merge across peers)
                                         ↓
                            SHA-1(info dict) === infohash
                                         ↓
                          layout + file pick → one transaction → id
```

Two completion conditions, because their failures differ:

- **Metadata is required.** No info dict means no chunk record, which means sl-stream 404s. Missing
  it by the deadline is a `504` and nothing is written.
- **Peers are best-effort.** Collection continues during metadata fetch and through a short grace
  window; whatever exists then is written.

The "file pick" is the **default**, not the only reachable file. `selectVideoFile` chooses the
largest `.mp4`, `.m4v`, `.mkv` or `.avi` — in a release the feature always dwarfs the sample — and
that choice is what `chunk_records`' `file_index`/`file_offset`/`file_length` describe. The whole
file list goes into the record and the `/resolve` response alongside it, so sl-stream's
`?file=<index>` can address any of the others without a second resolve. A torrent holding none of
those extensions is still a `422`: there is nothing to stream.

## Records written

`id` is the lowercase 40-character v1 infohash, and it is also the info hash — the schema stores it
once and the read contract aliases it back to both names. The full DDL is `sql/001_init.sql`.

```sql
magnets       (id pk, version, magnet, name, trackers text[], created_at, updated_at, peer_count)
peer_records  (id pk → magnets, version, resolved_at, peer_count, peers jsonb, webseeds text[])
chunk_records (id pk → magnets, version, name, piece_length, piece_count, total_length,
               pieces bytea, files jsonb, file_index, file_path, file_offset, file_length,
               mime, resolved_at)
peer_health   (id, peer_key, banned_until, ok, fails, updated_at)   -- sl-stream writes, we read
```

All three land in one transaction, and the claim on `magnets` is
`insert … on conflict (id) do nothing returning id`, so the first writer wins and sl-stream can
never see a peer record without its chunk record. Two processes resolving the same magnet at once
produce one write and one no-op: the loser blocks on the winner's row lock and then gets zero rows
back. It never raises a duplicate-key error, so there is nothing to retry and nothing to misread as
a failure.

Every instant is epoch milliseconds in a `bigint` rather than a `timestamptz`. They are numbers in
the contract sl-stream consumes, and a `bigint` means the same thing under every driver, session
`TimeZone` and pooler.

Constraints worth knowing before changing `records.ts` or the schema:

- `pieceCount` must equal `ceil(totalLength / pieceLength)` **exactly**. sl-stream's
  `validateLayout` re-derives it and returns a 500 for the id forever if it disagrees. The
  `chunk_records_geometry` CHECK enforces it now, so a record that would break an id permanently
  fails its write instead.
- There is deliberately **no top-level `length` key**, and no column may be aliased to one.
  sl-stream reads the torrent length from the alias list `totalLength|length|size|totalSize`, so
  `select file_length as length` — which looks harmless — would be read as the whole torrent and
  every byte offset would be wrong. This used to be a record-shape rule; it is a SQL-review rule
  now, and easier to break by accident.
- **Every file keeps its position in `files`**, padding included. `?file=` indexes that array, so a
  reader that skipped unusable entries would shift every later index by one and `?file=3` would
  silently stream file 4.
- **Webseeds live inside the `peers` array**, not only in the sibling `webseeds` column.
  `adaptPeers` reads that one array and classifies structurally — a string containing `://` is a
  webseed, an `{ip, port}` object is a socket to dial — so anything outside it is invisible.

What used to be here and is now gone: Deno KV capped a value at 64 KiB, so `buildChunksRecord`
shrank the record in defined steps — piece hashes offloaded to a `["chunkhashes", id, shard]`
namespace first, the file list dropped second, in that order because losing the list took every file
except the default out of reach. `pieces` is a `bytea` that TOASTs without being asked, so nothing
is dropped at any size, the overflow namespace does not exist, and the argument about which to
sacrifice is moot. A 120 000-piece torrent stores all 2.4 MB of its hashes inline.

## The contract to hand sl-stream

Its two point reads become two selects. The aliases are chosen so **the returned row _is_ the
record** — `adaptLayout` and `adaptPeers` take the row object unchanged, and only the loader
changes.

```sql
-- replaces kv.get(["peers", id])
select version, id as "infoHash", resolved_at as "resolvedAt", peer_count as "count",
       peers, webseeds
from peer_records where id = $1;

-- replaces kv.get(["chunks", id])
select version, id as "infoHash", name,
       piece_length as "pieceLength", piece_count as "pieceCount", total_length as "totalLength",
       pieces, files,
       file_index as "fileIndex", file_path as "filePath",
       file_offset as "fileOffset", file_length as "fileLength",
       mime, resolved_at as "resolvedAt"
from chunk_records where id = $1;

-- replaces kv.set(["v", id, "peerhealth"], entries) — one row per peer now, so two concurrent bans
-- cannot lose each other the way a read-modify-write on a single JSON map could
insert into peer_health (id, peer_key, banned_until, ok, fails, updated_at)
values ($1, $2, $3, $4, $5, $6)
on conflict (id, peer_key) do update set
  banned_until = excluded.banned_until,
  ok           = peer_health.ok    + excluded.ok,
  fails        = peer_health.fails + excluded.fails,
  updated_at   = excluded.updated_at;
```

Five things the port must not miss:

- **`bigint` columns arrive as strings** under postgres.js (`totalLength`, `fileOffset`,
  `fileLength`, `resolvedAt`). `validateLayout` compares a string to a number and rejects the
  record. `Number()` every one — and `x == null ? null : Number(x)` for a nullable column, because
  `Number(null)` is `0`, a valid-looking timestamp.
- **`pieces` arrives as a `Buffer`**, not a plain `Uint8Array`. `decodePieceHashes` accepts it (a
  Buffer _is_ a Uint8Array), but a structural comparison will not; normalise with
  `new Uint8Array(v)`, never `.slice()`, which does not copy a Buffer.
- **`files` is positional and already parsed.** Never `ORDER BY` it, never filter it.
- **A missing row is `rows.length === 0`**, the same 404 a KV `null` produced. A peer record without
  its chunk record is impossible: one transaction, and both foreign-key to `magnets`.
- **A database outage answers `503 db_unavailable`** where it used to answer `503 kv_unavailable`.

Something Deno KV could not do at all, now worth stating: the reader can be locked out of writing
what it reads.

```sql
grant select on magnets, peer_records, chunk_records to sl_stream;
grant select, insert, update, delete on peer_health to sl_stream;
```

ma-stream owns the migrations; sl-stream must never run DDL.

**Open question for that port, not this one.** sl-stream runs on Deno Deploy, and reaching Postgres
needs outbound TCP there. Supabase's pooler is the likely route, with `@supabase/supabase-js` over
PostgREST as the fallback if TCP turns out to be unavailable. Worth confirming before its migration
starts — outbound TCP is precisely the constraint that put ma-stream on a VPS in the first place.

### Known gap: sl-stream cannot stream from this peer record

`peer_records.peers` holds **BitTorrent swarm endpoints**. sl-stream's `adaptPeers` resolves every
entry to an HTTP URL and its fetcher issues `fetch(peer.url, {range})` in file coordinates — it
expects BEP-19 webseeds, not peers. A bare `1.2.3.4:6881` becomes `http://1.2.3.4:6881/` and every
fetch fails.

This is intentional and recorded: the peer data is complete and honest, and closing the gap needs
either a BitTorrent transport inside sl-stream or a Range-serving gateway in front of it. Neither is
in scope here. `test/contract_test.ts` pins the current behaviour so it cannot regress silently.

Webseeds from the magnet's `ws=` are stored alongside under `webseeds`; they are the only entries
sl-stream could fetch from today.

## Peer refresh

Swarm peers rot within minutes, so a peer record is worth little an hour after it was written.
sl-stream calls `POST /refresh` when it notices — no peers it can dial, a swarm where nobody
unchoked, a piece no transport could serve, or simply a record older than its threshold.

```bash
curl -X POST https://ma-stream.example/refresh \
  -H 'authorization: Bearer $MA_REFRESH_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"id":"dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c"}'
```

The caller sends only an id: the `magnets` row holds the magnet it was first resolved from. Three
things make this cheap and safe:

- **No metadata is fetched.** The id _is_ the infohash, and an infohash pins the info dict for all
  time, so the `chunk_records` row can never need rewriting. A refresh is ~1s against a live swarm
  where a full resolve is longer and can fail outright when no peer will serve BEP-9.
- **sl-stream's verdict is honoured.** Peers it has banned in `peer_health` are dropped from the
  result — one `where banned_until > $2`. It has actually tried to stream from them; ma-stream has
  not.
- **It never makes things worse.** A walk that comes back empty, or with no verified peers where the
  stored record had some, leaves the old record alone and reports `updated: false`. A stale peer
  list beats an empty one.

Auth is a shared bearer token, compared in constant time. An unset `MA_REFRESH_TOKEN` returns 401
for every request rather than running open — the route does uncapped outbound swarm work on a public
host, so "unconfigured" has to mean closed.

## Reading the records back

`GET /records/<40 hex>` returns the two stored records and sl-stream's own peer health, in one read:

```bash
curl -H 'authorization: Bearer $MA_REFRESH_TOKEN' \
  https://ma-stream.example/records/dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c
```

```json
{ "chunks": { "pieces": "…base64…", "files": [ … ], … }, "peers": { … }, "health": [ … ] }
```

The body is exactly the object a consumer inlines as its records — the same three keys, in the same
shapes. That is the point of the route. sl-stream reaches the two rows itself over PostgREST, which
costs it two of a Cloudflare Worker's fifty subrequests and requires a database credential at the
edge; a caller that already holds the records can inline them into the `start` frame instead and
spend neither. `test/consumer_contract_test.ts` runs the route's JSON through the consuming Worker's
actual `normalizeRecords`, so the two ends cannot drift apart quietly.

Two representation notes, both forced by JSON:

- **`pieces` is base64.** The record holds `pieceCount * 20` raw bytes. Readers accept base64,
  `\x`-hex bytea or a JSON `Buffer`; base64 is the compact one — 3.2 MB against 4.8 MB at 120 000
  pieces.
- **`health` is an array and is usually empty.** `peer_health` is sl-stream's table to write and
  starts empty for every id, so `[]` means "nothing has been streamed yet", not "record missing".

Missing either record is a 404 rather than a half answer: `persist` writes both in one transaction,
so "chunks but no peers" is not a state this service can produce.

Unlike `/refresh`, this route costs nothing to serve — three point queries, no swarm, no writes. It
is behind the same `MA_REFRESH_TOKEN` for the other reason: a peer record is a list of IP addresses
of people in a swarm, and the database holding it is otherwise reachable only with a credential.

## Address hygiene

Trackers and DHT nodes are unauthenticated and can return any address they like. Handed
`10.0.0.5:22` or `169.254.169.254:80`, a naive client dials the operator's internal network from
inside it. Non-routable addresses — loopback, RFC 1918, CGNAT, link-local, multicast, IPv6 ULA and
IPv4-mapped equivalents — are dropped before anything is dialled. `MA_ALLOW_PRIVATE_PEERS=1` turns
this off for a LAN seedbox or private tracker.

## Testing

```bash
deno task verify
```

That runs `deno fmt --check`, `deno lint`, `deno check` and the full suite. Everything is offline
and deterministic: peer behaviour is exercised against a local fake peer
(`test/support/fake_peer.ts`) that serves BEP-9 from a synthetic info dict, including poisoned and
partial variants, and the database is **PGlite** — real Postgres compiled to WebAssembly, in
process. The suite therefore runs the same SQL and applies the same `sql/*.sql` as production, with
no daemon and no container.

PGlite has a single backend and serialises everything, so it cannot express two concurrent
transactions. The sequential first-writer-wins proof runs everywhere; the genuinely concurrent one
is gated behind a real database and skipped when it is absent:

```bash
MA_TEST_DATABASE_URL=postgresql://... deno task test
```

`test/contract_test.ts` imports sl-stream's **actual** adapter and feeds it our records, so the
constraints above are checked against the real implementation rather than a copy of its rules. It
skips if the sibling checkout is absent.

## Notes on the protocol implementation

- **Bencode** is bounds-checked and depth-limited. Everything decoded arrives from an
  unauthenticated peer, and the obvious implementation hangs on truncated input.
- **Metadata is verified** (`SHA-1(info dict) === infohash`) before a single byte offset is derived
  from it. On a mismatch the buffer is discarded and every contributor is banned.
- **Cancellation goes through `reader.cancel()`**, not `conn.close()` — closing a `Deno.Conn` does
  _not_ interrupt a pending read, so a quiet peer would otherwise pin a socket open forever.
- **BEP-10 extended ids are per-recipient**: outgoing messages use the id the peer advertised,
  incoming ones arrive under the id we advertised. The fake peer deliberately advertises
  `ut_metadata` as 3 to keep that honest.
- **BitTorrent v2** (`urn:btmh:`) magnets are refused with a clear message; the chunk record model
  is v1 piece-based.
