# Both services plus the test page in one container.
#
# One container rather than two because sl-stream has to reach ma-stream over loopback with the same
# bearer token it uses in production, and because tying three lifetimes together is the point (see
# entrypoint.sh). The database is its own service in compose.yaml — nothing is shared through the
# filesystem any more. In production they are separate too: sl-stream on Deno Deploy, ma-stream on a
# VPS, both against the same Postgres.
#
# Build context is the directory holding *both* project checkouts:
#   docker build -f ma-stream/devstack/Dockerfile -t ma-stack ..
# or just use compose.yaml, which sets that up.

FROM denoland/deno:2.8.3

WORKDIR /app

# Manifests first, so a source edit does not invalidate the dependency cache.
COPY ma-stream/deno.json ma-stream/deno.lock* /app/ma-stream/
COPY sl-stream/deno.json sl-stream/deno.lock* /app/sl-stream/

# The fallback player (libmedia: wasm demuxers and decoders for everything the browser refuses).
# Vendored before the source copy so editing a file does not re-download ~18 MiB, and at build time
# rather than from the page so a running container fetches nothing to play a video.
COPY ma-stream/devstack/vendor.ts /app/ma-stream/devstack/
RUN deno run -A /app/ma-stream/devstack/vendor.ts

COPY ma-stream/ /app/ma-stream/
COPY sl-stream/ /app/sl-stream/

# Type-check and warm the module cache at build time, so a container start is not also a compile.
RUN deno cache /app/ma-stream/main.ts /app/sl-stream/main.ts \
    /app/ma-stream/devstack/server.ts /app/ma-stream/scripts/migrate.ts

RUN chown -R deno:deno /app

USER deno

EXPOSE 8080 8201 8202

ENTRYPOINT ["/bin/bash", "/app/ma-stream/devstack/entrypoint.sh"]
