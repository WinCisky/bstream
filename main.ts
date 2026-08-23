/**
 * Entry point.
 *
 * The crash guards come first, before anything can import a module that opens a socket. This
 * process holds dozens of concurrent peer connections whose failure modes are almost entirely
 * "the other end vanished"; without these, one socket dying during teardown after its session
 * already returned takes down the whole service and every other resolve in flight with it.
 */

import { config } from "./src/config.ts";
import { errFields, log } from "./src/log.ts";
import { handleRequest } from "./src/http/handler.ts";

globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  log.error("unhandled_rejection", errFields(event.reason));
});

globalThis.addEventListener("error", (event) => {
  event.preventDefault();
  log.error("uncaught_error", errFields(event.error ?? event.message));
});

// Said once at boot rather than only on the first request. A config read must never be able to
// kill a boot, so an unset database is a 503 from `openDb()` and not a crash — which makes it easy
// to miss until a resolve fails.
if (config.databaseUrl.length === 0) {
  log.warn("db.unconfigured", { hint: "MA_DATABASE_URL is not set; /resolve will answer 503" });
}

const rawPort = Number(Deno.env.get("PORT") ?? 8000);
const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 8000;

Deno.serve({ port }, async (request) => {
  try {
    return await handleRequest(request);
  } catch (err) {
    // Belt and braces: handleRequest maps its own errors, so reaching here is a bug, not a peer.
    log.error("handler_threw", errFields(err));
    return new Response(
      JSON.stringify({ error: "internal_error", message: "request failed" }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
});
