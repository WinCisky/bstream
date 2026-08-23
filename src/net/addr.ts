/**
 * Address hygiene.
 *
 * Trackers and DHT nodes are unauthenticated, and both can return whatever addresses they like.
 * Handed `10.0.0.5:22` or `169.254.169.254:80`, a naive client will happily dial the operator's
 * internal network from inside it — a swarm-driven port scan at best, a metadata-endpoint probe at
 * worst. Non-routable addresses are useless as peers anyway, so they are dropped at the door.
 */

export function isRoutableIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    if (value > 255) return false;
    octets.push(value);
  }
  const [a, b] = octets as [number, number, number, number];

  if (a === 0) return false; // "this network"
  if (a === 10) return false; // RFC 1918
  if (a === 127) return false; // loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // RFC 6598 CGNAT
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
  if (a === 192 && b === 168) return false; // RFC 1918
  if (a === 192 && b === 0) return false; // IETF protocol assignments / RFC 5737
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

export function isRoutableIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return false;
  if (lower.startsWith("fe8") || lower.startsWith("fe9")) return false; // link-local
  if (lower.startsWith("fea") || lower.startsWith("feb")) return false;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return false; // unique local
  if (lower.startsWith("ff")) return false; // multicast
  if (lower.startsWith("::ffff:")) return isRoutableIPv4(lower.slice("::ffff:".length));
  return true;
}

export function isRoutable(ip: string): boolean {
  return ip.includes(":") ? isRoutableIPv6(ip) : isRoutableIPv4(ip);
}

export function isUsablePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}
