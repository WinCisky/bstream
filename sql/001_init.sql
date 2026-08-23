-- ma-stream owns this schema.
--
-- sl-stream reads magnets, peer_records and chunk_records, and owns the contents of peer_health.
-- It must never run a migration; see "The contract to hand sl-stream" in the README.
--
-- Every instant here is epoch milliseconds in a bigint, not a timestamptz. They are numbers in the
-- record contract sl-stream consumes, and a bigint means the same thing under every driver, session
-- TimeZone and pooler. The cost is that int8 arrives as a string under postgres.js and a number
-- under PGlite, so every reader coerces with Number().

create table magnets (
  -- The lowercase v1 infohash. The record carries it as both `id` and `infoHash`, but they are the
  -- same value; storing it once removes a drift hazard and the read contract aliases it back.
  id         text    primary key check (id ~ '^[0-9a-f]{40}$'),
  version    integer not null,
  magnet     text    not null,
  name       text    not null,
  trackers   text[]  not null default '{}',
  created_at bigint  not null,
  updated_at bigint  not null,
  peer_count integer not null default 0
);

create table chunk_records (
  id           text    primary key references magnets (id) on delete cascade,
  version      integer not null,
  name         text    not null,
  piece_length integer not null,
  piece_count  integer not null,
  total_length bigint  not null, -- exceeds 2^31 for any torrent over 2 GiB
  -- piece_count * 20 raw SHA-1 bytes, always stored inline. Deno KV capped a value at 64 KiB and
  -- the writer degraded in defined steps to fit; Postgres TOASTs this and the ladder is gone.
  pieces       bytea   not null,
  -- Positional: the index into this array IS sl-stream's `?file=`. Padding entries occupy a
  -- position and must never be skipped, or every later file shifts by one.
  files        jsonb   not null,
  file_index   integer not null,
  file_path    text    not null,
  file_offset  bigint  not null,
  file_length  bigint  not null,
  mime         text    not null,
  resolved_at  bigint  not null,

  -- The invariant sl-stream's validateLayout re-derives, and 500s the id over forever if it
  -- disagrees. Under KV only parseInfo stood between a bad record and a permanently broken id;
  -- here the write fails instead.
  constraint chunk_records_geometry check (
    piece_length > 0 and piece_count = ceil(total_length::numeric / piece_length)
  ),
  constraint chunk_records_pieces_length check (
    octet_length(pieces) = piece_count::bigint * 20
  )
);

-- SHA-1 digests do not compress, so skip the pointless pglz attempt — and, more usefully, let
-- `substring(pieces from n for 20)` fetch one digest without detoasting the whole blob.
alter table chunk_records alter column pieces set storage external;

create table peer_records (
  id          text    primary key references magnets (id) on delete cascade,
  version     integer not null,
  resolved_at bigint  not null,
  -- BitTorrent endpoints only, which is why this is not jsonb_array_length(peers): that array
  -- also carries the webseeds.
  peer_count  integer not null,
  -- Webseed URL strings first, then {ip, port, source, verified} objects. sl-stream classifies
  -- them structurally and reads only this array, so both transports have to share it.
  peers       jsonb   not null,
  webseeds    text[]  not null default '{}'
);

-- Written by sl-stream, read here so a refresh does not hand back peers it has already banned.
--
-- One row per peer rather than the single JSON map KV stored. The map made two concurrent bans a
-- read-modify-write race that lost one of them; a per-row upsert cannot. It also turns the ban
-- filter into a WHERE clause, so a refresh fetches only the keys it will actually filter on.
--
-- Deliberately no foreign key. sl-stream can ban a peer for an id whose magnet row does not exist
-- — a race against a first resolve, or a magnet deleted since — and an FK would turn a
-- best-effort telemetry write in the reader into an error path.
create table peer_health (
  id           text    not null check (id ~ '^[0-9a-f]{40}$'),
  peer_key     text    not null, -- "host:port" for BitTorrent peers, hostname for webseeds
  banned_until bigint,
  ok           integer not null default 0,
  fails        integer not null default 0,
  updated_at   bigint  not null,
  primary key (id, peer_key)
);
