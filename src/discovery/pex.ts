/**
 * BEP-11 peer exchange.
 *
 * The cheapest peer source there is: it rides on connections already open for metadata, so the
 * marginal cost of every peer it yields is zero round trips. Neither sibling project implements
 * it — the PoC advertises only `ut_metadata` and drops anything else.
 */

import { asBytes, asDict, decode } from "../bencode/decode.ts";
import { parseCompactPeers4, parseCompactPeers6 } from "../net/compact.ts";
import type { PeerHint } from "../magnet.ts";

/** A peer flooding `added` cannot be allowed to fill the queue on its own. */
const MAX_PEERS_PER_MESSAGE = 200;

export function parsePexMessage(payload: Uint8Array): PeerHint[] {
  let dict;
  try {
    dict = asDict(decode(payload));
  } catch {
    return [];
  }
  if (!dict) return [];

  const out: PeerHint[] = [];
  const added4 = asBytes(dict["added"]);
  if (added4) out.push(...parseCompactPeers4(added4));
  const added6 = asBytes(dict["added6"]);
  if (added6) out.push(...parseCompactPeers6(added6));
  // `dropped`/`dropped6` are deliberately ignored: a peer that left this peer's swarm view may
  // still be perfectly reachable from here, and we are building a snapshot, not a live membership.
  return out.slice(0, MAX_PEERS_PER_MESSAGE);
}
