/**
 * BEP-9 metadata assembly, shared by every peer session at once.
 *
 * Two things here that the PoC does not do, both of which decide whether this works at all:
 *
 * **Pieces merge across peers.** The PoC gives each peer its own buffer and throws away anything
 * short of a complete set, so a swarm of peers that each serve half the metadata yields nothing.
 * Here there is one buffer; a session asks what is still `missing()` and requests only that.
 *
 * **The result is verified.** `SHA-1(info dict) === infohash` is the whole reason a magnet link
 * can be trusted. Skip it and any peer can hand back an arbitrary info dict — different piece
 * length, different file list — and every byte offset downstream is derived from a lie. On a
 * mismatch the buffer is discarded outright and everyone who contributed to it is banned, because
 * there is no way to tell which of them poisoned it.
 */

import { bytesEqual, sha1, toHex } from "../bytes.ts";
import { log } from "../log.ts";

export const METADATA_PIECE_BYTES = 16 * 1024;

/** A poisoned round costs a full re-fetch, so allow a few and then stop burning the deadline. */
const MAX_RESETS = 3;

export class MetadataAssembler {
  readonly #infoHash: Uint8Array;
  readonly #maxBytes: number;
  readonly #deferred = Promise.withResolvers<Uint8Array>();
  readonly #banned = new Set<string>();

  #size: number | null = null;
  #sizeFrom: string | null = null;
  #pieceCount = 0;
  #buffer: Uint8Array | null = null;
  #have: boolean[] = [];
  #haveCount = 0;
  #contributors = new Map<number, string>();
  #verifying = false;
  #resets = 0;
  #done = false;

  constructor(infoHash: Uint8Array, maxBytes: number) {
    this.#infoHash = infoHash;
    this.#maxBytes = maxBytes;
    // Nothing awaits this until the orchestrator does; keep it from ever being an unhandled
    // rejection in the meantime. It only ever resolves, but the guard costs nothing.
    this.#deferred.promise.catch(() => {});
  }

  /** Resolves with the verified info dict bytes. Never rejects; the caller owns the deadline. */
  get verified(): Promise<Uint8Array> {
    return this.#deferred.promise;
  }

  get done(): boolean {
    return this.#done;
  }

  get exhausted(): boolean {
    return this.#resets > MAX_RESETS;
  }

  isBanned(peerKey: string): boolean {
    return this.#banned.has(peerKey);
  }

  /**
   * Register the `metadata_size` a peer advertised. Returns false when this peer cannot be used:
   * an implausible size, or one that contradicts the size already being assembled.
   */
  declareSize(size: number, peerKey: string): boolean {
    if (this.#done) return false;
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.#maxBytes) return false;
    if (this.#size === null) {
      this.#size = size;
      this.#sizeFrom = peerKey;
      this.#pieceCount = Math.ceil(size / METADATA_PIECE_BYTES);
      this.#buffer = new Uint8Array(size);
      this.#have = new Array<boolean>(this.#pieceCount).fill(false);
      this.#haveCount = 0;
      return true;
    }
    return this.#size === size;
  }

  /** Piece indexes still outstanding, in order. */
  missing(): number[] {
    if (this.#done || this.#size === null) return [];
    const out: number[] = [];
    for (let i = 0; i < this.#pieceCount; i++) {
      if (!this.#have[i]) out.push(i);
    }
    return out;
  }

  expectedPieceLength(index: number): number {
    if (this.#size === null) return 0;
    return Math.min(METADATA_PIECE_BYTES, this.#size - index * METADATA_PIECE_BYTES);
  }

  /**
   * Accept a metadata piece. Returns true when it was new and usable.
   *
   * Verification is awaited rather than fired off, so that by the time this resolves `done` is
   * settled. A caller that checked a still-pending flag would go back to waiting for a message its
   * peer has no reason to send, and sit there until its session budget expired.
   */
  async offer(index: number, bytes: Uint8Array, peerKey: string): Promise<boolean> {
    if (this.#done || this.#size === null || this.#buffer === null) return false;
    if (!Number.isInteger(index) || index < 0 || index >= this.#pieceCount) return false;
    if (this.#have[index]) return false;

    const expected = this.expectedPieceLength(index);
    // Peers may append padding after the piece, but never send less than the piece.
    if (bytes.length < expected) return false;

    this.#buffer.set(bytes.subarray(0, expected), index * METADATA_PIECE_BYTES);
    this.#have[index] = true;
    this.#haveCount++;
    this.#contributors.set(index, peerKey);

    if (this.#haveCount === this.#pieceCount) await this.#verify();
    return true;
  }

  async #verify(): Promise<void> {
    if (this.#verifying || this.#done || this.#buffer === null) return;
    this.#verifying = true;
    const candidate = this.#buffer;
    try {
      const digest = await sha1(candidate);
      if (bytesEqual(digest, this.#infoHash)) {
        this.#done = true;
        this.#deferred.resolve(candidate);
        return;
      }
      log.warn("metadata.hash_mismatch", {
        want: toHex(this.#infoHash),
        got: toHex(digest),
        contributors: this.#contributors.size,
      });
      this.#reset();
    } catch (err) {
      log.error("metadata.verify_failed", { msg: String(err) });
      this.#reset();
    } finally {
      this.#verifying = false;
    }
  }

  /**
   * Throw the round away. Any contributor could be the liar and there is no way to tell which, so
   * all of them are banned — including whoever declared the size, since a wrong size produces a
   * buffer that can never hash correctly no matter who fills it.
   */
  #reset(): void {
    for (const peerKey of this.#contributors.values()) this.#banned.add(peerKey);
    if (this.#sizeFrom) this.#banned.add(this.#sizeFrom);
    this.#contributors.clear();
    this.#size = null;
    this.#sizeFrom = null;
    this.#pieceCount = 0;
    this.#buffer = null;
    this.#have = [];
    this.#haveCount = 0;
    this.#resets++;
  }
}
