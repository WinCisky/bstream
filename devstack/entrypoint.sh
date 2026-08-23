#!/bin/bash
#
# Starts ma-stream, sl-stream and the dev page, and ties their lifetimes together.
#
# The `wait -n` is the point: if any one of the three dies, the container exits rather than sitting
# there half-working. A stack that is silently missing its resolver looks exactly like a stack whose
# peers went stale, and debugging the wrong one of those wastes an afternoon.

set -euo pipefail

: "${MA_PORT:=8201}"
: "${SL_PORT:=8202}"
: "${DEVSTACK_PORT:=8080}"
: "${MA_REFRESH_TOKEN:=devstack-local-token}"
export MA_REFRESH_TOKEN

# All three processes talk to the same Postgres. Under compose that is the `db` service and
# `depends_on: service_healthy` has already waited for it; under a bare `docker run` nothing has, so
# the migration step below does the waiting itself.
: "${MA_DATABASE_URL:?MA_DATABASE_URL must be set}"
export MA_DATABASE_URL
export SL_DATABASE_URL="${SL_DATABASE_URL:-${MA_DATABASE_URL}}"
export DEVSTACK_DATABASE_URL="${DEVSTACK_DATABASE_URL:-${MA_DATABASE_URL}}"

# Apply the schema before either service starts. A service that boots against an empty database
# fails on its first request instead of at start, and a stack that is silently missing its schema
# looks exactly like a resolver bug — which is the afternoon this whole file exists to save.
deno run --allow-net --allow-env --allow-read --allow-sys \
  /app/ma-stream/scripts/migrate.ts --wait 60

# ma-stream needs UDP (trackers, DHT) and raw TCP (peer wire); sl-stream needs raw TCP.
MA_PERMS=(--unstable-net --allow-net --allow-env --allow-read --allow-write --allow-sys)
SL_PERMS=(--allow-net --allow-env --allow-read --allow-write --allow-sys)

echo "devstack: ma=:${MA_PORT} sl=:${SL_PORT} web=:${DEVSTACK_PORT}"

PORT="${MA_PORT}" \
  MA_CORS_ORIGIN="${MA_CORS_ORIGIN:-*}" \
  deno run "${MA_PERMS[@]}" /app/ma-stream/main.ts &
ma=$!

# sl-stream reaches ma-stream over loopback, which is the same call it makes to the VPS in
# production — same route, same bearer token, same failure handling.
PORT="${SL_PORT}" \
  SL_REFRESH_URL="http://127.0.0.1:${MA_PORT}/refresh" \
  SL_REFRESH_TOKEN="${MA_REFRESH_TOKEN}" \
  deno run "${SL_PERMS[@]}" /app/sl-stream/main.ts &
sl=$!

DEVSTACK_MA_URL="${DEVSTACK_MA_URL:-http://localhost:${MA_PORT}}" \
  DEVSTACK_SL_URL="${DEVSTACK_SL_URL:-http://localhost:${SL_PORT}}" \
  deno run --allow-net --allow-env --allow-read --allow-write --allow-sys \
  /app/ma-stream/devstack/server.ts &
web=$!

shutdown() {
  trap - TERM INT
  kill "${ma}" "${sl}" "${web}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap shutdown TERM INT

wait -n "${ma}" "${sl}" "${web}"
echo "devstack: a service exited; shutting the rest down" >&2
shutdown
exit 1
