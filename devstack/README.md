# Dev stack

Both services and a test page in one container, for trying the whole thing locally.

```bash
cd ma-stream/devstack
docker compose up --build
```

Then open <http://localhost:8080>.

| Port | What                                          |
| ---- | --------------------------------------------- |
| 8080 | Test page and the dev-only database endpoints |
| 8201 | ma-stream — `POST /resolve`, `POST /refresh`  |
| 8202 | sl-stream — `GET /stream/:id?file=`           |

Without compose:

```bash
docker build -f ma-stream/devstack/Dockerfile -t ma-stack:dev ..
docker run --rm -p 8080:8080 -p 8201:8201 -p 8202:8202 -e MA_REFRESH_TOKEN=devstack-local-token ma-stack:dev
```

The build context is the directory holding **both** checkouts, since the image needs each of them.

## Why one container

Not because anything is shared through the filesystem any more — Postgres is its own service in
`compose.yaml`. It is one container because sl-stream has to reach ma-stream over loopback with the
same bearer token it uses in production, and because tying three lifetimes together is the point:
`wait -n` means any one of them dying takes the container down rather than leaving a stack that is
silently missing its resolver.

The entrypoint applies the schema before either service starts, with `scripts/migrate.ts --wait 60`.
Under compose `depends_on: service_healthy` has already waited for Postgres; under a bare
`docker run` nothing has, so the `--wait` does it.

Production is of course separate: sl-stream on Deno Deploy, ma-stream on a VPS, both against the
same Postgres. The one thing this stack cannot tell you is whether **Deno Deploy permits outbound
TCP** to that database — which matters, because it is the constraint that put ma-stream on a VPS.

## What the page does

1. **Resolve a magnet.** Prefilled with Big Buck Bunny (CC-BY, and an `.mp4`). ma-stream walks
   trackers, the DHT and PEX while fetching metadata over BEP-9, verifies
   `SHA-1(info dict) === infohash`, and writes the peer and chunk records.
2. **Show what was resolved** — peer counts, how many were verified by a handshake, piece geometry,
   how long ago each record was written, and the torrent's full contents as a tree. Clicking a
   playable file streams it: the tree's positions are exactly what sl-stream's `?file=` indexes, so
   a season pack is one resolve and ten episodes. Non-video and padding files are behind the two
   checkboxes, off by default.
3. **Play it, and check the bytes.** Play the video, or _Verify a piece_ — which fetches one
   piece-aligned range and checks its SHA-1 against the torrent's own hash for that index. That
   assertion is the point: it only passes if discovery, the peer wire and the piece maths are all
   correct, and it is computed from the **selected** file's offset, so it re-proves the maths on
   every file switch.

`Verify a piece` requests with `cache: no-store`, and the player URL carries a cache-buster. Without
those, the browser answers a repeated range from its own cache and the check passes without a byte
crossing the network.

The peer record can still be broken by hand to watch a refresh recover it, and that is pleasanter
than editing a binary KV file was:

```bash
docker compose exec db psql -U devstack -d stack \
  -c "update peer_records set resolved_at = resolved_at - 3600000 where id = '<id>'"
```

There is no longer a button for it.

## Playback

ma-stream lists every `.mp4`, `.m4v`, `.mkv` and `.avi` in a torrent and defaults to the largest,
and a torrent is under no obligation to hold something a browser can decode: Matroska and AVI play
natively nowhere, HEVC is hardware- and platform-dependent, and AC-3 or DTS audio is common in
releases and supported almost nowhere. Those used to show up as a black player, which is a false
negative — the page is meant to answer whether the swarm and the range serving work, not whether the
browser ships an AC-3 decoder.

