import { assert, assertEquals } from "@std/assert";
import { PeerQueue } from "../src/discovery/queue.ts";
import { isRoutable, isRoutableIPv4, isUsablePort } from "../src/net/addr.ts";
import { parseCompactNodes, parseCompactPeers4, parseCompactPeers6 } from "../src/net/compact.ts";
import { parsePexMessage } from "../src/discovery/pex.ts";
import { encode } from "../src/bencode/encode.ts";

Deno.test("non-routable addresses are rejected", () => {
  // An unauthenticated tracker returning these would have us dialling the internal network.
  for (
    const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1", // CGNAT
      "224.0.0.1", // multicast
      "255.255.255.255",
    ]
  ) {
    assertEquals(isRoutableIPv4(ip), false, `${ip} should be rejected`);
  }
});

Deno.test("public addresses are accepted", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.167.1.1", "203.0.5.9"]) {
    assertEquals(isRoutableIPv4(ip), true, `${ip} should be accepted`);
  }
});

Deno.test("malformed addresses are rejected", () => {
  for (const ip of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "a.b.c.d", "1.2.3.-4"]) {
    assertEquals(isRoutableIPv4(ip), false, `${ip} should be rejected`);
  }
});

Deno.test("IPv6 loopback, link-local and ULA are rejected", () => {
  assertEquals(isRoutable("::1"), false);
  assertEquals(isRoutable("fe80:0:0:0:0:0:0:1"), false);
  assertEquals(isRoutable("fd00:0:0:0:0:0:0:1"), false);
  assertEquals(isRoutable("ff02:0:0:0:0:0:0:1"), false);
  assertEquals(isRoutable("2001:4860:4860:0:0:0:0:8888"), true);
  // An IPv4-mapped private address must not slip through the v6 path.
  assertEquals(isRoutable("::ffff:10.0.0.1"), false);
});

Deno.test("ports are range checked", () => {
  assertEquals(isUsablePort(0), false);
  assertEquals(isUsablePort(1), true);
  assertEquals(isUsablePort(65535), true);
  assertEquals(isUsablePort(65536), false);
  assertEquals(isUsablePort(1.5), false);
});

Deno.test("the queue dedupes on ip:port, not object identity", () => {
  // The PoC uses `new Set<{ip, port}>`, which dedupes nothing.
  const queue = new PeerQueue(10);
  assertEquals(queue.add({ ip: "1.2.3.4", port: 6881 }, "udp"), true);
  assertEquals(queue.add({ ip: "1.2.3.4", port: 6881 }, "dht"), false);
  assertEquals(queue.add({ ip: "1.2.3.4", port: 6882 }, "dht"), true);
  assertEquals(queue.size, 2);
});

Deno.test("the queue enforces its cap", () => {
  const queue = new PeerQueue(3);
  for (let i = 0; i < 10; i++) queue.add({ ip: `8.8.8.${i}`, port: 6881 }, "dht");
  assertEquals(queue.size, 3);
});

Deno.test("snapshot puts verified peers first", () => {
  const queue = new PeerQueue(10);
  queue.add({ ip: "1.1.1.1", port: 1 }, "dht");
  queue.add({ ip: "2.2.2.2", port: 2 }, "udp");
  queue.add({ ip: "3.3.3.3", port: 3 }, "pex");
  queue.markVerified("2.2.2.2:2");

  const snapshot = queue.snapshot();
  assertEquals(snapshot[0]!.ip, "2.2.2.2");
  assertEquals(queue.verifiedCount, 1);
});

Deno.test("the queue yields peers as they arrive and stops on close", async () => {
  const queue = new PeerQueue(10);
  queue.add({ ip: "1.1.1.1", port: 1 }, "magnet");

  const seen: string[] = [];
  const consumer = (async () => {
    for await (const peer of queue) seen.push(peer.ip);
  })();

  // A peer added after the consumer is already waiting must still be delivered.
  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.add({ ip: "2.2.2.2", port: 2 }, "dht");
  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.close();
  await consumer;

  assertEquals(seen, ["1.1.1.1", "2.2.2.2"]);
});

Deno.test("compact peer parsing tolerates a truncated tail", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 0x1a, 0xe1, 9, 9]); // one peer plus 2 stray bytes
  const peers = parseCompactPeers4(bytes);
  assertEquals(peers.length, 1);
  assertEquals(peers[0], { ip: "1.2.3.4", port: 6881 });
});

Deno.test("compact IPv6 peers parse", () => {
  const bytes = new Uint8Array(18);
  bytes[0] = 0x20;
  bytes[1] = 0x01;
  bytes[15] = 0x01;
  bytes[16] = 0x1a;
  bytes[17] = 0xe1;
  assertEquals(parseCompactPeers6(bytes), [{ ip: "2001:0:0:0:0:0:0:1", port: 6881 }]);
});

Deno.test("compact DHT nodes parse", () => {
  const bytes = new Uint8Array(26);
  bytes.fill(0xab, 0, 20);
  bytes.set([8, 8, 8, 8, 0x1a, 0xe1], 20);
  const nodes = parseCompactNodes(bytes);
  assertEquals(nodes.length, 1);
  assertEquals(nodes[0]!.ip, "8.8.8.8");
  assertEquals(nodes[0]!.port, 6881);
  assertEquals(nodes[0]!.id.length, 20);
});

Deno.test("PEX messages yield peers and survive garbage", () => {
  const added = new Uint8Array([1, 2, 3, 4, 0x1a, 0xe1]);
  assertEquals(parsePexMessage(encode({ added })), [{ ip: "1.2.3.4", port: 6881 }]);
  assertEquals(parsePexMessage(new Uint8Array([0x64, 0x99])), []);
  assertEquals(parsePexMessage(new Uint8Array(0)), []);
});

Deno.test("PEX flooding is capped", () => {
  const added = new Uint8Array(6 * 500);
  for (let i = 0; i < 500; i++) added.set([8, 8, 8, i & 0xff, 0x1a, 0xe1], i * 6);
  assert(parsePexMessage(encode({ added })).length <= 200);
});
