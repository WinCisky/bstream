/**
 * BEP-3 HTTP(S) tracker announce.
 *
 * The PoC's version is switched off everywhere (`skipHttp: true`) and for good reason: it loops
 * over trackers **sequentially** and calls `fetch` with **no timeout**, so one hung tracker blocks
 * discovery for as long as the connection stays open. Both are fixed here, along with `left=0`
 * (which advertises us as a seeder and gets fewer peers back) and the dictionary-model peer list,
 * which the PoC's compact-only parser turns into garbage.
 */

import { asBytes, asDict, asInt, asList, asText, decode } from "../bencode/decode.ts";
import { log } from "../log.ts";
import type { PeerHint } from "../magnet.ts";
import { parseCompactPeers4, parseCompactPeers6 } from "../net/compact.ts";

/** A tracker response larger than this is not a peer list. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Percent-encode raw bytes; the infohash is binary, not text. */
function encodeBytes(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    const isUnreserved = (byte >= 0x30 && byte <= 0x39) || // 0-9
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e; // - . _ ~
    out += isUnreserved ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** The dictionary model: a list of `{ip, port}` dicts instead of a packed byte string. */
function parseDictPeers(value: ReturnType<typeof asList>): PeerHint[] {
  if (!value) return [];
  const out: PeerHint[] = [];
  for (const entry of value) {
    const dict = asDict(entry);
    if (!dict) continue;
    const ip = asText(dict["ip"]);
    const port = asInt(dict["port"]);
    if (ip && port !== null) out.push({ ip, port });
  }
  return out;
}

async function announceOne(
  trackerUrl: string,
  infoHash: Uint8Array,
  peerId: Uint8Array,
  listenPort: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PeerHint[]> {
  const url = new URL(trackerUrl);
  // Built by hand rather than through URLSearchParams: the infohash and peer id are raw bytes,
  // and URLSearchParams would UTF-8 encode them into something the tracker cannot match.
  const query = [
    `info_hash=${encodeBytes(infoHash)}`,
    `peer_id=${encodeBytes(peerId)}`,
    `port=${listenPort}`,
    "uploaded=0",
    "downloaded=0",
    // Non-zero: announcing as a seeder gets us fewer peers back.
    "left=9007199254740991",
    "compact=1",
    "numwant=200",
    "event=started",
  ].join("&");
  url.search = url.search ? `${url.search}&${query}` : `?${query}`;

  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, timeout]),
    headers: { accept: "text/plain, */*" },
    redirect: "follow",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`tracker returned ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error("tracker response too large");
  const decoded = asDict(decode(new Uint8Array(buffer)));
  if (!decoded) throw new Error("tracker response is not a dict");

  const failure = asText(decoded["failure reason"]);
  if (failure) throw new Error(`tracker refused: ${failure.slice(0, 200)}`);

  const out: PeerHint[] = [];
  const peers = decoded["peers"];
  const compact = asBytes(peers);
  if (compact) out.push(...parseCompactPeers4(compact));
  else out.push(...parseDictPeers(asList(peers)));

  const compact6 = asBytes(decoded["peers6"]);
  if (compact6) out.push(...parseCompactPeers6(compact6));
  return out;
}

export interface HttpAnnounceOptions {
  readonly trackers: readonly string[];
  readonly infoHash: Uint8Array;
  readonly peerId: Uint8Array;
  readonly listenPort: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly onPeers: (peers: PeerHint[], tracker: string) => void;
}

export async function announceHttpTrackers(options: HttpAnnounceOptions): Promise<void> {
  const trackers = options.trackers.filter((tracker) =>
    tracker.startsWith("http://") || tracker.startsWith("https://")
  );
  if (trackers.length === 0) return;

  await Promise.allSettled(trackers.map(async (tracker) => {
    try {
      const peers = await announceOne(
        tracker,
        options.infoHash,
        options.peerId,
        options.listenPort,
        options.timeoutMs,
        options.signal,
      );
      if (peers.length > 0) options.onPeers(peers, tracker);
      log.debug("tracker.http_ok", { tracker, peers: peers.length });
    } catch (err) {
      log.debug("tracker.http_failed", { tracker, msg: String(err) });
    }
  }));
}