Everything therefore plays through **[libmedia](https://github.com/zhaohappy/libmedia)**
(`public/player.js`): it demuxes MP4, Matroska and AVI in WebAssembly and decodes through WebCodecs
where the browser has it and through per-codec ffmpeg wasm modules where it does not — H.264, HEVC,
VVC, AV1, VP8/9, MPEG-2/4 and AAC, AC-3, E-AC-3, DTS, MP3, Opus, FLAC, Vorbis, PCM. It fetches by
range, so the transport stays under test.

There is **no native `<video>` path**, not even for files a browser could play, because
`canPlayType` cannot be trusted to say so. It answers per container, not per track: Chrome says
`"maybe"` to `video/x-matroska`, then plays an HEVC file with `videoWidth === 0`, no `error` event
and audio only — a black picture and a green tick. An AC-3 track in a file whose video decodes fine
fails the same way in reverse. Every "yes" would have to be re-checked after the fact against what
was actually decoded, and libmedia covers the easy cases anyway: it switches to MSE by itself when
the codecs are natively supported.

Nothing is transcoded server-side; sl-stream still serves the original bytes.

`devstack/vendor.ts` downloads the player and ~18 MiB of wasm into `public/vendor/` **at image build
time**, pinned to one libmedia version, so a running container fetches nothing from the internet to
play a video and no CDN is trusted mid-test. It is idempotent and gitignored; run it by hand for the
no-Docker setup below. libmedia is LGPL-3.0 — vendored unmodified and dynamically loaded, with its
licence text alongside it.

The page is served **cross-origin isolated** (`COOP: same-origin`, `COEP: require-corp`), which is
what makes `SharedArrayBuffer` available so wasm decoding runs on worker threads instead of the main
one; the page logs which it got. That is also why sl-stream sends
`cross-origin-resource-policy: cross-origin`: without it an isolated page cannot load the stream at
all. Software-decoded 1080p HEVC will still not be smooth — the test is that frames arrive, not that
they arrive in real time.

### Rendering, and the line of numbers under the player

The page polls libmedia's own counters once a second: render and decode framerate, dropped frames
and packets, decode errors, stutter, keyframe interval, slowest render.

They are there for one question. When the picture drops out for a frame or two, the cause is either
the pipeline losing frames or the compositor showing an empty canvas, and the two are
indistinguishable by eye. If a glitch happens while every counter sits still — decode framerate
equal to the file's own rate, zero drops, zero errors, slowest render no longer than one frame —
then libmedia delivered every frame on time and the problem is after it: the canvas it renders into
belongs to a worker, and such a canvas can be composited on a frame where its drawing buffer has
been discarded. That is why the canvas gets its own compositing layer in the stylesheet and why
WebGPU is requested when the machine has an adapter; the header line reports which renderer was
asked for.

## Dev-only endpoints

Served by `server.ts` on :8080. **No authentication, direct database access.** Fine inside a local
container, indefensible anywhere else — this is not part of either service.

| Endpoint                         | Purpose                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| `GET /dev/config`                | URLs and the refresh token, so the page can call both services          |
| `GET /dev/state?id=`             | The three records for an id, with piece hashes summarised not sent, and |
|                                  | the full file list the tree is drawn from                               |
| `GET /dev/piece-hash?id=&index=` | The torrent's own SHA-1 for one piece                                   |

## The same page against the deployed services

`.github/workflows/deploy-page.yml` publishes `public/` to GitHub Pages, pointed at ma-stream on the
VPS and sl-stream on Deno Deploy. It runs on a push to `main` that touches the page or `vendor.ts`,
and from the Actions tab. Set two repository **variables** first — Settings → Secrets and variables
→ Actions → Variables — plus an optional third:

| Variable         | Example                       |
| ---------------- | ----------------------------- |
| `MA_URL`         | `https://ma.example.com`      |
| `SL_URL`         | `https://sl.example.deno.net` |
| `DEFAULT_MAGNET` | the magnet the page prefills  |

The workflow vendors libmedia the same way the image does and writes `dev/config` from those
variables, so the page finds the same JSON there that `server.ts` serves locally. Every path in the
page is relative to the document, which is what lets the same files sit at the site root in the
container and under `/<repo>/` on Pages.

ma-stream then needs `MA_CORS_ORIGIN=https://<owner>.github.io`, since the page calls `/resolve`
from the browser. sl-stream already sends `cross-origin-resource-policy: cross-origin`.

`MA_CORS_ORIGIN` takes a comma-separated list, so a service fronted by more than one page allows
them all at once — `MA_CORS_ORIGIN=https://sl-stream.simo.deno.net,https://<owner>.github.io`.
ma-stream echoes back whichever of them sent the request, since the header carries one origin.

Three things are different from the container, and the page says so rather than pretending
otherwise:

- **No dev endpoints.** They reach into the database, which the deployed page cannot touch.
  `dev/config` says `live: true`, and the page then rebuilds its state panel from what `/resolve`
  and `/refresh` return, hides _Break it_, and reports _Verify a piece_ as a digest with nothing to
  compare it against — the torrent's piece hashes are only in the database.
- **No refresh token.** It is a shared secret and the artifact is public, so it is not deployed and
  _Refresh peers_ is disabled. Open the page as `…/#token=<MA_REFRESH_TOKEN>` to enable it for a
  session; the fragment is never sent to the server.
- **No cross-origin isolation.** Pages cannot set COOP/COEP, so `SharedArrayBuffer` is unavailable
  and libmedia decodes on the main thread. The header line still logs which it got.

## Configuration

`compose.yaml` sets sensible local values. The ones worth knowing:

| Variable                 | Default here           | Why                                                      |
| ------------------------ | ---------------------- | -------------------------------------------------------- |
| `MA_REFRESH_TOKEN`       | `devstack-local-token` | Shared by ma-stream's route and sl-stream's client       |
| `MA_CORS_ORIGIN`         | `*`                    | The page is on :8080 and calls ma-stream on :8201        |
| `MA_RESOLVE_DEADLINE_MS` | `30000`                | Lower than production, so a bad magnet fails visibly     |
| `SL_REFRESH_COOLDOWN_MS` | `15000`                | Low enough to break-and-recover repeatedly while testing |

`MA_CORS_ORIGIN` is empty by default in ma-stream itself — nothing in the real deployment is
browser-facing, since sl-stream calls `/refresh` server-side. It accepts a comma-separated list of
origins, or `*` as here.

Records persist in the `stack-db` volume. To start clean:

```bash
docker compose down -v
```

## Running it without Docker

Three processes against one database, which is all the container does — plus the database itself,
which no longer comes for free with the filesystem:

```bash
docker run -d --rm --name ma-db -p 5432:5432 \
  -e POSTGRES_USER=devstack -e POSTGRES_PASSWORD=devstack -e POSTGRES_DB=stack postgres:17-alpine

export DB=postgresql://devstack:devstack@localhost:5432/stack TOKEN=devstack-local-token

(cd ma-stream && MA_DATABASE_URL=$DB deno task migrate -- --wait 60)

(cd ma-stream && MA_DATABASE_URL=$DB MA_REFRESH_TOKEN=$TOKEN MA_CORS_ORIGIN='*' PORT=8201 \
  deno run --unstable-net -A main.ts) &

(cd sl-stream && SL_DATABASE_URL=$DB PORT=8202 \
  SL_REFRESH_URL=http://127.0.0.1:8201/refresh SL_REFRESH_TOKEN=$TOKEN \
  deno run -A main.ts) &

(cd ma-stream && DEVSTACK_DATABASE_URL=$DB MA_REFRESH_TOKEN=$TOKEN \
  deno run -A devstack/server.ts) &
```
