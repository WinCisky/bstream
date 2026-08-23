/**
 * A TCP connection to a peer that can actually be cancelled.
 *
 * The PoC races `conn.read(buf.subarray(off))` against a `setTimeout` and catches the rejection.
 * The read is still pending and still owns that slice of the caller's buffer, so bytes arriving
 * later land in a buffer the caller has moved on from — silent stream desync rather than an error.
 *
 * The fix is not simply to close the socket on timeout: **`Deno.Conn.close()` does not interrupt a
 * pending `conn.read()`**. A read blocked on a peer that has gone quiet stays blocked forever,
 * pinning the socket and the event loop open, which is the same hang wearing a different hat.
 * `conn.readable`'s reader *does* cancel — `reader.cancel()` settles the pending read as `done` —
 * so all I/O goes through the stream API and cancellation goes through the reader.
 *
 * Chunks are copied out of the stream before being retained, so nothing the caller holds can be
 * aliased by a buffer the socket might reuse.
 */

export class WireError extends Error {
  override readonly name = "WireError";
}

/**
 * Connects that have been started but not yet settled, **including ones we stopped waiting for**.
 *
 * `Deno.connect` cannot be cancelled, so a connect to a routed-but-silent host stays pending until
 * the OS gives up on the SYN — on Linux, over two minutes. Each one holds a file descriptor for
 * that whole time, long after its dial slot was freed. Counting them is what lets the dial pool
 * bound file descriptors rather than just bounding sessions.
 */
let pendingConnects = 0;

export function outstandingConnects(): number {
  return pendingConnects;
}

export class WireConn {
  readonly #conn: Deno.TcpConn;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #signal: AbortSignal;
  readonly #abortListener: () => void;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #closed = false;

  private constructor(conn: Deno.TcpConn, signal: AbortSignal) {
    this.#conn = conn;
    this.#reader = conn.readable.getReader();
    this.#writer = conn.writable.getWriter();
    this.#signal = signal;
    this.#abortListener = () => this.close();
    signal.addEventListener("abort", this.#abortListener, { once: true });
    if (signal.aborted) this.close();
  }

  static async connect(
    hostname: string,
    port: number,
    signal: AbortSignal,
    connectTimeoutMs: number,
  ): Promise<WireConn> {
    if (signal.aborted) throw new WireError("aborted before connect");

    // `Deno.connect` takes no signal, so this one really is a race.
    pendingConnects++;
    let accounted = false;
    const settleAccount = () => {
      if (accounted) return;
      accounted = true;
      pendingConnects--;
    };

    const pending = Deno.connect({ hostname, port, transport: "tcp" });
    let settled = false;

    let fail: (reason: Error) => void = () => {};
    const guard = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const timer = setTimeout(() => {
      if (!settled) fail(new WireError(`connect to ${hostname}:${port} timed out`));
    }, connectTimeoutMs);
    const onAbort = () => {
      if (!settled) fail(new WireError("aborted during connect"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const conn = await Promise.race([pending, guard]);
      settled = true;
      settleAccount();
      return new WireConn(conn, signal);
    } catch (err) {
      // The connect may still succeed after we stopped waiting. Adopt and close it, rather than
      // leaving a leaked socket and an unhandled rejection the way the PoC does. The descriptor
      // stays charged to us until it actually settles.
      pending.then((late) => {
        try {
          late.close();
        } catch {
          // Already dead.
        }
      }).catch(() => {}).finally(settleAccount);
      throw err;
    } finally {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Read exactly `n` bytes. Throws on EOF, on cancellation, or on any socket error. */
  async readExact(n: number): Promise<Uint8Array> {
    if (n < 0) throw new WireError(`negative read length ${n}`);
    while (this.#buffered < n) {
      if (this.#closed) throw new WireError("connection closed");
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await this.#reader.read();
      } catch (err) {
        this.close();
        if (this.#signal.aborted) throw new WireError("aborted during read");
        throw new WireError(`read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // A cancelled reader settles as `done`, which is how an abort surfaces here.
      if (result.done) {
        this.close();
        throw new WireError(
          this.#signal.aborted ? "aborted during read" : "peer closed the connection",
        );
      }
      const chunk = result.value;
      if (chunk.length === 0) continue;
      // Copy before retaining: never hold a buffer the stream might reuse.
      this.#chunks.push(new Uint8Array(chunk));
      this.#buffered += chunk.length;
    }
    return this.#take(n);
  }

  #take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#chunks[0]!;
      const room = n - filled;
      if (chunk.length <= room) {
        out.set(chunk, filled);
        filled += chunk.length;
        this.#chunks.shift();
      } else {
        out.set(chunk.subarray(0, room), filled);
        this.#chunks[0] = chunk.subarray(room);
        filled = n;
      }
    }
    this.#buffered -= n;
    return out;
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw new WireError("connection closed");
    try {
      await this.#writer.write(data);
    } catch (err) {
      this.close();
      if (this.#signal.aborted) throw new WireError("aborted during write");
      throw new WireError(`write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#abortListener);
    this.#chunks = [];
    this.#buffered = 0;
    // Cancelling the reader is what actually unblocks a pending read; the rest is teardown.
    this.#reader.cancel().catch(() => {});
    this.#writer.abort().catch(() => {});
    try {
      this.#conn.close();
    } catch {
      // Expected once the streams have already torn the socket down.
    }
  }
}
