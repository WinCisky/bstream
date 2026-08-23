/**
 * One UDP socket for every datagram source, with a single receive loop and explicit demuxing.
 *
 * The PoC opens a fresh socket per tracker and calls `conn.receive()` inline, which means it
 * accepts *whatever arrives first* on that socket as the answer to the question it just asked.
 * Combined with never checking transaction ids, any host that can guess the port can inject a
 * peer list. Here every waiter states what it is waiting for, and unmatched packets are dropped.
 *
 * It also fixes a quieter bug: the PoC builds `new DataView(buf.buffer)` without the byte offset,
 * which is correct only while Deno happens to return offset-zero views from `receive()`.
 */

import { log } from "../log.ts";

export type PacketMatcher = (data: Uint8Array, addr: Deno.NetAddr) => boolean;

interface Waiter {
  readonly match: PacketMatcher;
  readonly resolve: (packet: { data: Uint8Array; addr: Deno.NetAddr }) => void;
  readonly reject: (reason: Error) => void;
}

export class UdpError extends Error {
  override readonly name = "UdpError";
}

export class UdpSocket {
  readonly #conn: Deno.DatagramConn;
  readonly #waiters = new Set<Waiter>();
  #closed = false;

  private constructor(conn: Deno.DatagramConn) {
    this.#conn = conn;
    void this.#receiveLoop();
  }

  static open(): UdpSocket {
    const conn = Deno.listenDatagram({ transport: "udp", port: 0, hostname: "0.0.0.0" });
    return new UdpSocket(conn);
  }

  async #receiveLoop(): Promise<void> {
    while (!this.#closed) {
      let packet: [Uint8Array, Deno.Addr];
      try {
        packet = await this.#conn.receive();
      } catch {
        // Closed, or an ICMP error surfaced as a receive failure. Either way we are done.
        break;
      }
      const [data, addr] = packet;
      if (addr.transport !== "udp") continue;
      for (const waiter of this.#waiters) {
        let matched = false;
        try {
          matched = waiter.match(data, addr);
        } catch {
          matched = false;
        }
        if (matched) {
          this.#waiters.delete(waiter);
          waiter.resolve({ data, addr });
          break;
        }
      }
    }
    this.#failAll(new UdpError("socket closed"));
  }

  #failAll(reason: Error): void {
    for (const waiter of this.#waiters) waiter.reject(reason);
    this.#waiters.clear();
  }

  async send(data: Uint8Array, hostname: string, port: number): Promise<void> {
    if (this.#closed) throw new UdpError("socket closed");
    await this.#conn.send(data, { transport: "udp", hostname, port });
  }

  /** Resolve with the first packet `match` accepts, or reject on timeout or abort. */
  receive(
    match: PacketMatcher,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; addr: Deno.NetAddr }> {
    if (this.#closed) return Promise.reject(new UdpError("socket closed"));
    if (signal?.aborted) return Promise.reject(new UdpError("aborted"));

    let settle!: {
      resolve: (packet: { data: Uint8Array; addr: Deno.NetAddr }) => void;
      reject: (reason: Error) => void;
    };
    const promise = new Promise<{ data: Uint8Array; addr: Deno.NetAddr }>((resolve, reject) => {
      settle = { resolve, reject };
    });

    const timer = setTimeout(() => waiter.reject(new UdpError("receive timed out")), timeoutMs);
    const onAbort = () => waiter.reject(new UdpError("aborted"));

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.#waiters.delete(waiter);
    };

    const waiter: Waiter = {
      match,
      resolve: (packet) => {
        cleanup();
        settle.resolve(packet);
      },
      reject: (reason) => {
        cleanup();
        settle.reject(reason);
      },
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    this.#waiters.add(waiter);
    return promise;
  }

  /** Fire and forget: used where a reply is correlated by a later `receive` call. */
  trySend(data: Uint8Array, hostname: string, port: number): void {
    this.send(data, hostname, port).catch((err) => {
      log.debug("udp.send_failed", { hostname, port, msg: String(err) });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new UdpError("socket closed"));
    try {
      this.#conn.close();
    } catch {
      // Already closed.
    }
  }
}
