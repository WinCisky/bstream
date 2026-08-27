/**
 * The HTTP surface.
 *
 * Every case here is rejected before `resolveMagnet` reaches the database or the swarm, so nothing
 * touches KV or the network.
 */

import { assertEquals } from "@std/assert";
import { handleRequest, pickAllowedOrigin } from "../src/http/handler.ts";

function post(body: unknown, path = "/resolve"): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test("healthz responds", async () => {
  const response = await handleRequest(new Request("http://localhost/healthz"));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
});

Deno.test("unknown routes are 404", async () => {
  const response = await handleRequest(new Request("http://localhost/nope"));
  assertEquals(response.status, 404);
  assertEquals((await response.json()).error, "not_found");
});

Deno.test("GET /resolve is 405", async () => {
  const response = await handleRequest(new Request("http://localhost/resolve"));
  assertEquals(response.status, 405);
});

Deno.test("a non-JSON body is 400", async () => {
  const response = await handleRequest(post("not json at all"));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "bad_json");
});

Deno.test("a missing magnet is 400", async () => {
  const response = await handleRequest(post({ nope: true }));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "missing_magnet");
});

Deno.test("an empty magnet is 400", async () => {
  const response = await handleRequest(post({ magnet: "   " }));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "missing_magnet");
});

Deno.test("a malformed magnet is 400, not 500", async () => {
  const response = await handleRequest(post({ magnet: "magnet:?dn=no-topic-here" }));
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error, "bad_magnet");
});

Deno.test("a v2 magnet is refused with a specific message", async () => {
  const response = await handleRequest(
    post({ magnet: "magnet:?xt=urn:btmh:1220caf1e1c30e81cb361b9ee167c4946a448b" }),
  );
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error, "bad_magnet");
  assertEquals(body.message.includes("v2"), true);
});

Deno.test("an oversized body is 413", async () => {
  const response = await handleRequest(post({ magnet: `magnet:?dn=${"x".repeat(20_000)}` }));
  assertEquals(response.status, 413);
});

// --- POST /refresh -------------------------------------------------------------------------------
// These run with MA_REFRESH_TOKEN unset, which is the configuration that must fail closed.

function refresh(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return new Request("http://localhost/refresh", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test("refresh with no token configured refuses every caller", async () => {
  // The dangerous default would be to run open when MA_REFRESH_TOKEN is unset: this endpoint does
  // uncapped outbound swarm work on a public host.
  const response = await handleRequest(refresh({ id: "0".repeat(40) }));
  assertEquals(response.status, 401);
  assertEquals((await response.json()).error, "unauthorized");
});

Deno.test("refresh rejects a bearer token when none is configured", async () => {
  const response = await handleRequest(refresh({ id: "0".repeat(40) }, "guess"));
  assertEquals(response.status, 401);
});

Deno.test("refresh rejects a malformed authorization header", async () => {
  const request = new Request("http://localhost/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Basic abc" },
    body: JSON.stringify({ id: "0".repeat(40) }),
  });
  assertEquals((await handleRequest(request)).status, 401);
});

Deno.test("GET /refresh is 405", async () => {
  const response = await handleRequest(new Request("http://localhost/refresh"));
  assertEquals(response.status, 405);
});

Deno.test("auth is checked before the body is even parsed", async () => {
  // Otherwise an unauthenticated caller could probe validation behaviour, and a garbage body from
  // a stranger would be parsed before we knew whether to talk to them at all.
  const response = await handleRequest(refresh("not json"));
  assertEquals(response.status, 401);
});

// CORS origin selection. `Access-Control-Allow-Origin` carries one value, so with several origins
// configured the matching one has to be echoed back rather than the first in the list.

Deno.test("records with no token configured refuses every caller", async () => {
  // Same closed-by-default posture as /refresh, and checked before the id is even looked at, so an
  // unauthenticated caller cannot use the 400/404 split to probe which ids exist.
  const response = await handleRequest(
    new Request(`http://localhost/records/${"a".repeat(40)}`),
  );
  assertEquals(response.status, 401);
  assertEquals((await response.json()).error, "unauthorized");
});

Deno.test("records rejects a bearer token when none is configured", async () => {
  const response = await handleRequest(
    new Request(`http://localhost/records/${"a".repeat(40)}`, {
      headers: { authorization: "Bearer anything" },
    }),
  );
  assertEquals(response.status, 401);
});

Deno.test("a malformed id is refused before the database, not after", async () => {
  // 401 rather than 400: auth runs first, so this never opens a connection either way.
  const response = await handleRequest(new Request("http://localhost/records/nope"));
  assertEquals(response.status, 401);
});

Deno.test("POST /records/:id is 405", async () => {
  const response = await handleRequest(post({}, `/records/${"a".repeat(40)}`));
  assertEquals(response.status, 405);
});

Deno.test("bare /records with no id is 404", async () => {
  const response = await handleRequest(new Request("http://localhost/records"));
  assertEquals(response.status, 404);
  assertEquals((await response.json()).error, "not_found");
});

Deno.test("a configured origin is echoed back when it matches", () => {
  const allowed = ["https://sl-stream.simo.deno.net", "https://wincisky.github.io"];
  assertEquals(
    pickAllowedOrigin("https://wincisky.github.io", allowed),
    "https://wincisky.github.io",
  );
  assertEquals(
    pickAllowedOrigin("https://sl-stream.simo.deno.net", allowed),
    "https://sl-stream.simo.deno.net",
  );
});

Deno.test("an unlisted origin gets no CORS header", () => {
  assertEquals(pickAllowedOrigin("https://evil.example", ["https://wincisky.github.io"]), null);
  assertEquals(pickAllowedOrigin(null, ["https://wincisky.github.io"]), null);
});

Deno.test("no configured origins means no CORS at all", () => {
  assertEquals(pickAllowedOrigin("https://wincisky.github.io", []), null);
});

Deno.test("a configured wildcard still answers wildcard", () => {
  assertEquals(pickAllowedOrigin("https://anything.example", ["*"]), "*");
  assertEquals(pickAllowedOrigin(null, ["*"]), "*");
});
